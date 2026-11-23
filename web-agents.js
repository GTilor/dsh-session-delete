export const name = 'session-delete-web-agents'
export const inject = ['sessionDeleteWebAgents']

// The Web controller normally keeps the Agent but drops the handle that closes
// its writer. Retain that handle only for agents opened through this controller.
export function createWebAgentAccess(registry) {
  const handles = new WeakMap()
  const opening = new Map()
  const deleting = new Set()

  async function open(id, acquire) {
    if (deleting.has(id)) throw new Error('会话正在删除')
    opening.set(id, (opening.get(id) ?? 0) + 1)
    try {
      const handle = await acquire()
      if (handle?.agent?.id === id && typeof handle.dispose === 'function') {
        handles.set(handle.agent, handle)
      }
      return handle
    } finally {
      const count = opening.get(id) - 1
      if (count === 0) opening.delete(id)
      else opening.set(id, count)
    }
  }

  // Cordis Service.extend preserves the registry API and the calling fiber.
  // In particular, the native controller still owns its agents on shutdown.
  const webRegistry = registry[Symbol.for('cordis.extend')]({
    create(options) {
      return open(options.sessionId, () => registry.create.call(this, options))
    },
    resume(options) {
      return open(options.resumeSessionId, () => registry.resume.call(this, options))
    },
  })
  return {
    webRegistry,
    beginDelete(id) {
      if (deleting.has(id) || opening.has(id)) {
        throw Object.assign(new Error('会话正在打开或删除，请稍后重试'), { statusCode: 409, code: 'session-changing' })
      }
      deleting.add(id)
      return () => deleting.delete(id)
    },
    handleFor(agent) { return handles.get(agent) },
  }
}

export function apply(ctx) {
  ctx.provide('agents', ctx.sessionDeleteWebAgents.webRegistry)
}
