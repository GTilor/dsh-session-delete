/**
 * Host half of dsh-session-delete-lite.
 *
 * DSH ships archive / pin / rename / fork for sidebar sessions but no delete.
 * This plugin adds only that action, behind two private routes:
 *
 *   GET  /_dsh-session-delete/status?sessionId=…  → { busy, detail, resident }
 *   POST /_dsh-session-delete/delete {sessionId}  → { ok, removed, … }
 *
 * A delete: refuse while the session owns live work; unload it from the Host's
 * live store so the row is dropped rather than hidden; drop it from the
 * workspace registry; erase its payload (log directory, projection-cache
 * record, spilled tool results). If the unload probe fails, the row is hidden
 * instead and the response says so.
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

/** Append one diagnostic line; logging must never break a request. */
function opLog(line) {
  try {
    mkdirSync(dirname(opLogPath()), { recursive: true })
    appendFileSync(opLogPath(), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* swallow */
  }
}

export const name = 'session-delete-lite'
export const inject = ['webServer', 'connection', 'storageDomain']

/** Resolve a Host service without making it a load-time dependency. */
function serviceOf(ctx, key) {
  try {
    return ctx.get?.(key) ?? ctx[key]
  } catch {
    return undefined
  }
}

/** Authoritative liveness re-check; the sidebar's greyed row is only a hint. */
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

/** Whether the Host still holds the session in memory (the only reason a row survives). */
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
 * Remove a resident session from memory so the browser DROPS its row. DSH has no
 * documented unload API, so this reaches the framework's own teardown
 * (`liveEntryFor(session).detach()`), which emits `session/disposed` →
 * `api-session/removed`. Every step is probed; a miss returns unloaded:false and
 * the caller degrades honestly.
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

/** Degraded fallback: archive a row we could not unload, and report it as hidden. */
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

/** Drop archived/pinned ids whose session payload no longer exists. */
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

/** Remove the session from the workspace registry (global sets + every workspace row). */
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

/** Erase the session's log directory under `~/.dsh/sessions/`. */
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

/** Erase spilled tool results: only the session-hashed dir, never a spill root. */
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

/** Erase the projection-cache record, through the live domain and then the file. */
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

/** A deleted-but-resident session may still flush its cache once; re-purge it. */
function scheduleResidualPurge(ctx, sessionId) {
  const timer = setTimeout(() => {
    void eraseProjcache(ctx, sessionId).catch((error) =>
      opLog(`残留复清失败: ${sessionId} ${error?.message ?? error}`))
  }, 8000)
  timer.unref?.()
}

/** Read one JSON body; empty bodies resolve to {}. */
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

  /** Plugin routes are public by default; reuse the shipped /api trust gate. */
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
    // Register inside the plugin lifecycle: an unload or hot swap must release
    // the prefix, or a later reinstall collides with 'duplicate prefix route'.
    ctx.effect(() => server.register(route), 'session-delete-lite: routes')
  } else {
    routeDisposer = server.register(route)
  }

  log(`删除接口就绪：${ROUTE_PREFIX}`)
  void opLog('plugin activated (session-delete-lite)')
  void pruneDanglingIds(ctx).catch((error) => opLog(`启动清理失败: ${error?.message ?? error}`))
  return routeDisposer
}
