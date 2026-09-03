import type { StoreApi } from 'zustand/vanilla'

import type {
  CollaborationInteraction,
  CollaborationInvite,
  CollaborationRole,
  CollaborationRoom,
  CollaborationSession,
  PresenceState,
  InteractionPreview,
  NodeLease,
  NodeLeaseKind,
} from '../contracts/collaboration'
import { CANVAS_SNAPSHOT_VERSION } from '../model/project'
import type { CanvasSnapshotV2, ProjectSnapshotV1 } from '../model/project'
import type { CanvasStoreState } from '../store/canvas-store'
import type { WorkspaceRepository } from '../workspace'
import {
  diffCanvasEntities,
  hasCanvasEntityChanges,
  type CanvasEntityChangeSet,
} from './entityChanges'
import {
  CollaborationClient,
  CollaborationClientError,
  getCollaborationDisplayName,
} from './client'
import {
  clearActiveCollaboration,
  getActiveCollaboration,
  setActiveCollaboration,
} from './activeCollaborationStore'
import {
  CanvasCollaborationSession,
  type CanvasCollaborationStatus,
} from './session'

export type CollaborationLifecycleState =
  | 'inactive'
  | 'enabling'
  | 'connecting'
  | 'synced'
  | 'offline'
  | 'error'

export interface CollaborationControllerState {
  status: CollaborationLifecycleState
  room?: CollaborationRoom
  session?: CollaborationSession
  pendingInvite?: { roomId: string; suggestedName?: string }
  conflictRoomId?: string
  recoverySecret?: string
  authenticatedPendingResume?: string
  inviteLinks: Record<string, string>
  error?: string
}

export interface CollaborationLocation {
  hash: string
  href: string
  pathname: string
  search: string
}

export interface CollaborationHistory {
  replaceState(state: unknown, unused: string, url?: string | URL | null): void
}

export interface CollaborationSessionHandle {
  readonly status: CanvasCollaborationStatus
  readonly serverSession: CollaborationSession
  subscribeStatus(listener: (status: CanvasCollaborationStatus) => void): () => void
  subscribeSnapshot(listener: (snapshot: CanvasSnapshotV2) => void): () => void
  subscribeEntityChanges(listener: (changes: CanvasEntityChangeSet) => void): () => void
  subscribePresence(listener: (presence: readonly PresenceState[]) => void): () => void
  getRemotePresence(): PresenceState[]
  setCursor(cursor: { x: number; y: number } | null): void
  setSelection(nodeIds: readonly string[]): void
  setViewport(viewport: { x: number; y: number; zoom: number }): void
  setInteraction(interaction: CollaborationInteraction): void
  clearInteraction(): void
  setInteractionPreview(preview: InteractionPreview): void
  clearPreview(): void
  acquireLease(nodeIds: readonly string[], kind: NodeLeaseKind): NodeLease | undefined
  releaseLease(): void
  getLease(nodeId: string): NodeLease | undefined
  subscribeLeaseLost(listener: (lease: NodeLease) => void): () => void
  getSnapshot(): CanvasSnapshotV2 | undefined
  applySnapshot(snapshot: CanvasSnapshotV2, options?: { includeViewport?: boolean }): void
  applySnapshotChange(previous: CanvasSnapshotV2, next: CanvasSnapshotV2): void
  applyEntityChanges(changes: CanvasEntityChangeSet): void
  undo(): void
  redo(): void
  canUndo(): boolean
  canRedo(): boolean
  destroy(): Promise<void>
}

export interface CollaborationClientHandle {
  enableRoom: CollaborationClient['enableRoom']
  resumeRoom: CollaborationClient['resumeRoom']
  getRoom: CollaborationClient['getRoom']
  createInvite: CollaborationClient['createInvite']
  revokeInvite: CollaborationClient['revokeInvite']
  joinRoom: CollaborationClient['joinRoom']
  joinFromInviteFragment: CollaborationClient['joinFromInviteFragment']
  setMemberRole: CollaborationClient['setMemberRole']
  removeMember: CollaborationClient['removeMember']
  leaveRoom: CollaborationClient['leaveRoom']
  closeRoom: CollaborationClient['closeRoom']
  getTunnelStatus?: CollaborationClient['getTunnelStatus']
  startTunnel?: CollaborationClient['startTunnel']
  stopTunnel?: CollaborationClient['stopTunnel']
  setCustomTunnelUrl?: CollaborationClient['setCustomTunnelUrl']
}

export interface CollaborationControllerOptions {
  canvasId: string
  projectId: string
  store: StoreApi<CanvasStoreState>
  repository: WorkspaceRepository
  client?: CollaborationClientHandle
  createSession?: (input: {
    roomId: string
    serverSession: CollaborationSession
  }) => Promise<CollaborationSessionHandle>
  location?: CollaborationLocation
  history?: CollaborationHistory
  storage?: Storage
  leaseSettleMs?: number
  shareOrigin?: string
  refreshIntervalMs?: number
  leaseSettleTimers?: {
    setTimeout(callback: () => void, delay: number): unknown
    clearTimeout(timer: unknown): void
  }
}

const initialState = (): CollaborationControllerState => ({
  status: 'inactive',
  inviteLinks: {},
})

function collaborationLocation(): CollaborationLocation {
  return {
    hash: globalThis.location.hash,
    href: globalThis.location.href,
    pathname: globalThis.location.pathname,
    search: globalThis.location.search,
  }
}

function collaborationHistory(): CollaborationHistory {
  return globalThis.history
}

function roomIdFromLocation(location: Pick<CollaborationLocation, 'hash' | 'search'>): string | undefined {
  const search = new URLSearchParams(location.search)
  const hash = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash)
  return search.get('collabRoom') ?? hash.get('collabRoom') ?? undefined
}

function hasInvite(location: Pick<CollaborationLocation, 'hash'>): boolean {
  const hash = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash)
  return Boolean(hash.get('invite'))
}

function materialSnapshot(snapshot: Pick<CanvasSnapshotV2, 'name' | 'nodes' | 'edges'>): string {
  return JSON.stringify({ name: snapshot.name, nodes: snapshot.nodes, edges: snapshot.edges })
}

function projectSnapshot(snapshot: CanvasSnapshotV2, viewport = snapshot.viewport): ProjectSnapshotV1 {
  return {
    version: 1,
    projectId: snapshot.projectId,
    name: snapshot.name,
    viewport,
    nodes: snapshot.nodes,
    edges: snapshot.edges,
  }
}

export class CanvasCollaborationController {
  private readonly options: CollaborationControllerOptions
  private readonly client: CollaborationClientHandle
  private readonly createSession: NonNullable<CollaborationControllerOptions['createSession']>
  private readonly location: CollaborationLocation
  private readonly history: CollaborationHistory
  private readonly listeners = new Set<(state: CollaborationControllerState) => void>()
  private state: CollaborationControllerState = initialState()
  private canvasSession?: CollaborationSessionHandle
  private unsubscribeStore?: () => void
  private unsubscribeSessionStatus?: () => void
  private unsubscribeSessionEntityChanges?: () => void
  private unsubscribeSessionPresence?: () => void
  private readonly presenceListeners = new Set<(
    presence: readonly PresenceState[],
  ) => void>()
  private presence: PresenceState[] = []
  private readonly leaseLostListeners = new Set<(lease: NodeLease) => void>()
  private unsubscribeLeaseLost?: () => void
  private applyingRemote = false
  private disposed = false
  private operationEpoch = 0
  private operation?: { kind: string; abort: AbortController; promise: Promise<void> }
  private refreshAbort?: AbortController
  private refreshPromise?: Promise<void>
  private refreshEpoch = 0
  private refreshTimer?: ReturnType<typeof setInterval>
  private connectionBaseline?: CanvasSnapshotV2
  private readonly leaseSettleMs: number
  private readonly leaseSettleTimers: NonNullable<CollaborationControllerOptions['leaseSettleTimers']>
  private readonly pendingLeaseSettles = new Set<() => void>()

  constructor(options: CollaborationControllerOptions) {
    this.options = options
    this.client = options.client ?? new CollaborationClient()
    this.createSession = options.createSession ?? ((input) =>
      CanvasCollaborationSession.create(input))
    this.location = options.location ?? collaborationLocation()
    this.history = options.history ?? collaborationHistory()
    this.leaseSettleMs = Math.min(200, Math.max(0, options.leaseSettleMs ?? 120))
    this.leaseSettleTimers = options.leaseSettleTimers ?? {
      setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    }
  }

  getState(): CollaborationControllerState {
    return this.state
  }

  subscribe(listener: (state: CollaborationControllerState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribePresence(listener: (presence: readonly PresenceState[]) => void): () => void {
    this.presenceListeners.add(listener)
    return () => this.presenceListeners.delete(listener)
  }

  getPresence(): PresenceState[] {
    return structuredClone(this.presence)
  }

  setCursor(cursor: { x: number; y: number } | null): void {
    this.canvasSession?.setCursor(cursor)
  }

  setSelection(nodeIds: readonly string[]): void {
    this.canvasSession?.setSelection(nodeIds)
  }

  setViewport(viewport: { x: number; y: number; zoom: number }): void {
    this.canvasSession?.setViewport(viewport)
  }

  setInteraction(interaction: CollaborationInteraction): void {
    this.canvasSession?.setInteraction(interaction)
  }

  clearInteraction(): void {
    this.canvasSession?.clearInteraction()
  }

  setInteractionPreview(preview: InteractionPreview): void {
    this.canvasSession?.setInteractionPreview(preview)
  }

  clearPreview(): void { this.canvasSession?.clearPreview() }

  acquireLease(nodeIds: readonly string[], kind: NodeLeaseKind): NodeLease | undefined {
    return this.canvasSession?.acquireLease(nodeIds, kind)
  }

  releaseLease(): void { this.canvasSession?.releaseLease() }

  getLease(nodeId: string): NodeLease | undefined {
    return this.canvasSession?.getLease(nodeId)
  }

  subscribeLeaseLost(listener: (lease: NodeLease) => void): () => void {
    this.leaseLostListeners.add(listener)
    return () => this.leaseLostListeners.delete(listener)
  }

  async withNodeLease<T>(
    nodeIds: readonly string[],
    kind: NodeLeaseKind,
    operation: () => T | Promise<T>,
  ): Promise<Awaited<T> | undefined> {
    if (!this.canvasSession) return await operation()
    const lease = this.acquireLease(nodeIds, kind)
    if (!lease) return undefined
    try {
      if (lease.confirmed && !await this.settleLease(lease)) {
        return undefined
      }
      return await operation()
    } finally {
      this.clearPreview()
      this.clearInteraction()
      this.releaseLease()
    }
  }

  private settleLease(lease: NodeLease): Promise<boolean> {
    if (this.leaseSettleMs === 0) {
      return Promise.resolve(this.ownsEveryLeaseNode(lease))
    }
    return new Promise((resolve) => {
      let settled = false
      let timer: unknown
      let unsubscribe: () => void = () => undefined
      const cancel = () => finish(false)
      const finish = (result: boolean) => {
        if (settled) return
        settled = true
        if (timer !== undefined) this.leaseSettleTimers.clearTimeout(timer)
        unsubscribe()
        this.pendingLeaseSettles.delete(cancel)
        resolve(result)
      }
      unsubscribe = this.subscribeLeaseLost((lost) => {
        if (lost.leaseId === lease.leaseId) finish(false)
      })
      this.pendingLeaseSettles.add(cancel)
      timer = this.leaseSettleTimers.setTimeout(
        () => finish(this.ownsEveryLeaseNode(lease)),
        this.leaseSettleMs,
      )
    })
  }

  private ownsEveryLeaseNode(lease: NodeLease): boolean {
    return lease.nodeIds.every((nodeId) =>
      this.getLease(nodeId)?.leaseId === lease.leaseId,
    )
  }

  private cancelPendingLeaseSettles(): void {
    for (const cancel of [...this.pendingLeaseSettles]) cancel()
  }

  isLocalAutosaveSuppressed(): boolean {
    return this.canvasSession !== undefined
  }

  initializeFromLocation(): Promise<void> {
    const roomId = roomIdFromLocation(this.location)
    if (!roomId || this.disposed || this.canvasSession) return Promise.resolve()
    if (hasInvite(this.location)) {
      let suggestedName: string | undefined
      try {
        const storage = this.options.storage ?? globalThis.localStorage
        suggestedName = getCollaborationDisplayName(storage)
      } catch {
        suggestedName = undefined
      }
      this.patch({ pendingInvite: { roomId, suggestedName } })
      return Promise.resolve()
    }
    return this.runOperation('resume', async (epoch, signal) => {
      this.patch({ status: 'connecting', error: undefined })
      const baseline = this.connectionBaseline ?? this.currentSnapshot()
      this.connectionBaseline = baseline
      const context = await this.client.resumeRoom(roomId, { signal })
      this.assertCurrent(epoch)
      this.assertScope(context.session)
      await this.attach(context.room, context.session, epoch, baseline)
    })
  }

  enable(displayName: string): Promise<void> {
    if (this.canvasSession) return Promise.resolve()
    return this.runOperation('enable', async (epoch, signal) => {
      this.patch({ status: 'enabling', error: undefined, conflictRoomId: undefined })
      const snapshot = this.currentSnapshot()
      this.connectionBaseline = snapshot
      await this.options.repository.saveCanvas(snapshot)
      this.assertCurrent(epoch)
      let enabled
      try {
        enabled = await this.client.enableRoom({ snapshot, displayName }, { signal })
      } catch (error) {
        if (
          error instanceof CollaborationClientError &&
          error.code === 'collaboration_conflict' &&
          error.existingRoomId
        ) {
          try {
            const context = await this.client.resumeRoom(error.existingRoomId, { signal })
            this.assertCurrent(epoch)
            this.assertScope(context.session)
            this.replaceRoomInUrl(error.existingRoomId)
            this.patch({ conflictRoomId: undefined })
            await this.attach(context.room, context.session, epoch, snapshot)
            return
          } catch {
            this.assertCurrent(epoch)
            this.patch({
              status: 'inactive',
              conflictRoomId: error.existingRoomId,
              error: '该画布存在未关闭的历史协作房间。可输入所有者恢复密钥重新接管，或直接重置协作。',
            })
            return
          }
        }
        throw error
      }
      if (!this.isCurrent(epoch)) {
        void this.client.closeRoom(enabled.room.roomId).catch(() => undefined)
        return
      }
      this.assertScope(enabled.session)
      this.replaceRoomInUrl(enabled.room.roomId)
      this.patch({ recoverySecret: enabled.recoverySecret, conflictRoomId: undefined })
      await this.attach(enabled.room, enabled.session, epoch, snapshot)
    })
  }

  recoverConflictRoom(secret: string, displayName: string): Promise<void> {
    const roomId = this.state.conflictRoomId
    if (!roomId) return Promise.resolve()
    return this.runOperation('recover', async (epoch, signal) => {
      this.patch({ status: 'connecting', error: undefined })
      const baseline = this.connectionBaseline ?? this.currentSnapshot()
      this.connectionBaseline = baseline
      const session = await this.client.joinRoom({
        roomId,
        secret: secret.trim(),
        displayName,
      }, { signal })
      this.assertCurrent(epoch)
      this.assertScope(session)
      const room = await this.client.getRoom(roomId, { signal })
      this.assertCurrent(epoch)
      this.replaceRoomInUrl(roomId)
      this.patch({ conflictRoomId: undefined })
      await this.attach(room, session, epoch, baseline)
    })
  }

  async forceResetAndEnable(displayName: string): Promise<void> {
    const roomId = this.state.conflictRoomId
    if (roomId) {
      await this.client.closeRoom(roomId, { force: true }).catch(() => undefined)
      this.patch({ conflictRoomId: undefined, error: undefined })
    }
    return this.enable(displayName)
  }

  dismissConflict(): void {
    if (this.state.conflictRoomId) {
      this.patch({ conflictRoomId: undefined, error: undefined })
    }
  }

  joinPendingInvite(displayName: string): Promise<void> {
    const pending = this.state.pendingInvite
    if (!pending) return Promise.resolve()
    return this.runOperation('join', async (epoch, signal) => {
      this.patch({ status: 'connecting', error: undefined })
      const baseline = this.connectionBaseline ?? this.currentSnapshot()
      this.connectionBaseline = baseline
      const session = await this.client.joinFromInviteFragment({
        roomId: pending.roomId,
        displayName,
        location: this.location,
        history: this.history,
        signal,
      })
      this.assertCurrent(epoch)
      this.assertScope(session)
      this.location.hash = ''
      this.patch({ pendingInvite: undefined, authenticatedPendingResume: pending.roomId })
      try {
        const room = await this.client.getRoom(pending.roomId, { signal })
        this.assertCurrent(epoch)
        await this.attach(room, session, epoch, baseline)
        this.patch({ authenticatedPendingResume: undefined })
      } catch (error) {
        if (!this.isCurrent(epoch)) return
        this.patch({ status: 'offline', error: error instanceof Error ? error.message : 'Collaboration resume pending' })
      }
    })
  }

  retryAuthenticatedResume(): Promise<void> {
    const roomId = this.state.authenticatedPendingResume
    if (!roomId) return Promise.resolve()
    return this.runOperation('authenticated-resume', async (epoch, signal) => {
      this.patch({ status: 'connecting', error: undefined })
      const baseline = this.connectionBaseline ?? this.currentSnapshot()
      this.connectionBaseline = baseline
      const context = await this.client.resumeRoom(roomId, { signal })
      this.assertCurrent(epoch)
      this.assertScope(context.session)
      await this.attach(context.room, context.session, epoch, baseline)
      this.patch({ authenticatedPendingResume: undefined })
    })
  }

  dismissRecoverySecret(): void {
    if (this.state.recoverySecret) this.patch({ recoverySecret: undefined })
  }

  dismissPendingInvite(): void {
    if (this.state.pendingInvite) this.patch({ pendingInvite: undefined, status: 'inactive', error: undefined })
  }

  async createInvite(role: 'editor' | 'viewer', customOrigin?: string): Promise<string> {
    const room = this.requireOwnerRoom()
    const created = await this.client.createInvite(room.roomId, role)
    const link = this.inviteUrl(room.roomId, created.secret, customOrigin)
    this.patch({
      room: { ...room, invites: [...room.invites, created.invite] },
      inviteLinks: { ...this.state.inviteLinks, [created.invite.id]: link },
    })
    return link
  }

  async revokeInvite(inviteId: string): Promise<void> {
    const room = this.requireOwnerRoom()
    await this.client.revokeInvite(room.roomId, inviteId)
    const inviteLinks = { ...this.state.inviteLinks }
    delete inviteLinks[inviteId]
    this.patch({
      inviteLinks,
      room: {
        ...room,
        invites: room.invites.map((invite) =>
          invite.id === inviteId ? { ...invite, revoked: true } : invite),
      },
    })
    await this.refreshRoom()
  }

  async setMemberRole(memberId: string, role: 'editor' | 'viewer'): Promise<void> {
    const room = this.requireOwnerRoom()
    await this.client.setMemberRole(room.roomId, memberId, role)
    this.patch({
      room: {
        ...room,
        members: room.members.map((member) =>
          member.id === memberId ? { ...member, role } : member),
      },
    })
    await this.refreshRoom()
  }

  async removeMember(memberId: string): Promise<void> {
    const room = this.requireOwnerRoom()
    await this.client.removeMember(room.roomId, memberId)
    this.patch({
      room: {
        ...room,
        members: room.members.map((member) =>
          member.id === memberId ? { ...member, removed: true } : member),
      },
    })
    await this.refreshRoom()
  }

  refreshRoom(): Promise<void> {
    const roomId = this.state.room?.roomId ?? this.state.authenticatedPendingResume
    if (!roomId || this.disposed) return Promise.resolve()
    if (this.refreshPromise) return this.refreshPromise
    const abort = new AbortController()
    const refreshEpoch = ++this.refreshEpoch
    const operationEpoch = this.operationEpoch
    this.refreshAbort = abort
    const promise = this.client.resumeRoom(roomId, { signal: abort.signal })
      .then(async (context) => {
        if (!this.isRefreshCurrent(roomId, refreshEpoch, operationEpoch, abort)) return
        this.assertScope(context.session)
        const previous = this.state.session
        const roleChanged = previous && (
          previous.memberId !== context.session.memberId || previous.role !== context.session.role
        )
        if (!roleChanged) {
          this.patch({ room: context.room, session: context.session })
          return
        }
        this.patch({ room: context.room, session: context.session, status: 'connecting', error: undefined })
        await this.disposeSession()
        if (!this.isRefreshCurrent(roomId, refreshEpoch, operationEpoch, abort)) return
        await this.attach(context.room, context.session)
      })
      .finally(() => {
        if (this.refreshPromise === promise) this.refreshPromise = undefined
        if (this.refreshAbort === abort) this.refreshAbort = undefined
      })
    this.refreshPromise = promise
    return promise
  }

  undo(): void {
    this.canvasSession?.undo()
  }

  redo(): void {
    this.canvasSession?.redo()
  }

  canUndo(): boolean {
    return this.canvasSession?.canUndo() ?? false
  }

  canRedo(): boolean {
    return this.canvasSession?.canRedo() ?? false
  }

  async leave(): Promise<void> {
    const room = this.state.room
    if (!room || !this.canvasSession) return
    this.invalidateLifecycle()
    await this.persistLatestSharedSnapshot()
    await this.client.leaveRoom(room.roomId)
    await this.detach()
    this.clearRoomFromUrl()
    clearActiveCollaboration()
  }

  async closeRoom(): Promise<void> {
    const room = this.requireOwnerRoom()
    this.invalidateLifecycle()
    await this.persistLatestSharedSnapshot()
    await this.client.closeRoom(room.roomId)
    await this.detach()
    this.clearRoomFromUrl()
    clearActiveCollaboration()
  }

  async destroy(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.cancelPendingLeaseSettles()
    await Promise.resolve()
    this.invalidateLifecycle()
    await this.detach(false)
    this.listeners.clear()
  }

  private async attach(
    room: CollaborationRoom,
    serverSession: CollaborationSession,
    epoch?: number,
    baseline?: CanvasSnapshotV2,
  ): Promise<void> {
    if (this.disposed || (epoch !== undefined && !this.isCurrent(epoch))) return
    const session = await this.createSession({ roomId: room.roomId, serverSession })
    if (this.disposed || (epoch !== undefined && !this.isCurrent(epoch))) {
      await session.destroy()
      return
    }
    this.canvasSession = session
    this.patch({
      room,
      session: serverSession,
      status: session.status.state,
      error: session.status.error,
    })
    if (serverSession.role === 'owner') {
      setActiveCollaboration({
        roomId: room.roomId,
        projectId: room.projectId ?? this.options.projectId,
        canvasId: room.canvasId ?? this.options.canvasId,
        canvasName: baseline?.name ?? this.currentSnapshot().name ?? '协作画布',
        role: 'owner',
        status: 'active',
        createdAt: room.createdAt ?? new Date().toISOString(),
        memberCount: session.getRemotePresence().length + 1,
      })
    }
    let reconciled = false
    const reconcile = () => {
      if (reconciled || this.canvasSession !== session || session.status.state !== 'synced') return
      reconciled = true
      try {
        if (baseline && serverSession.role !== 'viewer') {
          const current = this.currentSnapshot()
          if (materialSnapshot(baseline) !== materialSnapshot(current)) {
            session.applySnapshotChange(baseline, current)
          }
        }
        if (this.connectionBaseline === baseline) this.connectionBaseline = undefined
        this.installDocumentBridge(session, serverSession)
      } catch (error) {
        this.patch({
          status: 'error',
          error: error instanceof Error ? error.message : 'Collaboration reconciliation failed',
        })
      }
    }
    this.unsubscribeSessionStatus = session.subscribeStatus((status) => {
      this.patch({ status: status.state, error: status.error })
      const nextPresence = status.state === 'synced'
        ? session.getRemotePresence()
        : []
      if (JSON.stringify(nextPresence) !== JSON.stringify(this.presence)) {
        this.presence = structuredClone(nextPresence)
        this.publishPresence()
      }
      reconcile()
    })
    this.presence = session.getRemotePresence()
    this.unsubscribeSessionPresence = session.subscribePresence((presence) => {
      if (this.canvasSession !== session) return
      this.presence = structuredClone([...presence])
      this.publishPresence()
      if (serverSession.role === 'owner') {
        const active = getActiveCollaboration()
        if (active && active.roomId === room.roomId) {
          setActiveCollaboration({
            ...active,
            memberCount: presence.length + 1,
          })
        }
      }
    })
    this.unsubscribeLeaseLost = session.subscribeLeaseLost((lease) => {
      for (const listener of this.leaseLostListeners) {
        try { listener(structuredClone(lease)) } catch { /* isolate lease observers */ }
      }
    })
    this.startRefreshLoop()
    reconcile()
  }

  private installDocumentBridge(
    session: CollaborationSessionHandle,
    serverSession: CollaborationSession,
  ): void {
    if (this.unsubscribeSessionEntityChanges || this.unsubscribeStore || this.canvasSession !== session) return
    this.unsubscribeSessionEntityChanges = session.subscribeEntityChanges((changes) => {
      if (changes.origin !== 'remote') return
      this.applyingRemote = true
      try {
        this.options.store.getState().applyEntityChanges(changes)
      } finally {
        this.applyingRemote = false
      }
    })
    this.unsubscribeStore = this.options.store.subscribe((state, previous) => {
      if (this.applyingRemote || state.snapshot === previous.snapshot) return
      const current = this.snapshotFromProject(state.snapshot)
      const previousSnapshot = this.snapshotFromProject(previous.snapshot)
      const changes = diffCanvasEntities(previousSnapshot, current, 'local')
      if (!hasCanvasEntityChanges(changes)) return
      const shared = session.getSnapshot()
      if (serverSession.role === 'viewer') {
        if (shared) this.applyRemoteSnapshot(shared)
        return
      }
      session.applyEntityChanges(changes)
    })
    const shared = session.getSnapshot()
    if (shared) this.applyRemoteSnapshot(shared)
  }

  private startRefreshLoop(): void {
    if (this.refreshTimer || this.disposed) return
    const interval = this.options.refreshIntervalMs ?? 3_000
    this.refreshTimer = setInterval(() => {
      void this.refreshRoom().catch(() => undefined)
    }, interval)
    ;(this.refreshTimer as unknown as { unref?: () => void }).unref?.()
  }

  private stopRefreshLoop(): void {
    if (!this.refreshTimer) return
    clearInterval(this.refreshTimer)
    this.refreshTimer = undefined
  }

  private applyRemoteSnapshot(snapshot: CanvasSnapshotV2): void {
    if (snapshot.canvasId !== this.options.canvasId ||
      snapshot.projectId !== this.options.projectId) return
    const state = this.options.store.getState()
    if (materialSnapshot(snapshot) === materialSnapshot(this.currentSnapshot())) return
    const viewport = state.snapshot.viewport
    this.applyingRemote = true
    try {
      state.reconcileRemoteSnapshot(projectSnapshot(snapshot, viewport))
    } finally {
      this.applyingRemote = false
    }
  }

  private async persistLatestSharedSnapshot(): Promise<void> {
    const snapshot = this.canvasSession?.getSnapshot()
    if (!snapshot) return
    const local = { ...snapshot, viewport: this.options.store.getState().snapshot.viewport }
    this.applyRemoteSnapshot(local)
    await this.options.repository.saveCanvas(local)
  }

  private async detach(resetState = true): Promise<void> {
    this.invalidateLifecycle()
    this.connectionBaseline = undefined
    await this.disposeSession()
    if (resetState && !this.disposed) this.setState(initialState())
  }

  private async disposeSession(): Promise<void> {
    this.unsubscribeStore?.()
    this.unsubscribeSessionStatus?.()
    this.unsubscribeSessionEntityChanges?.()
    this.unsubscribeSessionPresence?.()
    this.unsubscribeLeaseLost?.()
    this.unsubscribeStore = undefined
    this.unsubscribeSessionStatus = undefined
    this.unsubscribeSessionEntityChanges = undefined
    this.unsubscribeSessionPresence = undefined
    this.unsubscribeLeaseLost = undefined
    const session = this.canvasSession
    this.canvasSession = undefined
    if (session) await session.destroy()
    if (this.presence.length > 0) {
      this.presence = []
      this.publishPresence()
    }
  }

  private invalidateLifecycle(): void {
    this.operationEpoch += 1
    this.refreshEpoch += 1
    this.operation?.abort.abort()
    this.refreshAbort?.abort()
    this.stopRefreshLoop()
  }

  private isRefreshCurrent(
    roomId: string,
    refreshEpoch: number,
    operationEpoch: number,
    abort: AbortController,
  ): boolean {
    const currentRoomId = this.state.room?.roomId ?? this.state.authenticatedPendingResume
    return !this.disposed && !abort.signal.aborted && currentRoomId === roomId &&
      this.refreshEpoch === refreshEpoch && this.operationEpoch === operationEpoch
  }

  private currentSnapshot(): CanvasSnapshotV2 {
    return this.snapshotFromProject(this.options.store.getState().snapshot)
  }

  private snapshotFromProject(snapshot: ProjectSnapshotV1): CanvasSnapshotV2 {
    if (snapshot.projectId !== this.options.projectId) {
      throw new Error('协同画布作用域与当前文档不匹配 (The collaboration canvas scope does not match the current document)')
    }
    return {
      ...snapshot,
      version: CANVAS_SNAPSHOT_VERSION,
      canvasId: this.options.canvasId,
    }
  }

  private assertScope(session: CollaborationSession): void {
    if (session.canvasId !== this.options.canvasId || session.projectId !== this.options.projectId) {
      throw new Error('该协同房间属于其他画布 (The collaboration room belongs to another canvas)')
    }
  }

  private requireOwnerRoom(): CollaborationRoom {
    if (!this.state.room || this.state.session?.role !== 'owner') {
      throw new Error('仅协作房间房主有权管理此房间 (Only the collaboration owner can manage this room)')
    }
    return this.state.room
  }

  inviteUrl(roomId: string, secret: string, customOrigin?: string): string {
    const baseOrigin = customOrigin?.trim() || this.options.shareOrigin
    let url: URL
    if (baseOrigin) {
      try {
        const configured = new URL(baseOrigin)
        const current = new URL(this.location.href)
        url = new URL(current.pathname + current.search, configured.origin)
      } catch {
        url = new URL(this.location.href)
      }
    } else {
      url = new URL(this.location.href)
    }
    url.searchParams.set('collabRoom', roomId)
    url.hash = new URLSearchParams({ invite: secret }).toString()
    return url.toString()
  }

  async getTunnelStatus(): Promise<import('../contracts/collaboration.ts').TunnelStatus | undefined> {
    return this.client.getTunnelStatus?.()
  }

  async startTunnel(mode?: 'auto' | 'custom', customUrl?: string): Promise<import('../contracts/collaboration.ts').TunnelStatus | undefined> {
    return this.client.startTunnel?.(mode, customUrl)
  }

  async stopTunnel(): Promise<import('../contracts/collaboration.ts').TunnelStatus | undefined> {
    return this.client.stopTunnel?.()
  }

  async setCustomTunnelUrl(customUrl?: string): Promise<import('../contracts/collaboration.ts').TunnelStatus | undefined> {
    return this.client.setCustomTunnelUrl?.(customUrl)
  }

  private replaceRoomInUrl(roomId: string): void {
    const search = new URLSearchParams(this.location.search)
    search.set('collabRoom', roomId)
    const next = `${this.location.pathname}?${search.toString()}`
    this.history.replaceState(null, '', next)
    this.location.search = `?${search.toString()}`
    this.location.href = new URL(next, this.location.href).toString()
  }

  private clearRoomFromUrl(): void {
    const search = new URLSearchParams(this.location.search)
    search.delete('collabRoom')
    const query = search.toString()
    const next = `${this.location.pathname}${query ? `?${query}` : ''}`
    this.history.replaceState(null, '', next)
    this.location.search = query ? `?${query}` : ''
    this.location.hash = ''
  }

  private fail(error: unknown, keep: Partial<CollaborationControllerState> = {}): void {
    this.patch({
      ...keep,
      status: 'error',
      error: error instanceof Error ? error.message : 'Collaboration failed',
    })
  }

  private runOperation(
    kind: string,
    task: (epoch: number, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.operation) {
      return this.operation.kind === kind
        ? this.operation.promise
        : Promise.reject(new Error('Another collaboration operation is already running'))
    }
    const epoch = ++this.operationEpoch
    const abort = new AbortController()
    const promise = Promise.resolve()
      .then(() => task(epoch, abort.signal))
      .catch((error) => {
        if (this.isCurrent(epoch)) { this.fail(error); throw error }
      })
      .finally(() => {
        if (this.operation?.promise === promise) this.operation = undefined
      })
    this.operation = { kind, abort, promise }
    return promise
  }

  private isCurrent(epoch: number): boolean {
    return !this.disposed && epoch === this.operationEpoch
  }

  private assertCurrent(epoch: number): void {
    if (!this.isCurrent(epoch)) throw new DOMException('Collaboration operation superseded', 'AbortError')
  }

  private patch(patch: Partial<CollaborationControllerState>): void {
    this.setState({ ...this.state, ...patch })
  }

  private setState(state: CollaborationControllerState): void {
    this.state = state
    for (const listener of this.listeners) {
      try { listener(state) } catch { /* isolate view observers */ }
    }
  }

  private publishPresence(): void {
    const presence = this.getPresence()
    for (const listener of this.presenceListeners) {
      try { listener(presence) } catch { /* isolate view observers */ }
    }
  }
}

export function collaborationRoleLabel(role: CollaborationRole): string {
  if (role === 'owner') return '所有者'
  return role === 'editor' ? '可编辑' : '可查看'
}

export function activeCollaborationInvites(invites: readonly CollaborationInvite[]): CollaborationInvite[] {
  return invites.filter((invite) => !invite.revoked)
}
