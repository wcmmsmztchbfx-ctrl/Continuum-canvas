import { useEffect, useRef, useState } from 'react'
import {
  Check,
  Copy,
  Eye,
  Globe,
  Link2,
  Loader2,
  LogOut,
  Network,
  Radio,
  UserMinus,
  UsersRound,
  Wifi,
  X,
} from 'lucide-react'

import type { CollaborationRole, PresenceState, TunnelStatus } from '../../contracts/collaboration'
import { getCollaboratorColor } from '../../collaboration/colors'
import type { CollaborationControllerState } from '../../collaboration/controller'
import { activeCollaborationInvites, collaborationRoleLabel } from '../../collaboration/controller'
import { getActiveCollaboration, type ActiveCollaboration } from '../../collaboration/activeCollaborationStore'
import { COLLABORATION_DISPLAY_NAME_STORAGE_KEY } from '../../collaboration/client'
import type { ControlledOverlayProps } from './primitives'
import { DialogFrame } from './primitives'
import { usePopoverClose } from './usePopoverClose'

type AsyncAction = () => void | Promise<void>

export interface CollaborationPopoverProps extends ControlledOverlayProps {
  currentCanvasId?: string
  state: CollaborationControllerState
  onCloseRoom?: AsyncAction
  onCreateInvite?: (role: 'editor' | 'viewer', customOrigin?: string) => void | Promise<void>
  onDismissRecoverySecret?: () => void
  onEnable?: (displayName: string) => void | Promise<void>
  onLeave?: AsyncAction
  onNavigateToActiveCollaboration?: (collab: ActiveCollaboration, closeExisting?: boolean) => void
  onRemoveMember?: (memberId: string) => void | Promise<void>
  onRetryResume?: AsyncAction
  onRevokeInvite?: (inviteId: string) => void | Promise<void>
  onSetMemberRole?: (memberId: string, role: 'editor' | 'viewer') => void | Promise<void>
  onRecoverConflictRoom?: (secret: string, displayName: string) => void | Promise<void>
  onForceResetAndEnable?: (displayName: string) => void | Promise<void>
  onDismissConflict?: () => void
  onGetTunnelStatus?: () => Promise<TunnelStatus | undefined>
  onStartTunnel?: (mode?: 'auto' | 'custom', customUrl?: string) => Promise<TunnelStatus | undefined>
  onStopTunnel?: () => Promise<TunnelStatus | undefined>
  onSetCustomTunnelUrl?: (customUrl?: string) => Promise<TunnelStatus | undefined>
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
  currentCanvasId,
  onClose,
  onCloseRoom,
  onCreateInvite,
  onDismissRecoverySecret,
  onEnable,
  onLeave,
  onNavigateToActiveCollaboration,
  onRemoveMember,
  onRetryResume,
  onRevokeInvite,
  onSetMemberRole,
  onRecoverConflictRoom,
  onForceResetAndEnable,
  onDismissConflict: _onDismissConflict,
  onGetTunnelStatus,
  onStartTunnel,
  onStopTunnel,
  onSetCustomTunnelUrl,
  followingMemberId,
  onFollowMember,
  open,
  presence = [],
  state,
}: CollaborationPopoverProps) {
  const surfaceRef = useRef<HTMLElement | null>(null)
  const [displayName, setDisplayName] = useState(() => {
    if (typeof window === 'undefined') return ''
    try {
      return localStorage.getItem(COLLABORATION_DISPLAY_NAME_STORAGE_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [conflictSecret, setConflictSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [modeTab, setModeTab] = useState<'lan' | 'remote'>('lan')
  const [activeLinkTab, setActiveLinkTab] = useState<'lan' | 'remote'>('lan')
  const [lanOrigin, setLanOrigin] = useState<string | null>(null)
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus>({
    enabled: false,
    mode: 'auto',
    status: 'stopped',
  })
  const [customUrlInput, setCustomUrlInput] = useState('')
  const [customModeActive, setCustomModeActive] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  usePopoverClose(open, onClose, surfaceRef)

  useEffect(() => {
    if (!open) return
    let mounted = true
    fetch('/api/network/lan-address')
      .then((res) => res.json())
      .then((data: { lanOrigin?: string }) => {
        if (mounted && data.lanOrigin) setLanOrigin(data.lanOrigin)
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let mounted = true
    let pollTimer: ReturnType<typeof setTimeout> | undefined

    const fetchTunnel = async () => {
      try {
        const res = await onGetTunnelStatus?.()
        if (res && mounted) {
          setTunnelStatus(res)
          if (res.customUrl) setCustomUrlInput(res.customUrl)
          if (res.status === 'running') {
            setActiveLinkTab('remote')
          }
          if (res.status === 'starting' || res.status === 'downloading') {
            pollTimer = setTimeout(fetchTunnel, 800)
          }
        }
      } catch {
        if (mounted && (tunnelStatus.status === 'starting' || tunnelStatus.status === 'downloading')) {
          pollTimer = setTimeout(fetchTunnel, 1200)
        }
      }
    }

    void fetchTunnel()
    return () => {
      mounted = false
      if (pollTimer) clearTimeout(pollTimer)
    }
  }, [open, onGetTunnelStatus, tunnelStatus.status])

  useEffect(() => {
    if (!open || !surfaceRef.current) return
    const root = surfaceRef.current
    const focusable = () => [
      ...root.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ]
    ;(root.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0])?.focus()
    return undefined
  }, [open, state.status, modeTab])

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
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  const handleCopy = async (key: string, text: string) => {
    await copy(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000)
  }

  const handleStartTunnel = async () => {
    setBusy(true)
    try {
      const res = await onStartTunnel?.(
        customModeActive ? 'custom' : 'auto',
        customModeActive ? customUrlInput : undefined,
      )
      if (res) setTunnelStatus(res)
    } finally {
      setBusy(false)
    }
  }

  const handleStopTunnel = async () => {
    setBusy(true)
    try {
      const res = await onStopTunnel?.()
      if (res) setTunnelStatus(res)
    } finally {
      setBusy(false)
    }
  }

  const handleSaveCustomUrl = async () => {
    if (!customUrlInput.trim()) return
    setBusy(true)
    try {
      const res = await onSetCustomTunnelUrl?.(customUrlInput.trim())
      if (res) setTunnelStatus(res)
    } finally {
      setBusy(false)
    }
  }

  const activeCollab = getActiveCollaboration()
  const isOtherCanvasActive = Boolean(
    !active &&
      activeCollab &&
      activeCollab.status === 'active' &&
      currentCanvasId &&
      activeCollab.canvasId !== currentCanvasId,
  )

  const effectiveOrigin =
    activeLinkTab === 'remote' && tunnelStatus.publicUrl
      ? tunnelStatus.publicUrl
      : activeLinkTab === 'lan' && lanOrigin
        ? lanOrigin
        : undefined

  return (
    <div className="overlay-backdrop" onClick={onClose} style={{ zIndex: 90 }}>
      <section
        aria-label="多人协作"
        className="overlay-surface integration-popover collaboration-popover"
        onClick={(event) => event.stopPropagation()}
        onKeyDownCapture={(event) => {
          if (event.key !== 'Tab') return
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
            ),
          ]
          if (items.length === 0) return
          const first = items[0]!
          const last = items.at(-1)!
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (
            !event.shiftKey &&
            (document.activeElement === last ||
              (event.target instanceof HTMLElement &&
                event.target.dataset.focusEnd === 'true'))
          ) {
            event.preventDefault()
            first.focus()
          }
        }}
        ref={surfaceRef}
        role="dialog"
      >
        <header className="integration-popover__header">
          <div>
            <UsersRound aria-hidden="true" />
            <strong>多人协作</strong>
            <span
              className="integration-status"
              data-tone={state.status === 'synced' ? 'online' : undefined}
            >
              {state.status === 'inactive'
                ? '未开启'
                : state.status === 'synced'
                  ? '已同步'
                  : state.status === 'offline'
                    ? '离线编辑'
                    : state.status === 'error'
                      ? '连接失败'
                      : '连接中'}
            </span>
          </div>
          <button
            aria-label="关闭多人协作"
            className="overlay-icon-button"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        {!active ? (
          <div className="collaboration-start">
            {isOtherCanvasActive && activeCollab ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  width: '100%',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="floating-collab-pulse" />
                  <strong style={{ fontSize: '13px', color: '#f3f4f6' }}>
                    已有正在进行的协作房间
                  </strong>
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: '12px',
                    color: '#9ca3af',
                    lineHeight: 1.5,
                  }}
                >
                  您当前在【
                  <strong style={{ color: '#f9fafb' }}>
                    {activeCollab.canvasName}
                  </strong>
                  】中已有正在进行的协作房间。系统暂不支持同时发起多个协作房间。
                </p>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    marginTop: '4px',
                  }}
                >
                  <button
                    className="overlay-text-button overlay-text-button--primary"
                    onClick={() =>
                      onNavigateToActiveCollaboration?.(activeCollab)
                    }
                    type="button"
                  >
                    回到【{activeCollab.canvasName}】协作
                  </button>
                  <button
                    className="overlay-text-button overlay-text-button--danger"
                    onClick={() =>
                      onNavigateToActiveCollaboration?.(activeCollab, true)
                    }
                    type="button"
                  >
                    前往关闭原协作
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Dual Mode Switcher Tabs */}
                <div className="collab-mode-tabs">
                  <button
                    type="button"
                    className={`collab-mode-tab ${modeTab === 'lan' ? 'is-active' : ''}`}
                    onClick={() => setModeTab('lan')}
                  >
                    <Network size={14} aria-hidden="true" />
                    <span>本地局域网</span>
                  </button>
                  <button
                    type="button"
                    className={`collab-mode-tab ${modeTab === 'remote' ? 'is-active' : ''}`}
                    onClick={() => setModeTab('remote')}
                  >
                    <Globe size={14} aria-hidden="true" />
                    <span>远程互联网</span>
                    {tunnelStatus.status === 'running' ? (
                      <span className="collab-tab-indicator is-online" />
                    ) : null}
                  </button>
                </div>

                {modeTab === 'lan' ? (
                  <div className="collab-mode-panel">
                    <div className="collab-mode-intro">
                      <Wifi size={20} className="collab-intro-icon" />
                      <div>
                        <strong>局域网极速直连</strong>
                        <small>同一 Wi-Fi 或办公室网络直连，零配置免公网。</small>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="collab-mode-panel">
                    <div className="collab-mode-intro">
                      <Globe size={20} className="collab-intro-icon" />
                      <div>
                        <strong>远程互联网安全穿透</strong>
                        <small>
                          Cloudflare 安全隧道加密加速，免公网 IP 异地联机。
                        </small>
                      </div>
                    </div>

                    <div className="collab-tunnel-card">
                      <div className="collab-tunnel-header">
                        <span className="collab-tunnel-title">
                          <Radio size={13} />
                          <span>远程通道状态</span>
                        </span>
                        <span
                          className={`collab-tunnel-badge is-${tunnelStatus.status}`}
                        >
                          {tunnelStatus.status === 'running'
                            ? '运行中'
                            : tunnelStatus.status === 'downloading'
                              ? `组件部署中 ${tunnelStatus.downloadProgress ?? 0}%`
                              : tunnelStatus.status === 'starting'
                                ? '正在连接...'
                                : tunnelStatus.status === 'error'
                                  ? '连接异常'
                                  : '未启动'}
                        </span>
                      </div>

                      {tunnelStatus.status === 'downloading' ? (
                        <div className="collab-tunnel-progress-wrap">
                          <div className="collab-tunnel-progress-bar">
                            <div
                              className="collab-tunnel-progress-fill"
                              style={{ width: `${tunnelStatus.downloadProgress ?? 0}%` }}
                            />
                          </div>
                          <span className="collab-tunnel-progress-hint">
                            正在自动下载内置穿透组件 ({tunnelStatus.downloadProgress ?? 0}%)...
                          </span>
                        </div>
                      ) : null}

                      {tunnelStatus.status === 'running' && tunnelStatus.publicUrl ? (
                        <div className="collab-tunnel-url-box">
                          <code>{tunnelStatus.publicUrl}</code>
                          <button
                            type="button"
                            className="overlay-icon-button"
                            onClick={() =>
                              handleCopy('tunnelUrl', tunnelStatus.publicUrl!)
                            }
                            title="复制远程公网地址"
                          >
                            {copiedKey === 'tunnelUrl' ? (
                              <Check size={14} color="#10b981" />
                            ) : (
                              <Copy size={14} />
                            )}
                          </button>
                        </div>
                      ) : null}

                      {tunnelStatus.status === 'error' && tunnelStatus.error ? (
                        <p className="collab-tunnel-error">
                          {tunnelStatus.error}
                        </p>
                      ) : null}

                      <div className="collab-tunnel-controls">
                        {tunnelStatus.status === 'running' ? (
                          <button
                            type="button"
                            className="collab-tunnel-action-btn is-stop"
                            disabled={busy}
                            onClick={handleStopTunnel}
                          >
                            停止远程通道
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="collab-tunnel-action-btn is-start"
                            disabled={busy || tunnelStatus.status === 'downloading' || tunnelStatus.status === 'starting'}
                            onClick={handleStartTunnel}
                          >
                            {busy || tunnelStatus.status === 'downloading' || tunnelStatus.status === 'starting' ? (
                              <Loader2 size={13} className="is-spinning" />
                            ) : (
                              <Globe size={13} />
                            )}
                            <span>
                              {tunnelStatus.status === 'downloading'
                                ? `正在下载组件 (${tunnelStatus.downloadProgress ?? 0}%)...`
                                : tunnelStatus.status === 'starting'
                                  ? '正在建立加密隧道...'
                                  : '开启远程通道 (Cloudflare)'}
                            </span>
                          </button>
                        )}
                        <button
                          type="button"
                          className="collab-custom-domain-toggle"
                          onClick={() => setCustomModeActive(!customModeActive)}
                        >
                          {customModeActive ? '收起自定义' : '自定义域名'}
                        </button>
                      </div>

                      {customModeActive ? (
                        <div className="collab-custom-url-form">
                          <input
                            type="text"
                            placeholder="例如 https://canvas.yourdomain.com"
                            value={customUrlInput}
                            onChange={(e) => setCustomUrlInput(e.target.value)}
                          />
                          <button
                            type="button"
                            className="overlay-text-button"
                            onClick={handleSaveCustomUrl}
                            disabled={!customUrlInput.trim() || busy}
                          >
                            保存
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}

                {state.conflictRoomId ? (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      width: '100%',
                    }}
                  >
                    <input
                      aria-label="协作昵称"
                      data-autofocus
                      maxLength={32}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="你的昵称"
                      value={displayName}
                    />
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <input
                        aria-label="所有者恢复密钥"
                        maxLength={128}
                        onChange={(event) =>
                          setConflictSecret(event.target.value)
                        }
                        placeholder="所有者恢复密钥（可选）"
                        style={{ flex: 1 }}
                        value={conflictSecret}
                      />
                      <button
                        className="overlay-text-button"
                        disabled={
                          !displayName.trim() ||
                          !conflictSecret.trim() ||
                          busy
                        }
                        onClick={() =>
                          run(() =>
                            onRecoverConflictRoom?.(
                              conflictSecret,
                              displayName,
                            ),
                          )
                        }
                        type="button"
                      >
                        密钥接管
                      </button>
                    </div>
                    <button
                      className="overlay-text-button overlay-text-button--primary"
                      data-focus-end="true"
                      disabled={!displayName.trim() || busy}
                      onClick={() =>
                        run(() => {
                          try {
                            localStorage.setItem(COLLABORATION_DISPLAY_NAME_STORAGE_KEY, displayName.trim())
                          } catch {}
                          return onForceResetAndEnable?.(displayName)
                        })
                      }
                      type="button"
                    >
                      重置并重新开启协作
                    </button>
                  </div>
                ) : state.authenticatedPendingResume ? (
                  <button
                    className="overlay-text-button overlay-text-button--primary"
                    data-autofocus
                    disabled={busy}
                    onClick={() => run(onRetryResume)}
                    type="button"
                  >
                    重新连接协作
                  </button>
                ) : (
                  <>
                    <input
                      aria-label="协作昵称"
                      data-autofocus
                      maxLength={32}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="你的协作昵称"
                      value={displayName}
                    />
                    <button
                      aria-label="开启协作"
                      className="overlay-text-button overlay-text-button--primary"
                      data-focus-end="true"
                      disabled={
                        !displayName.trim() ||
                        busy ||
                        state.status === 'enabling'
                      }
                      onClick={() =>
                        run(() => {
                          try {
                            localStorage.setItem(COLLABORATION_DISPLAY_NAME_STORAGE_KEY, displayName.trim())
                          } catch {}
                          return onEnable?.(displayName)
                        })
                      }
                      type="button"
                    >
                      {modeTab === 'lan' ? '开启协作 (本地局域网)' : '开启协作 (远程互联网)'}
                    </button>
                  </>
                )}
                {state.error ? (
                  <p className="collaboration-error" role="alert">
                    {state.error}
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="collaboration-summary">
              <div aria-label="在线成员" className="collaboration-avatars">
                {onlineMembers.slice(0, 5).map((member) => (
                  <span
                    data-online="true"
                    key={member.id}
                    style={{
                      backgroundColor:
                        onlinePresence.get(member.id)?.member.color ||
                        getCollaboratorColor(member.id),
                    }}
                    title={member.displayName}
                  >
                    {initials(member.displayName)}
                  </span>
                ))}
              </div>
              <span>
                {onlineMembers.length} 在线 / {members.length} 位成员
              </span>
            </div>

            {state.recoverySecret ? (
              <div className="collaboration-secret">
                <div>
                  <strong>所有者恢复密钥</strong>
                  <small>仅本次会话展示，请妥善保存。</small>
                </div>
                <code>{state.recoverySecret}</code>
                <button
                  aria-label="复制恢复密钥"
                  onClick={() => void handleCopy('recoverySecret', state.recoverySecret!)}
                  type="button"
                >
                  {copiedKey === 'recoverySecret' ? (
                    <Check size={14} color="#10b981" />
                  ) : (
                    <Copy aria-hidden="true" />
                  )}
                </button>
                <button onClick={onDismissRecoverySecret} type="button">
                  已保存并隐藏
                </button>
              </div>
            ) : null}

            {/* Active Room Link Type Switcher */}
            {owner ? (
              <div className="collab-active-network-panel">
                <div className="collab-active-tabs">
                  <button
                    type="button"
                    className={`collab-active-tab ${activeLinkTab === 'lan' ? 'is-active' : ''}`}
                    onClick={() => setActiveLinkTab('lan')}
                  >
                    <Network size={12} />
                    <span>局域网内网链接</span>
                  </button>
                  <button
                    type="button"
                    className={`collab-active-tab ${activeLinkTab === 'remote' ? 'is-active' : ''}`}
                    onClick={() => setActiveLinkTab('remote')}
                  >
                    <Globe size={12} />
                    <span>远程互联网链接</span>
                    {tunnelStatus.status === 'running' ? (
                      <span className="collab-tab-indicator is-online" />
                    ) : null}
                  </button>
                </div>

                {activeLinkTab === 'remote' && tunnelStatus.status !== 'running' ? (
                  <div className="collab-tunnel-prompt">
                    <small>远程通道未开启，点击一键启动生成公网链接</small>
                    <button
                      type="button"
                      className="collab-tunnel-action-btn is-start"
                      disabled={busy}
                      onClick={handleStartTunnel}
                    >
                      {busy ? (
                        <Loader2 size={12} className="is-spinning" />
                      ) : (
                        <Globe size={12} />
                      )}
                      <span>开启 Cloudflare 远程通道</span>
                    </button>
                  </div>
                ) : null}

                {activeLinkTab === 'lan' ? (
                  <div
                    className="collab-tunnel-prompt"
                    style={{
                      borderLeft: '2px solid #10b981',
                      background: 'rgba(16, 185, 129, 0.08)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span
                        className="collab-tab-indicator is-online"
                        style={{ display: 'inline-block', position: 'static' }}
                      />
                      <small style={{ color: '#34d399', fontWeight: 600 }}>
                        局域网直连模式（同一 Wi-Fi 可用）
                      </small>
                    </div>
                    <small style={{ color: '#9ca3af', marginTop: '2px' }}>
                      {lanOrigin
                        ? `局域网地址：${lanOrigin}`
                        : '未检测到物理局域网网卡，若跨设备推荐使用【远程互联网链接】'}
                    </small>
                  </div>
                ) : null}
              </div>
            ) : null}

            {owner ? (
              <div className="collaboration-link-actions">
                <button
                  aria-label="创建编辑链接"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await onCreateInvite?.('editor', effectiveOrigin)
                    })
                  }
                  type="button"
                >
                  <Link2 aria-hidden="true" />
                  创建编辑链接 {activeLinkTab === 'remote' ? '(外网)' : '(内网)'}
                </button>
                <button
                  aria-label="创建查看链接"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await onCreateInvite?.('viewer', effectiveOrigin)
                    })
                  }
                  type="button"
                >
                  <Link2 aria-hidden="true" />
                  创建查看链接 {activeLinkTab === 'remote' ? '(外网)' : '(内网)'}
                </button>
              </div>
            ) : null}

            {owner && invites.length > 0 ? (
              <div aria-label="协作邀请" className="collaboration-invites">
                {invites.map((invite) => {
                  const baseLink = state.inviteLinks[invite.id]
                  let resolvedUrl = baseLink ?? ''
                  if (baseLink && effectiveOrigin) {
                    try {
                      const parsed = new URL(baseLink)
                      const target = new URL(
                        parsed.pathname + parsed.search + parsed.hash,
                        effectiveOrigin,
                      )
                      resolvedUrl = target.toString()
                    } catch {}
                  }
                  return (
                    <div key={invite.id}>
                      <span>{collaborationRoleLabel(invite.role)}</span>
                      <button
                        aria-label={`复制${collaborationRoleLabel(invite.role)}链接`}
                        disabled={!resolvedUrl}
                        onClick={() => void handleCopy(invite.id, resolvedUrl)}
                        type="button"
                      >
                        {copiedKey === invite.id ? (
                          <Check size={14} color="#10b981" />
                        ) : (
                          <Copy aria-hidden="true" />
                        )}
                      </button>
                      <button
                        aria-label={`撤销${collaborationRoleLabel(invite.role)}链接`}
                        onClick={() => run(() => onRevokeInvite?.(invite.id))}
                        type="button"
                      >
                        撤销
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : null}

            <div
              aria-label="协作成员"
              className="collaboration-members"
              role="list"
            >
              {members.map((member) => (
                <div key={member.id} role="listitem">
                  <span
                    className="collaboration-member-avatar"
                    data-online={onlineMemberIds.has(member.id) || undefined}
                    style={{
                      backgroundColor:
                        onlinePresence.get(member.id)?.member.color ||
                        getCollaboratorColor(member.id),
                    }}
                  >
                    {initials(member.displayName)}
                  </span>
                  <div>
                    <strong>
                      {member.displayName}
                      {member.id === state.session?.memberId ? '（你）' : ''}
                    </strong>
                    <small>
                      {onlineMemberIds.has(member.id) ? '在线' : '离线'}
                    </small>
                  </div>
                  <div className="collaboration-member-actions">
                    {member.id !== state.session?.memberId &&
                    onlinePresence.get(member.id)?.viewport ? (
                      <button
                        aria-label={
                          followingMemberId === member.id
                            ? `取消跟随 ${member.displayName}`
                            : `跟随 ${member.displayName}`
                        }
                        data-active={
                          followingMemberId === member.id || undefined
                        }
                        onClick={() =>
                          onFollowMember?.(
                            followingMemberId === member.id
                              ? undefined
                              : member.id,
                          )
                        }
                        title={
                          followingMemberId === member.id
                            ? '取消跟随'
                            : '跟随视口'
                        }
                        type="button"
                      >
                        <Eye aria-hidden="true" />
                      </button>
                    ) : null}
                    {owner && member.role !== 'owner' ? (
                      <div className="collaboration-member-controls">
                        <select
                          aria-label={`设置 ${member.displayName} 的角色`}
                          onChange={(event) =>
                            run(() =>
                              onSetMemberRole?.(
                                member.id,
                                event.target.value as Exclude<
                                  CollaborationRole,
                                  'owner'
                                >,
                              ),
                            )
                          }
                          value={member.role}
                        >
                          <option value="editor">可编辑</option>
                          <option value="viewer">可查看</option>
                        </select>
                        <button
                          aria-label={`移除 ${member.displayName}`}
                          onClick={() => run(() => onRemoveMember?.(member.id))}
                          type="button"
                        >
                          <UserMinus aria-hidden="true" />
                        </button>
                      </div>
                    ) : (
                      <span className="collaboration-member-role">
                        {collaborationRoleLabel(member.role)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <footer className="integration-popover__actions integration-popover__actions--split">
              {state.session?.role !== 'owner' ? (
                <button
                  className="overlay-text-button"
                  data-focus-end="true"
                  onClick={() => run(onLeave)}
                  type="button"
                >
                  <LogOut aria-hidden="true" />
                  离开协作
                </button>
              ) : (
                <span />
              )}
              {owner ? (
                <button
                  className="overlay-text-button overlay-text-button--danger"
                  data-focus-end="true"
                  onClick={() => run(onCloseRoom)}
                  type="button"
                >
                  关闭协作
                </button>
              ) : null}
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

export function CollaborationNicknameDialog({
  defaultName = '',
  onCancel,
  onSubmit,
  open,
}: CollaborationNicknameDialogProps) {
  const [name, setName] = useState(defaultName)
  const [busy, setBusy] = useState(false)
  return (
    <DialogFrame
      className="collaboration-nickname-dialog"
      closeLabel="取消加入协作"
      onClose={onCancel}
      open={open}
      title="加入协作画布"
    >
      <div className="collaboration-nickname-dialog__body">
        <label>
          显示名称
          <input
            aria-label="协作显示名称"
            autoComplete="nickname"
            maxLength={32}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <small>其他成员会在光标和选区旁看到这个名称。</small>
      </div>
      <footer className="overlay-dialog__footer">
        <button onClick={onCancel} type="button">
          取消
        </button>
        <button
          disabled={!name.trim() || busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onSubmit(name)
            } finally {
              setBusy(false)
            }
          }}
          type="button"
        >
          加入画布
        </button>
      </footer>
    </DialogFrame>
  )
}
