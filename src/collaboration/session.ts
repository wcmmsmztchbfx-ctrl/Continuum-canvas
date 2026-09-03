import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'

import {
  COLLABORATION_MAX_CLIENT_MESSAGE_BYTES,
  COLLABORATION_MAX_SERVER_MESSAGE_BYTES,
  type CollaborationInteraction,
  type CollaborationRole,
  type CollaborationSession,
  type InteractionPreview,
  type NodeLease,
  type NodeLeaseKind,
  type PersonalUndoState,
  type PresenceState,
} from '../contracts/collaboration.ts'
import type { CanvasSnapshotV2 } from '../model/project.ts'
import {
  applyCollaborativeEntityChanges,
  applyCollaborativeCanvasSnapshot,
  applyCollaborativeSnapshotChange,
  createCollaborativeCanvasDocument,
  exportCollaborativeCanvasSnapshot,
  observeCollaborativeEntityChanges,
} from './document.ts'
import {
  hasCanvasEntityChanges,
  type CanvasEntityChangeSet,
} from './entityChanges.ts'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const SOCKET_OPEN = 1
const INITIAL_RECONNECT_DELAY_MS = 250
const MAX_RECONNECT_DELAY_MS = 2_500
const TERMINAL_CLOSE_CODES = new Set([1002, 1003, 1008, 1009])
const MAX_PRESENCE_STATES = 10
const MAX_SELECTION_NODE_IDS = 500
const MAX_NODE_ID_LENGTH = 256
const MAX_COORDINATE = 1_000_000_000
const MAX_ZOOM = 64
const MAX_PREVIEW_NODES = 100
const PRESENCE_THROTTLE_MS = 50
const MAX_LEASE_NODES = 100
const LEASE_TTL_MS = 6_000
const LEASE_HEARTBEAT_MS = 2_000
const LEASE_ID = /^[A-Za-z0-9_-]{16,128}$/

interface WireNodeLease {
  leaseId: string
  nodeIds: string[]
  kind: NodeLeaseKind
  startedAt: number
  heartbeatAt: number
  expiresAt: number
}

interface WirePresenceState {
  memberId: string
  displayName: string
  color: string
  role: CollaborationRole
  cursor?: { x: number; y: number } | null
  selection?: { nodeIds: string[] }
  viewport?: { x: number; y: number; zoom: number }
  interaction?: CollaborationInteraction
  interactionPreview?: InteractionPreview
  lease?: WireNodeLease
}

export type CanvasCollaborationConnectionState =
  | 'connecting'
  | 'synced'
  | 'offline'
  | 'error'

export interface CanvasCollaborationStatus {
  state: CanvasCollaborationConnectionState
  error?: string
}

export interface CollaborationPersistenceHandle {
  whenSynced: Promise<unknown>
  destroy(): Promise<unknown> | unknown
}

export type CollaborationPersistenceFactory = (
  name: string,
  doc: Y.Doc,
) => CollaborationPersistenceHandle

export type CollaborationWebSocket = Pick<
  WebSocket,
  'binaryType' | 'readyState' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'
>

export type CollaborationWebSocketFactory = (url: string) => CollaborationWebSocket

export interface CollaborationTimers {
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(timer: unknown): void
}

export interface CanvasCollaborationSessionOptions {
  roomId: string
  serverSession: CollaborationSession
  /** @deprecated The collaboration room is seeded exclusively by the server. */
  snapshot?: CanvasSnapshotV2
  doc?: Y.Doc
  persistenceFactory?: CollaborationPersistenceFactory
  webSocketFactory?: CollaborationWebSocketFactory
  webSocketUrl?: string
  maxMessageBytes?: number
  maxIncomingMessageBytes?: number
  maxOutgoingMessageBytes?: number
  timers?: CollaborationTimers
  now?: () => number
}

interface SocketListeners {
  socket: CollaborationWebSocket
  generation: number
  open: (event: Event) => void
  message: (event: MessageEvent<unknown>) => void
  error: (event: Event) => void
  close: (event: CloseEvent) => void
}

function defaultPersistenceFactory(name: string, doc: Y.Doc): CollaborationPersistenceHandle {
  return new IndexeddbPersistence(name, doc)
}

function defaultWebSocketFactory(url: string): CollaborationWebSocket {
  return new WebSocket(url)
}

const defaultTimers: CollaborationTimers = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
}

function websocketUrl(roomId: string): string {
  if (!globalThis.location) {
    throw new Error('A WebSocket URL is required outside a browser')
  }
  const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = new URL('/api/collaboration/ws', `${protocol}//${globalThis.location.host}`)
  url.searchParams.set('roomId', roomId)
  return url.toString()
}

function collaborativeRootsAreEmpty(doc: Y.Doc): boolean {
  for (const key of ['meta', 'viewport', 'nodes', 'edges']) doc.getMap(key)
  for (const key of ['nodeOrder', 'edgeOrder']) doc.getArray(key)
  if (doc.share.size === 0) return true
  const allowed = new Set(['meta', 'viewport', 'nodes', 'edges', 'nodeOrder', 'edgeOrder'])
  for (const [key, root] of doc.share.entries()) {
    if (!allowed.has(key)) return false
    if (root instanceof Y.Map && root.size > 0) return false
    if (root instanceof Y.Array && root.length > 0) return false
  }
  return true
}

function persistenceNamespace(session: CollaborationSession): string {
  return [
    'libtv-collaboration',
    session.roomId,
    session.role,
    session.memberId,
  ].join(':')
}

function syncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  return encoding.toUint8Array(encoder)
}

function syncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

function awarenessMessage(awareness: awarenessProtocol.Awareness): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
  )
  return encoding.toUint8Array(encoder)
}

import { getCollaboratorColor } from './colors.ts'

function memberColor(memberId: string): string {
  return getCollaboratorColor(memberId)
}

function validPoint(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const point = value as Record<string, unknown>
  return typeof point.x === 'number' && Number.isFinite(point.x) &&
    Math.abs(point.x) <= MAX_COORDINATE &&
    typeof point.y === 'number' && Number.isFinite(point.y) &&
    Math.abs(point.y) <= MAX_COORDINATE
}

function validViewport(value: unknown): value is { x: number; y: number; zoom: number } {
  if (!validPoint(value)) return false
  const zoom = (value as Record<string, unknown>).zoom
  return typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 && zoom <= MAX_ZOOM
}

function validateNodeIds(value: readonly string[], limit: number): string[] {
  if (value.length > limit) throw new Error(`Presence node selection is limited to ${limit} nodes`)
  const unique = new Set<string>()
  for (const nodeId of value) {
    if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > MAX_NODE_ID_LENGTH) {
      throw new Error('Presence node id is invalid')
    }
    unique.add(nodeId)
  }
  return [...unique]
}

function validateInteractionPreview(value: InteractionPreview): InteractionPreview {
  if (!value || (value.kind !== 'drag' && value.kind !== 'resize') ||
    (value.coordinateSpace !== undefined && value.coordinateSpace !== 'canvas-absolute') ||
    !Array.isArray(value.nodes)) {
    throw new Error('Interaction preview is invalid')
  }
  if (value.nodes.length > MAX_PREVIEW_NODES) {
    throw new Error(`Interaction preview is limited to ${MAX_PREVIEW_NODES} nodes`)
  }
  const nodeIds = validateNodeIds(value.nodes.map((node) => node.nodeId), MAX_PREVIEW_NODES)
  if (nodeIds.length !== value.nodes.length) throw new Error('Interaction preview node ids must be unique')
  return {
    kind: value.kind,
    coordinateSpace: 'canvas-absolute',
    nodes: value.nodes.map((node) => {
      if (node.position !== undefined && !validPoint(node.position)) {
        throw new Error('Interaction preview position is invalid')
      }
      for (const dimension of [node.width, node.height]) {
        if (dimension !== undefined && (
          typeof dimension !== 'number' || !Number.isFinite(dimension) ||
          dimension <= 0 || dimension > MAX_COORDINATE
        )) throw new Error('Interaction preview size is invalid')
      }
      return {
        nodeId: node.nodeId,
        position: node.position ? { ...node.position } : undefined,
        width: node.width,
        height: node.height,
      }
    }),
  }
}

function secureLeaseId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Secure randomness is unavailable for collaboration leases')
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validLeaseTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseWireLease(value: unknown, memberId: string, confirmed: boolean): NodeLease | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const lease = value as Record<string, unknown>
  if (
    typeof lease.leaseId !== 'string' || !LEASE_ID.test(lease.leaseId) ||
    !Array.isArray(lease.nodeIds) || lease.nodeIds.length === 0 ||
    lease.nodeIds.length > MAX_LEASE_NODES ||
    (lease.kind !== 'drag' && lease.kind !== 'resize' && lease.kind !== 'text' &&
      lease.kind !== 'settings' && lease.kind !== 'bulk') ||
    !validLeaseTimestamp(lease.startedAt) || !validLeaseTimestamp(lease.heartbeatAt) ||
    !validLeaseTimestamp(lease.expiresAt) || lease.heartbeatAt < lease.startedAt ||
    lease.expiresAt <= lease.heartbeatAt || lease.expiresAt - lease.heartbeatAt > LEASE_TTL_MS
  ) return undefined
  let nodeIds: string[]
  try {
    nodeIds = validateNodeIds(lease.nodeIds, MAX_LEASE_NODES).sort()
  } catch {
    return undefined
  }
  if (nodeIds.length !== lease.nodeIds.length) return undefined
  return {
    leaseId: lease.leaseId,
    nodeIds,
    memberId,
    kind: lease.kind,
    startedAt: lease.startedAt,
    heartbeatAt: lease.heartbeatAt,
    expiresAt: lease.expiresAt,
    confirmed,
  }
}

function wireLease(lease: NodeLease): WireNodeLease {
  return {
    leaseId: lease.leaseId,
    nodeIds: [...lease.nodeIds],
    kind: lease.kind,
    startedAt: lease.startedAt,
    heartbeatAt: lease.heartbeatAt,
    expiresAt: lease.expiresAt,
  }
}

function compareLeases(left: NodeLease, right: NodeLease): number {
  return left.startedAt - right.startedAt ||
    compareUtf16(left.leaseId, right.leaseId) ||
    compareUtf16(left.memberId, right.memberId)
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function validateInteraction(value: CollaborationInteraction): CollaborationInteraction {
  if (!value || (
    value.kind !== 'idle' && value.kind !== 'dragging' && value.kind !== 'resizing' &&
    value.kind !== 'editing-text' && value.kind !== 'editing-generation'
  ) || !Array.isArray(value.nodeIds)) throw new Error('Collaboration interaction is invalid')
  return { kind: value.kind, nodeIds: validateNodeIds(value.nodeIds, MAX_PREVIEW_NODES) }
}

function parseRemotePresence(clientId: number, value: unknown, now: number): PresenceState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const state = value as Record<string, unknown>
  if (
    typeof state.memberId !== 'string' || state.memberId.length === 0 || state.memberId.length > 128 ||
    typeof state.displayName !== 'string' || state.displayName.length === 0 || state.displayName.length > 32 ||
    (state.role !== 'owner' && state.role !== 'editor' && state.role !== 'viewer') ||
    typeof state.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(state.color)
  ) return undefined
  let nodeIds: string[] = []
  if (state.selection !== undefined) {
    if (!state.selection || typeof state.selection !== 'object' || Array.isArray(state.selection)) return undefined
    const selection = state.selection as Record<string, unknown>
    if (!Array.isArray(selection.nodeIds)) return undefined
    try {
      nodeIds = validateNodeIds(selection.nodeIds, MAX_SELECTION_NODE_IDS)
    } catch {
      return undefined
    }
  }
  if (state.cursor !== undefined && state.cursor !== null && !validPoint(state.cursor)) return undefined
  if (state.viewport !== undefined && !validViewport(state.viewport)) return undefined
  let interactionPreview: InteractionPreview | undefined
  if (state.role !== 'viewer' && state.interactionPreview !== undefined) {
    try {
      interactionPreview = validateInteractionPreview(state.interactionPreview as InteractionPreview)
    } catch {
      return undefined
    }
  }
  let interaction: CollaborationInteraction | undefined
  if (state.interaction !== undefined) {
    try { interaction = validateInteraction(state.interaction as CollaborationInteraction) } catch { return undefined }
  }
  const parsedLease = state.role === 'viewer' || state.lease === undefined
    ? undefined
    : parseWireLease(state.lease, state.memberId, true)
  if (state.role !== 'viewer' && state.lease !== undefined && !parsedLease) return undefined
  const lease = parsedLease && now < parsedLease.expiresAt ? parsedLease : undefined
  return {
    clientId,
    member: {
      memberId: state.memberId,
      displayName: state.displayName,
      role: state.role,
      color: state.color,
    },
    cursor: state.cursor === undefined || state.cursor === null
      ? null
      : { x: state.cursor.x, y: state.cursor.y },
    selection: { nodeIds },
    viewport: state.viewport === undefined
      ? undefined
      : { x: state.viewport.x, y: state.viewport.y, zoom: state.viewport.zoom },
    ...(interaction ? { interaction } : {}),
    ...(interactionPreview ? { interactionPreview } : {}),
    ...(lease ? { lease } : {}),
  }
}

async function binaryMessageData(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer())
  }
  throw new Error('Collaboration WebSocket accepts binary messages only')
}

function applyChangesToPublishedSnapshot(
  snapshot: CanvasSnapshotV2,
  changes: CanvasEntityChangeSet,
): CanvasSnapshotV2 {
  const merge = <T extends { id: string }>(
    current: readonly T[],
    upserted: readonly T[],
    removed: readonly string[],
    order?: readonly string[],
  ): T[] => {
    const removedIds = new Set(removed)
    const updates = new Map(upserted.map((entity) => [entity.id, entity]))
    const merged = current.flatMap((entity) => {
      if (removedIds.has(entity.id)) return []
      const update = updates.get(entity.id)
      if (update) updates.delete(entity.id)
      return [update ?? entity]
    })
    merged.push(...updates.values())
    if (!order) return merged
    const rank = new Map(order.map((id, index) => [id, index]))
    return merged.sort((left, right) =>
      (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )
  }
  return {
    ...snapshot,
    ...(changes.name !== undefined ? { name: changes.name } : {}),
    nodes: merge(snapshot.nodes, changes.nodes.upserted, changes.nodes.removed, changes.nodeOrder),
    edges: merge(snapshot.edges, changes.edges.upserted, changes.edges.removed, changes.edgeOrder),
  }
}

export class CanvasCollaborationSession {
  readonly roomId: string
  readonly serverSession: CollaborationSession

  readonly #document: ReturnType<typeof createCollaborativeCanvasDocument>
  readonly #doc: Y.Doc

  private readonly persistence: CollaborationPersistenceHandle
  private readonly awareness: awarenessProtocol.Awareness
  private readonly webSocketFactory: CollaborationWebSocketFactory
  private readonly url: string
  private readonly maxIncomingMessageBytes: number
  private readonly maxOutgoingMessageBytes: number
  private readonly timers: CollaborationTimers
  private readonly now: () => number
  private readonly remoteOrigin = Object.freeze({ type: 'collaboration-remote' })
  private readonly statusListeners = new Set<(status: CanvasCollaborationStatus) => void>()
  private readonly snapshotListeners = new Set<(snapshot: CanvasSnapshotV2) => void>()
  private readonly entityChangeListeners = new Set<(changes: CanvasEntityChangeSet) => void>()
  private readonly presenceListeners = new Set<(presence: readonly PresenceState[]) => void>()
  private readonly leaseListeners = new Set<(leases: readonly NodeLease[]) => void>()
  private readonly leaseLostListeners = new Set<(lease: NodeLease) => void>()
  private readonly undoStateListeners = new Set<(state: PersonalUndoState) => void>()
  private localPresence: WirePresenceState
  private localLease?: NodeLease
  private socket?: CollaborationWebSocket
  private socketListeners?: SocketListeners
  private socketGeneration = 0
  private hasSynchronizedDocument: boolean
  private reconnectTimer?: unknown
  private presenceThrottleTimer?: unknown
  private leaseHeartbeatTimer?: unknown
  private leaseExpiryTimer?: unknown
  private lastThrottledPresenceAt = Number.NEGATIVE_INFINITY
  private reconnectAttempt = 0
  private stopped = false
  private destroyed = false
  private terminal = false
  private reconcilingLeases = false
  private destroyPromise?: Promise<void>
  private currentStatus: CanvasCollaborationStatus = { state: 'connecting' }
  private stopEntityChanges: () => void = () => undefined
  private publishedSnapshot?: CanvasSnapshotV2
  private pendingEntityChanges: CanvasEntityChangeSet[] = []

  private readonly onAwarenessChange = (): void => {
    if (this.destroyed) return
    this.reconcileLeases()
    this.publishPresence()
  }

  private readonly onUndoStateChange = (): void => {
    if (!this.destroyed) this.publishUndoState()
  }

  private readonly onDocumentUpdate = (update: Uint8Array, origin: unknown): void => {
    if (this.destroyed) return
    if (this.serverSession.role !== 'viewer' && origin !== this.remoteOrigin &&
      origin !== this.persistence &&
      this.socket?.readyState === SOCKET_OPEN) {
      this.send(syncUpdate(update))
    }
    const pending = this.pendingEntityChanges
    this.pendingEntityChanges = []
    for (const changes of pending) this.publishEntityChanges(changes)
  }

  private readonly onBrowserOffline = (): void => {
    if (this.stopped || this.destroyed || this.terminal) return
    this.cancelReconnect()
    this.handleLeaseDisconnect()
    this.detachSocket(true)
    this.setStatus({ state: 'offline' })
  }

  private readonly onBrowserOnline = (): void => {
    if (this.stopped || this.destroyed || this.terminal || this.socket) return
    this.connect()
  }

  private constructor(input: {
    options: CanvasCollaborationSessionOptions
    document: ReturnType<typeof createCollaborativeCanvasDocument>
    persistence: CollaborationPersistenceHandle
    hasCachedSnapshot: boolean
  }) {
    const { options } = input
    this.roomId = options.roomId
    this.serverSession = options.serverSession
    this.#document = input.document
    this.#doc = input.document.doc
    this.persistence = input.persistence
    this.awareness = new awarenessProtocol.Awareness(this.#doc)
    this.awareness.setLocalState(null)
    this.localPresence = {
      memberId: options.serverSession.memberId,
      displayName: options.serverSession.displayName,
      role: options.serverSession.role,
      color: memberColor(options.serverSession.memberId),
    }
    this.awareness.setLocalState(this.localPresence)
    this.awareness.on('change', this.onAwarenessChange)
    this.#document.undoManager.on('stack-item-added', this.onUndoStateChange)
    this.#document.undoManager.on('stack-item-popped', this.onUndoStateChange)
    this.#document.undoManager.on('stack-item-updated', this.onUndoStateChange)
    this.#document.undoManager.on('stack-cleared', this.onUndoStateChange)
    this.hasSynchronizedDocument = input.hasCachedSnapshot
    this.publishedSnapshot = readableSnapshot(this.#document)
    this.stopEntityChanges = observeCollaborativeEntityChanges(
      this.#document,
      (origin) => {
        if (!this.hasSynchronizedDocument) return undefined
        if (origin === this.#document.localOrigin) return 'local'
        return 'remote'
      },
      (changes) => this.pendingEntityChanges.push(changes),
    )
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory
    this.url = options.webSocketUrl ?? (
      options.webSocketFactory && !globalThis.location
        ? `ws://localhost/api/collaboration/ws?roomId=${encodeURIComponent(options.roomId)}`
        : websocketUrl(options.roomId)
    )
    this.maxIncomingMessageBytes = options.maxIncomingMessageBytes
      ?? options.maxMessageBytes
      ?? COLLABORATION_MAX_SERVER_MESSAGE_BYTES
    this.maxOutgoingMessageBytes = options.maxOutgoingMessageBytes
      ?? options.maxMessageBytes
      ?? COLLABORATION_MAX_CLIENT_MESSAGE_BYTES
    this.timers = options.timers ?? defaultTimers
    this.now = options.now ?? Date.now
    this.#doc.on('update', this.onDocumentUpdate)
    globalThis.addEventListener?.('offline', this.onBrowserOffline)
    globalThis.addEventListener?.('online', this.onBrowserOnline)
    this.connect()
  }

  static async create(options: CanvasCollaborationSessionOptions): Promise<CanvasCollaborationSession> {
    if (options.roomId !== options.serverSession.roomId) {
      throw new Error('Collaboration room does not match the authenticated session')
    }
    const externalDoc = options.doc
    const doc = new Y.Doc()
    if (options.serverSession.role === 'viewer' && externalDoc &&
      !collaborativeRootsAreEmpty(externalDoc)) {
      doc.destroy()
      throw new Error('Viewer collaboration sessions require an empty external document')
    }
    if (externalDoc && options.serverSession.role !== 'viewer') {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(externalDoc), 'external-seed')
    }
    const persistenceFactory = options.persistenceFactory ?? defaultPersistenceFactory
    const persistence = persistenceFactory(persistenceNamespace(options.serverSession), doc)
    try {
      await persistence.whenSynced
      const document = createCollaborativeCanvasDocument(undefined, { doc })
      const hasCachedSnapshot = readableSnapshot(document) !== undefined
      return new CanvasCollaborationSession({
        options,
        document,
        persistence,
        hasCachedSnapshot,
      })
    } catch (error) {
      await persistence.destroy()
      doc.destroy()
      throw error
    }
  }

  get status(): CanvasCollaborationStatus {
    return this.currentStatus
  }

  subscribeStatus(listener: (status: CanvasCollaborationStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  subscribeSnapshot(listener: (snapshot: CanvasSnapshotV2) => void): () => void {
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }

  subscribeEntityChanges(listener: (changes: CanvasEntityChangeSet) => void): () => void {
    this.entityChangeListeners.add(listener)
    return () => this.entityChangeListeners.delete(listener)
  }

  subscribePresence(listener: (presence: readonly PresenceState[]) => void): () => void {
    this.presenceListeners.add(listener)
    return () => this.presenceListeners.delete(listener)
  }

  getRemotePresence(): PresenceState[] {
    const presence: PresenceState[] = []
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.awareness.clientID) continue
      const parsed = parseRemotePresence(clientId, state, this.now())
      if (parsed) presence.push(parsed)
      if (presence.length === MAX_PRESENCE_STATES) break
    }
    return structuredClone(presence.sort((left, right) => left.clientId - right.clientId))
  }

  setCursor(cursor: { x: number; y: number } | null): void {
    if (cursor !== null && !validPoint(cursor)) throw new Error('Presence cursor is invalid')
    this.localPresence = { ...this.localPresence, cursor: cursor ? { ...cursor } : null }
    if (cursor === null) this.flushThrottledPresence()
    else this.scheduleThrottledPresence()
  }

  setSelection(nodeIds: readonly string[]): void {
    const valid = validateNodeIds(nodeIds, MAX_SELECTION_NODE_IDS)
    if (
      this.localPresence.selection &&
      JSON.stringify(valid) === JSON.stringify(this.localPresence.selection.nodeIds)
    ) {
      return
    }
    this.updateLocalPresenceImmediately({
      selection: { nodeIds: valid },
    })
  }

  setViewport(viewport: { x: number; y: number; zoom: number }): void {
    if (!validViewport(viewport)) throw new Error('Presence viewport is invalid')
    this.updateLocalPresenceImmediately({ viewport: { ...viewport } })
  }

  setInteraction(interaction: CollaborationInteraction): void {
    this.updateLocalPresenceImmediately({ interaction: validateInteraction(interaction) })
  }

  clearInteraction(): void {
    const presence = { ...this.localPresence }
    delete presence.interaction
    this.localPresence = presence
    this.updateLocalPresenceImmediately({})
  }

  setInteractionPreview(preview: InteractionPreview): void {
    this.assertWritable()
    this.localPresence = {
      ...this.localPresence,
      interactionPreview: validateInteractionPreview(preview),
    }
    this.scheduleThrottledPresence()
  }

  clearPreview(): void {
    const { interactionPreview: _removed, ...presence } = this.localPresence
    this.localPresence = presence
    this.flushThrottledPresence()
  }

  acquireLease(nodeIds: readonly string[], kind: NodeLeaseKind): NodeLease | undefined {
    this.assertWritable()
    if (nodeIds.length < 1 || nodeIds.length > MAX_LEASE_NODES) {
      throw new Error(`A collaboration lease requires 1 to ${MAX_LEASE_NODES} nodes`)
    }
    if (kind !== 'drag' && kind !== 'resize' && kind !== 'text' &&
      kind !== 'settings' && kind !== 'bulk') {
      throw new Error('Collaboration lease kind is invalid')
    }
    const normalized = validateNodeIds(nodeIds, MAX_LEASE_NODES).sort()
    for (const nodeId of normalized) {
      const existing = this.getLease(nodeId)
      if (existing && existing.memberId !== this.serverSession.memberId) return undefined
    }
    if (this.localLease) this.releaseLease()
    const now = this.now()
    this.localLease = {
      leaseId: secureLeaseId(),
      nodeIds: normalized,
      memberId: this.serverSession.memberId,
      kind,
      startedAt: now,
      heartbeatAt: now,
      expiresAt: now + LEASE_TTL_MS,
      confirmed: this.currentStatus.state === 'synced' && this.socket?.readyState === SOCKET_OPEN,
    }
    this.localPresence = { ...this.localPresence, lease: wireLease(this.localLease) }
    this.updateLocalPresenceImmediately({ lease: wireLease(this.localLease) })
    if (this.localLease.confirmed) this.scheduleLeaseHeartbeat()
    return this.localLease ? structuredClone(this.localLease) : undefined
  }

  releaseLease(): void {
    if (!this.localLease) return
    this.clearLocalLease(false)
  }

  subscribeLeases(listener: (leases: readonly NodeLease[]) => void): () => void {
    this.leaseListeners.add(listener)
    return () => this.leaseListeners.delete(listener)
  }

  subscribeLeaseLost(listener: (lease: NodeLease) => void): () => void {
    this.leaseLostListeners.add(listener)
    return () => this.leaseLostListeners.delete(listener)
  }

  getLease(nodeId: string): NodeLease | undefined {
    const lease = this.winningLeases().find((candidate) => candidate.nodeIds.includes(nodeId))
    return lease ? structuredClone(lease) : undefined
  }

  isNodeLockedByOther(nodeId: string): boolean {
    const lease = this.getLease(nodeId)
    return lease !== undefined && lease.memberId !== this.serverSession.memberId
  }

  transact(callback: (doc: Y.Doc) => void): void {
    this.assertWritable()
    this.#document.transact(() => callback(this.#doc))
  }

  applySnapshot(
    snapshot: CanvasSnapshotV2,
    options: { includeViewport?: boolean } = {},
  ): void {
    this.assertWritable()
    this.#document.transact(() => {
      applyCollaborativeCanvasSnapshot(this.#document, snapshot, options)
    })
  }

  applySnapshotChange(previous: CanvasSnapshotV2, next: CanvasSnapshotV2): void {
    this.assertWritable()
    this.#document.transact(() => {
      applyCollaborativeSnapshotChange(this.#document, previous, next)
    })
  }

  applyEntityChanges(changes: CanvasEntityChangeSet): void {
    this.assertWritable()
    this.#document.transact(() => {
      applyCollaborativeEntityChanges(this.#document, changes)
    })
  }

  undo(): void {
    this.assertWritable()
    this.#document.undoManager.undo()
  }

  redo(): void {
    this.assertWritable()
    this.#document.undoManager.redo()
  }

  canUndo(): boolean {
    return this.#document.undoManager.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.#document.undoManager.redoStack.length > 0
  }

  subscribeUndoState(listener: (state: PersonalUndoState) => void): () => void {
    this.undoStateListeners.add(listener)
    return () => this.undoStateListeners.delete(listener)
  }

  getSnapshot(): CanvasSnapshotV2 | undefined {
    return readableSnapshot(this.#document)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.cancelReconnect()
    this.handleLeaseDisconnect()
    this.detachSocket(true)
    if (!this.destroyed) this.setStatus({ state: 'offline' })
  }

  destroy(): Promise<void> {
    this.destroyPromise ??= this.destroyInternal()
    return this.destroyPromise
  }

  private async destroyInternal(): Promise<void> {
    this.cancelLeaseHeartbeat()
    if (this.leaseExpiryTimer !== undefined) {
      this.timers.clearTimeout(this.leaseExpiryTimer)
      this.leaseExpiryTimer = undefined
    }
    this.localLease = undefined
    this.awareness.setLocalState(null)
    if (this.socket?.readyState === SOCKET_OPEN) this.send(awarenessMessage(this.awareness))
    this.destroyed = true
    this.stop()
    this.cancelPresenceThrottle()
    this.stopEntityChanges()
    this.#doc.off('update', this.onDocumentUpdate)
    globalThis.removeEventListener?.('offline', this.onBrowserOffline)
    globalThis.removeEventListener?.('online', this.onBrowserOnline)
    this.statusListeners.clear()
    this.snapshotListeners.clear()
    this.entityChangeListeners.clear()
    this.presenceListeners.clear()
    this.leaseListeners.clear()
    this.leaseLostListeners.clear()
    this.undoStateListeners.clear()
    this.awareness.off('change', this.onAwarenessChange)
    this.#document.undoManager.off('stack-item-added', this.onUndoStateChange)
    this.#document.undoManager.off('stack-item-popped', this.onUndoStateChange)
    this.#document.undoManager.off('stack-item-updated', this.onUndoStateChange)
    this.#document.undoManager.off('stack-cleared', this.onUndoStateChange)
    this.awareness.setLocalState(null)
    this.awareness.destroy()
    await this.persistence.destroy()
    this.#document.destroy()
  }

  private assertWritable(): void {
    if (this.destroyed) throw new Error('Collaboration session is destroyed')
    if (this.serverSession.role === 'viewer') {
      throw new Error('Viewer collaboration sessions are read-only')
    }
  }

  private connect(): void {
    if (this.stopped || this.destroyed || this.terminal) return
    this.cancelReconnect()
    this.setStatus({ state: 'connecting' })
    let socket: CollaborationWebSocket
    try {
      socket = this.webSocketFactory(this.url)
    } catch {
      this.setStatus({ state: 'offline', error: 'Collaboration connection failed' })
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    const generation = ++this.socketGeneration
    const current = () => this.isCurrentSocket(socket, generation)
    const listeners: SocketListeners = {
      socket,
      generation,
      open: () => {
        if (!current()) return
        this.setStatus({ state: 'connecting' })
        this.send(syncStep1(this.#doc))
        this.prepareLeaseReconnect()
        this.commitLocalPresence()
        this.send(awarenessMessage(this.awareness))
      },
      message: (event) => {
        void this.receive(event.data, socket, generation).catch((error: unknown) => {
          if (!current()) return
          this.protocolFailure(
            1002,
            'Invalid collaboration message',
            error instanceof Error ? error.message : 'Invalid collaboration message',
          )
        })
      },
      error: () => {
        if (current() && !this.terminal) {
          this.setStatus({ state: 'offline', error: 'Collaboration connection failed' })
        }
      },
      close: (event) => {
        if (!current()) return
        this.handleLeaseDisconnect()
        if (this.terminal || TERMINAL_CLOSE_CODES.has(event.code ?? 0)) {
          this.terminal = true
          this.setStatus({ state: 'error', error: cleanCloseReason(event.reason) })
          return
        }
        this.setStatus({ state: 'offline' })
        this.scheduleReconnect()
      },
    }
    this.socketListeners = listeners
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('open', listeners.open)
    socket.addEventListener('message', listeners.message)
    socket.addEventListener('error', listeners.error)
    socket.addEventListener('close', listeners.close)
  }

  private detachSocket(close: boolean): void {
    const listeners = this.socketListeners
    const socket = listeners?.socket ?? this.socket
    if (!socket) return
    if (listeners) {
      socket.removeEventListener('open', listeners.open)
      socket.removeEventListener('message', listeners.message)
      socket.removeEventListener('error', listeners.error)
      socket.removeEventListener('close', listeners.close)
    }
    if (close) socket.close(1000, 'Collaboration session stopped')
    this.socketListeners = undefined
    this.socket = undefined
  }

  private isCurrentSocket(socket: CollaborationWebSocket, generation: number): boolean {
    return !this.stopped && !this.destroyed && this.socket === socket &&
      this.socketGeneration === generation
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.stopped || this.destroyed || this.terminal) return
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * (2 ** this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS,
    )
    this.reconnectAttempt += 1
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined
      this.detachSocket(false)
      this.connect()
    }, delay)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === undefined) return
    this.timers.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private send(bytes: Uint8Array): void {
    if (bytes.byteLength > this.maxOutgoingMessageBytes) {
      this.protocolFailure(1009, 'Collaboration message too large', 'Outgoing collaboration message is too large')
      return
    }
    if (this.socket?.readyState === SOCKET_OPEN) {
      const payload = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(payload).set(bytes)
      this.socket.send(payload)
    }
  }

  private async receive(
    value: unknown,
    socket: CollaborationWebSocket,
    generation: number,
  ): Promise<void> {
    const bytes = await binaryMessageData(value)
    if (!this.isCurrentSocket(socket, generation)) return
    if (bytes.byteLength > this.maxIncomingMessageBytes) {
      this.protocolFailure(1009, 'Collaboration message too large', 'Collaboration message is too large')
      return
    }
    const decoder = decoding.createDecoder(bytes)
    const messageType = decoding.readVarUint(decoder)
    if (messageType === MESSAGE_SYNC) {
      const inspector = decoding.createDecoder(bytes)
      decoding.readVarUint(inspector)
      const syncType = decoding.readVarUint(inspector)
      const response = encoding.createEncoder()
      encoding.writeVarUint(response, MESSAGE_SYNC)
      syncProtocol.readSyncMessage(decoder, response, this.#doc, this.remoteOrigin)
      if (this.serverSession.role !== 'viewer' && encoding.length(response) > 1) {
        this.send(encoding.toUint8Array(response))
      }
      if (syncType === syncProtocol.messageYjsSyncStep2) {
        this.reconnectAttempt = 0
        this.hasSynchronizedDocument = true
        if (!this.publishedSnapshot) {
          this.publishedSnapshot = readableSnapshot(this.#document)
        }
        this.setStatus({ state: 'synced' })
        this.confirmLocalLease()
      }
      return
    }
    if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this.remoteOrigin,
      )
      return
    }
    throw new Error('Unknown collaboration message')
  }

  private protocolFailure(code: number, reason: string, detail: string): void {
    if (this.terminal || this.destroyed) return
    this.terminal = true
    this.cancelReconnect()
    this.setStatus({ state: 'error', error: detail })
    this.socket?.close(code, reason)
  }

  private setStatus(status: CanvasCollaborationStatus): void {
    if (this.destroyed) return
    if (this.currentStatus.state === status.state && this.currentStatus.error === status.error) return
    this.currentStatus = status
    for (const listener of this.statusListeners) {
      try {
        listener(status)
      } catch {
        // Status observers are isolated from transport and one another.
      }
    }
  }

  private publishEntityChanges(changes: CanvasEntityChangeSet): void {
    if (!hasCanvasEntityChanges(changes)) return
    for (const listener of this.entityChangeListeners) {
      try {
        listener(structuredClone(changes))
      } catch {
        // Entity change observers are isolated from transport and one another.
      }
    }
    if (this.snapshotListeners.size === 0 || !this.publishedSnapshot) return
    const snapshot = applyChangesToPublishedSnapshot(this.publishedSnapshot, changes)
    this.publishedSnapshot = snapshot
    for (const listener of this.snapshotListeners) {
      try {
        listener(structuredClone(snapshot))
      } catch {
        // Snapshot observers are isolated from transport and one another.
      }
    }
  }

  private leaseCandidates(): NodeLease[] {
    const candidates: NodeLease[] = []
    for (const [clientId, value] of this.awareness.getStates()) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const state = value as Record<string, unknown>
      let lease: NodeLease | undefined
      if (clientId === this.awareness.clientID) {
        lease = this.localLease ? { ...this.localLease, nodeIds: [...this.localLease.nodeIds] } : undefined
      } else if (typeof state.memberId === 'string') {
        lease = parseWireLease(state.lease, state.memberId, true)
      }
      if (!lease) continue
      if (lease.expiresAt <= this.now()) continue
      candidates.push(lease)
    }
    return candidates
  }

  private winningLeases(): NodeLease[] {
    const occupied = new Set<string>()
    const winners: NodeLease[] = []
    for (const lease of this.leaseCandidates().sort(compareLeases)) {
      if (lease.nodeIds.some((nodeId) => occupied.has(nodeId))) continue
      winners.push(lease)
      for (const nodeId of lease.nodeIds) occupied.add(nodeId)
    }
    return winners
  }

  private reconcileLeases(): void {
    if (this.destroyed || this.reconcilingLeases) return
    this.reconcilingLeases = true
    try {
      let winners = this.winningLeases()
      if (this.localLease && !winners.some((lease) => lease.leaseId === this.localLease?.leaseId)) {
        this.clearLocalLease(true)
        winners = this.winningLeases()
      }
      this.scheduleLeaseExpiry()
      this.publishLeases(winners)
    } finally {
      this.reconcilingLeases = false
    }
  }

  private clearLocalLease(lost: boolean): void {
    const lease = this.localLease
    if (!lease) return
    this.cancelLeaseHeartbeat()
    this.localLease = undefined
    const presence = { ...this.localPresence }
    delete presence.lease
    delete presence.interactionPreview
    this.localPresence = presence
    this.cancelPresenceThrottle()
    this.commitLocalPresence()
    if (this.socket?.readyState === SOCKET_OPEN) this.send(awarenessMessage(this.awareness))
    if (lost) {
      for (const listener of this.leaseLostListeners) {
        try { listener(structuredClone(lease)) } catch { /* Lease observers are isolated. */ }
      }
    }
  }

  private publishLeases(leases = this.winningLeases()): void {
    for (const listener of this.leaseListeners) {
      try { listener(structuredClone(leases)) } catch { /* Lease observers are isolated. */ }
    }
  }

  private publishUndoState(): void {
    const state: PersonalUndoState = {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    }
    for (const listener of this.undoStateListeners) {
      try { listener({ ...state }) } catch { /* Undo observers are isolated. */ }
    }
  }

  private scheduleLeaseHeartbeat(): void {
    this.cancelLeaseHeartbeat()
    if (!this.localLease || !this.localLease.confirmed || this.destroyed) return
    this.leaseHeartbeatTimer = this.timers.setTimeout(() => {
      this.leaseHeartbeatTimer = undefined
      if (!this.localLease || this.currentStatus.state !== 'synced') return
      const now = this.now()
      if (now >= this.localLease.expiresAt) {
        this.clearLocalLease(true)
        return
      }
      this.localLease = {
        ...this.localLease,
        heartbeatAt: now,
        expiresAt: now + LEASE_TTL_MS,
      }
      this.localPresence = { ...this.localPresence, lease: wireLease(this.localLease) }
      this.commitLocalPresence()
      if (this.socket?.readyState === SOCKET_OPEN) this.send(awarenessMessage(this.awareness))
      this.scheduleLeaseHeartbeat()
    }, LEASE_HEARTBEAT_MS)
  }

  private cancelLeaseHeartbeat(): void {
    if (this.leaseHeartbeatTimer === undefined) return
    this.timers.clearTimeout(this.leaseHeartbeatTimer)
    this.leaseHeartbeatTimer = undefined
  }

  private scheduleLeaseExpiry(): void {
    if (this.leaseExpiryTimer !== undefined) {
      this.timers.clearTimeout(this.leaseExpiryTimer)
      this.leaseExpiryTimer = undefined
    }
    const nextExpiry = this.leaseCandidates()
      .filter((lease) => lease.memberId !== this.serverSession.memberId && lease.expiresAt > this.now())
      .reduce<number | undefined>((earliest, lease) =>
        earliest === undefined ? lease.expiresAt : Math.min(earliest, lease.expiresAt), undefined)
    if (nextExpiry === undefined) return
    this.leaseExpiryTimer = this.timers.setTimeout(() => {
      this.leaseExpiryTimer = undefined
      this.reconcileLeases()
    }, Math.max(0, nextExpiry - this.now()))
  }

  private handleLeaseDisconnect(): void {
    this.cancelLeaseHeartbeat()
    if (this.localLease) {
      this.localLease = { ...this.localLease, confirmed: false }
      const presence = { ...this.localPresence, lease: wireLease(this.localLease) }
      delete presence.interactionPreview
      this.localPresence = presence
      this.commitLocalPresence()
    }
    const remoteIds = [...this.awareness.getStates().keys()]
      .filter((clientId) => clientId !== this.awareness.clientID)
    if (remoteIds.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, remoteIds, this.remoteOrigin)
    }
    this.reconcileLeases()
  }

  private prepareLeaseReconnect(): void {
    if (!this.localLease) return
    const now = this.now()
    this.localLease = {
      ...this.localLease,
      startedAt: now,
      heartbeatAt: now,
      expiresAt: now + LEASE_TTL_MS,
      confirmed: false,
    }
    this.localPresence = { ...this.localPresence, lease: wireLease(this.localLease) }
  }

  private confirmLocalLease(): void {
    if (!this.localLease) return
    this.localLease = { ...this.localLease, confirmed: true }
    this.reconcileLeases()
    this.scheduleLeaseHeartbeat()
  }

  private updateLocalPresenceImmediately(patch: Partial<WirePresenceState>): void {
    if (this.destroyed) throw new Error('Collaboration session is destroyed')
    this.localPresence = { ...this.localPresence, ...patch }
    this.cancelPresenceThrottle()
    this.commitLocalPresence()
    if (this.socket?.readyState === SOCKET_OPEN) this.send(awarenessMessage(this.awareness))
  }

  private scheduleThrottledPresence(): void {
    if (this.destroyed) throw new Error('Collaboration session is destroyed')
    const remaining = PRESENCE_THROTTLE_MS - (this.now() - this.lastThrottledPresenceAt)
    if (remaining <= 0) {
      this.flushThrottledPresence()
      return
    }
    if (this.presenceThrottleTimer !== undefined) return
    this.presenceThrottleTimer = this.timers.setTimeout(() => {
      this.presenceThrottleTimer = undefined
      this.flushThrottledPresence()
    }, remaining)
  }

  private flushThrottledPresence(): void {
    this.cancelPresenceThrottle()
    this.lastThrottledPresenceAt = this.now()
    this.commitLocalPresence()
    if (this.socket?.readyState === SOCKET_OPEN) this.send(awarenessMessage(this.awareness))
  }

  private cancelPresenceThrottle(): void {
    if (this.presenceThrottleTimer === undefined) return
    this.timers.clearTimeout(this.presenceThrottleTimer)
    this.presenceThrottleTimer = undefined
  }

  private commitLocalPresence(): void {
    this.awareness.setLocalState(this.localPresence)
  }

  private publishPresence(): void {
    const presence = this.getRemotePresence()
    for (const listener of this.presenceListeners) {
      try {
        listener(structuredClone(presence))
      } catch {
        // Presence observers are isolated from transport and one another.
      }
    }
  }
}

function readableSnapshot(
  document: ReturnType<typeof createCollaborativeCanvasDocument>,
): CanvasSnapshotV2 | undefined {
  try {
    return exportCollaborativeCanvasSnapshot(document)
  } catch {
    return undefined
  }
}

function cleanCloseReason(reason: string | undefined): string {
  if (!reason) return 'Collaboration connection closed'
  const normalized = Array.from(reason, (character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127 ? ' ' : character
  }).join('').trim()
  return normalized ? normalized.slice(0, 256) : 'Collaboration connection closed'
}
