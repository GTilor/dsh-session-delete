/**
 * dsh-session-delete-lite 的客户端。
 *
 * 我往官方的 `sidebar.workspaces.session.menu.item` 列表里加一行——置顶、重命名、
 * 分叉、归档都住在那个列表里——这样每个会话的「…」菜单都会多出「删除会话」。
 *
 * 菜单行只负责发一个请求，确认框和结果提示放在 `shell.overlay`。原因是行会随
 * 菜单一起卸载，把弹窗塞在行里，菜单一关弹窗就没了。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-delete-lite',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const {
      Button, IconTrashOutlineRegular, IconWarningOutlineRegular,
      MenuItemButton, Modal, ReferenceIconRegular, Toast,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'dsh-session-delete-lite'
    const DICT = {
      zh: {
        menu: '删除会话',
        menuBusy: '会话运行中，无法删除',
        confirmTitle: '删除会话？',
        confirmDesc: '删除后，对话记录和本地数据都无法恢复。',
        confirmAction: '永久删除',
        retry: '重试删除',
        cancel: '取消',
        close: '关闭',
        deleting: '正在删除…',
        done: '会话已删除',
        failed: '会话删除失败',
        incomplete: '会话未完全删除',
        partial: '可能还有记录或文件，重试可继续清理。',
        connectionFailed: '暂时无法连接到 DeepSeek Harness，请稍后重试。',
        responseUnavailable: '暂时无法确认删除结果，请稍后重试。',
        confirmationTimedOut: '等待删除结果超时。清理可能仍在进行，请稍后重试确认。',
        sessionBusy: '会话仍有进行中的工作，结束后可以重试。',
        sessionChanging: '会话正在打开或删除，请稍后重试。',
        sessionHeld: '会话仍由其他组件持有，释放后可以重试。',
        writerHeld: '另一个进程正在使用这个会话，结束后可以重试。',
        unsupportedStorage: '此会话没有可单独删除的 JSONL 文件。SQLite 等共享存储暂不支持删除。',
      },
      en: {
        menu: 'Delete session',
        menuBusy: 'Cannot delete a busy session',
        confirmTitle: 'Delete session?',
        confirmDesc: 'Deleting this session permanently removes its conversation history and local data.',
        confirmAction: 'Delete permanently',
        retry: 'Retry deletion',
        cancel: 'Cancel',
        close: 'Close',
        deleting: 'Deleting…',
        done: 'Session deleted',
        failed: 'Couldn’t delete session',
        incomplete: 'Session deletion incomplete',
        partial: 'Some records or files may remain. Retry to finish the cleanup.',
        connectionFailed: 'Couldn’t reach DeepSeek Harness. Check your connection and try again.',
        responseUnavailable: 'Couldn’t confirm the deletion. Try again in a moment.',
        confirmationTimedOut: 'The deletion is taking longer than expected. It may still be in progress. Retry to check the result.',
        sessionBusy: 'This session still has work in progress. Try again when it finishes.',
        sessionChanging: 'This session is being opened or deleted. Try again in a moment.',
        sessionHeld: 'Another component is using this session. Try again when it releases the session.',
        writerHeld: 'Another process is using this session. Try again when it releases the session.',
        unsupportedStorage: 'This session has no separate JSONL file. Deletion from shared storage such as SQLite is currently unavailable.',
      },
    }

    const STYLE_ID = 'dsh-session-delete-lite-style'
    const ERROR_LABELS = new Map([
      ['unsupported-storage', 'unsupportedStorage'],
      ['session-busy', 'sessionBusy'],
      ['session-changing', 'sessionChanging'],
      ['session-held', 'sessionHeld'],
      ['writer-held', 'writerHeld'],
    ])

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dsh-sd-dialog {
  max-height: 100%;
}
.dsh-sd-content {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.dsh-sd-subject {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0;
  padding: 11px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  overflow-wrap: anywhere;
}
.dsh-sd-subject svg {
  flex: none;
  margin-top: 3px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-sd-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 12px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.dsh-sd-warning svg {
  flex: none;
  margin-top: 2px;
  color: var(--dsw-alias-state-warn-label);
}
.dsh-sd-confirm {
  --dsw-alias-button-primary-fill: var(--dsw-alias-state-business-tertiary);
  --dsw-alias-button-primary-hover: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-state-business-tertiary));
  --dsw-alias-label-primary-foreground: var(--dsw-alias-label-primary-bluish);
}
`
      document.head.appendChild(style)
    }

    /** 注册文案命名空间。用带 key 的 effect，插件卸载时字典跟着拆掉。 */
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

    /* 菜单行把请求丢在这里，由 shell overlay 渲染。行会随菜单卸载，
     * 所以弹窗不能住在行里面。 */
    let pending = null
    const listeners = new Set()

    function requestDelete(sessionId, displayTitle, workspaceId) {
      if (pending !== null) return
      pending = { sessionId, displayTitle, workspaceId }
      for (const listener of listeners) listener()
    }

    function settle(request) {
      if (pending !== request) return
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

    /** 菜单行：每个会话都有；正在干活的会话自动置灰。 */
    function DeleteMenuItem({ sessionId, displayTitle, useMenuOpenState, useSessionStatus, useWorkspaces, t }) {
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

      return h(MenuItemButton, {
        icon: h(IconTrashOutlineRegular, { size: 14 }),
        separatorBefore: true,
        disabled: busy,
        disabledReason: busy ? t('menuBusy') : undefined,
        onSelect: () => {
          setMenuOpen(false)
          requestDelete(sessionId, displayTitle, workspaceId)
        },
      }, busy ? t('menuBusy') : t('menu'))
    }

    function DeleteDialog({ request, t, ctx, showNotice }) {
      const subjectId = React.useId()
      const warningId = subjectId + '-warning'
      const [deleting, setDeleting] = React.useState(false)
      const inFlight = React.useRef(false)
      const [warning, setWarning] = React.useState(null)

      const close = () => {
        if (!inFlight.current) settle(request)
      }

      /** 删掉的正是当前会话时，在同工作区新开一个，别把人留在已删除的对话上。 */
      const leaveDeletedConversation = (sessionId, workspaceId) => {
        try {
          const info = ctx?.get?.('sessions')?.retainInfo?.(sessionId)?.getSnapshot?.()
          if (!(info?.retainedBy?.mainView > 0)) return
          const uiWorkspace = ctx?.get?.('uiWorkspace')
          if (typeof uiWorkspace?.startSession !== 'function') return
          if (typeof workspaceId === 'string' && workspaceId !== '') uiWorkspace.startSession(workspaceId)
          else uiWorkspace.startSession()
        } catch {
          /* 跳转只是顺手的事，失败了不影响删除结果 */
        }
      }

      const callDelete = async () => {
        if (inFlight.current) return
        inFlight.current = true
        const { sessionId, workspaceId } = request
        setDeleting(true)
        setWarning(null)
        showNotice(null)
        try {
          const signal = AbortSignal.timeout(30_000)
          const response = await fetch('/_dsh-session-delete/delete', {
            method: 'POST',
            credentials: 'same-origin',
            signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          }).catch(() => {
            throw new Error(t(signal.aborted ? 'confirmationTimedOut' : 'connectionFailed'))
          })
          const payload = await response.json().catch(() => {
            throw new Error(t(signal.aborted ? 'confirmationTimedOut' : 'responseUnavailable'))
          })
          const partial = response.status === 207 && payload?.partial === true
          if (!response.ok || (payload?.ok !== true && !partial)) {
            const reasonKey = ERROR_LABELS.get(payload?.code)
            if (reasonKey) throw new Error(t(reasonKey))
            throw new Error(typeof payload?.error === 'string' ? payload.error : t('responseUnavailable'))
          }
          // 冷会话删除不会产生卸载事件，所以主动重拉一次列表基线。
          try {
            const refreshed = ctx?.get?.('sessions')?.refresh?.()
            if (refreshed && typeof refreshed.catch === 'function') refreshed.catch(() => {})
          } catch {
            /* 刷新同样是顺手的事 */
          }
          if (partial) {
            setWarning(t('partial'))
            showNotice('incomplete')
            return
          }
          showNotice('done')
          settle(request)
          leaveDeletedConversation(sessionId, workspaceId)
        } catch (reason) {
          setWarning(reason instanceof Error ? reason.message : String(reason))
          showNotice('failed')
        } finally {
          inFlight.current = false
          setDeleting(false)
        }
      }

      const actionLabel = warning === null ? t('confirmAction') : t('retry')
      return h(Modal, {
        open: true, onClose: close, closeLabel: t('close'),
        title: t('confirmTitle'), description: t('confirmDesc'),
        className: 'dsh-sd-dialog', contentClassName: 'dsh-sd-content',
        footer: h(React.Fragment, null,
          h(Button, {
            variant: 'outline', disabled: deleting, onClick: close, 'data-modal-autofocus': true,
          }, t('cancel')),
          h(Button, {
            variant: 'primary', className: 'dsh-sd-confirm', disabled: deleting,
            'aria-busy': deleting, 'aria-describedby': warning === null ? subjectId : subjectId + ' ' + warningId,
            onClick: callDelete,
          }, deleting ? t('deleting') : actionLabel),
        ),
      },
        h('p', { className: 'dsh-sd-subject', id: subjectId },
          h(ReferenceIconRegular, { kind: 'session', size: 16 }),
          h('bdi', null, request.displayTitle || request.sessionId),
        ),
        warning !== null && h('p', { className: 'dsh-sd-warning', id: warningId },
          h(IconWarningOutlineRegular, { size: 16 }), h('span', null, warning),
        ),
      )
    }

    /** 每次结果都重新挂载原生提示，同一会话重复失败也能得到完整的提示时间。 */
    function DeleteOverlay({ t, ctx }) {
      const request = usePending()
      const [notice, setNotice] = React.useState({ textKey: null, sequence: 0 })
      const showNotice = textKey => setNotice(previous => ({ textKey, sequence: previous.sequence + 1 }))
      return h(React.Fragment, null,
        request !== null && h(DeleteDialog, { key: request.sessionId, request, t, ctx, showNotice }),
        notice.textKey !== null && h(Toast, {
          key: notice.sequence, text: t(notice.textKey),
          tone: notice.textKey === 'done' ? 'success' : undefined,
          icon: h(IconWarningOutlineRegular, { size: 16 }),
          onDone: () => setNotice(previous => previous.sequence === notice.sequence
            ? { ...previous, textKey: null }
            : previous),
        }),
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
            (props) => h(DeleteMenuItem, { ...props, t }),
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
