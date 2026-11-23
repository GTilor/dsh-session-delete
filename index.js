/**
 * dsh-session-delete-lite 的宿主端。
 *
 * POST /_dsh-session-delete/delete {sessionId}
 * 检查运行状态，关闭会话，清理并复查磁盘记录，最后移除工作区登记。
 */

import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createWebAgentAccess } from './web-agents.js'

const DELETE_ROUTE = '/_dsh-session-delete/delete'
const SESSION_ID_RE = /^session-[0-9a-fA-F-]{36}$/
const SPILL_ROOT_RE = /^dsh-spill-[A-Za-z0-9_-]{6}$/
const STAGING_DIR = '.dsh-session-delete'

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
export const inject = ['agents']

/** 宿主在真正删除前再查一次活动状态。 */
function assertIdle(agents, sessionId, activity = []) {
  const agent = agents.get(sessionId)
  const snapshot = agent?.session?.getSnapshot?.() ?? agent?.getSnapshot?.()
  if (activity.length > 0 || agent?.status === 'running' || agent?.inbox?.nextTurn?.length > 0 ||
      agent?.inbox?.nextStep?.some(message => message.source?.kind === 'user') ||
      snapshot?.running === true || snapshot?.pendingInteraction != null) {
    opLog(`会话正忙 ${sessionId}`)
    throw Object.assign(new Error('会话仍有进行中的工作，无法删除'), { statusCode: 409, code: 'session-busy' })
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
async function unloadLiveSession(ctx, sessionId, expected) {
  const sessions = ctx.sessions
  const session = sessions.get(sessionId)
  if (session !== expected) return false
  const agent = ctx.agents.get(sessionId)
  if (agent != null) {
    const handle = ctx.sessionDeleteWebAgents.handleFor(agent)
    if (!handle || agent.session !== expected || expected == null || expected.header?.origin === 'subagent') return false
    await handle.dispose()
    return !stillLoaded(ctx, sessionId)
  }
  if (session == null) return true
  const entry = sessions.liveEntryFor?.(session)
  if (entry == null || typeof sessions.detachEntered !== 'function') return false
  sessions.detachEntered(entry)
  return sessions.get(sessionId) == null
}

function stillLoaded(ctx, sessionId) {
  return ctx.sessions.get(sessionId) != null || ctx.agents.get(sessionId) != null
}

function sessionChanging() {
  return Object.assign(new Error('会话正在打开或删除，请稍后重试'), { statusCode: 409, code: 'session-changing' })
}

async function claimHistory(persistence, sessionId) {
  try {
    return await persistence.open(sessionId, 'write')
  } catch (error) {
    if (error?.name === 'SessionPersistenceNotFoundError') throw sessionChanging()
    if (error?.name !== 'SessionAlreadyOwnedError') throw error
    throw Object.assign(new Error('另一个进程正在使用这个会话，结束后可以重试'), { statusCode: 409, code: 'writer-held' })
  }
}

async function forgetInRegistry(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  const table = ctx.storageDomain.get('workspace')?.table('workspaces')
  for (const workspace of registry.list()) {
    // After a restart the public membership hides sessions whose log is gone.
    const sessionIds = table?.get(workspace.id)?.sessionIds ?? workspace.sessionIds
    if (sessionIds.includes(sessionId)) await workspace.detachSession(sessionId)
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
    dirs = await listDirectories(root)
  } catch (error) {
    opLog(`目录读取失败 ${root}: ${error?.message ?? error}`)
    return false
  }

  let complete = true
  for (const dir of dirs) {
    if (parentPattern && !parentPattern.test(dir)) continue
    const target = join(root, dir, sessionDir)
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

function historyRoot(persistence) {
  const configured = persistence.config?.root
  if (typeof configured !== 'string' || configured.length === 0) return undefined
  // 相对路径在 DSH 启动时已经解析过，进程的当前目录此后可能改变。
  const root = isAbsolute(configured) ? configured : persistence.root
  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new Error('无法定位会话存储目录')
  }
  return root
}

async function isDirectory(path) {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function readEntries(path) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function listDirectories(path) {
  const entries = await readEntries(path)
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
}

async function* stagedSessions(root) {
  if (root === undefined) return
  for (const project of await listDirectories(root)) {
    const staging = join(root, project, STAGING_DIR)
    if (!await isDirectory(staging)) continue
    for (const id of await listDirectories(staging)) {
      if (SESSION_ID_RE.test(id)) yield [id, join(staging, id)]
    }
  }
}

async function stageHistory(ctx, sessionId, directory, stored) {
  const writer = await claimHistory(ctx.sessionPersistence, sessionId)
  const staging = join(dirname(directory), STAGING_DIR)
  const staged = join(staging, sessionId)
  let closed
  try {
    const current = await ctx.sessionPersistence.stat(sessionId)
    if (jsonlSessionDir(current, sessionId) !== directory ||
        current.header.createdAt !== stored.header.createdAt || stillLoaded(ctx, sessionId)) {
      throw sessionChanging()
    }
    await mkdir(staging, { recursive: true, mode: 0o700 })
    if (!await isDirectory(staging)) throw new Error('无法使用会话清理目录')
    await rm(staged, { recursive: true, force: true })
    // Move the directory with its write lock intact. DSH looks for logs
    // two levels below its root, so a staged log must be a level deeper.
    await rename(directory, staged)
  } finally {
    closed = await cleanupStep(`释放写入句柄失败 ${sessionId}`, () => writer.close())
  }
  return closed ? staged : undefined
}

async function assertHistoryGone(ctx, sessionId) {
  if (await ctx.sessionPersistence.stat(sessionId) != null || stillLoaded(ctx, sessionId)) {
    throw new Error('宿主仍能读取会话')
  }
}

async function eraseResidualHistory(root, sessionId) {
  for (const project of await listDirectories(root)) {
    const path = join(root, project, sessionId)
    if (!await isDirectory(path)) continue
    const entries = await readEntries(path)
    // A missing stat alone is insufficient to delete a log or an active
    // writer's directory. Leave unrecognized history in place.
    if (entries.some(entry => entry.name === 'session.lock' || entry.name.includes('.jsonl'))) {
      throw new Error('会话目录中仍有未核实的记录或写入锁')
    }
    for (const entry of entries) await rm(join(path, entry.name), { recursive: true, force: true })
    await rmdir(path).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

async function finishDeletion(ctx, sessionId, stagedPaths, residualRoot) {
  const gone = await cleanupStep(`删除后复查失败 ${sessionId}`, () => assertHistoryGone(ctx, sessionId))
  if (!gone) return false

  if (residualRoot && !await cleanupStep(`清理残余目录失败 ${sessionId}`, () =>
    eraseResidualHistory(residualRoot, sessionId))) return false

  const sideData = await Promise.all([
    eraseProjcache(ctx.storageDomain, sessionId),
    eraseSessionDirs(spillBase(), spillSessionDirName(sessionId), SPILL_ROOT_RE),
  ])
  if (!sideData.every(Boolean)) return false

  // Keep the staged directory as a record of the confirmed deletion until
  // cleanup and registry updates succeed, so the next launch can resume them.
  const forgotten = await cleanupStep(`复查或更新工作区失败 ${sessionId}`, async () => {
    await assertHistoryGone(ctx, sessionId)
    await forgetInRegistry(ctx, sessionId)
  })
  if (!forgotten) return false
  if (residualRoot && !await eraseSessionDirs(residualRoot, `.dsh-deleting-${sessionId}`)) return false
  const results = await Promise.all(stagedPaths.map(path =>
    cleanupStep(`清理暂存会话失败 ${sessionId}`, () => rm(path, { recursive: true, force: true }))))
  return results.every(Boolean)
}

async function removeUnloadedSession(ctx, sessionId, directory, stored) {
  if (directory !== undefined) {
    const staged = await stageHistory(ctx, sessionId, directory, stored)
    if (staged === undefined) return false
    return finishDeletion(ctx, sessionId, [staged])
  }
  const root = historyRoot(ctx.sessionPersistence)
  const paths = []
  for await (const [id, path] of stagedSessions(root)) {
    if (id === sessionId) paths.push(path)
  }
  return finishDeletion(ctx, sessionId, paths, paths.length === 0 ? root : undefined)
}

async function recoverInterruptedDeletes(ctx) {
  for await (const [sessionId, path] of stagedSessions(historyRoot(ctx.sessionPersistence))) {
    await cleanupStep(`恢复删除失败 ${sessionId}`, async () => {
      const done = ctx.sessionDeleteWebAgents.beginDelete(sessionId)
      try {
        if (await finishDeletion(ctx, sessionId, [path])) opLog(`已完成中断的删除 ${sessionId}`)
      } finally {
        done()
      }
    })
  }
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
  ctx.provide('sessionDeleteWebAgents', createWebAgentAccess(ctx.agents))
  ctx.inject(['webServer', 'connection', 'sessions', 'sessionPersistence', 'storageDomain', 'workspaceRegistry'], registerDeleteRoute)
}

function registerDeleteRoute(ctx) {
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
        const endDelete = ctx.sessionDeleteWebAgents.beginDelete(sessionId)
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
          if (!await unloadLiveSession(ctx, sessionId, live)) {
            opLog(`会话仍由其他组件持有 ${sessionId}`)
            return sendJson(res, 409, { ok: false, code: 'session-held', error: '会话仍由其他组件持有，释放后可以重试' })
          }
          const complete = await removeUnloadedSession(ctx, sessionId, directory, stored)
          opLog(`${complete ? '已删除' : '未完整删除'} ${sessionId}`)
          if (!complete) return sendJson(res, 207, { ok: false, partial: true })
          sendJson(res, 200, { ok: true })
        } finally {
          endDelete()
        }
      } catch (error) {
        const status = Number(error?.statusCode) || 500
        const message = error instanceof Error ? error.message : String(error)
        opLog(`ERROR ${req.method} ${req.url} → ${status}: ${message}`)
        sendJson(res, status, { ok: false, code: error?.statusCode ? error.code : undefined, error: message })
      }
    },
  }

  ctx.effect(() => ctx.webServer.register(route), 'session-delete-lite: route')
  ctx.effect(() => {
    const recovery = cleanupStep('恢复中断的会话删除失败', () => recoverInterruptedDeletes(ctx))
    return async () => { await recovery }
  }, 'session-delete-lite: recover')
  console.log(`[session-delete-lite] 删除接口已注册 ${DELETE_ROUTE}`)
  opLog('plugin activated (session-delete-lite)')
}
