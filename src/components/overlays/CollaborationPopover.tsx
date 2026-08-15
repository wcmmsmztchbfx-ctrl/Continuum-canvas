import { useEffect, useRef, useState } from 'react'
import { Copy, Eye, Link2, LogOut, ShieldCheck, UserMinus, UsersRound, X } from 'lucide-react'

import type { CollaborationRole, PresenceState } from '../../contracts/collaboration'
import type { CollaborationControllerState } from '../../collaboration/controller'
import { activeCollaborationInvites, collaborationRoleLabel } from '../../collaboration/controller'
import type { ControlledOverlayProps } from './primitives'
import { DialogFrame } from './primitives'
import { usePopoverClose } from './usePopoverClose'

type AsyncAction = () => void | Promise<void>

export interface CollaborationPopoverProps extends ControlledOverlayProps {
  state: CollaborationControllerState
  onCloseRoom?: AsyncAction
  onCreateInvite?: (role: 'editor' | 'viewer') => void | Promise<void>
  onDismissRecoverySecret?: () => void
  onEnable?: (displayName: string) => void | Promise<void>
  onLeave?: AsyncAction
  onRemoveMember?: (memberId: string) => void | Promise<void>
  onRetryResume?: AsyncAction
  onRevokeInvite?: (inviteId: string) => void | Promise<void>
  onSetMemberRole?: (memberId: string, role: 'editor' | 'viewer') => void | Promise<void>
  onRecoverConflictRoom?: (secret: string, displayName: string) => void | Promise<void>
  onForceResetAndEnable?: (displayName: string) => void | Promise<void>
  onDismissConflict?: () => void
  followingMemberId?: string
  onFollowMember?: (memberId: string | undefined) => void
  presence?: readonly PresenceState[]
}

async function copy(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
  await navigator.clipboard.writeText(value)
}

const initials = (name: string) => name.trim().slice(0, 1).toUpperCase() || '协'

export function CollaborationPopover({
  onClose, onCloseRoom, onCreateInvite, onDismissRecoverySecret, onEnable,
  onLeave, onRemoveMember, onRetryResume, onRevokeInvite, onSetMemberRole,
  onRecoverConflictRoom, onForceResetAndEnable, onDismissConflict: _onDismissConflict,
  followingMemberId, onFollowMember, open, presence = [], state,
}: CollaborationPopoverProps) {
  const surfaceRef = useRef<HTMLElement | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [conflictSecret, setConflictSecret] = useState('')
  const [busy, setBusy] = useState(false)
  usePopoverClose(open, onClose, surfaceRef)
  useEffect(() => {
    if (!open || !surfaceRef.current) return
    const root = surfaceRef.current
    const focusable = () => [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    ;(root.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0])?.focus()
    return undefined
  }, [open, state.status])
  if (!open) return null

  const active = Boolean(state.room && state.session)
  const owner = state.session?.role === 'owner'
  const members = state.room?.members.filter((member) => !member.removed) ?? []
  const onlinePresence = new Map(
    presence.map((remote) => [remote.member.memberId, remote] as const),
  )
  const onlineMemberIds = new Set(onlinePresence.keys())
  if (state.session) onlineMemberIds.add(state.session.memberId)
  const onlineMembers = members.filter((member) => onlineMemberIds.has(member.id))
  const invites = activeCollaborationInvites(state.room?.invites ?? [])
  const run = async (action?: AsyncAction) => {
    if (!action || busy) return
    setBusy(true)
    try { await action() } finally { setBusy(false) }
  }

  return (
    <div className="overlay-backdrop" onClick={onClose} style={{ zIndex: 90 }}>
      <section
        aria-label="多人协作"
        className="overlay-surface integration-popover collaboration-popover"
        onClick={(event) => event.stopPropagation()}
        onKeyDownCapture={(event) => {
          if (event.key !== 'Tab') return
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
          if (items.length === 0) return
          const first = items[0]!, last = items.at(-1)!
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && (document.activeElement === last || (event.target instanceof HTMLElement && event.target.dataset.focusEnd === 'true'))) { event.preventDefault(); first.focus() }
        }}
        ref={surfaceRef}
        role="dialog"
      >
        <header className="integration-popover__header">
          <div>
            <UsersRound aria-hidden="true" />
            <strong>多人协作</strong>
            <span className="integration-status" data-tone={state.status === 'synced' ? 'online' : undefined}>
              {state.status === 'inactive' ? '未开启' : state.status === 'synced' ? '已同步' : state.status === 'offline' ? '离线编辑' : state.status === 'error' ? '连接失败' : '连接中'}
            </span>
          </div>
          <button aria-label="关闭多人协作" className="overlay-icon-button" onClick={onClose} type="button"><X aria-hidden="true" /></button>
        </header>

      {!active ? (
        <div className="collaboration-start">
          <ShieldCheck aria-hidden="true" />
          <div><strong>在当前画布开启实时协作</strong><small>开启前会先保存一份完整本地备份。</small></div>
          {state.conflictRoomId ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
              <input aria-label="协作昵称" data-autofocus maxLength={32} onChange={(event) => setDisplayName(event.target.value)} placeholder="你的昵称" value={displayName} />
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  aria-label="所有者恢复密钥"
                  maxLength={128}
                  onChange={(event) => setConflictSecret(event.target.value)}
                  placeholder="所有者恢复密钥（可选）"
                  style={{ flex: 1 }}
                  value={conflictSecret}
                />
                <button
                  className="overlay-text-button"
                  disabled={!displayName.trim() || !conflictSecret.trim() || busy}
                  onClick={() => run(() => onRecoverConflictRoom?.(conflictSecret, displayName))}
                  type="button"
                >
                  密钥接管
                </button>
              </div>
              <button
                className="overlay-text-button overlay-text-button--primary"
                data-focus-end="true"
                disabled={!displayName.trim() || busy}
                onClick={() => run(() => onForceResetAndEnable?.(displayName))}
                type="button"
              >
                重置并重新开启协作
              </button>
            </div>
          ) : state.authenticatedPendingResume ? (
            <button className="overlay-text-button overlay-text-button--primary" data-autofocus disabled={busy} onClick={() => run(onRetryResume)} type="button">重新连接协作</button>
          ) : <>
            <input aria-label="协作昵称" data-autofocus maxLength={32} onChange={(event) => setDisplayName(event.target.value)} placeholder="你的昵称" value={displayName} />
            <button className="overlay-text-button overlay-text-button--primary" data-focus-end="true" disabled={!displayName.trim() || busy || state.status === 'enabling'} onClick={() => run(() => onEnable?.(displayName))} type="button">开启协作</button>
          </>}
          {state.error ? <p className="collaboration-error" role="alert">{state.error}</p> : null}
        </div>
      ) : (
        <>
          <div className="collaboration-summary">
            <div aria-label="在线成员" className="collaboration-avatars">
              {onlineMembers.slice(0, 5).map((member) => (
                <span
                  data-online="true"
                  key={member.id}
                  style={{ backgroundColor: onlinePresence.get(member.id)?.member.color }}
                  title={member.displayName}
                >{initials(member.displayName)}</span>
              ))}
            </div>
            <span>{onlineMembers.length} 在线 / {members.length} 位成员</span>
          </div>

          {state.recoverySecret ? (
            <div className="collaboration-secret">
              <div><strong>所有者恢复密钥</strong><small>仅本次会话展示，请妥善保存。</small></div>
              <code>{state.recoverySecret}</code>
              <button aria-label="复制恢复密钥" onClick={() => void copy(state.recoverySecret!)} type="button"><Copy aria-hidden="true" /></button>
              <button onClick={onDismissRecoverySecret} type="button">已保存并隐藏</button>
            </div>
          ) : null}

          {owner ? (
            <div className="collaboration-link-actions">
              <button disabled={busy} onClick={() => run(() => onCreateInvite?.('editor'))} type="button"><Link2 aria-hidden="true" />创建编辑链接</button>
              <button disabled={busy} onClick={() => run(() => onCreateInvite?.('viewer'))} type="button"><Link2 aria-hidden="true" />创建查看链接</button>
            </div>
          ) : null}

          {owner && invites.length > 0 ? (
            <div aria-label="协作邀请" className="collaboration-invites">
              {invites.map((invite) => (
                <div key={invite.id}>
                  <span>{collaborationRoleLabel(invite.role)}</span>
                  <button aria-label={`复制${collaborationRoleLabel(invite.role)}链接`} disabled={!state.inviteLinks[invite.id]} onClick={() => void copy(state.inviteLinks[invite.id]!)} type="button"><Copy aria-hidden="true" /></button>
                  <button aria-label={`撤销${collaborationRoleLabel(invite.role)}链接`} onClick={() => run(() => onRevokeInvite?.(invite.id))} type="button">撤销</button>
                </div>
              ))}
            </div>
          ) : null}

          <div aria-label="协作成员" className="collaboration-members" role="list">
            {members.map((member) => (
              <div key={member.id} role="listitem">
                <span
                  className="collaboration-member-avatar"
                  data-online={onlineMemberIds.has(member.id) || undefined}
                  style={{ backgroundColor: onlinePresence.get(member.id)?.member.color }}
                >{initials(member.displayName)}</span>
                <div><strong>{member.displayName}{member.id === state.session?.memberId ? '（你）' : ''}</strong><small>{onlineMemberIds.has(member.id) ? '在线' : '离线'}</small></div>
                <div className="collaboration-member-actions">
                  {member.id !== state.session?.memberId && onlinePresence.get(member.id)?.viewport ? (
                    <button
                      aria-label={followingMemberId === member.id ? `取消跟随 ${member.displayName}` : `跟随 ${member.displayName}`}
                      data-active={followingMemberId === member.id || undefined}
                      onClick={() => onFollowMember?.(
                        followingMemberId === member.id ? undefined : member.id,
                      )}
                      title={followingMemberId === member.id ? '取消跟随' : '跟随视口'}
                      type="button"
                    ><Eye aria-hidden="true" /></button>
                  ) : null}
                  {owner && member.role !== 'owner' ? (
                    <div className="collaboration-member-controls">
                      <select aria-label={`设置 ${member.displayName} 的角色`} onChange={(event) => run(() => onSetMemberRole?.(member.id, event.target.value as Exclude<CollaborationRole, 'owner'>))} value={member.role}><option value="editor">可编辑</option><option value="viewer">可查看</option></select>
                      <button aria-label={`移除 ${member.displayName}`} onClick={() => run(() => onRemoveMember?.(member.id))} type="button"><UserMinus aria-hidden="true" /></button>
                    </div>
                  ) : <span className="collaboration-member-role">{collaborationRoleLabel(member.role)}</span>}
                </div>
              </div>
            ))}
          </div>

          <footer className="integration-popover__actions integration-popover__actions--split">
            {state.session?.role !== 'owner' ? <button className="overlay-text-button" data-focus-end="true" onClick={() => run(onLeave)} type="button"><LogOut aria-hidden="true" />离开协作</button> : <span />}
            {owner ? <button className="overlay-text-button overlay-text-button--danger" data-focus-end="true" onClick={() => run(onCloseRoom)} type="button">关闭协作</button> : null}
          </footer>
        </>
      )}
      </section>
    </div>
  )
}

export interface CollaborationNicknameDialogProps {
  defaultName?: string
  onCancel: () => void
  onSubmit: (displayName: string) => void | Promise<void>
  open: boolean
}

export function CollaborationNicknameDialog({ defaultName = '', onCancel, onSubmit, open }: CollaborationNicknameDialogProps) {
  const [name, setName] = useState(defaultName)
  const [busy, setBusy] = useState(false)
  return (
    <DialogFrame className="collaboration-nickname-dialog" closeLabel="取消加入协作" onClose={onCancel} open={open} title="加入协作画布">
      <div className="collaboration-nickname-dialog__body">
        <label>显示名称<input aria-label="协作显示名称" autoComplete="nickname" maxLength={32} onChange={(event) => setName(event.target.value)} value={name} /></label>
        <small>其他成员会在光标和选区旁看到这个名称。</small>
      </div>
      <footer className="overlay-dialog__footer"><button onClick={onCancel} type="button">取消</button><button disabled={!name.trim() || busy} onClick={async () => { setBusy(true); try { await onSubmit(name) } finally { setBusy(false) } }} type="button">加入画布</button></footer>
    </DialogFrame>
  )
}
