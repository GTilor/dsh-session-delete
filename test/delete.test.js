import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'
import { apply as bindWebAgents } from '../web-agents.js'

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
  const agents = new Map()
  const registry = {
    [Symbol.for('cordis.extend')](methods) { return Object.assign(Object.create(this), methods) },
    get: id => agents.get(id),
    set: (id, agent) => agents.set(id, agent),
    async create({ sessionId }) {
      const agent = { id: sessionId, session: { id: sessionId }, status: 'idle' }
      agents.set(sessionId, agent)
      live.set(sessionId, agent.session)
      return { agent, async dispose() { live.delete(sessionId); agents.delete(sessionId) } }
    },
    resume({ resumeSessionId }) { return registry.create({ sessionId: resumeSessionId }) },
  }
  let route
  let recovery
  const ctx = {
    effect(effect, label) {
      const dispose = effect()
      if (label === 'session-delete-lite: recover') recovery = dispose()
    },
    provide(name, value) { this[name] = value },
    inject(_services, register) { register(this) },
    webServer: { register(value) { route = value } },
    waterfall: (_event, _request, next) => next(),
    agents: registry,
    sessions: {
      get: id => live.get(id),
      flush: async () => true,
      liveEntryFor: session => session,
      detachEntered: session => live.delete(session.id),
    },
    sessionPersistence: {
      config: { root },
      async open(id, mode) {
        assert.equal(id, target)
        assert.equal(mode, 'write')
        return { async close() {} }
      },
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
  async function start() {
    apply(ctx)
    await recovery
  }
  await start()
  const web = Object.create(ctx)
  bindWebAgents(web)
  const webRegistry = web.agents
  async function remove() {
    const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: target }))])
    req.method = 'POST'
    req.url = route.path
    const res = { setHeader() {}, end(json) { this.body = JSON.parse(json) } }
    await route.handler(req, res)
    return { status: res.statusCode, ...res.body }
  }
  return { ctx, home, live, log, remove, start, workspace, webRegistry, registry }
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

test('an idle Agent opened by a different owner keeps its session and sidebar entry', async t => {
  const { ctx, live, log, remove, workspace } = await fixture(t)
  const session = { id: target }
  live.set(target, session)
  ctx.agents.set(target, { session, status: 'idle' })
  const result = await remove()
  assert.equal(result.status, 409)
  assert.equal(result.code, 'session-held')
  assert.equal(live.get(target), session)
  assert.deepEqual(workspace.sessionIds, [target, sibling])
  assert.equal(await readFile(log(target), 'utf8'), 'target history')
})

for (const method of ['create', 'resume']) {
  test(`deletion closes the idle Web agent from ${method} and preserves another open session`, async t => {
    const { ctx, live, log, remove, workspace, webRegistry } = await fixture(t)
    const handle = method === 'create' ? await webRegistry.create({ sessionId: target })
      : await webRegistry.resume({ resumeSessionId: target })
    const dispose = t.mock.method(handle, 'dispose')
    const other = await webRegistry.resume({ resumeSessionId: sibling })
    assert.deepEqual(await remove(), { status: 200, ok: true })
    assert.equal(dispose.mock.callCount(), 1)
    assert.equal(live.has(target), false)
    assert.equal(ctx.agents.get(sibling), other.agent)
    assert.deepEqual(workspace.sessionIds, [sibling])
    await assert.rejects(readFile(log(target)), { code: 'ENOENT' })
    assert.equal(await readFile(log(sibling), 'utf8'), 'sibling history')
  })
}

test('pending approval and queued input protect a Web-owned agent', async t => {
  const { webRegistry, log, remove, workspace } = await fixture(t)
  const { agent } = await webRegistry.resume({ resumeSessionId: target })
  agent.getSnapshot = () => ({ pendingInteraction: { kind: 'approval' } })
  assert.equal((await remove()).code, 'session-busy')
  agent.getSnapshot = () => ({})
  agent.inbox = { nextTurn: [{}] }
  assert.equal((await remove()).code, 'session-busy')
  agent.inbox = { nextStep: [{ source: { kind: 'user' } }] }
  assert.equal((await remove()).code, 'session-busy')
  assert.deepEqual(workspace.sessionIds, [target, sibling])
  assert.equal(await readFile(log(target), 'utf8'), 'target history')
})

test('a context note for a future step does not block deleting an idle session', async t => {
  const { webRegistry, log, remove } = await fixture(t)
  const { agent } = await webRegistry.resume({ resumeSessionId: target })
  agent.inbox = { nextStep: [{ source: { kind: 'repeat-tool-reminder' } }] }
  assert.deepEqual(await remove(), { status: 200, ok: true })
  await assert.rejects(readFile(log(target)), { code: 'ENOENT' })
})

test('a disposal failure or an agent still registered after disposal preserves the history', async t => {
  const { webRegistry, log, remove, workspace } = await fixture(t)
  const handle = await webRegistry.resume({ resumeSessionId: target })
  t.mock.method(handle, 'dispose', async () => { throw new Error('drain failed') })
  assert.equal((await remove()).status, 500)
  handle.dispose.mock.mockImplementation(async () => {})
  assert.equal((await remove()).status, 409)
  assert.deepEqual(workspace.sessionIds, [target, sibling])
  assert.equal(await readFile(log(target), 'utf8'), 'target history')
})

test('a writer in another process keeps the history and the workspace entry', async t => {
  const { ctx, log, remove, workspace } = await fixture(t)
  t.mock.method(ctx.sessionPersistence, 'open', async () => {
    throw Object.assign(new Error('already owned'), { name: 'SessionAlreadyOwnedError' })
  })
  assert.equal((await remove()).code, 'writer-held')
  assert.deepEqual(workspace.sessionIds, [target, sibling])
  assert.equal(await readFile(log(target), 'utf8'), 'target history')
})

test('opening and deleting the same id exclude each other in either order', async t => {
  const { ctx, registry, webRegistry, remove } = await fixture(t)
  const opened = Promise.withResolvers()
  const resume = registry.resume
  t.mock.method(registry, 'resume', async options => { await opened.promise; return resume(options) })
  const pending = webRegistry.resume({ resumeSessionId: target })
  try {
    assert.equal((await remove()).code, 'session-changing')
  } finally {
    opened.resolve()
  }
  await pending
  ctx.waterfall = async () => {
    await assert.rejects(webRegistry.resume({ resumeSessionId: target }), /正在删除/)
    await webRegistry.create({ sessionId: sibling })
    return []
  }
  assert.deepEqual(await remove(), { status: 200, ok: true })
  assert.ok(ctx.agents.get(sibling))
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

test('the directory still identifies the same session after acquiring the write lock', async t => {
  const { ctx, log, remove, workspace } = await fixture(t)
  const stat = ctx.sessionPersistence.stat
  const close = t.mock.fn(async () => {})
  ctx.sessionPersistence.open = async () => {
    ctx.sessionPersistence.stat = async id => {
      const stored = await stat(id)
      return { ...stored, header: { ...stored.header, createdAt: 5 } }
    }
    return { close }
  }
  assert.equal((await remove()).code, 'session-changing')
  assert.equal(close.mock.callCount(), 1)
  assert.deepEqual(workspace.sessionIds, [target, sibling])
  assert.equal(await readFile(log(target), 'utf8'), 'target history')
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
  const { ctx, log, remove, workspace } = await fixture(t, { relocated: true })
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
  assert.deepEqual(workspace.sessionIds, [target, sibling])
  assert.equal(await readFile(log(target), 'utf8'), 'late write')
  assert.deepEqual(await remove(), { status: 200, ok: true })
  await assert.rejects(readFile(log(target)), { code: 'ENOENT' })
})

test('retry after an interrupted directory removal clears the staged files', async t => {
  const { log, remove, workspace } = await fixture(t, { relocated: true })
  const staged = join(dirname(dirname(log(target))), '.dsh-session-delete', target, 'session.v4.jsonl')
  await writeLog(staged, 'interrupted cleanup')
  await rm(dirname(log(target)), { recursive: true })
  assert.deepEqual(await remove(), { status: 200, ok: true })
  await assert.rejects(readFile(staged), { code: 'ENOENT' })
  assert.deepEqual(workspace.sessionIds, [sibling])
  assert.equal(await readFile(log(sibling), 'utf8'), 'sibling history')
})

test('startup completes an interrupted deletion, including workspace entries hidden by the missing log', async t => {
  const { ctx, home, log, remove, start, workspace } = await fixture(t, { relocated: true })
  const staged = join(dirname(dirname(log(target))), '.dsh-session-delete', target, 'session.v4.jsonl')
  const cache = join(home, 'storages', 'session_projcache', 'sessions', target + '.json')
  await writeLog(cache, 'target projection')
  const detach = workspace.detachSession
  const failing = t.mock.method(workspace, 'detachSession', () => { throw new Error('temporary registry error') })
  assert.deepEqual(await remove(), { status: 207, ok: false, partial: true })
  assert.equal(await readFile(staged, 'utf8'), 'target history')
  await assert.rejects(readFile(log(target)), { code: 'ENOENT' })

  // On restart DSH projects the visible members from the histories it found.
  const record = { sessionIds: [target, sibling] }
  ctx.workspaceRegistry.list = () => [{
    id: 'project',
    sessionIds: [sibling],
    detachSession: id => detach.call(record, id),
  }]
  ctx.storageDomain.set('workspace', { table: () => new Map([['project', record]]) })
  await start()
  assert.equal(failing.mock.callCount(), 1)
  assert.deepEqual(record.sessionIds, [sibling])
  await assert.rejects(readFile(staged), { code: 'ENOENT' })
  await assert.rejects(readFile(cache), { code: 'ENOENT' })
  assert.equal(await readFile(log(sibling), 'utf8'), 'sibling history')
})

test('recovery preserves a replacement with the same id and its cache', async t => {
  const { home, log, start, workspace } = await fixture(t)
  const staged = join(dirname(dirname(log(target))), '.dsh-session-delete', target, 'session.v4.jsonl')
  const cache = join(home, 'storages', 'session_projcache', 'sessions', target + '.json')
  await writeLog(staged, 'old history')
  await writeLog(cache, 'current projection')
  await start()
  assert.equal(await readFile(staged, 'utf8'), 'old history')
  assert.equal(await readFile(cache, 'utf8'), 'current projection')
  assert.equal(await readFile(log(target), 'utf8'), 'target history')
  assert.deepEqual(workspace.sessionIds, [target, sibling])
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

test('an unreadable JSONL log or held lock is kept when DSH cannot identify the history', async t => {
  const { ctx, log, remove, workspace } = await fixture(t)
  ctx.sessionPersistence.stat = async () => undefined
  assert.deepEqual(await remove(), { status: 207, ok: false, partial: true })
  assert.equal(await readFile(log(target), 'utf8'), 'target history')
  await rm(log(target))
  const lock = join(dirname(log(target)), 'session.lock')
  await writeLog(lock, 'lock')
  assert.deepEqual(await remove(), { status: 207, ok: false, partial: true })
  assert.equal(await readFile(lock, 'utf8'), 'lock')
  assert.deepEqual(workspace.sessionIds, [target, sibling])
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
