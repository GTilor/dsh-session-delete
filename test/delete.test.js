import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'

const target = 'session-11111111-1111-4111-8111-111111111111'
const sibling = 'session-22222222-2222-4222-8222-222222222222'

async function writeLog(path, text) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

async function fixture(t, { relocated = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-delete-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const home = join(dir, 'home')
  for (const [key, value] of Object.entries({ DSH_HOME: home, DSH_SESSION_DELETE_TMP: join(dir, 'tmp') })) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    })
  }
  const root = relocated ? join(dir, 'custom-history') : join(home, 'sessions')
  const log = (id) => join(root, 'project', id, 'session.v4.jsonl')
  await writeLog(log(target), 'target history')
  await writeLog(log(sibling), 'sibling history')

  const workspace = {
    sessionIds: [target, sibling],
    detachSession(id) { this.sessionIds = this.sessionIds.filter(member => member !== id) },
  }
  const live = new Map()
  let route
  const ctx = {
    effect: effect => effect(),
    webServer: { register(value) { route = value } },
    waterfall: (_event, _request, next) => next(),
    agents: new Map(),
    sessions: {
      get: id => live.get(id),
      flush: async () => true,
      liveEntryFor: session => session,
      detachEntered: session => live.delete(session.id),
    },
    sessionPersistence: {
      config: { root },
      async stat(id) {
        try { await access(log(id)) } catch (error) {
          if (error.code === 'ENOENT') return undefined
          throw error
        }
        return { header: { id }, location: { kind: 'jsonl', path: log(id) } }
      },
    },
    workspaceRegistry: { list: () => [workspace], unpinSession() {}, unarchiveSession() {} },
    storageDomain: new Map(),
  }
  apply(ctx)
  async function remove() {
    const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: target }))])
    req.method = 'POST'
    req.url = route.path
    const res = { setHeader() {}, end(json) { this.body = JSON.parse(json) } }
    await route.handler(req, res)
    return { status: res.statusCode, ...res.body }
  }
  return { ctx, home, live, log, remove, workspace }
}

test('a running host Agent cannot be deleted, even without a client snapshot', async t => {
  const { ctx, live, log, remove, workspace } = await fixture(t)
  const session = { id: target }
  live.set(target, session)
  ctx.agents.set(target, { session, status: 'running' })
  assert.equal((await remove()).status, 409)
  assert.equal(live.get(target), session)
  assert.deepEqual(workspace.sessionIds, [target, sibling])
  assert.equal(await readFile(log(target), 'utf8'), 'target history')
})

test('host activity and turns that start during the check both prevent deletion', async t => {
  const { ctx, log, remove, workspace } = await fixture(t)
  ctx.waterfall = async (event, request) => {
    assert.equal(event, 'workspace/session-activity')
    assert.equal(request.sessionId, target)
    return [{ kind: 'job' }]
  }
  assert.equal((await remove()).status, 409)
  ctx.waterfall = async () => {
    ctx.agents.set(target, { status: 'running' })
    return []
  }
  assert.equal((await remove()).status, 409)
  assert.deepEqual(workspace.sessionIds, [target, sibling])
  assert.equal(await readFile(log(target), 'utf8'), 'target history')
})

test('an idle Agent that still holds the history keeps its session and sidebar entry', async t => {
  const { ctx, live, log, remove, workspace } = await fixture(t)
  const session = { id: target }
  live.set(target, session)
  ctx.agents.set(target, { session, status: 'idle' })
  const result = await remove()
  assert.equal(result.status, 409)
  assert.match(result.error, /重启/)
  assert.equal(live.get(target), session)
  assert.deepEqual(workspace.sessionIds, [target, sibling])
  assert.equal(await readFile(log(target), 'utf8'), 'target history')
})

for (const relocated of [false, true]) {
  test(`deletion removes only the selected history in the ${relocated ? 'custom' : 'default'} root`, async t => {
    const { home, log, remove, workspace } = await fixture(t, { relocated })
    const otherRootLog = join(home, 'sessions', 'another-project', target, 'session.v4.jsonl')
    if (relocated) await writeLog(otherRootLog, 'separate storage')
    assert.deepEqual(await remove(), { status: 200, ok: true })
    await assert.rejects(readFile(log(target)), { code: 'ENOENT' })
    assert.deepEqual(workspace.sessionIds, [sibling])
    assert.deepEqual(await remove(), { status: 200, ok: true })
    assert.equal(await readFile(log(sibling), 'utf8'), 'sibling history')
    if (relocated) assert.equal(await readFile(otherRootLog, 'utf8'), 'separate storage')
  })
}

test('a shared SQLite record is refused before unloading or changing the workspace', async t => {
  const { ctx, live, log, remove, workspace } = await fixture(t)
  const session = { id: target }
  live.set(target, session)
  ctx.sessionPersistence.stat = async id => ({ header: { id }, formatStatus: 'current', eventCount: 1 })
  const result = await remove()
  assert.equal(result.status, 409)
  assert.equal(result.ok, false)
  assert.match(result.error, /SQLite/)
  assert.equal(live.get(target), session)
  assert.deepEqual(workspace.sessionIds, [target, sibling])
  assert.equal(await readFile(log(target), 'utf8'), 'target history')
})

test('an inconsistent storage location cannot remove a sibling directory', async t => {
  const { ctx, log, remove, workspace } = await fixture(t)
  ctx.sessionPersistence.stat = async id => ({ header: { id }, location: { kind: 'jsonl', path: log(sibling) } })
  assert.equal((await remove()).status, 409)
  assert.deepEqual(workspace.sessionIds, [target, sibling])
  assert.equal(await readFile(log(sibling), 'utf8'), 'sibling history')
})

test('a new live JSONL session flushes its buffered history before deletion', async t => {
  const { ctx, live, log, remove } = await fixture(t, { relocated: true })
  await rm(dirname(log(target)), { recursive: true })
  const session = { id: target }
  live.set(target, session)
  const flush = t.mock.method(ctx.sessions, 'flush', async current => {
    assert.equal(current, session)
    await writeLog(log(current.id), 'buffered history')
    return true
  })
  assert.deepEqual(await remove(), { status: 200, ok: true })
  assert.equal(flush.mock.callCount(), 1)
  assert.equal(live.has(target), false)
  await assert.rejects(readFile(log(target)), { code: 'ENOENT' })
})

test('a record that reappears during cleanup yields a partial result and can be retried', async t => {
  const { ctx, log, remove } = await fixture(t, { relocated: true })
  const stat = ctx.sessionPersistence.stat
  let restoreOnce = true
  ctx.sessionPersistence.stat = async id => {
    const stored = await stat(id)
    if (stored || !restoreOnce) return stored
    restoreOnce = false
    await writeLog(log(id), 'late write')
    return stat(id)
  }
  assert.deepEqual(await remove(), { status: 207, ok: false, partial: true })
  assert.equal(await readFile(log(target), 'utf8'), 'late write')
  assert.deepEqual(await remove(), { status: 200, ok: true })
  await assert.rejects(readFile(log(target)), { code: 'ENOENT' })
})

test('retry cleans leftover files using the root DSH resolved at startup', async t => {
  const { ctx, log, remove } = await fixture(t, { relocated: true })
  ctx.sessionPersistence.root = ctx.sessionPersistence.config.root
  ctx.sessionPersistence.config.root = 'relative-history'
  await rm(log(target))
  const leftover = join(dirname(log(target)), 'index.tmp')
  await writeFile(leftover, 'previous cleanup')
  assert.deepEqual(await remove(), { status: 200, ok: true })
  await assert.rejects(readFile(leftover), { code: 'ENOENT' })
  assert.equal(await readFile(log(sibling), 'utf8'), 'sibling history')
})

test('overlapping requests cannot both start deleting the same session', async t => {
  const { ctx, remove } = await fixture(t)
  const checking = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const waterfall = ctx.waterfall
  ctx.waterfall = async (...args) => {
    ctx.waterfall = waterfall
    checking.resolve()
    await resume.promise
    return waterfall(...args)
  }
  const first = remove()
  let duplicate
  try {
    const reachedCheck = await Promise.race([checking.promise.then(() => true), first.then(() => false)])
    assert.ok(reachedCheck, 'the first request reaches the activity check')
    duplicate = await remove()
  } finally {
    resume.resolve()
  }
  assert.deepEqual(await first, { status: 200, ok: true })
  assert.equal(duplicate.status, 409)
})
