import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type {
  CollaborationInteraction,
  InteractionPreview,
  NodeLease,
  NodeLeaseKind,
  CollaborationRoom,
  CollaborationSession,
  PresenceState,
} from '../contracts/collaboration'
import type { CanvasSnapshotV2, ProjectSnapshotV1 } from '../model/project'
import { createCanvasStore } from '../store/canvas-store'
import type { WorkspaceRepository } from '../workspace'
import type {
  CollaborationClientHandle,
  CollaborationLocation,
  CollaborationSessionHandle,
} from './controller'
import { CanvasCollaborationController } from './controller'
import { CollaborationClientError } from './client'
import type { CanvasCollaborationStatus } from './session'
import type { CanvasEntityChangeSet } from './entityChanges'

const project: ProjectSnapshotV1 = {
  version: 1,
  projectId: 'project-a',
  name: 'Canvas A',
  viewport: { x: 40, y: 50, zoom: 0.8 },
  nodes: [{
    id: 'text-a', type: 'text', name: 'Text A',
    position: { x: 10, y: 20 }, size: { width: 240, height: 160 },
    data: { text: 'Local text' },
  }],
  edges: [],
}

function v2(value = project): CanvasSnapshotV2 {
  return { ...value, version: 2, canvasId: 'canvas-a' }
}

const owner: CollaborationSession = {
  roomId: 'room-a', canvasId: 'canvas-a', projectId: 'project-a',
  memberId: 'owner-a', displayName: 'Owner', role: 'owner', status: 'connected',
}

function room(session = owner): CollaborationRoom {
  return {
    roomId: session.roomId, canvasId: session.canvasId,
    projectId: session.projectId, ownerId: 'owner-a',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z', enabled: true,
    members: [{ id: session.memberId, displayName: session.displayName, role: session.role, removed: false }],
    invites: [],
  }
}

class FakeSession implements CollaborationSessionHandle {
  status: CanvasCollaborationStatus = { state: 'synced' }
  readonly serverSession: CollaborationSession
  snapshot: CanvasSnapshotV2
  readonly applySnapshot = vi.fn((snapshot: CanvasSnapshotV2) => {
    this.snapshot = structuredClone({ ...snapshot, viewport: this.snapshot.viewport })
    this.emitSnapshot(this.snapshot)
  })
  readonly applySnapshotChange = vi.fn((_previous: CanvasSnapshotV2, next: CanvasSnapshotV2) => {
    this.snapshot = structuredClone({ ...next, viewport: this.snapshot.viewport })
    this.emitSnapshot(this.snapshot)
  })
  readonly applyEntityChanges = vi.fn((changes: CanvasEntityChangeSet) => {
    const current = this.snapshot
    const nodes = new Map(current.nodes.map((node) => [node.id, node]))
    changes.nodes.removed.forEach((id) => nodes.delete(id))
    changes.nodes.upserted.forEach((node) => nodes.set(node.id, structuredClone(node)))
    const edges = new Map(current.edges.map((edge) => [edge.id, edge]))
    changes.edges.removed.forEach((id) => edges.delete(id))
    changes.edges.upserted.forEach((edge) => edges.set(edge.id, structuredClone(edge)))
    this.snapshot = {
      ...current,
      ...(changes.name === undefined ? {} : { name: changes.name }),
      nodes: [...nodes.values()], edges: [...edges.values()],
    }
    this.emitEntityChanges(changes)
  })
  readonly undo = vi.fn()
  readonly redo = vi.fn()
  readonly setCursor = vi.fn()
  readonly setSelection = vi.fn()
  readonly setViewport = vi.fn()
  readonly setInteraction = vi.fn()
  readonly clearInteraction = vi.fn()
  readonly setInteractionPreview = vi.fn()
  readonly clearPreview = vi.fn()
  readonly releaseLease = vi.fn()
  readonly acquireLease = vi.fn((nodeIds: readonly string[], kind: NodeLeaseKind): NodeLease => ({
    leaseId: 'lease-local', nodeIds: [...nodeIds], memberId: this.serverSession.memberId,
    kind, startedAt: 1, heartbeatAt: 1, expiresAt: 7000, confirmed: true,
  }))
  readonly getLease = vi.fn((_nodeId: string) => undefined as NodeLease | undefined)
  readonly destroy = vi.fn(async () => undefined)
  readonly flush = vi.fn(async () => undefined)
  private readonly statusListeners = new Set<(status: CanvasCollaborationStatus) => void>()
  private readonly snapshotListeners = new Set<(snapshot: CanvasSnapshotV2) => void>()
  private readonly entityChangeListeners = new Set<(changes: CanvasEntityChangeSet) => void>()
  private readonly presenceListeners = new Set<(presence: readonly PresenceState[]) => void>()
  private readonly leaseLostListeners = new Set<(lease: NodeLease) => void>()
  private presence: PresenceState[] = []

  constructor(serverSession: CollaborationSession, snapshot = v2()) {
    this.serverSession = serverSession
    this.snapshot = structuredClone(snapshot)
  }

  subscribeStatus(listener: (status: CanvasCollaborationStatus) => void) {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }
  emitStatus(status: CanvasCollaborationStatus) {
    this.status = status
    for (const listener of this.statusListeners) listener(status)
  }
  subscribeSnapshot(listener: (snapshot: CanvasSnapshotV2) => void) {
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }
  subscribeEntityChanges(listener: (changes: CanvasEntityChangeSet) => void) {
    this.entityChangeListeners.add(listener)
    return () => this.entityChangeListeners.delete(listener)
  }
  subscribePresence(listener: (presence: readonly PresenceState[]) => void) {
    this.presenceListeners.add(listener)
    return () => this.presenceListeners.delete(listener)
  }
  getRemotePresence() { return structuredClone(this.presence) }
  subscribeLeaseLost(listener: (lease: NodeLease) => void) {
    this.leaseLostListeners.add(listener)
    return () => this.leaseLostListeners.delete(listener)
  }
  getSnapshot() { return structuredClone(this.snapshot) }
  canUndo() { return true }
  canRedo() { return true }
  emitSnapshot(snapshot: CanvasSnapshotV2) {
    this.snapshot = structuredClone(snapshot)
    for (const listener of this.snapshotListeners) listener(structuredClone(snapshot))
  }
  emitEntityChanges(changes: CanvasEntityChangeSet) {
    for (const listener of this.entityChangeListeners) listener(structuredClone(changes))
  }
  emitPresence(presence: PresenceState[]) {
    this.presence = structuredClone(presence)
    for (const listener of this.presenceListeners) listener(structuredClone(presence))
  }
  emitLeaseLost(lease: NodeLease) {
    for (const listener of this.leaseLostListeners) listener(structuredClone(lease))
  }
}

function location(hash = ''): CollaborationLocation {
  return {
    hash,
    href: `http://localhost/canvas?projectId=project-a&canvasId=canvas-a${hash}`,
    pathname: '/canvas',
    search: '?projectId=project-a&canvasId=canvas-a',
  }
}

function setup(input: {
  serverSession?: CollaborationSession
  location?: CollaborationLocation
  leaseSettleMs?: number
  shareOrigin?: string
} = {}) {
  const serverSession = input.serverSession ?? owner
  const store = createCanvasStore(project)
  const events: string[] = []
  const saved: CanvasSnapshotV2[] = []
  const repository = {
    loadCanvas: vi.fn(async () => structuredClone(session.snapshot)),
    saveCanvas: vi.fn(async (snapshot: CanvasSnapshotV2) => {
      events.push('backup')
      saved.push(structuredClone(snapshot))
    }),
  } as unknown as WorkspaceRepository
  const session = new FakeSession(serverSession)
  const client: CollaborationClientHandle = {
    enableRoom: vi.fn(async () => {
      events.push('enable')
      return { room: room(serverSession), session: serverSession, recoverySecret: 'recovery-only-memory' }
    }),
    resumeRoom: vi.fn(async () => ({ room: room(serverSession), session: serverSession })),
    getRoom: vi.fn(async () => room(serverSession)),
    createInvite: vi.fn(async (_roomId, role) => ({
      invite: { id: `invite-${role}`, role, createdAt: '2026-07-18T00:01:00.000Z', revoked: false },
      secret: `secret-${role}`,
    })),
    revokeInvite: vi.fn(async () => undefined),
    joinRoom: vi.fn(async () => serverSession),
    joinFromInviteFragment: vi.fn(async (join) => {
      join.history.replaceState(null, '', `${join.location.pathname}${join.location.search}`)
      return serverSession
    }),
    setMemberRole: vi.fn(async () => undefined),
    removeMember: vi.fn(async () => undefined),
    leaveRoom: vi.fn(async () => undefined),
    closeRoom: vi.fn(async () => undefined),
  }
  const history = { replaceState: vi.fn() }
  const createSession = vi.fn(async () => session)
  const controllerOptions = {
    canvasId: 'canvas-a', projectId: 'project-a', store, repository, client,
    createSession,
    location: input.location ?? location(), history,
    storage: { getItem: () => null } as Storage,
    leaseSettleMs: input.leaseSettleMs,
    shareOrigin: input.shareOrigin,
  }
  const controller = new CanvasCollaborationController(controllerOptions)
  return { client, controller, createSession, events, history, repository, saved, session, store }
}

describe('CanvasCollaborationController', () => {
  it.each(['owner', 'editor'] as const)('waits for a durable collaboration checkpoint before an Agent run for %s', async role => {
    const subject = setup({ serverSession: { ...owner, role } })
    await subject.controller.enable('Member')
    subject.store.getState().renameNode('text-a', 'Must reach the server')
    let release!: () => void
    let persistedName: string | undefined
    subject.session.flush.mockImplementation(() => new Promise<void>(resolve => { release = () => { persistedName = subject.session.snapshot.nodes[0]!.name; resolve() } }))
    let prepared = false
    const pending = subject.controller.flushForAgent().then(() => { prepared = true })
    await Promise.resolve()
    expect(prepared).toBe(false)
    release()
    await pending
    expect(persistedName).toBe('Must reach the server')
    await subject.controller.destroy()
  })

  it('refuses to prepare an Agent run for a viewer or after losing the connection', async () => {
    const viewer = setup({ serverSession: { ...owner, role: 'viewer' } })
    await viewer.controller.enable('Viewer')
    await expect(viewer.controller.flushForAgent()).rejects.toThrow()
    expect(viewer.session.flush).not.toHaveBeenCalled()
    await viewer.controller.destroy()
    const subject = setup()
    await subject.controller.enable('Owner')
    subject.session.flush.mockImplementation(async () => { subject.session.emitStatus({ state: 'offline' }) })
    await expect(subject.controller.flushForAgent()).rejects.toThrow()
    await subject.controller.destroy()
  })

  it.each(['leave', 'closeRoom'] as const)('refreshes the server checkpoint during %s without saving against the old revision', async (action) => {
    const subject = setup()
    await subject.controller.enable('Owner')
    vi.mocked(subject.repository.saveCanvas).mockRejectedValue(Object.assign(new Error('旧 revision 冲突'), { status: 409 }))
    const order: string[] = []
    subject.session.flush.mockImplementation(async () => { order.push('checkpoint') })
    const clientAction = action === 'leave' ? subject.client.leaveRoom : subject.client.closeRoom
    vi.mocked(clientAction).mockImplementation(async () => { order.push('exit') })
    const authoritative = { ...v2(), name: '服务端最新检查点' }
    vi.mocked(subject.repository.loadCanvas).mockImplementation(async () => { order.push('load'); return authoritative })

    await subject.controller[action]()

    expect(order).toEqual(['checkpoint', 'exit', 'load'])
    expect(subject.repository.saveCanvas).toHaveBeenCalledTimes(1)
    expect(subject.repository.loadCanvas).toHaveBeenLastCalledWith('canvas-a', { requireRemote: true })
    expect(subject.store.getState().snapshot.name).toBe('服务端最新检查点')
    expect(subject.controller.getState().status).toBe('inactive')
    expect(subject.controller.isLocalAutosaveSuppressed()).toBe(false)
  })

  it('keeps editing disabled throughout the checkpoint barrier despite session status updates', async () => {
    const subject = setup()
    await subject.controller.enable('Owner')
    let release!: () => void
    subject.session.flush.mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    const closing = subject.controller.closeRoom()
    await vi.waitFor(() => expect(subject.session.flush).toHaveBeenCalledOnce())
    subject.session.emitStatus({ state: 'offline' })
    subject.session.emitStatus({ state: 'synced' })
    expect(subject.controller.getState().status).toBe('connecting')
    subject.store.getState().renameNode('text-a', '禁止退出中修改')
    expect(subject.store.getState().snapshot.nodes[0]?.name).toBe('Text A')
    expect(subject.client.closeRoom).not.toHaveBeenCalled()
    expect(subject.controller.isLocalAutosaveSuppressed()).toBe(true)
    release()
    await closing
  })

  it('retains the offline session and its local shared updates when leaving cannot checkpoint', async () => {
    const subject = setup()
    await subject.controller.enable('Owner')
    subject.store.getState().renameNode('text-a', '离线协作修改')
    subject.session.emitStatus({ state: 'offline' })
    subject.session.flush.mockRejectedValueOnce(new Error('离线修改已保留，请连接后重试'))
    await expect(subject.controller.leave()).rejects.toThrow('连接后重试')
    expect(subject.session.destroy).not.toHaveBeenCalled()
    expect(subject.client.leaveRoom).not.toHaveBeenCalled()
    expect(subject.controller.isLocalAutosaveSuppressed()).toBe(true)
    expect(subject.session.snapshot.nodes[0]?.name).toBe('离线协作修改')
    subject.session.emitStatus({ state: 'synced' })
    await subject.controller.leave()
    expect(subject.controller.getState().status).toBe('inactive')
  })

  it('retries only the authoritative reload if closing already succeeded', async () => {
    const subject = setup()
    await subject.controller.enable('Owner')
    vi.mocked(subject.repository.loadCanvas).mockRejectedValueOnce(new Error('权威版本暂不可读'))
    await expect(subject.controller.closeRoom()).rejects.toThrow('权威版本暂不可读')
    expect(subject.controller.getState().status).toBe('connecting')
    expect(subject.session.destroy).not.toHaveBeenCalled()
    expect(subject.controller.isLocalAutosaveSuppressed()).toBe(true)
    await subject.controller.closeRoom()
    expect(subject.session.flush).toHaveBeenCalledOnce()
    expect(subject.client.closeRoom).toHaveBeenCalledOnce()
    expect(subject.controller.getState().status).toBe('inactive')
  })

  it('resumes an existing room when enabling the same canvas conflicts', async () => {
    const subject = setup()
    vi.mocked(subject.client.enableRoom).mockRejectedValueOnce(
      new CollaborationClientError(
        409,
        'collaboration_conflict',
        'conflict',
        'room-a',
      ),
    )

    await expect(subject.controller.enable('Owner')).resolves.toBeUndefined()

    expect(subject.client.resumeRoom).toHaveBeenCalledWith('room-a', expect.anything())
    expect(subject.createSession).toHaveBeenCalledOnce()
    expect(subject.history.replaceState).toHaveBeenCalledWith(
      null,
      '',
      expect.stringContaining('collabRoom=room-a'),
    )
    expect(subject.controller.getState()).toMatchObject({
      status: 'synced',
      room: { roomId: 'room-a' },
    })
  })

  it('flattens synchronous and asynchronous lease operation result types', async () => {
    const subject = setup()
    const synchronous = subject.controller.withNodeLease([], 'bulk', () => 'sync')
    const asynchronous = subject.controller.withNodeLease([], 'bulk', async () => 'async')

    expectTypeOf(synchronous).toEqualTypeOf<Promise<string | undefined>>()
    expectTypeOf(asynchronous).toEqualTypeOf<Promise<string | undefined>>()
    await expect(synchronous).resolves.toBe('sync')
    await expect(asynchronous).resolves.toBe('async')
  })
  it('exposes controlled presence without exposing the shared Yjs document', async () => {
    const subject = setup()
    const presence: PresenceState = {
      clientId: 42,
      member: {
        memberId: 'editor-b', displayName: '剪辑师', color: '#e59a52', role: 'editor',
      },
      cursor: { x: 120, y: 80 },
      selection: { nodeIds: ['text-a'] },
      viewport: { x: 10, y: 20, zoom: 0.75 },
    }
    const observed = vi.fn()

    await subject.controller.enable('Owner')
    const unsubscribe = subject.controller.subscribePresence(observed)
    subject.session.emitPresence([presence])
    subject.controller.setCursor({ x: 5, y: 6 })
    subject.controller.setSelection(['text-a'])
    subject.controller.setViewport({ x: 1, y: 2, zoom: 1.2 })
    subject.controller.setInteraction({ kind: 'dragging', nodeIds: ['text-a'] })
    subject.controller.clearInteraction()

    expect(subject.controller.getPresence()).toEqual([presence])
    expect(observed).toHaveBeenLastCalledWith([presence])
    expect(subject.session.setCursor).toHaveBeenCalledWith({ x: 5, y: 6 })
    expect(subject.session.setSelection).toHaveBeenCalledWith(['text-a'])
    expect(subject.session.setViewport).toHaveBeenCalledWith({ x: 1, y: 2, zoom: 1.2 })
    expect(subject.session.setInteraction).toHaveBeenCalledWith({
      kind: 'dragging', nodeIds: ['text-a'],
    } satisfies CollaborationInteraction)
    expect(subject.session.clearInteraction).toHaveBeenCalledTimes(1)
    expect('doc' in subject.controller).toBe(false)

    subject.session.emitStatus({ state: 'offline' })
    expect(subject.controller.getPresence()).toEqual([])
    expect(observed).toHaveBeenLastCalledWith([])

    unsubscribe()
    await subject.controller.destroy()
  })

  it('guards lease operations and releases them around one settled transaction', async () => {
    const subject = setup({ leaseSettleMs: 0 })
    await subject.controller.enable('Owner')
    const lost = vi.fn()
    subject.controller.subscribeLeaseLost(lost)
    const preview: InteractionPreview = {
      kind: 'drag', coordinateSpace: 'canvas-absolute', nodes: [{ nodeId: 'text-a', position: { x: 20, y: 30 } }],
    }

    const lease = subject.session.acquireLease.mock.results[0]?.value ?? {
      leaseId: 'lease-local', nodeIds: ['text-a'], memberId: 'owner-a', kind: 'bulk' as const,
      startedAt: 1, heartbeatAt: 1, expiresAt: 7000, confirmed: true,
    }
    subject.session.getLease.mockReturnValue(lease)
    const result = await subject.controller.withNodeLease(['text-a'], 'bulk', () => 'done')
    subject.controller.setInteractionPreview(preview)
    subject.controller.clearPreview()

    expect(result).toBe('done')
    expect(subject.session.acquireLease).toHaveBeenCalledWith(['text-a'], 'bulk')
    expect(subject.session.releaseLease).toHaveBeenCalledTimes(1)
    expect(subject.session.setInteractionPreview).toHaveBeenCalledWith(preview)
    expect(subject.session.clearPreview).toHaveBeenCalledTimes(2)

    subject.session.emitLeaseLost(lease)
    expect(lost).toHaveBeenCalledWith(lease)

    subject.session.acquireLease.mockReturnValueOnce(undefined as never)
    const blocked = vi.fn()
    await expect(subject.controller.withNodeLease(['text-a'], 'bulk', blocked)).resolves.toBeUndefined()
    expect(blocked).not.toHaveBeenCalled()
  })

  it('runs an unconfirmed offline lease immediately without a settle delay', async () => {
    vi.useFakeTimers()
    const subject = setup({ leaseSettleMs: 200 })
    await subject.controller.enable('Owner')
    subject.session.emitStatus({ state: 'offline' })
    subject.session.acquireLease.mockReturnValue({
      leaseId: 'lease-offline', nodeIds: ['text-a'], memberId: 'owner-a', kind: 'bulk',
      startedAt: 1, heartbeatAt: 1, expiresAt: 7000, confirmed: false,
    })
    const operation = vi.fn(() => 'offline-result')

    await expect(subject.controller.withNodeLease(['text-a'], 'bulk', operation))
      .resolves.toBe('offline-result')
    expect(operation).toHaveBeenCalledOnce()
    expect(subject.session.releaseLease).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('cancels a pending settle during dispose without invoking its callback', async () => {
    vi.useFakeTimers()
    const subject = setup({ leaseSettleMs: 200 })
    await subject.controller.enable('Owner')
    const lease = {
      leaseId: 'lease-pending', nodeIds: ['text-a'], memberId: 'owner-a', kind: 'bulk' as const,
      startedAt: 1, heartbeatAt: 1, expiresAt: 7000, confirmed: true,
    }
    subject.session.acquireLease.mockReturnValue(lease)
    subject.session.getLease.mockReturnValue(lease)
    const operation = vi.fn()

    const pending = subject.controller.withNodeLease(['text-a'], 'bulk', operation)
    await subject.controller.destroy()
    const sentinel = Symbol('still-pending')
    const result = await Promise.race([pending, Promise.resolve(sentinel)])

    expect(result).toBeUndefined()
    expect(operation).not.toHaveBeenCalled()
    expect(subject.session.releaseLease).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('cancels a pending settle immediately when its lease is lost', async () => {
    vi.useFakeTimers()
    const subject = setup({ leaseSettleMs: 200 })
    await subject.controller.enable('Owner')
    const lease = {
      leaseId: 'lease-contested', nodeIds: ['text-a'], memberId: 'owner-a', kind: 'bulk' as const,
      startedAt: 1, heartbeatAt: 1, expiresAt: 7000, confirmed: true,
    }
    subject.session.acquireLease.mockReturnValue(lease)
    subject.session.getLease.mockReturnValue(lease)
    const operation = vi.fn()

    const pending = subject.controller.withNodeLease(['text-a'], 'bulk', operation)
    subject.session.emitLeaseLost(lease)

    await expect(pending).resolves.toBeUndefined()
    expect(operation).not.toHaveBeenCalled()
    expect(subject.session.releaseLease).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('settles a confirmed text lease so only one same-node editor commits', async () => {
    vi.useFakeTimers()
    const first = setup({ leaseSettleMs: 120 })
    const second = setup({ leaseSettleMs: 120 })
    await first.controller.enable('First')
    await second.controller.enable('Second')
    const firstLease = {
      leaseId: 'lease-first', nodeIds: ['text-a'], memberId: 'owner-a', kind: 'text' as const,
      startedAt: 1, heartbeatAt: 1, expiresAt: 7000, confirmed: true,
    }
    const secondLease = {
      ...firstLease, leaseId: 'lease-second', memberId: 'editor-b', startedAt: 2,
    }
    first.session.acquireLease.mockReturnValue(firstLease)
    second.session.acquireLease.mockReturnValue(secondLease)
    first.session.getLease.mockReturnValue(firstLease)
    second.session.getLease.mockReturnValue(firstLease)
    const firstOperation = vi.fn(() => 'first')
    const secondOperation = vi.fn(() => 'second')

    const firstResult = Promise.resolve(first.controller.withNodeLease(['text-a'], 'text', firstOperation))
    const secondResult = Promise.resolve(second.controller.withNodeLease(['text-a'], 'text', secondOperation))
    expect(firstOperation).not.toHaveBeenCalled()
    expect(secondOperation).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120)

    await expect(firstResult).resolves.toBe('first')
    await expect(secondResult).resolves.toBeUndefined()
    expect(firstOperation).toHaveBeenCalledOnce()
    expect(secondOperation).not.toHaveBeenCalled()
    expect(first.session.releaseLease).toHaveBeenCalledOnce()
    expect(second.session.releaseLease).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('backs up before enabling, suppresses autosave only after attach, and keeps recovery secret out of storage', async () => {
    const subject = setup()
    expect(subject.controller.isLocalAutosaveSuppressed()).toBe(false)

    await subject.controller.enable('Owner')

    expect(subject.events).toEqual(['backup', 'enable'])
    expect(subject.controller.isLocalAutosaveSuppressed()).toBe(true)
    expect(subject.controller.getState()).toMatchObject({
      status: 'synced', recoverySecret: 'recovery-only-memory',
    })
    expect(subject.saved).toHaveLength(1)
    expect(JSON.stringify(subject.saved)).not.toContain('recovery-only-memory')
    expect(subject.history.replaceState).toHaveBeenCalledWith(
      null, '', expect.stringContaining('collabRoom=room-a'),
    )
  })

  it('merges edits made while enable is connecting before restoring the shared snapshot', async () => {
    const subject = setup()
    let release!: () => void
    vi.mocked(subject.client.enableRoom).mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { room: room(), session: owner, recoverySecret: 'recovery-only-memory' }
    })

    const enabling = subject.controller.enable('Owner')
    await vi.waitFor(() => expect(subject.client.enableRoom).toHaveBeenCalledOnce())
    subject.store.getState().renameNode('text-a', 'Late local edit')
    release()
    await enabling

    expect(subject.session.applySnapshotChange).toHaveBeenCalledOnce()
    expect(subject.session.applySnapshotChange).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: [expect.objectContaining({ name: 'Text A' })] }),
      expect.objectContaining({ nodes: [expect.objectContaining({ name: 'Late local edit' })] }),
    )
    expect(subject.store.getState().snapshot.nodes[0]?.name).toBe('Late local edit')
  })

  it('merges connection-window edits when resuming an existing room', async () => {
    const resumedLocation = location()
    resumedLocation.search += '&collabRoom=room-a'
    resumedLocation.href = `http://localhost${resumedLocation.pathname}${resumedLocation.search}`
    const subject = setup({ location: resumedLocation })
    let release!: (value: { room: CollaborationRoom; session: CollaborationSession }) => void
    vi.mocked(subject.client.resumeRoom).mockImplementationOnce(() =>
      new Promise((resolve) => { release = resolve }))

    const resuming = subject.controller.initializeFromLocation()
    await vi.waitFor(() => expect(subject.client.resumeRoom).toHaveBeenCalledOnce())
    subject.store.getState().renameNode('text-a', 'Late resume edit')
    release({ room: room(), session: owner })
    await resuming

    expect(subject.session.applySnapshotChange).toHaveBeenCalledOnce()
    expect(subject.store.getState().snapshot.nodes[0]?.name).toBe('Late resume edit')
    await subject.controller.destroy()
  })

  it('merges connection-window edits after authenticating an invite', async () => {
    const invitedLocation = location('#invite=secret-editor')
    invitedLocation.search += '&collabRoom=room-a'
    invitedLocation.href = `http://localhost${invitedLocation.pathname}${invitedLocation.search}${invitedLocation.hash}`
    const subject = setup({ location: invitedLocation })
    let release!: (value: CollaborationSession) => void
    vi.mocked(subject.client.joinFromInviteFragment).mockImplementationOnce(() =>
      new Promise((resolve) => { release = resolve }))

    await subject.controller.initializeFromLocation()
    const joining = subject.controller.joinPendingInvite('Editor')
    await vi.waitFor(() => expect(subject.client.joinFromInviteFragment).toHaveBeenCalledOnce())
    subject.store.getState().renameNode('text-a', 'Late invite edit')
    release(owner)
    await joining

    expect(subject.session.applySnapshotChange).toHaveBeenCalledOnce()
    expect(subject.store.getState().snapshot.nodes[0]?.name).toBe('Late invite edit')
    await subject.controller.destroy()
  })

  it('reports a reconciliation failure once without retrying the local change', async () => {
    vi.useFakeTimers()
    try {
      const subject = setup()
      let release!: () => void
      vi.mocked(subject.client.enableRoom).mockImplementation(async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return { room: room(), session: owner, recoverySecret: 'recovery-only-memory' }
      })
      subject.session.applySnapshotChange.mockImplementationOnce(() => {
        throw new Error('merge rejected')
      })

      const enabling = subject.controller.enable('Owner')
      await vi.waitFor(() => expect(subject.client.enableRoom).toHaveBeenCalledOnce())
      subject.store.getState().renameNode('text-a', 'Unsynced late edit')
      release()
      await enabling
      await vi.advanceTimersByTimeAsync(9_000)

      expect(subject.session.applySnapshotChange).toHaveBeenCalledOnce()
      expect(subject.controller.getState()).toMatchObject({ status: 'error', error: 'merge rejected' })
      await subject.controller.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bridges local document changes once and restores remote documents without echoing or replacing personal state', async () => {
    const subject = setup()
    await subject.controller.enable('Owner')
    subject.store.getState().selectNode('text-a')
    subject.store.getState().setViewport({ x: 400, y: 300, zoom: 1.5 })
    expect(subject.session.applyEntityChanges).not.toHaveBeenCalled()

    subject.store.getState().renameNode('text-a', 'Local rename')
    expect(subject.session.applyEntityChanges).toHaveBeenCalledTimes(1)
    expect(subject.session.applyEntityChanges).toHaveBeenLastCalledWith(
      expect.objectContaining({
        origin: 'local',
        nodes: { upserted: [expect.objectContaining({ name: 'Local rename' })], removed: [] },
      }),
    )

    subject.session.applyEntityChanges.mockClear()
    subject.session.emitEntityChanges({
      origin: 'remote', name: 'Remote name',
      nodes: {
        upserted: subject.session.snapshot.nodes.map((node) => ({ ...node, name: 'Remote rename' })),
        removed: [],
      },
      edges: { upserted: [], removed: [] },
    })
    expect(subject.store.getState().snapshot.name).toBe('Remote name')
    expect(subject.store.getState().snapshot.nodes[0]?.name).toBe('Remote rename')
    expect(subject.store.getState().snapshot.viewport).toEqual({ x: 400, y: 300, zoom: 1.5 })
    expect(subject.store.getState().selectedNodeIds).toEqual(['text-a'])
    expect(subject.session.applyEntityChanges).not.toHaveBeenCalled()
  })

  it('reconciles remote documents without restoring or replacing unchanged entities', async () => {
    const subject = setup()
    await subject.controller.enable('Owner')
    subject.session.emitEntityChanges({
      origin: 'remote',
      nodes: { upserted: [{
          id: 'text-b', type: 'text', name: 'Text B',
          position: { x: 320, y: 20 }, size: { width: 240, height: 160 },
          data: { text: 'Unchanged text' },
        }], removed: [] },
      edges: { upserted: [{ id: 'edge-a-b', source: 'text-a', target: 'text-b', relation: 'flow' }], removed: [] },
    })
    const before = subject.store.getState().snapshot
    const unchangedNode = before.nodes[1]
    const unchangedEdge = before.edges[0]
    const restore = vi.spyOn(subject.store.getState(), 'restore')

    subject.session.emitEntityChanges({
      origin: 'remote',
      nodes: { upserted: [{ ...subject.session.snapshot.nodes[0]!, name: 'Remote rename' }], removed: [] },
      edges: { upserted: [], removed: [] },
    })

    const after = subject.store.getState().snapshot
    expect(restore).not.toHaveBeenCalled()
    expect(after.nodes[0]?.name).toBe('Remote rename')
    expect(after.nodes[1]).toBe(unchangedNode)
    expect(after.edges[0]).toBe(unchangedEdge)
  })

  it('keeps node and edge identity when an identical remote snapshot is received without restoring', async () => {
    const subject = setup()
    await subject.controller.enable('Owner')
    subject.session.emitSnapshot({
      ...subject.session.snapshot,
      nodes: [
        ...subject.session.snapshot.nodes,
        {
          id: 'text-b', type: 'text', name: 'Text B',
          position: { x: 320, y: 20 }, size: { width: 240, height: 160 },
          data: { text: 'Stable text' },
        },
      ],
      edges: [{ id: 'edge-a-b', source: 'text-a', target: 'text-b', relation: 'flow' }],
    })
    const before = subject.store.getState().snapshot
    const node = before.nodes[1]
    const edge = before.edges[0]
    const restore = vi.spyOn(subject.store.getState(), 'restore')

    subject.session.emitSnapshot(structuredClone(subject.session.snapshot))

    const after = subject.store.getState().snapshot
    expect(restore).not.toHaveBeenCalled()
    expect(after.nodes[1]).toBe(node)
    expect(after.edges[0]).toBe(edge)
  })

  it('bridges entity changes after hydration without reconciling whole snapshots', async () => {
    const subject = setup()
    await subject.controller.enable('Owner')
    const applyEntityChanges = vi.spyOn(subject.store.getState(), 'applyEntityChanges')
    const reconcileRemoteSnapshot = vi.spyOn(subject.store.getState(), 'reconcileRemoteSnapshot')

    subject.session.emitEntityChanges({
      origin: 'remote',
      nodes: {
        upserted: [{ ...subject.session.snapshot.nodes[0]!, name: 'Remote entity rename' }],
        removed: [],
      },
      edges: { upserted: [], removed: [] },
    })

    expect(applyEntityChanges).toHaveBeenCalledTimes(1)
    expect(reconcileRemoteSnapshot).not.toHaveBeenCalled()
    expect(subject.store.getState().snapshot.nodes[0]?.name).toBe('Remote entity rename')

    subject.session.applyEntityChanges.mockClear()
    subject.session.applyEntityChanges.mockClear()
    subject.store.getState().renameNode('text-a', 'Local entity rename')

    expect(subject.session.applyEntityChanges).toHaveBeenCalledTimes(1)
    expect(subject.session.applySnapshotChange).not.toHaveBeenCalled()
  })

  it('reverts viewer document mutations and routes personal undo and redo to the session', async () => {
    const viewer = { ...owner, memberId: 'viewer-a', displayName: 'Viewer', role: 'viewer' as const }
    const subject = setup({ serverSession: viewer })
    await subject.controller.enable('Viewer')

    subject.store.getState().renameNode('text-a', 'Forbidden local rename')
    expect(subject.store.getState().snapshot.nodes[0]?.name).toBe('Text A')
    expect(subject.session.applySnapshotChange).not.toHaveBeenCalled()
    subject.controller.undo()
    subject.controller.redo()
    expect(subject.session.undo).toHaveBeenCalledOnce()
    expect(subject.session.redo).toHaveBeenCalledOnce()
  })

  it('detects invite fragments, joins after nickname submission, and clears the fragment only after success', async () => {
    const invitedLocation = location('#invite=secret-editor')
    invitedLocation.search += '&collabRoom=room-a'
    invitedLocation.href = `http://localhost${invitedLocation.pathname}${invitedLocation.search}${invitedLocation.hash}`
    const subject = setup({ location: invitedLocation })

    await subject.controller.initializeFromLocation()
    expect(subject.controller.getState().pendingInvite).toMatchObject({ roomId: 'room-a' })
    expect(subject.controller.isLocalAutosaveSuppressed()).toBe(false)

    await subject.controller.joinPendingInvite('Editor')
    expect(subject.client.joinFromInviteFragment).toHaveBeenCalledOnce()
    expect(subject.controller.getState().pendingInvite).toBeUndefined()
    expect(subject.controller.isLocalAutosaveSuppressed()).toBe(true)
    expect(subject.history.replaceState).toHaveBeenCalledWith(
      null, '', expect.not.stringContaining('invite=secret-editor'),
    )
  })

  it('creates fragment-only invite links and never writes invite secrets into the canvas backup', async () => {
    const subject = setup()
    await subject.controller.enable('Owner')
    const link = await subject.controller.createInvite('editor')

    expect(link).toContain('collabRoom=room-a')
    expect(link).toContain('#invite=secret-editor')
    expect(JSON.stringify(subject.saved)).not.toContain('secret-editor')
    expect(subject.store.getState().serialize()).not.toContain('secret-editor')
  })

  it('creates invite links with the configured public origin instead of loopback', async () => {
    const subject = setup({ shareOrigin: 'http://192.168.1.4:4173' })
    await subject.controller.enable('Owner')

    const link = await subject.controller.createInvite('editor')

    expect(new URL(link).origin).toBe('http://192.168.1.4:4173')
    expect(link).toContain('#invite=secret-editor')
  })

  it('single-flights enable and ignores a late response after destroy while closing the orphan room', async () => {
    const subject = setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(subject.client.enableRoom).mockImplementation(async () => {
      await gate
      return { room: room(), session: owner, recoverySecret: 'late-secret' }
    })
    const first = subject.controller.enable('Owner')
    const second = subject.controller.enable('Owner')
    expect(subject.client.enableRoom).toHaveBeenCalledTimes(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(subject.client.enableRoom).toHaveBeenCalledTimes(1)
    const destroyed = subject.controller.destroy()
    release()
    await Promise.all([first, second, destroyed])
    expect(subject.controller.getState().recoverySecret).toBeUndefined()
    expect(subject.history.replaceState).not.toHaveBeenCalled()
    expect(subject.client.closeRoom).toHaveBeenCalledWith('room-a')
  })

  it('keeps an authenticated invite resumable without reading the fragment secret again', async () => {
    const invitedLocation = location('#invite=secret-editor')
    invitedLocation.search += '&collabRoom=room-a'
    invitedLocation.href = `http://localhost${invitedLocation.pathname}${invitedLocation.search}${invitedLocation.hash}`
    const subject = setup({ location: invitedLocation })
    vi.mocked(subject.client.getRoom).mockRejectedValueOnce(new Error('room status unavailable'))
    await subject.controller.initializeFromLocation()
    await subject.controller.joinPendingInvite('Editor')
    expect(subject.controller.getState()).toMatchObject({ authenticatedPendingResume: 'room-a' })
    expect(invitedLocation.hash).toBe('')
    subject.store.getState().renameNode('text-a', 'Edit before authenticated retry')

    await subject.controller.retryAuthenticatedResume()
    expect(subject.client.resumeRoom).toHaveBeenCalledWith('room-a', expect.anything())
    expect(subject.client.joinFromInviteFragment).toHaveBeenCalledTimes(1)
    expect(subject.controller.getState().status).toBe('synced')
    expect(subject.session.applySnapshotChange).toHaveBeenCalledOnce()
    expect(subject.store.getState().snapshot.nodes[0]?.name).toBe('Edit before authenticated retry')
  })

  it('refreshes live room membership with one in-flight request', async () => {
    const subject = setup()
    await subject.controller.enable('Owner')
    const refreshed = room()
    refreshed.members.push({ id: 'editor-new', displayName: 'New editor', role: 'editor', removed: false })
    vi.mocked(subject.client.resumeRoom).mockResolvedValue({ room: refreshed, session: owner })
    const first = subject.controller.refreshRoom()
    const second = subject.controller.refreshRoom()
    await Promise.all([first, second])
    expect(subject.client.resumeRoom).toHaveBeenCalledTimes(1)
    expect(subject.controller.getState().room?.members).toHaveLength(2)
  })

  it('rebuilds the session on dynamic downgrade and emits no further writes', async () => {
    const subject = setup()
    await subject.controller.enable('Owner')
    const viewer = { ...owner, role: 'viewer' as const }
    vi.mocked(subject.client.resumeRoom).mockResolvedValue({
      room: room(viewer),
      session: viewer,
    })

    await subject.controller.refreshRoom()

    expect(subject.controller.getState()).toMatchObject({
      status: 'synced', session: { role: 'viewer' },
    })
    expect(subject.createSession).toHaveBeenCalledTimes(2)
    expect(subject.session.destroy).toHaveBeenCalledOnce()
    subject.session.applyEntityChanges.mockClear()
    subject.store.getState().renameNode('text-a', 'Forbidden after downgrade')
    expect(subject.session.applySnapshotChange).not.toHaveBeenCalled()
    expect(subject.store.getState().snapshot.nodes[0]?.name).toBe('Text A')
  })

  it('rebuilds the session after viewer promotion and restores write capability', async () => {
    const viewer = { ...owner, memberId: 'member-a', role: 'viewer' as const }
    const editor = { ...viewer, role: 'editor' as const }
    const subject = setup({ serverSession: viewer })
    await subject.controller.enable('Viewer')
    vi.mocked(subject.client.resumeRoom).mockResolvedValue({ room: room(editor), session: editor })

    await subject.controller.refreshRoom()
    subject.session.applySnapshotChange.mockClear()
    subject.store.getState().renameNode('text-a', 'Allowed after promotion')

    expect(subject.controller.getState().session?.role).toBe('editor')
    expect(subject.createSession).toHaveBeenCalledTimes(2)
    expect(subject.session.applyEntityChanges).toHaveBeenCalledOnce()
  })

  it('refreshes roles throughout the active session without requiring the collaboration popover', async () => {
    vi.useFakeTimers()
    try {
      const subject = setup()
      await subject.controller.enable('Owner')
      const viewer = { ...owner, role: 'viewer' as const }
      vi.mocked(subject.client.resumeRoom).mockResolvedValue({ room: room(viewer), session: viewer })

      await vi.advanceTimersByTimeAsync(3_000)

      expect(subject.client.resumeRoom).toHaveBeenCalledOnce()
      expect(subject.controller.getState().session?.role).toBe('viewer')
      expect(subject.createSession).toHaveBeenCalledTimes(2)

      await subject.controller.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops active-session refreshes on detach and never lets an old response revive the room', async () => {
    vi.useFakeTimers()
    try {
      const subject = setup()
      await subject.controller.enable('Owner')
      let release!: (value: { room: CollaborationRoom; session: CollaborationSession }) => void
      vi.mocked(subject.client.resumeRoom).mockImplementationOnce(() =>
        new Promise((resolve) => { release = resolve }))

      await vi.advanceTimersByTimeAsync(3_000)
      const leaving = subject.controller.leave()
      release({ room: room(), session: owner })
      await leaving
      await vi.advanceTimersByTimeAsync(9_000)

      expect(subject.client.resumeRoom).toHaveBeenCalledTimes(1)
      expect(subject.controller.getState().status).toBe('inactive')
      expect(subject.controller.getState().room).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['leave', 'closeRoom'] as const)('ignores refresh completion while %s is detaching', async (action) => {
    const subject = setup()
    await subject.controller.enable('Owner')
    let release!: (value: { room: CollaborationRoom; session: CollaborationSession }) => void
    vi.mocked(subject.client.resumeRoom).mockImplementationOnce(() =>
      new Promise((resolve) => { release = resolve }))
    const refresh = subject.controller.refreshRoom()

    await subject.controller[action]()
    release({ room: room(), session: owner })
    await refresh

    expect(subject.controller.getState().status).toBe('inactive')
    expect(subject.controller.getState().room).toBeUndefined()
  })

  it('handles room conflict gracefully when resume fails by exposing conflictRoomId', async () => {
    const subject = setup()
    vi.mocked(subject.client.enableRoom).mockRejectedValueOnce(
      new CollaborationClientError(409, 'collaboration_conflict', 'Room conflict', 'room-conflict-1'),
    )
    vi.mocked(subject.client.resumeRoom).mockRejectedValueOnce(
      new CollaborationClientError(403, 'collaboration_forbidden', 'Collaboration access was denied'),
    )

    await subject.controller.enable('User')

    expect(subject.controller.getState().status).toBe('inactive')
    expect(subject.controller.getState().conflictRoomId).toBe('room-conflict-1')
    expect(subject.controller.getState().error).toContain('未关闭的历史协作房间')
  })

  it('recovers conflict room using recovery secret and establishes session', async () => {
    const subject = setup()
    vi.mocked(subject.client.enableRoom).mockRejectedValueOnce(
      new CollaborationClientError(409, 'collaboration_conflict', 'Room conflict', 'room-conflict-1'),
    )
    vi.mocked(subject.client.resumeRoom).mockRejectedValueOnce(
      new CollaborationClientError(403, 'collaboration_forbidden', 'Collaboration access was denied'),
    )

    await subject.controller.enable('User')
    expect(subject.controller.getState().conflictRoomId).toBe('room-conflict-1')

    const recoveredSession: CollaborationSession = {
      ...owner,
      roomId: 'room-conflict-1',
    }
    vi.mocked(subject.client.joinRoom).mockResolvedValueOnce(recoveredSession)
    vi.mocked(subject.client.getRoom).mockResolvedValueOnce(room(recoveredSession))

    await subject.controller.recoverConflictRoom('recovery-secret-123', 'OwnerUser')

    expect(subject.client.joinRoom).toHaveBeenCalledWith({
      roomId: 'room-conflict-1',
      secret: 'recovery-secret-123',
      displayName: 'OwnerUser',
    }, expect.anything())
    expect(subject.controller.getState().status).toBe('synced')
    expect(subject.controller.getState().conflictRoomId).toBeUndefined()
    expect(subject.controller.getState().room?.roomId).toBe('room-conflict-1')
  })

  it('force resets conflict room and successfully re-enables collaboration', async () => {
    const subject = setup()
    vi.mocked(subject.client.enableRoom).mockRejectedValueOnce(
      new CollaborationClientError(409, 'collaboration_conflict', 'Room conflict', 'room-conflict-1'),
    )
    vi.mocked(subject.client.resumeRoom).mockRejectedValueOnce(
      new CollaborationClientError(403, 'collaboration_forbidden', 'Collaboration access was denied'),
    )

    await subject.controller.enable('User')
    expect(subject.controller.getState().conflictRoomId).toBe('room-conflict-1')

    vi.mocked(subject.client.closeRoom).mockResolvedValueOnce(undefined)
    vi.mocked(subject.client.enableRoom).mockResolvedValueOnce({
      room: room(),
      session: owner,
      recoverySecret: 'secret-new',
    })

    await subject.controller.forceResetAndEnable('Owner')

    expect(subject.client.closeRoom).toHaveBeenCalledWith('room-conflict-1', { force: true })
    expect(subject.controller.getState().status).toBe('synced')
    expect(subject.controller.getState().conflictRoomId).toBeUndefined()
  })
})
