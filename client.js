/**
 * Client half of dsh-session-delete-lite.
 *
 * Adds one row to the shipped `sidebar.workspaces.session.menu.item` list — the
 * same list pin / rename / fork / archive live in — so every session's “…” menu
 * gets a Delete action. The row only files a request; the confirm dialog and the
 * result toast live in `shell.overlay`, because a menu row unmounts with its menu.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-delete-lite',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-session-delete-lite'
    const DICT = {
      zh: {
        menu: '删除会话',
        menuBusy: '会话运行中，无法删除',
        confirmTitle: '删除会话？',
        confirmDesc: '永久删除「{title}」的对话记录与本地数据，无法恢复。',
        confirmAction: '删除',
        cancel: '取消',
        deleting: '删除中…',
        done: '已删除',
        doneLive: '已删除；列表里暂时还留着，重启 DSH 后消失',
        failed: '删除失败：{message}',
      },
      en: {
        menu: 'Delete session',
        menuBusy: 'Session is running; cannot delete',
        confirmTitle: 'Delete session?',
        confirmDesc: 'Permanently deletes “{title}” — its history and local data. This cannot be undone.',
        confirmAction: 'Delete',
        cancel: 'Cancel',
        deleting: 'Deleting…',
        done: 'Session deleted',
        doneLive: 'Deleted; the row stays until you restart DSH',
        failed: 'Delete failed: {message}',
      },
    }

    const STYLE_ID = 'dsh-session-delete-lite-style'

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dsh-sd-overlay { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); }
.dsh-sd-dialog { width: min(420px, calc(100vw - 48px)); border-radius: 12px; border: .5px solid var(--dsw-alias-border-l2, #333); background: var(--dsw-alias-bg-layer-2, #1f1f1f); color: var(--dsw-alias-label-primary, #eee); padding: 18px; box-shadow: 0 12px 40px rgba(0,0,0,.4); }
.dsh-sd-menu-item { appearance: none; -webkit-appearance: none; box-sizing: border-box; display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; margin: 0; padding: 6px 8px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-primary, #eee); font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; }
.dsh-sd-menu-item:hover:not(:disabled):not([aria-disabled="true"]) { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }
.dsh-sd-menu-item:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); outline: none; }
.dsh-sd-menu-item[aria-disabled="true"], .dsh-sd-menu-item:disabled { opacity: .4; cursor: not-allowed; }
.dsh-sd-menu-item-icon { display: inline-flex; flex: none; width: 14px; height: 14px; align-items: center; justify-content: center; color: inherit; }
.dsh-sd-menu-item-icon svg { width: 14px; height: 14px; }
.dsh-sd-menu-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sd-title { margin: 0 0 8px; font-size: 17px; font-weight: 600; }
.dsh-sd-desc { margin: 0 0 16px; font-size: 15px; line-height: 22px; color: var(--dsw-alias-label-secondary, #aaa); word-break: break-all; }
.dsh-sd-warn { margin: 0 0 14px; font-size: 15px; color: var(--dsw-alias-state-error-primary, #f85149); }
.dsh-sd-footer { display: flex; justify-content: flex-end; gap: 8px; }
.dsh-sd-btn { padding: 7px 16px; border-radius: 8px; border: .5px solid var(--dsw-alias-border-l2, #444); background: transparent; color: inherit; font: inherit; font-size: 15px; cursor: pointer; }
.dsh-sd-btn:disabled { opacity: .55; cursor: default; }
.dsh-sd-btn[data-danger="true"] { border-color: transparent; background: var(--dsw-alias-state-error-primary, #d1242f); color: #fff; }
.dsh-sd-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 10000; padding: 10px 18px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #1f1f1f); border: .5px solid var(--dsw-alias-border-l2, #333); color: var(--dsw-alias-label-primary, #eee); font-size: 15px; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
`
      document.head.appendChild(style)
    }

    /** Register the locale namespace; the keyed effect tears it down with the plugin. */
    function bindLocale(ctx) {
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en })
        } catch (error) {
          if (!String(error?.message).includes('already has locale')) throw error
        }
      }, 'dsh-session-delete-lite: locale')
      return ctx.locale.bind(NS)
    }

    /* The menu row files a request here; the shell overlay renders it. A row
     * unmounts with its menu, so the dialog cannot live inside the row. */
    let pending = null
    const listeners = new Set()

    function requestDelete(sessionId, displayTitle, workspaceId, wasOpen) {
      pending = { sessionId, displayTitle, workspaceId, wasOpen }
      for (const listener of listeners) listener()
    }

    function settle() {
      pending = null
      for (const listener of listeners) listener()
    }

    function usePending() {
      const [request, setRequest] = React.useState(pending)
      React.useEffect(() => {
        const listener = () => setRequest(pending)
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      return request
    }

    /** The shipped trash outline glyph, so the row matches its neighbours. */
    function TrashIcon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1, 'aria-hidden': true,
        style: { flex: 'none' },
      },
        h('path', { d: 'M1.28149 3.88831H14.7187' }),
        h('path', { d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833' }),
        h('path', { d: 'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831' }),
        h('path', { d: 'M6.44946 6.98926V11.1238' }),
        h('path', { d: 'M9.55054 6.98926V11.1238' }),
      )
    }

    /** Menu row: shown for every session; a running one greys out. */
    function DeleteMenuItem({ sessionId, displayTitle, useMenuOpenState, useSessionStatus, useWorkspaces, ctx, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      const status = useSessionStatus((snapshot) =>
        snapshot instanceof Map ? snapshot.get(sessionId) : snapshot?.[sessionId])
      const busy = status?.running === true ||
        (status?.pendingInteraction !== undefined && status?.pendingInteraction !== null)
      const workspaceId = typeof useWorkspaces === 'function'
        ? useWorkspaces((state) => {
          const items = Array.isArray(state?.items) ? state.items : []
          return items.find((workspace) => (workspace?.sessionIds ?? []).includes(sessionId))?.workspaceId
        })
        : undefined

      /** Whether the main view currently shows this session. */
      const isMainViewOpen = () => {
        try {
          const info = ctx?.get?.('sessions')?.retainInfo?.(sessionId)?.getSnapshot?.()
          return (info?.retainedBy?.mainView ?? 0) > 0
        } catch {
          return false
        }
      }

      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dsh-sd-menu-item',
        'aria-disabled': busy ? 'true' : undefined,
        title: busy ? t('menuBusy') : undefined,
        onClick: () => {
          if (busy) return
          setMenuOpen(false)
          requestDelete(sessionId, displayTitle, workspaceId, isMainViewOpen())
        },
      },
        h('span', { className: 'dsh-sd-menu-item-icon', 'aria-hidden': 'true' }, h(TrashIcon)),
        h('span', { className: 'dsh-sd-menu-item-label' }, busy ? t('menuBusy') : t('menu')),
      )
    }

    /** Overlay occupant: one confirm dialog per request, plus the result toast. */
    function DeleteOverlay({ t, ctx }) {
      const request = usePending()
      const [deleting, setDeleting] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [toast, setToast] = React.useState(null)

      React.useEffect(() => {
        if (toast === null) return
        const timer = window.setTimeout(() => setToast(null), 3200)
        return () => window.clearTimeout(timer)
      }, [toast])

      React.useEffect(() => {
        setError(null)
        setDeleting(false)
      }, [request?.sessionId])

      /** Start a fresh session in the same workspace when the open one was deleted. */
      const leaveDeletedConversation = (workspaceId) => {
        try {
          const uiWorkspace = ctx?.get?.('uiWorkspace')
          if (typeof uiWorkspace?.startSession !== 'function') return
          if (typeof workspaceId === 'string' && workspaceId !== '') uiWorkspace.startSession(workspaceId)
          else uiWorkspace.startSession()
        } catch {
          /* navigation is a convenience */
        }
      }

      const callDelete = async (sessionId) => {
        setDeleting(true)
        setError(null)
        const wasOpen = pending?.wasOpen === true
        const workspaceId = pending?.workspaceId
        try {
          const response = await fetch('/_dsh-session-delete/delete', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error ?? `HTTP ${response.status}`)
          }
          const stillLive = payload?.live === true
          setToast(stillLive ? t('doneLive') : t('done'))
          settle()
          // A cold delete leaves no unload event, so re-pull the list baseline.
          try {
            const refreshed = ctx?.get?.('sessions')?.refresh?.()
            if (refreshed && typeof refreshed.catch === 'function') refreshed.catch(() => {})
          } catch {
            /* refresh is a convenience */
          }
          if (wasOpen && !stillLive) window.setTimeout(() => leaveDeletedConversation(workspaceId), 0)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setDeleting(false)
        }
      }

      return h(React.Fragment, null,
        request !== null && h('div', { className: 'dsh-sd-overlay', role: 'presentation' },
          h('div', { className: 'dsh-sd-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('confirmTitle') },
            h('h2', { className: 'dsh-sd-title' }, t('confirmTitle')),
            h('p', { className: 'dsh-sd-desc' },
              t('confirmDesc', { title: request.displayTitle || request.sessionId })),
            error !== null && h('p', { className: 'dsh-sd-warn' }, t('failed', { message: error })),
            h('div', { className: 'dsh-sd-footer' },
              h('button', {
                type: 'button', className: 'dsh-sd-btn', disabled: deleting,
                onClick: () => { if (!deleting) settle() },
              }, t('cancel')),
              h('button', {
                type: 'button', className: 'dsh-sd-btn', 'data-danger': true, disabled: deleting,
                onClick: () => { void callDelete(request.sessionId) },
              }, deleting ? t('deleting') : t('confirmAction')),
            ),
          ),
        ),
        toast !== null && h('div', { className: 'dsh-sd-toast' }, toast),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyles()
        const t = bindLocale(ctx)

        ctx.effect(() => () => {
          document.getElementById(STYLE_ID)?.remove()
        })

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'dsh-session-delete-lite', order: 500 },
            (props) => h(DeleteMenuItem, { ...props, ctx, t }),
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-session-delete-lite' },
            () => h(DeleteOverlay, { t, ctx }),
          ),
        )
      },
    }
  },
})
