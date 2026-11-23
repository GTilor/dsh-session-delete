/**
 * dsh-session-delete-lite 的宿主端。
 *
 * POST /_dsh-session-delete/delete {sessionId}
 * 复查运行状态，卸载内存中的会话，移除工作区登记，再清理磁盘数据。
 */

import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
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
export const inject = ['webServer', 'connection', 'agents', 'sessions', 'storageDomain', 'workspaceRegistry']

/** 宿主在真正删除前再查一次活动状态。 */
function busyReason(agents, sessionId) {
  const agent = agents.get(sessionId)
  const snapshot = agent?.session?.getSnapshot?.() ?? agent?.getSnapshot?.()
  if (snapshot?.running === true) return 'running'
  if (snapshot?.pendingInteraction != null) return 'pending-interaction'
}

/** 走 DSH 自己的拆解路径，让宿主发出会话移除事件。 */
function unloadLiveSession(sessions, sessionId) {
  const session = sessions.get(sessionId)
  if (session == null) return true
  const entry = sessions.liveEntryFor?.(session)
  if (entry == null || typeof sessions.detachEntered !== 'function') return false
  sessions.detachEntered(entry)
  return sessions.get(sessionId) == null
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

async function erasePayload(storageDomain, sessionId) {
  const results = await Promise.all([
    eraseSessionDirs(sessionsRoot(), sessionId),
    eraseProjcache(storageDomain, sessionId),
    eraseSessionDirs(spillBase(), spillSessionDirName(sessionId), SPILL_ROOT_RE),
  ])
  return results.every(Boolean)
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
        const busy = busyReason(ctx.agents, sessionId)
        if (busy) {
          opLog(`会话正忙 ${sessionId} (${busy})`)
          return sendJson(res, 409, { ok: false, error: '会话仍有进行中的工作，无法删除' })
        }

        deleting.add(sessionId)
        try {
          if (!unloadLiveSession(ctx.sessions, sessionId)) {
            opLog(`会话卸载失败 ${sessionId}`)
            return sendJson(res, 409, { ok: false, error: '会话仍留在内存里，请重启 DSH 后重试' })
          }
          const registryClean = await cleanupStep(`清理工作区登记失败 ${sessionId}`, () =>
            forgetInRegistry(ctx.workspaceRegistry, sessionId))
          const complete = registryClean && await erasePayload(ctx.storageDomain, sessionId)
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
