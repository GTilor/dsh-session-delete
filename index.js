/**
 * dsh-session-delete-lite 的宿主端。
 *
 * POST /_dsh-session-delete/delete {sessionId}
 * 复查运行状态，卸载内存中的会话，移除工作区登记，再清理磁盘数据。
 */

import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { rm, readdir } from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'

const DELETE_ROUTE = '/_dsh-session-delete/delete'
const SESSION_ID_RE = /^session-[0-9a-fA-F-]{36}$/
const SPILL_ROOT_RE = /^dsh-spill-[A-Za-z0-9_-]{6}$/

const dshHome = () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  return process.env.DSH_HOME ?? join(home, '.dsh')
}
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
export const inject = ['webServer', 'connection', 'agents', 'sessions', 'sessionPersistence', 'storageDomain', 'workspaceRegistry']

/** 宿主在真正删除前再查一次活动状态。 */
function assertIdle(agents, sessionId, activity = []) {
  const agent = agents.get(sessionId)
  const snapshot = agent?.session?.getSnapshot?.() ?? agent?.getSnapshot?.()
  if (activity.length > 0 || agent?.status === 'running' ||
      snapshot?.running === true || snapshot?.pendingInteraction != null) {
    opLog(`会话正忙 ${sessionId}`)
    throw Object.assign(new Error('会话仍有进行中的工作，无法删除'), { statusCode: 409 })
  }
}

/** 只接受宿主为目标会话定位到的独立 JSONL 目录。SQLite 的记录没有这样的路径。 */
function jsonlSessionDir(stored, sessionId) {
  const location = stored?.location
  if (stored?.header?.id !== sessionId || location?.kind !== 'jsonl' ||
      typeof location.path !== 'string' || !isAbsolute(location.path)) return
  const directory = dirname(resolve(location.path))
  if (basename(directory) === sessionId) return directory
}

/** 走 DSH 自己的拆解路径，让宿主发出会话移除事件。 */
function unloadLiveSession(ctx, sessionId, expected) {
  // Agent 的销毁句柄归创建者持有。单独摘掉 Session 会让 Agent 继续持有原对话。
  if (ctx.agents.get(sessionId)?.session != null) return false
  const sessions = ctx.sessions
  const session = sessions.get(sessionId)
  if (session == null) return true
  if (session !== expected) return false
  const entry = sessions.liveEntryFor?.(session)
  if (entry == null || typeof sessions.detachEntered !== 'function') return false
  sessions.detachEntered(entry)
  return sessions.get(sessionId) == null
}

function stillLoaded(ctx, sessionId) {
  return ctx.sessions.get(sessionId) != null || ctx.agents.get(sessionId)?.session != null
}

async function forgetInRegistry(registry, sessionId) {
  for (const workspace of registry.list()) {
    if (workspace.sessionIds.includes(sessionId)) await workspace.detachSession(sessionId)
  }
  await registry.unpinSession(sessionId)
  await registry.unarchiveSession(sessionId)
}

/** 记录单项失败，让后面的清理继续，并把结果带回确认框。 */
async function cleanupStep(label, operation) {
  try {
    await operation()
    return true
  } catch (error) {
    opLog(`${label}: ${error?.message ?? error}`)
    return false
  }
}

/** 在工作区或 spill 目录中只清理目标会话的子目录。 */
async function eraseSessionDirs(root, sessionDir, parentPattern) {
  let dirs
  try {
    dirs = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    opLog(`目录读取失败 ${root}: ${error?.message ?? error}`)
    return false
  }

  let complete = true
  for (const dir of dirs) {
    if (!dir.isDirectory() || (parentPattern && !parentPattern.test(dir.name))) continue
    const target = join(root, dir.name, sessionDir)
    const removed = await cleanupStep(`目录删除失败 ${target}`, () => rm(target, { recursive: true, force: true }))
    if (!removed) complete = false
  }
  return complete
}

/** 清理投影缓存的存储域和文件，两种会话键都可能存在。 */
async function eraseProjcache(storageDomain, sessionId) {
  let table
  let complete = await cleanupStep('读取投影缓存域失败', () => {
    table = storageDomain.get('session_projcache')?.table('sessions')
  })
  for (const key of [sessionId, uuidOf(sessionId)]) {
    if (table) {
      const removed = await cleanupStep(`投影缓存记录删除失败 ${key}`, () => table.delete(key))
      if (!removed) complete = false
    }
    const file = join(projcacheSessionsDir(), `${key}.json`)
    const removed = await cleanupStep(`投影缓存文件删除失败 ${file}`, () => rm(file, { force: true }))
    if (!removed) complete = false
  }
  return complete
}

async function eraseHistory(persistence, sessionId, directory) {
  if (directory !== undefined) {
    return cleanupStep(`会话目录删除失败 ${directory}`, () => rm(directory, { recursive: true, force: true }))
  }
  // 重试时日志可能已经删掉。只在此 JSONL 后端配置的根目录里查找残余文件。
  const configured = persistence.config?.root
  if (typeof configured !== 'string' || configured.length === 0) return true
  // 相对路径在 DSH 启动时已经解析过，进程的当前目录此后可能改变。
  const root = isAbsolute(configured) ? configured : persistence.root
  if (typeof root !== 'string' || !isAbsolute(root)) {
    opLog(`无法定位会话残余目录 ${sessionId}`)
    return false
  }
  return eraseSessionDirs(root, sessionId)
}

async function erasePayload(ctx, sessionId, directory) {
  const results = await Promise.all([
    eraseHistory(ctx.sessionPersistence, sessionId, directory),
    eraseProjcache(ctx.storageDomain, sessionId),
    eraseSessionDirs(spillBase(), spillSessionDirName(sessionId), SPILL_ROOT_RE),
  ])
  if (!results.every(Boolean)) return false
  return cleanupStep(`删除后复查失败 ${sessionId}`, async () => {
    if (await ctx.sessionPersistence.stat(sessionId) != null || stillLoaded(ctx, sessionId)) {
      throw new Error('宿主仍能读取会话')
    }
  })
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
  const deleting = new Set()
  const route = {
    kind: 'exact',
    path: DELETE_ROUTE,
    auth: 'required',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return sendJson(res, 405, { ok: false, error: '请使用 POST' })
      }
      try {
        const body = await readJsonBody(req)
        const sessionId = body?.sessionId
        if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
          return sendJson(res, 400, { ok: false, error: '非法的 sessionId' })
        }
        if (deleting.has(sessionId)) {
          return sendJson(res, 409, { ok: false, error: '会话正在删除，请稍后重试' })
        }
        deleting.add(sessionId)
        try {
          assertIdle(ctx.agents, sessionId)
          const live = ctx.sessions.get(sessionId)
          // 新会话可能还没有文件。先让这条会话的缓冲记录落盘，再问宿主要位置。
          if (live != null) await ctx.sessions.flush(live)
          const stored = await ctx.sessionPersistence.stat(sessionId)
          const directory = jsonlSessionDir(stored, sessionId)
          if (stored != null && directory === undefined) {
            return sendJson(res, 409, {
              ok: false,
              code: 'unsupported-storage',
              error: '此会话没有可单独删除的 JSONL 文件。SQLite 等共享存储暂不支持删除。',
            })
          }
          const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
          assertIdle(ctx.agents, sessionId, activity)
          if (!unloadLiveSession(ctx, sessionId, live)) {
            opLog(`会话卸载失败 ${sessionId}`)
            return sendJson(res, 409, { ok: false, error: '会话仍留在内存里，请重启 DSH 后重试' })
          }
          const registryClean = await cleanupStep(`清理工作区登记失败 ${sessionId}`, () =>
            forgetInRegistry(ctx.workspaceRegistry, sessionId))
          const complete = registryClean && !stillLoaded(ctx, sessionId) &&
            await erasePayload(ctx, sessionId, directory)
          opLog(`${complete ? '已删除' : '未完整删除'} ${sessionId}`)
          if (!complete) return sendJson(res, 207, { ok: false, partial: true })
          sendJson(res, 200, { ok: true })
        } finally {
          deleting.delete(sessionId)
        }
      } catch (error) {
        const status = Number(error?.statusCode) || 500
        const message = error instanceof Error ? error.message : String(error)
        opLog(`ERROR ${req.method} ${req.url} → ${status}: ${message}`)
        sendJson(res, status, { ok: false, error: message })
      }
    },
  }

  ctx.effect(() => ctx.webServer.register(route), 'session-delete-lite: route')
  console.log(`[session-delete-lite] 删除接口已注册 ${DELETE_ROUTE}`)
  opLog('plugin activated (session-delete-lite)')
}
