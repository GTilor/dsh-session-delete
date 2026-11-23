/**
 * dsh-session-delete-lite 的宿主端。
 *
 * 我只做一件事：DSH 有归档、置顶、重命名、分叉，偏偏没有删除会话。客户端通过
 * 两个私有路由找我：
 *
 *   GET  /_dsh-session-delete/status?sessionId=…  → { busy, detail, resident }
 *   POST /_dsh-session-delete/delete {sessionId}  → { ok, removed, … }
 *
 * 删除的顺序是踩过坑之后定下来的：先自己复查一遍会话是不是还在干活，有活就不
 * 删；再把仍留在内存里的会话从宿主卸掉，这样侧栏那一行是真的消失，而不是藏起
 * 来；然后从工作区登记里摘掉；最后抹掉磁盘载荷（会话目录、投影缓存、溢出的工
 * 具结果）。卸载探针失败时我选择降级隐藏，并在响应里如实说明，绝不假装删干净。
 */

import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { rm, readdir } from 'node:fs/promises'
import { existsSync, appendFileSync, mkdirSync } from 'node:fs'

const TAG = '[session-delete-lite]'
const ROUTE_PREFIX = '/_dsh-session-delete'
const SESSION_ID_RE = /^session-[0-9a-fA-F-]{36}$/
const SPILL_ROOT_RE = /^dsh-spill-[A-Za-z0-9_-]{6}$/

const dshHome = () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  return process.env.DSH_HOME ?? join(home, '.dsh')
}
const sessionsRoot = () => join(dshHome(), 'sessions')
const projcacheSessionsDir = () => join(dshHome(), 'storages', 'session_projcache', 'sessions')
const opLogPath = () => join(dshHome(), 'logs', 'session-delete-lite.log')
const spillBase = () => process.env.DSH_SESSION_DELETE_TMP ?? tmpdir()

const uuidOf = (sessionId) => sessionId.slice('session-'.length)
const spillSessionDirName = (sessionId) =>
  `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`

/** 写一行诊断日志。日志自己绝不能把请求搞挂，所以整段都吞异常。 */
function opLog(line) {
  try {
    mkdirSync(dirname(opLogPath()), { recursive: true })
    appendFileSync(opLogPath(), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* 写不进去就算了 */
  }
}

export const name = 'session-delete-lite'
export const inject = ['webServer', 'connection', 'storageDomain']

/** 按需取宿主服务：拿不到就给 undefined，别让它在加载期变成硬依赖。 */
function serviceOf(ctx, key) {
  try {
    return ctx.get?.(key) ?? ctx[key]
  } catch {
    return undefined
  }
}

/** 删除前自己再查一次活。侧栏把菜单项置灰只是提示，真正拦人的是这里。 */
function probeBusy(ctx, sessionId) {
  const agents = serviceOf(ctx, 'agents')
  if (!agents || typeof agents.get !== 'function') return { busy: false, detail: 'agents-unavailable' }
  let agent
  try {
    agent = agents.get(sessionId)
  } catch {
    agent = undefined
  }
  if (agent === undefined || agent === null) return { busy: false, detail: 'no-live-agent' }
  const snapshot = agent?.session?.getSnapshot?.() ?? agent?.getSnapshot?.()
  const running =
    snapshot?.running === true ||
    (snapshot?.pendingInteraction !== undefined && snapshot?.pendingInteraction !== null)
  if (running) return { busy: true, detail: snapshot?.running === true ? 'running' : 'pending-interaction' }
  return { busy: false, detail: 'agent-idle' }
}

/** 会话是否还留在宿主内存里。只要还在，侧栏那一行就掉不了。 */
function isResident(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') return false
  try {
    return sessions.get(sessionId) !== undefined
  } catch {
    return false
  }
}

/**
 * 把还在内存里的会话真正卸掉，浏览器那边才会把这一行丢掉。
 *
 * DSH 没有公开的卸载接口，所以我走框架自己的拆解路径
 * （`liveEntryFor(session).detach()`），它会发出 `session/disposed` →
 * `api-session/removed`。每一步都先探测能力，探不到就返回 unloaded:false，
 * 由调用方老实降级。
 */
async function unloadLiveSession(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') return { unloaded: false, detail: 'sessions-unavailable' }
  let session
  try {
    session = sessions.get(sessionId)
  } catch (error) {
    return { unloaded: false, detail: `get-failed: ${error?.message ?? error}` }
  }
  if (session === undefined || session === null) return { unloaded: false, detail: 'not-resident' }
  if (typeof sessions.liveEntryFor !== 'function') return { unloaded: false, detail: 'no-liveEntryFor' }
  if (typeof sessions.detachEntered !== 'function') return { unloaded: false, detail: 'no-detachEntered' }
  try {
    const entry = sessions.liveEntryFor(session)
    if (entry === undefined || entry === null) return { unloaded: false, detail: 'no-entry' }
    sessions.detachEntered(entry)
  } catch (error) {
    return { unloaded: false, detail: `unload-failed: ${error?.message ?? error}` }
  }
  return isResident(ctx, sessionId)
    ? { unloaded: false, detail: 'still-resident' }
    : { unloaded: true, detail: 'detached' }
}

/** 降级兜底：卸不掉的会话就归档藏起来，并在响应里标成 hidden。 */
async function hideLiveRemnant(ctx, sessionId) {
  const domain = serviceOf(ctx, 'storageDomain')?.get?.('workspace')
  if (!domain?.global) return false
  const state = { ...domain.global.get() }
  const archived = state.archivedSessionIds ?? []
  if (archived.includes(sessionId)) return false
  state.archivedSessionIds = [sessionId, ...archived]
  await domain.global.set(state)
  return true
}

/** 清掉指向已不存在会话的归档/置顶标记——那种 id 点开只会报错。 */
async function pruneDanglingIds(ctx) {
  const domain = serviceOf(ctx, 'storageDomain')?.get?.('workspace')
  if (!domain?.global) return 0
  const state = { ...domain.global.get() }
  const archived = state.archivedSessionIds ?? []
  const pinned = state.pinnedSessionIds ?? []
  if (archived.length === 0 && pinned.length === 0) return 0
  const root = sessionsRoot()
  if (!existsSync(root)) return 0
  const workspaceDirs = await readdir(root)
  const alive = (id) => workspaceDirs.some((dir) => existsSync(join(root, dir, id)))
  const nextArchived = archived.filter(alive)
  const nextPinned = pinned.filter(alive)
  const dropped = archived.length - nextArchived.length + (pinned.length - nextPinned.length)
  if (dropped === 0) return 0
  state.archivedSessionIds = nextArchived
  state.pinnedSessionIds = nextPinned
  await domain.global.set(state)
  return dropped
}

/** 从工作区登记里摘掉：全局的归档/置顶集合，加上每个工作区的 sessionIds。 */
async function forgetInRegistry(ctx, sessionId) {
  const domain = serviceOf(ctx, 'storageDomain')?.get?.('workspace')
  if (!domain || typeof domain.table !== 'function' || !domain.global) {
    throw new Error('workspace 存储域未打开，无法从注册表移除该会话')
  }
  const removed = { workspaces: [], archived: false, pinned: false }
  const globalState = { ...domain.global.get() }
  const archiveSet = globalState.archivedSessionIds ?? []
  const pinSet = globalState.pinnedSessionIds ?? []
  if (archiveSet.includes(sessionId)) {
    removed.archived = true
    globalState.archivedSessionIds = archiveSet.filter((id) => id !== sessionId)
  }
  if (pinSet.includes(sessionId)) {
    removed.pinned = true
    globalState.pinnedSessionIds = pinSet.filter((id) => id !== sessionId)
  }
  if (removed.archived || removed.pinned) await domain.global.set(globalState)

  const table = domain.table('workspaces')
  for (const [workspaceId, record] of table.entries()) {
    const owned = Array.isArray(record?.sessionIds) && record.sessionIds.includes(sessionId)
    if (!owned) continue
    await table.update(workspaceId, () => ({
      ...record,
      sessionIds: record.sessionIds.filter((id) => id !== sessionId),
      updatedAt: new Date().toISOString(),
    }))
    removed.workspaces.push(record.title || workspaceId)
  }
  return removed
}

/** 删掉 `~/.dsh/sessions/` 下这个会话的目录。 */
async function eraseSessionLog(sessionId) {
  const removed = []
  const root = sessionsRoot()
  if (!existsSync(root)) return removed
  for (const workspaceDir of await readdir(root)) {
    const target = join(root, workspaceDir, sessionId)
    if (!existsSync(target)) continue
    await rm(target, { recursive: true, force: true })
    removed.push(target)
  }
  return removed
}

/** 删溢出的工具结果：只删按会话哈希命名的那个目录，绝不碰 spill 根目录。 */
async function eraseSpill(sessionId) {
  const removed = []
  let entries
  try {
    entries = await readdir(spillBase())
  } catch {
    return removed
  }
  const name = spillSessionDirName(sessionId)
  for (const entry of entries) {
    if (!SPILL_ROOT_RE.test(entry)) continue
    const target = join(spillBase(), entry, name)
    if (!existsSync(target)) continue
    try {
      await rm(target, { recursive: true, force: true })
      removed.push(target)
    } catch (error) {
      await opLog(`spill 删除失败 ${target}: ${error?.message ?? error}`)
    }
  }
  return removed
}

/** 删投影缓存：先走活着的 domain，再兜底删文件。 */
async function eraseProjcache(ctx, sessionId) {
  const removed = []
  const uuid = uuidOf(sessionId)
  try {
    const cacheDomain = serviceOf(ctx, 'storageDomain')?.get?.('session_projcache')
    if (cacheDomain && typeof cacheDomain.table === 'function') {
      const table = cacheDomain.table('sessions')
      if (table && typeof table.delete === 'function') {
        for (const key of new Set([sessionId, uuid])) {
          try {
            if (await table.delete(key)) removed.push(`session_projcache#sessions:${key}`)
          } catch (error) {
            await opLog(`projcache 域删除失败 ${key}: ${error?.message ?? error}`)
          }
        }
      }
    }
  } catch (error) {
    await opLog(`projcache 域不可用，改用文件删除: ${error?.message ?? error}`)
  }
  for (const cacheFile of [
    join(projcacheSessionsDir(), `${sessionId}.json`),
    join(projcacheSessionsDir(), `${uuid}.json`),
  ]) {
    if (!existsSync(cacheFile)) continue
    try {
      await rm(cacheFile, { force: true })
      removed.push(cacheFile)
    } catch (error) {
      await opLog(`projcache 文件删除失败 ${cacheFile}: ${error?.message ?? error}`)
    }
  }
  return removed
}

async function erasePayload(ctx, sessionId) {
  const removed = await eraseSessionLog(sessionId)
  removed.push(...(await eraseProjcache(ctx, sessionId)))
  removed.push(...(await eraseSpill(sessionId)))
  return removed
}

/** 没卸掉的会话可能还会把缓存回写一次，所以过几秒再清一遍。 */
function scheduleResidualPurge(ctx, sessionId) {
  const timer = setTimeout(() => {
    void eraseProjcache(ctx, sessionId).catch((error) =>
      opLog(`残留复清失败: ${sessionId} ${error?.message ?? error}`))
  }, 8000)
  timer.unref?.()
}

/** 读一个 JSON 请求体；空体当 {}。 */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 })
  }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

export function apply(ctx) {
  const log = (message, error) => {
    if (error === undefined) console.log(`${TAG} ${message}`)
    else console.warn(`${TAG} ${message}`, error)
  }

  const server = serviceOf(ctx, 'webServer')
  if (!server || typeof server.register !== 'function') {
    log('没有 webServer 服务，删除接口不可用')
    return
  }

  /** 插件路由默认是公开的，这里复用官方 /api 那套连接信任检查。 */
  const rejectUntrusted = (req, res) => {
    const connection = serviceOf(ctx, 'connection')
    if (!connection) return false
    try {
      if (typeof connection.requestRejection === 'function') {
        const rejection = connection.requestRejection(req)
        if (rejection === undefined || rejection === null) return false
        sendJson(res, Number(rejection) || 403, { error: '未通过连接信任检查' })
        return true
      }
      if (typeof connection.admit === 'function') {
        const admission = connection.admit(req)
        if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
          sendJson(res, Number(admission.rejection) || 403, { error: '未通过连接信任检查' })
          return true
        }
      }
    } catch (error) {
      log('连接信任检查出错，放行本次请求', error)
    }
    return false
  }

  const route = {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (rejectUntrusted(req, res)) return
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      try {
        if (url.pathname === `${ROUTE_PREFIX}/status` && req.method === 'GET') {
          const sessionId = url.searchParams.get('sessionId') ?? ''
          if (!SESSION_ID_RE.test(sessionId)) throw Object.assign(new Error('非法的 sessionId'), { statusCode: 400 })
          sendJson(res, 200, { ...probeBusy(ctx, sessionId), resident: isResident(ctx, sessionId) })
          return
        }
        if (url.pathname === `${ROUTE_PREFIX}/delete` && req.method === 'POST') {
          const body = await readJsonBody(req)
          const sessionId = body?.sessionId
          if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
            throw Object.assign(new Error('非法的 sessionId'), { statusCode: 400 })
          }
          const busy = probeBusy(ctx, sessionId)
          const resident = isResident(ctx, sessionId)
          await opLog(`delete ${sessionId} busy=${busy.busy}(${busy.detail}) resident=${resident}`)
          if (busy.busy) {
            sendJson(res, 409, { ok: false, error: '会话仍有进行中的工作，无法删除', detail: busy.detail })
            return
          }

          const unload = resident
            ? await unloadLiveSession(ctx, sessionId)
            : { unloaded: false, detail: 'not-resident' }
          const registry = await forgetInRegistry(ctx, sessionId)
          let removedPaths = []
          try {
            removedPaths = await erasePayload(ctx, sessionId)
          } catch (error) {
            await opLog(`载荷清理失败（注册表已移除）: ${error?.message ?? error}`)
          }

          let hidden = false
          const live = isResident(ctx, sessionId)
          if (live) {
            try {
              hidden = await hideLiveRemnant(ctx, sessionId)
            } catch (error) {
              await opLog(`残留隐藏失败: ${error?.message ?? error}`)
            }
            scheduleResidualPurge(ctx, sessionId)
          }
          await opLog(`已删除 ${sessionId}，文件 ${removedPaths.length} 处，卸载=${unload.unloaded}`)
          sendJson(res, 200, {
            ok: true,
            ...registry,
            removed: removedPaths,
            live,
            unloaded: unload.unloaded,
            unloadDetail: unload.detail,
            hidden,
          })
          return
        }
        sendJson(res, 404, { error: '未知接口' })
      } catch (error) {
        const status = Number(error?.statusCode) || 500
        await opLog(`ERROR ${req.method} ${req.url} → ${status}: ${error instanceof Error ? error.message : String(error)}`)
        sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  let routeDisposer
  if (typeof ctx.effect === 'function') {
    // 路由注册挂在插件生命周期里：卸载或热替换时必须把前缀还回去，
    // 否则下次重装会撞上 'duplicate prefix route'。
    ctx.effect(() => server.register(route), 'session-delete-lite: routes')
  } else {
    routeDisposer = server.register(route)
  }

  log(`删除接口就绪：${ROUTE_PREFIX}`)
  void opLog('plugin activated (session-delete-lite)')
  void pruneDanglingIds(ctx).catch((error) => opLog(`启动清理失败: ${error?.message ?? error}`))
  return routeDisposer
}
