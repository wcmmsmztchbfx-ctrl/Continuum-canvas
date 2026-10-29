import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'

import type { CollaborationSession } from '../contracts/collaboration.ts'
import type { CanvasSnapshotV2 } from '../model/project.ts'
import {
  createCollaborativeCanvasDocument,
  exportCollaborativeCanvasSnapshot,
} from './document.ts'
import { getCollaboratorColor } from './colors.ts'
import {
  CanvasCollaborationSession,
  type CollaborationPersistenceHandle,
  type CollaborationWebSocket,
} from './session.ts'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

const snapshot: CanvasSnapshotV2 = {
  version: 2,
  canvasId: 'canvas-alpha',
  projectId: 'project-alpha',
  name: 'Seeded canvas',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
}

const editor: CollaborationSession = {
  roomId: 'room-alpha',
  canvasId: snapshot.canvasId,
  projectId: snapshot.projectId,
  memberId: 'member-editor',
  displayName: 'Editor',
  role: 'editor',
  status: 'connected',
}

type FakeSocketEvent = { code?: number; reason?: string; data?: unknown }
type Listener = (event: FakeSocketEvent) => void

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  binaryType = 'arraybuffer'
  readyState = FakeWebSocket.CONNECTING
  readonly sent: Uint8Array[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []
  private readonly listeners = new Map<string, Set<Listener>>()
  onSend?: (bytes: Uint8Array) => void

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(value: ArrayBufferLike | ArrayBufferView | Blob | string): void {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer)
    this.sent.push(bytes)
    this.onSend?.(bytes)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.readyState = FakeWebSocket.CLOSED
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open', {})
  }

  receive(bytes: Uint8Array): void {
    this.receiveData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  }

  receiveData(data: unknown): void {
    this.emit('message', { data })
  }

  disconnect(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', { code, reason: '' })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function persistence(
  onCreate?: (doc: Y.Doc) => void,
  deferred?: { promise: Promise<void> },
): { handle: CollaborationPersistenceHandle; factory: (name: string, doc: Y.Doc) => CollaborationPersistenceHandle } {
  const handle = {
    whenSynced: deferred?.promise ?? Promise.resolve(),
    destroy: vi.fn(async () => {}),
  }
  return {
    handle,
    factory: vi.fn((_name, doc) => {
      onCreate?.(doc)
      return handle
    }),
  }
}

function attachServer(socket: FakeWebSocket, serverDoc: Y.Doc): void {
  socket.onSend = (bytes) => {
    const decoder = decoding.createDecoder(bytes)
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return
    const response = encoding.createEncoder()
    encoding.writeVarUint(response, MESSAGE_SYNC)
    syncProtocol.readSyncMessage(decoder, response, serverDoc, 'client')
    if (encoding.length(response) > 1) socket.receive(encoding.toUint8Array(response))
  }
  socket.open()
  const initial = encoding.createEncoder()
  encoding.writeVarUint(initial, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(initial, serverDoc)
  socket.receive(encoding.toUint8Array(initial))
}

function socketFactory(sockets: FakeWebSocket[]) {
  return vi.fn<() => CollaborationWebSocket>(() => {
    const socket = new FakeWebSocket()
    sockets.push(socket)
    return socket as unknown as CollaborationWebSocket
  })
}

function syncMessageType(message: Uint8Array): number {
  const decoder = decoding.createDecoder(message)
  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return -1
  return decoding.readVarUint(decoder)
}

function collaborationMessageType(message: Uint8Array): number {
  return decoding.readVarUint(decoding.createDecoder(message))
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

function decodeAwarenessMessage(message: Uint8Array): Record<string, unknown> {
  const decoder = decoding.createDecoder(message)
  expect(decoding.readVarUint(decoder)).toBe(MESSAGE_AWARENESS)
  const awareness = new awarenessProtocol.Awareness(new Y.Doc())
  awareness.setLocalState(null)
  awarenessProtocol.applyAwarenessUpdate(
    awareness,
    decoding.readVarUint8Array(decoder),
    'test',
  )
  const state = [...awareness.getStates().values()][0] as Record<string, unknown>
  awareness.destroy()
  return state
}

function seedDocument(doc: Y.Doc, value: CanvasSnapshotV2 = snapshot): void {
  const source = createCollaborativeCanvasDocument(value)
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source.doc))
  source.destroy()
}

class ManualClock {
  time = 10_000
  private sequence = 0
  private readonly tasks: Array<{
    id: number
    at: number
    callback: () => void
    cancelled: boolean
  }> = []

  readonly timers = {
    setTimeout: (callback: () => void, delay: number) => {
      const task = {
        id: ++this.sequence,
        at: this.time + delay,
        callback,
        cancelled: false,
      }
      this.tasks.push(task)
      return task
    },
    clearTimeout: (timer: unknown) => {
      (timer as typeof this.tasks[number]).cancelled = true
    },
  }

  advance(milliseconds: number): void {
    const target = this.time + milliseconds
    while (true) {
      const task = this.tasks
        .filter((candidate) => !candidate.cancelled && candidate.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0]
      if (!task) break
      task.cancelled = true
      this.time = task.at
      task.callback()
    }
    this.time = target
  }

  sleepAndRun(milliseconds: number): void {
    this.time += milliseconds
    while (true) {
      const task = this.tasks
        .filter((candidate) => !candidate.cancelled && candidate.at <= this.time)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0]
      if (!task) return
      task.cancelled = true
      task.callback()
    }
  }

  activeTimers(): number {
    return this.tasks.filter((task) => !task.cancelled).length
  }
}

class HighFidelityRoom {
  readonly doc = new Y.Doc()
  readonly awareness = new awarenessProtocol.Awareness(this.doc)
  private readonly connections = new Map<FakeWebSocket, {
    session: CollaborationSession
    awarenessClientId?: number
    blockAwareness: boolean
  }>()
  private awarenessPaused = false
  private readonly queuedAwareness: Array<{ socket: FakeWebSocket; bytes: Uint8Array }> = []

  constructor() {
    seedDocument(this.doc)
    this.awareness.setLocalState(null)
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)
      for (const socket of this.connections.keys()) {
        if (socket !== origin && socket.readyState === FakeWebSocket.OPEN) socket.receive(message)
      }
    })
    this.awareness.on('update', ({ added, updated, removed }, origin: unknown) => {
      const changed = added.concat(updated, removed)
      if (changed.length === 0) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
      )
      const bytes = encoding.toUint8Array(encoder)
      for (const socket of this.connections.keys()) {
        if (socket === origin || socket.readyState !== FakeWebSocket.OPEN) continue
        if (this.awarenessPaused) this.queuedAwareness.push({ socket, bytes })
        else socket.receive(bytes)
      }
    })
  }

  factory(session: CollaborationSession, sockets: FakeWebSocket[]) {
    return () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)
      const connection = { session, blockAwareness: false }
      this.connections.set(socket, connection)
      socket.onSend = (bytes) => this.receive(socket, bytes)
      socket.addEventListener('close', () => {
        if (connection.awarenessClientId !== undefined) {
          awarenessProtocol.removeAwarenessStates(
            this.awareness,
            [connection.awarenessClientId],
            socket,
          )
          connection.awarenessClientId = undefined
        }
      })
      return socket as unknown as CollaborationWebSocket
    }
  }

  open(socket: FakeWebSocket): void {
    socket.open()
    const syncEncoder = encoding.createEncoder()
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(syncEncoder, this.doc)
    socket.receive(encoding.toUint8Array(syncEncoder))
    const ownId = this.connections.get(socket)?.awarenessClientId
    const ids = [...this.awareness.getStates().keys()].filter((clientId) => clientId !== ownId)
    if (ids.length === 0) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids),
    )
    socket.receive(encoding.toUint8Array(encoder))
  }

  pauseAwareness(): void {
    this.awarenessPaused = true
  }

  flushAwareness(): void {
    this.awarenessPaused = false
    for (const message of this.queuedAwareness.splice(0)) message.socket.receive(message.bytes)
  }

  blockAwarenessFrom(socket: FakeWebSocket, blocked = true): void {
    const connection = this.connections.get(socket)
    if (connection) connection.blockAwareness = blocked
  }

  destroy(): void {
    this.awareness.destroy()
    this.doc.destroy()
  }

  private receive(socket: FakeWebSocket, bytes: Uint8Array): void {
    const connection = this.connections.get(socket)
    if (!connection) return
    const decoder = decoding.createDecoder(bytes)
    const type = decoding.readVarUint(decoder)
    if (type === MESSAGE_SYNC) {
      const response = encoding.createEncoder()
      encoding.writeVarUint(response, MESSAGE_SYNC)
      syncProtocol.readSyncMessage(decoder, response, this.doc, socket)
      if (encoding.length(response) > 1) socket.receive(encoding.toUint8Array(response))
      return
    }
    if (type !== MESSAGE_AWARENESS || connection.blockAwareness) return
    const update = decoding.readVarUint8Array(decoder)
    const updateDecoder = decoding.createDecoder(update)
    expect(decoding.readVarUint(updateDecoder)).toBe(1)
    const clientId = decoding.readVarUint(updateDecoder)
    const clock = decoding.readVarUint(updateDecoder)
    const value = JSON.parse(decoding.readVarString(updateDecoder)) as Record<string, unknown> | null
    const sanitized = value === null ? null : {
      ...value,
      memberId: connection.session.memberId,
      displayName: connection.session.displayName,
      role: connection.session.role,
      color: getCollaboratorColor(connection.session.memberId),
    }
    const authenticated = encoding.createEncoder()
    encoding.writeVarUint(authenticated, 1)
    encoding.writeVarUint(authenticated, clientId)
    encoding.writeVarUint(authenticated, clock)
    encoding.writeVarString(authenticated, JSON.stringify(sanitized))
    connection.awarenessClientId = clientId
    awarenessProtocol.applyAwarenessUpdate(
      this.awareness,
      encoding.toUint8Array(authenticated),
      socket,
    )
  }
}

async function highFidelityPair(clock = new ManualClock()) {
  const room = new HighFidelityRoom()
  const firstSession = { ...editor, memberId: 'member-first', displayName: 'First' }
  const secondSession = { ...editor, memberId: 'member-second', displayName: 'Second' }
  const firstSockets: FakeWebSocket[] = []
  const secondSockets: FakeWebSocket[] = []
  const first = await CanvasCollaborationSession.create({
    roomId: editor.roomId,
    serverSession: firstSession,
    persistenceFactory: persistence().factory,
    webSocketFactory: room.factory(firstSession, firstSockets),
    timers: clock.timers,
    now: () => clock.time,
  })
  const second = await CanvasCollaborationSession.create({
    roomId: editor.roomId,
    serverSession: secondSession,
    persistenceFactory: persistence().factory,
    webSocketFactory: room.factory(secondSession, secondSockets),
    timers: clock.timers,
    now: () => clock.time,
  })
  room.open(firstSockets[0]!)
  room.open(secondSockets[0]!)
  await vi.waitFor(() => {
    expect(first.status.state).toBe('synced')
    expect(second.status.state).toBe('synced')
  })
  return { room, clock, first, second, firstSockets, secondSockets }
}

function collaborationSocket(socket = new FakeWebSocket()): CollaborationWebSocket {
  return socket as unknown as CollaborationWebSocket
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function sharedBroadcastPersistence() {
  interface Peer {
    doc: Y.Doc
    handle: CollaborationPersistenceHandle
  }
  const channels = new Map<string, { update?: Uint8Array; peers: Set<Peer> }>()
  const factory = (name: string, doc: Y.Doc): CollaborationPersistenceHandle => {
    const channel = channels.get(name) ?? { peers: new Set<Peer>() }
    channels.set(name, channel)
    if (channel.update) Y.applyUpdate(doc, channel.update, 'shared-cache')
    let peer!: Peer
    const handle: CollaborationPersistenceHandle = {
      whenSynced: Promise.resolve(),
      destroy() {
        doc.off('update', onUpdate)
        channel.peers.delete(peer)
      },
    }
    peer = { doc, handle }
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === handle) return
      channel.update = channel.update
        ? Y.mergeUpdates([channel.update, update])
        : update
      for (const candidate of channel.peers) {
        if (candidate !== peer) Y.applyUpdate(candidate.doc, update, candidate.handle)
      }
    }
    doc.on('update', onUpdate)
    channel.peers.add(peer)
    return handle
  }
  return {
    factory,
    read(name: string): Y.Doc {
      const doc = new Y.Doc()
      const update = channels.get(name)?.update
      if (update) Y.applyUpdate(doc, update)
      return doc
    },
  }
}

describe('CanvasCollaborationSession', () => {
  it('flushes preceding local updates only after a matching checkpoint acknowledgment', async () => {
    const sockets: FakeWebSocket[] = []
    const server = createCollaborativeCanvasDocument(snapshot)
    const session = await CanvasCollaborationSession.create({ roomId: editor.roomId, serverSession: editor,
      persistenceFactory: persistence().factory, webSocketFactory: socketFactory(sockets) })
    try {
      const socket = sockets[0]!
      attachServer(socket, server.doc)
      await vi.waitFor(() => expect(session.status.state).toBe('synced'))
      session.applySnapshot({ ...snapshot, name: '已发送的本地修改' })
      const completed = vi.fn()
      const pending = session.flush().then(completed)
      await Promise.resolve()
      expect(completed).not.toHaveBeenCalled()
      const request = decoding.createDecoder(socket.sent.at(-1)!)
      expect(decoding.readVarUint(request)).toBe(2)
      const requestId = decoding.readVarUint(request)
      expect(exportCollaborativeCanvasSnapshot(server).name).toBe('已发送的本地修改')
      const ack = (id: number) => {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, 2); encoding.writeVarUint(encoder, id)
        socket.receive(encoding.toUint8Array(encoder))
      }
      ack(requestId + 1)
      await Promise.resolve(); await Promise.resolve()
      expect(completed).not.toHaveBeenCalled()
      ack(requestId)
      await pending
      expect(completed).toHaveBeenCalledOnce()
    } finally { await session.destroy(); server.destroy() }
  })

  it.each(['disconnect', 'timeout', 'destroy'] as const)('rejects an unacknowledged checkpoint on %s without treating it as saved', async (failure) => {
    const sockets: FakeWebSocket[] = []
    const server = createCollaborativeCanvasDocument(snapshot)
    const clock = new ManualClock()
    const session = await CanvasCollaborationSession.create({ roomId: editor.roomId, serverSession: editor,
      persistenceFactory: persistence().factory, webSocketFactory: socketFactory(sockets), timers: clock.timers })
    try {
      attachServer(sockets[0]!, server.doc)
      await vi.waitFor(() => expect(session.status.state).toBe('synced'))
      const pending = session.flush()
      const rejected = expect(pending).rejects.toThrow()
      if (failure === 'disconnect') sockets[0]!.disconnect()
      else if (failure === 'timeout') clock.advance(15_000)
      else await session.destroy()
      await rejected
    } finally { await session.destroy(); server.destroy() }
  })

  it('lets only the server seed two concurrent first sessions sharing one broadcast cache', async () => {
    const seededSnapshot: CanvasSnapshotV2 = {
      ...snapshot,
      nodes: [{
        id: 'text-1', type: 'text', name: 'Text',
        position: { x: 20, y: 30 }, size: { width: 320, height: 180 },
        data: { text: 'Server seeded' },
      }],
    }
    const shared = sharedBroadcastPersistence()
    const firstSockets: FakeWebSocket[] = []
    const secondSockets: FakeWebSocket[] = []
    const [first, second] = await Promise.all([
      CanvasCollaborationSession.create({
        roomId: editor.roomId,
        serverSession: editor,
        snapshot: seededSnapshot,
        persistenceFactory: shared.factory,
        webSocketFactory: socketFactory(firstSockets),
      }),
      CanvasCollaborationSession.create({
        roomId: editor.roomId,
        serverSession: editor,
        snapshot: seededSnapshot,
        persistenceFactory: shared.factory,
        webSocketFactory: socketFactory(secondSockets),
      }),
    ])

    expect(first.getSnapshot()).toBeUndefined()
    expect(second.getSnapshot()).toBeUndefined()
    firstSockets[0]!.open()
    secondSockets[0]!.open()
    expect(firstSockets[0]!.sent.filter((message) => collaborationMessageType(message) === MESSAGE_SYNC))
      .toHaveLength(1)
    expect(secondSockets[0]!.sent.filter((message) => collaborationMessageType(message) === MESSAGE_SYNC))
      .toHaveLength(1)

    const server = createCollaborativeCanvasDocument(seededSnapshot)
    const expectedSnapshot = exportCollaborativeCanvasSnapshot(server)
    for (const socket of [firstSockets[0]!, secondSockets[0]!]) {
      const step2 = encoding.createEncoder()
      encoding.writeVarUint(step2, MESSAGE_SYNC)
      syncProtocol.writeSyncStep2(step2, server.doc)
      socket.receive(encoding.toUint8Array(step2))
    }
    await vi.waitFor(() => {
      expect(first.status.state).toBe('synced')
      expect(second.status.state).toBe('synced')
    })

    expect(first.getSnapshot()).toEqual(expectedSnapshot)
    expect(second.getSnapshot()).toEqual(expectedSnapshot)
    expect(firstSockets[0]!.sent.map(syncMessageType).filter((type) => type >= 0))
      .toEqual([syncProtocol.messageYjsSyncStep1])
    expect(secondSockets[0]!.sent.map(syncMessageType).filter((type) => type >= 0))
      .toEqual([syncProtocol.messageYjsSyncStep1])
    const cached = shared.read('libtv-collaboration:room-alpha:editor:member-editor')
    expect(cached.getArray('nodeOrder').toArray()).toEqual(['text-1'])

    await first.destroy()
    await second.destroy()
    cached.destroy()
    server.destroy()
  })
  it('waits for the local cache and connects without using the deprecated snapshot seed', async () => {
    const cache = deferred()
    const persistenceState = persistence(undefined, cache)
    const sockets: FakeWebSocket[] = []
    const factory = socketFactory(sockets)
    const creating = CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      persistenceFactory: persistenceState.factory,
      webSocketFactory: factory,
    })

    await Promise.resolve()
    expect(factory).not.toHaveBeenCalled()
    cache.resolve()
    const session = await creating

    expect(session.getSnapshot()).toBeUndefined()
    expect(factory).toHaveBeenCalledTimes(1)
    session.destroy()
  })

  it('uses cached state instead of reinitializing the supplied snapshot', async () => {
    const cached = { ...snapshot, name: 'Cached canvas' }
    const cachedDoc = new Y.Doc()
    const meta = cachedDoc.getMap('meta')
    meta.set('version', 1)
    meta.set('canvasId', cached.canvasId)
    meta.set('projectId', cached.projectId)
    meta.set('name', cached.name)
    cachedDoc.getMap('viewport').set('x', 0)
    cachedDoc.getMap('viewport').set('y', 0)
    cachedDoc.getMap('viewport').set('zoom', 1)
    cachedDoc.getMap('nodes')
    cachedDoc.getMap('edges')
    cachedDoc.getArray('nodeOrder')
    cachedDoc.getArray('edgeOrder')
    const persistenceState = persistence((doc) => Y.applyUpdate(doc, Y.encodeStateAsUpdate(cachedDoc)))

    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      persistenceFactory: persistenceState.factory,
      webSocketFactory: () => collaborationSocket(),
    })

    expect(session.getSnapshot()?.name).toBe('Cached canvas')
    session.destroy()
    cachedDoc.destroy()
  })

  it('speaks the server Yjs sync protocol and excludes remote updates from local undo', async () => {
    const serverDoc = new Y.Doc()
    seedDocument(serverDoc)
    const sockets: FakeWebSocket[] = []
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
    })
    const statuses: string[] = []
    session.subscribeStatus((status) => statuses.push(status.state))
    attachServer(sockets[0]!, serverDoc)

    await vi.waitFor(() => expect(session.status.state).toBe('synced'))
    session.transact((doc) => doc.getMap('meta').set('name', 'Local name'))
    expect(serverDoc.getMap('meta').get('name')).toBe('Local name')

    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(serverDoc))
    const before = Y.encodeStateVector(remote)
    remote.getMap('viewport').set('zoom', 2)
    const remoteMessage = encoding.createEncoder()
    encoding.writeVarUint(remoteMessage, MESSAGE_SYNC)
    syncProtocol.writeUpdate(remoteMessage, Y.encodeStateAsUpdate(remote, before))
    sockets[0]!.receive(encoding.toUint8Array(remoteMessage))

    await vi.waitFor(() => expect(session.getSnapshot()?.viewport.zoom).toBe(2))
    session.undo()
    expect(session.getSnapshot()?.name).toBe('Seeded canvas')
    expect(session.getSnapshot()?.viewport.zoom).toBe(2)
    expect(statuses).toContain('synced')
    session.destroy()
    serverDoc.destroy()
    remote.destroy()
  })

  it('publishes validated presence and isolates remote presence listeners from transport', async () => {
    const sockets: FakeWebSocket[] = []
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
    })
    sockets[0]!.open()
    sockets[0]!.sent.splice(0)
    const before = session.getSnapshot()
    const secondListener = vi.fn()
    session.subscribePresence(() => { throw new Error('broken presence observer') })
    session.subscribePresence(secondListener)

    session.setCursor({ x: 12, y: -8 })
    session.setSelection(['node-a', 'node-b'])
    session.setViewport({ x: 30, y: 40, zoom: 1.5 })
    session.setInteraction({ kind: 'editing-text', nodeIds: ['node-a'] })

    const localPresence = decodeAwarenessMessage(sockets[0]!.sent.at(-1)!)
    expect(Object.keys(localPresence).sort()).toEqual([
      'color', 'cursor', 'displayName', 'interaction', 'memberId', 'role', 'selection', 'viewport',
    ])
    expect(localPresence).toMatchObject({
      memberId: editor.memberId,
      displayName: editor.displayName,
      role: editor.role,
      cursor: { x: 12, y: -8 },
      selection: { nodeIds: ['node-a', 'node-b'] },
      viewport: { x: 30, y: 40, zoom: 1.5 },
      interaction: { kind: 'editing-text', nodeIds: ['node-a'] },
    })

    const remoteDoc = new Y.Doc()
    const remoteAwareness = new awarenessProtocol.Awareness(remoteDoc)
    remoteAwareness.setLocalState({
      memberId: 'member-remote', displayName: 'Remote', role: 'editor', color: getCollaboratorColor('member-remote'),
      cursor: { x: 9, y: 4 }, selection: { nodeIds: ['node-c'] },
      viewport: { x: 5, y: 6, zoom: 2 },
      interaction: { kind: 'dragging', nodeIds: ['node-c'] },
    })
    sockets[0]!.receive(awarenessMessage(remoteAwareness))
    await vi.waitFor(() => expect(secondListener).toHaveBeenCalled())

    expect(session.getRemotePresence()).toEqual([
      expect.objectContaining({
        member: {
          memberId: 'member-remote', displayName: 'Remote', role: 'editor', color: getCollaboratorColor('member-remote'),
        },
        cursor: { x: 9, y: 4 },
        selection: { nodeIds: ['node-c'] },
        viewport: { x: 5, y: 6, zoom: 2 },
        interaction: { kind: 'dragging', nodeIds: ['node-c'] },
      }),
    ])
    expect(session.getSnapshot()).toEqual(before)
    session.undo()
    expect(session.getSnapshot()).toEqual(before)
    expect(sockets[0]!.closes).toEqual([])

    await session.destroy()
    remoteAwareness.destroy()
    remoteDoc.destroy()
  })

  it('lets viewers broadcast basic presence while rejecting invalid values', async () => {
    const sockets: FakeWebSocket[] = []
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: { ...editor, role: 'viewer' },
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
    })
    sockets[0]!.open()
    sockets[0]!.sent.splice(0)

    expect(() => session.setCursor({ x: Number.NaN, y: 0 })).toThrow(/cursor/i)
    expect(() => session.setSelection(Array.from({ length: 501 }, (_, index) => `n-${index}`)))
      .toThrow(/500/)
    expect(() => session.setViewport({ x: 0, y: 0, zoom: Number.POSITIVE_INFINITY }))
      .toThrow(/viewport/i)
    expect(() => session.setInteraction({
      kind: 'dragging',
      nodeIds: Array.from({ length: 101 }, (_, index) => `node-${index}`),
    })).toThrow(/100/)
    session.setCursor({ x: 1, y: 2 })
    session.setSelection(['node-a'])
    session.setViewport({ x: 0, y: 0, zoom: 1 })
    session.setInteraction({ kind: 'idle', nodeIds: [] })
    session.clearInteraction()

    expect(sockets[0]!.sent.some((message) => collaborationMessageType(message) === MESSAGE_AWARENESS))
      .toBe(true)
    await session.destroy()
  })

  it('strips forged viewer leases and previews while preserving basic remote presence', async () => {
    const sockets: FakeWebSocket[] = []
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId, serverSession: editor,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
      now: () => 10_000,
    })
    sockets[0]!.open()
    const remote = new awarenessProtocol.Awareness(new Y.Doc())
    remote.setLocalState({
      memberId: 'viewer-member', displayName: 'Viewer', role: 'viewer', color: getCollaboratorColor('viewer-member'),
      cursor: { x: 1, y: 2 }, selection: { nodeIds: ['node-a'] },
      viewport: { x: 3, y: 4, zoom: 1 },
      interaction: { kind: 'idle', nodeIds: [] },
      interactionPreview: { kind: 'drag', coordinateSpace: 'canvas-absolute', nodes: [{ nodeId: 'node-a', position: { x: 9, y: 9 } }] },
      lease: {
        leaseId: 'forged-viewer-lease', nodeIds: ['node-a'], kind: 'drag',
        startedAt: 9_000, heartbeatAt: 9_000, expiresAt: 15_000,
      },
    })
    sockets[0]!.receive(awarenessMessage(remote))
    await vi.waitFor(() => expect(session.getRemotePresence()).toHaveLength(1))
    expect(session.getRemotePresence()[0]).toMatchObject({
      member: { role: 'viewer' }, cursor: { x: 1, y: 2 },
      selection: { nodeIds: ['node-a'] }, viewport: { x: 3, y: 4, zoom: 1 },
      interaction: { kind: 'idle', nodeIds: [] },
    })
    expect(session.getRemotePresence()[0]).not.toHaveProperty('interactionPreview')
    expect(session.getRemotePresence()[0]).not.toHaveProperty('lease')
    await session.destroy()
    remote.destroy()
  })

  it('performance gate: throttles cursor and preview updates to 20Hz while flushing final cleared values', async () => {
    let now = 0
    const scheduled: Array<{
      at: number
      callback: () => void
      cancelled: boolean
    }> = []
    const runUntil = (time: number) => {
      while (true) {
        const next = scheduled
          .filter((timer) => !timer.cancelled && timer.at <= time)
          .sort((left, right) => left.at - right.at)[0]
        if (!next) break
        next.cancelled = true
        now = next.at
        next.callback()
      }
      now = time
    }
    const sockets: FakeWebSocket[] = []
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
      now: () => now,
      timers: {
        setTimeout(callback, delay) {
          const timer = { at: now + delay, callback, cancelled: false }
          scheduled.push(timer)
          return timer
        },
        clearTimeout(timer) { (timer as typeof scheduled[number]).cancelled = true },
      },
    })
    sockets[0]!.open()
    sockets[0]!.sent.splice(0)

    session.setCursor({ x: 0, y: 0 })
    for (let index = 1; index <= 10; index += 1) {
      now = index * 4
      session.setCursor({ x: index, y: index * 2 })
      session.setInteractionPreview({
        kind: 'drag', coordinateSpace: 'canvas-absolute', nodes: [{ nodeId: 'node-a', position: { x: index, y: index } }],
      })
    }
    expect(sockets[0]!.sent.filter((message) => collaborationMessageType(message) === MESSAGE_AWARENESS))
      .toHaveLength(1)

    runUntil(50)
    const awarenessMessages = sockets[0]!.sent
      .filter((message) => collaborationMessageType(message) === MESSAGE_AWARENESS)
    expect(awarenessMessages).toHaveLength(2)
    expect(decodeAwarenessMessage(awarenessMessages[1]!)).toMatchObject({
      cursor: { x: 10, y: 20 },
      interactionPreview: {
        kind: 'drag', coordinateSpace: 'canvas-absolute', nodes: [{ nodeId: 'node-a', position: { x: 10, y: 10 } }],
      },
    })

    now = 60
    session.setCursor({ x: 99, y: 99 })
    session.setCursor(null)
    session.setInteractionPreview({
      kind: 'resize', coordinateSpace: 'canvas-absolute', nodes: [{ nodeId: 'node-a', width: 320, height: 180 }],
    })
    session.clearPreview()
    const finalState = decodeAwarenessMessage(sockets[0]!.sent.at(-1)!)
    expect(finalState.cursor).toBeNull()
    expect(finalState).not.toHaveProperty('interactionPreview')

    await session.destroy()
  })

  it('rejects viewer previews and preview payloads above one hundred nodes', async () => {
    const owner = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      persistenceFactory: persistence().factory,
      webSocketFactory: () => collaborationSocket(),
    })
    expect(() => owner.setInteractionPreview({
      kind: 'drag',
      coordinateSpace: 'canvas-absolute',
      nodes: Array.from({ length: 101 }, (_, index) => ({
        nodeId: `node-${index}`, position: { x: index, y: index },
      })),
    })).toThrow(/100/)
    await owner.destroy()

    const viewer = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: { ...editor, role: 'viewer' },
      persistenceFactory: persistence().factory,
      webSocketFactory: () => collaborationSocket(),
    })
    expect(() => viewer.setInteractionPreview({
      kind: 'drag', coordinateSpace: 'canvas-absolute', nodes: [{ nodeId: 'node-a', position: { x: 1, y: 1 } }],
    })).toThrow(/viewer/i)
    await viewer.destroy()
  })

  it('allows parallel leases and converges simultaneous claims to one deterministic winner', async () => {
    const { room, first, second, firstSockets, secondSockets } = await highFidelityPair()
    const firstLost = vi.fn()
    const secondLost = vi.fn()
    first.subscribeLeaseLost(firstLost)
    second.subscribeLeaseLost(() => { throw new Error('broken lease-lost observer') })
    second.subscribeLeaseLost(secondLost)

    const firstParallel = first.acquireLease(['node-a'], 'drag')
    const secondParallel = second.acquireLease(['node-b'], 'resize')
    expect(firstParallel?.confirmed).toBe(true)
    expect(secondParallel?.confirmed).toBe(true)
    await vi.waitFor(() => {
      expect(first.getLease('node-b')?.memberId).toBe('member-second')
      expect(second.getLease('node-a')?.memberId).toBe('member-first')
    })
    expect(first.isNodeLockedByOther('node-a')).toBe(false)
    expect(first.isNodeLockedByOther('node-b')).toBe(true)
    first.releaseLease()
    second.releaseLease()

    room.pauseAwareness()
    first.setInteractionPreview({
      kind: 'drag', coordinateSpace: 'canvas-absolute', nodes: [{ nodeId: 'node-shared', position: { x: 1, y: 1 } }],
    })
    second.setInteractionPreview({
      kind: 'drag', coordinateSpace: 'canvas-absolute', nodes: [{ nodeId: 'node-shared', position: { x: 2, y: 2 } }],
    })
    const firstClaim = first.acquireLease(['node-shared'], 'drag')!
    const secondClaim = second.acquireLease(['node-shared'], 'drag')!
    const expectedWinner = [firstClaim, secondClaim].sort((left, right) =>
      left.startedAt - right.startedAt ||
      left.leaseId.localeCompare(right.leaseId) ||
      left.memberId.localeCompare(right.memberId),
    )[0]!
    room.flushAwareness()

    await vi.waitFor(() => {
      expect(first.getLease('node-shared')?.memberId).toBe(expectedWinner.memberId)
      expect(second.getLease('node-shared')?.memberId).toBe(expectedWinner.memberId)
      expect(firstLost.mock.calls.length + secondLost.mock.calls.length).toBe(1)
    })
    const loserSocket = expectedWinner.memberId === 'member-first'
      ? secondSockets[0]!
      : firstSockets[0]!
    const loserPresence = decodeAwarenessMessage(loserSocket.sent.at(-1)!)
    expect(loserPresence).not.toHaveProperty('lease')
    expect(loserPresence).not.toHaveProperty('interactionPreview')
    expect(firstSockets[0]!.closes).toEqual([])
    expect(secondSockets[0]!.closes).toEqual([])

    await first.destroy()
    await second.destroy()
    room.destroy()
  })

  it('orders simultaneous leases without consulting the process locale', async () => {
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => { throw new Error('locale must not be consulted') })
    try {
      const { room, first, second } = await highFidelityPair()
      room.pauseAwareness()
      const firstClaim = first.acquireLease(['node-shared'], 'drag')!
      const secondClaim = second.acquireLease(['node-shared'], 'drag')!
      room.flushAwareness()
      await vi.waitFor(() => {
        expect(first.getLease('node-shared')?.leaseId)
          .toBe(firstClaim.leaseId < secondClaim.leaseId ? firstClaim.leaseId : secondClaim.leaseId)
        expect(second.getLease('node-shared')?.leaseId)
          .toBe(first.getLease('node-shared')?.leaseId)
      })
      await first.destroy()
      await second.destroy()
      room.destroy()
    } finally {
      localeCompare.mockRestore()
    }
  })

  it('normalizes batch leases and rejects the whole batch when one node is unavailable', async () => {
    const { room, first, second } = await highFidelityPair()
    expect(() => first.acquireLease([], 'bulk')).toThrow(/1.*100/)
    expect(() => first.acquireLease(
      Array.from({ length: 101 }, (_, index) => `node-${index}`),
      'bulk',
    )).toThrow(/1.*100/)
    first.acquireLease(['node-b'], 'settings')
    await vi.waitFor(() => expect(second.getLease('node-b')).toBeDefined())

    expect(second.acquireLease(['node-c', 'node-b', 'node-c'], 'bulk')).toBeUndefined()
    expect(second.getLease('node-c')).toBeUndefined()
    first.releaseLease()
    const normalized = second.acquireLease(['node-c', 'node-a', 'node-c'], 'bulk')
    expect(normalized?.nodeIds).toEqual(['node-a', 'node-c'])

    await first.destroy()
    await second.destroy()
    room.destroy()
  })

  it('heartbeats leases and ignores stale remote claims after the six second TTL', async () => {
    const { room, clock, first, second, firstSockets } = await highFidelityPair()
    const leaseChanges = vi.fn()
    second.subscribeLeases(() => { throw new Error('broken lease observer') })
    second.subscribeLeases(leaseChanges)
    first.acquireLease(['node-a'], 'text')
    await vi.waitFor(() => expect(second.getLease('node-a')).toBeDefined())
    const initial = second.getLease('node-a')!
    firstSockets[0]!.sent.splice(0)
    room.blockAwarenessFrom(firstSockets[0]!)

    clock.advance(1_999)
    expect(firstSockets[0]!.sent).toHaveLength(0)
    clock.advance(1)
    expect(firstSockets[0]!.sent.filter((message) => collaborationMessageType(message) === MESSAGE_AWARENESS))
      .toHaveLength(1)
    expect(first.getLease('node-a')!.heartbeatAt).toBeGreaterThan(initial.heartbeatAt)

    clock.advance(4_001)
    expect(second.getLease('node-a')).toBeUndefined()
    expect(second.getRemotePresence().find((presence) => presence.member.memberId === 'member-first')?.lease)
      .toBeUndefined()
    expect(leaseChanges).toHaveBeenCalled()

    await first.destroy()
    await second.destroy()
    room.destroy()
  })

  it('loses a local lease after sleeping past TTL and never revives its old claim', async () => {
    const { room, clock, first, second, firstSockets } = await highFidelityPair()
    const lost = vi.fn()
    first.subscribeLeaseLost(lost)
    first.setInteractionPreview({
      kind: 'drag', coordinateSpace: 'canvas-absolute', nodes: [{ nodeId: 'node-a', position: { x: 1, y: 1 } }],
    })
    const oldLease = first.acquireLease(['node-a'], 'drag')!
    await vi.waitFor(() => expect(second.getLease('node-a')).toBeDefined())
    room.blockAwarenessFrom(firstSockets[0]!)

    clock.sleepAndRun(6_001)
    expect(first.getLease('node-a')).toBeUndefined()
    expect(lost).toHaveBeenCalledWith(expect.objectContaining({ leaseId: oldLease.leaseId }))
    const replacement = second.acquireLease(['node-a'], 'drag')
    expect(replacement).toBeDefined()
    expect(replacement?.leaseId).not.toBe(oldLease.leaseId)
    const localPresence = decodeAwarenessMessage(firstSockets[0]!.sent.at(-1)!)
    expect(localPresence).not.toHaveProperty('lease')
    expect(localPresence).not.toHaveProperty('interactionPreview')

    await first.destroy()
    await second.destroy()
    room.destroy()
  })

  it('marks a disconnected lease unconfirmed and republishes it when reconnected', async () => {
    const { room, clock, first, second, firstSockets } = await highFidelityPair()
    first.acquireLease(['node-a'], 'drag')
    await vi.waitFor(() => expect(second.getLease('node-a')).toBeDefined())

    firstSockets[0]!.disconnect()
    await vi.waitFor(() => expect(second.getLease('node-a')).toBeUndefined())
    expect(first.getLease('node-a')).toMatchObject({
      memberId: 'member-first', confirmed: false,
    })

    clock.advance(250)
    expect(firstSockets).toHaveLength(2)
    room.open(firstSockets[1]!)
    await vi.waitFor(() => {
      expect(first.status.state).toBe('synced')
      expect(first.getLease('node-a')?.confirmed).toBe(true)
      expect(second.getLease('node-a')?.memberId).toBe('member-first')
    })

    await first.destroy()
    await second.destroy()
    room.destroy()
  })

  it('rejects viewer claims and releases awareness leases and heartbeat timers on dispose', async () => {
    const clock = new ManualClock()
    const room = new HighFidelityRoom()
    const viewerSession = { ...editor, memberId: 'member-viewer', role: 'viewer' as const }
    const viewerSockets: FakeWebSocket[] = []
    const viewer = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: viewerSession,
      persistenceFactory: persistence().factory,
      webSocketFactory: room.factory(viewerSession, viewerSockets),
      timers: clock.timers,
      now: () => clock.time,
    })
    room.open(viewerSockets[0]!)
    expect(() => viewer.acquireLease(['node-a'], 'drag')).toThrow(/viewer/i)
    await viewer.destroy()

    const pair = await highFidelityPair(clock)
    pair.first.acquireLease(['node-a'], 'drag')
    await vi.waitFor(() => expect(pair.second.getLease('node-a')).toBeDefined())
    const sentBeforeDispose = pair.firstSockets[0]!.sent.length
    await pair.first.destroy()
    await vi.waitFor(() => expect(pair.second.getLease('node-a')).toBeUndefined())
    clock.advance(10_000)
    expect(pair.firstSockets[0]!.sent).toHaveLength(sentBeforeDispose + 1)

    await pair.second.destroy()
    pair.room.destroy()
    room.destroy()
  })

  it('exposes personal undo state without counting or undoing remote transactions', async () => {
    const { room, first, second } = await highFidelityPair()
    const undoStates = vi.fn()
    first.subscribeUndoState(() => { throw new Error('broken undo observer') })
    first.subscribeUndoState(undoStates)
    expect(first.canUndo()).toBe(false)
    expect(first.canRedo()).toBe(false)

    first.transact((doc) => doc.getMap('meta').set('name', 'First local name'))
    await vi.waitFor(() => expect(second.getSnapshot()?.name).toBe('First local name'))
    expect(first.canUndo()).toBe(true)
    expect(second.canUndo()).toBe(false)

    second.transact((doc) => doc.getMap('viewport').set('zoom', 2))
    await vi.waitFor(() => expect(first.getSnapshot()?.viewport.zoom).toBe(2))
    expect(first.canUndo()).toBe(true)
    first.undo()
    expect(first.getSnapshot()?.name).toBe('Seeded canvas')
    expect(first.getSnapshot()?.viewport.zoom).toBe(2)
    expect(first.canRedo()).toBe(true)
    expect(undoStates).toHaveBeenCalled()

    await first.destroy()
    await second.destroy()
    room.destroy()
  })

  it('excludes task and restore origins from personal undo and removes undo observers on dispose', async () => {
    const external = createCollaborativeCanvasDocument(snapshot)
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      doc: external.doc,
      persistenceFactory: persistence().factory,
      webSocketFactory: () => collaborationSocket(),
    })
    const states = vi.fn()
    session.subscribeUndoState(states)

    external.doc.transact(() => external.doc.getMap('meta').set('name', 'Task result'), 'task')
    external.doc.transact(() => external.doc.getMap('viewport').set('zoom', 2), 'restore')
    expect(session.canUndo()).toBe(false)
    expect(states).not.toHaveBeenCalled()

    session.transact((doc) => doc.getMap('meta').set('name', 'Local edit'))
    expect(session.canUndo()).toBe(true)
    expect(states).toHaveBeenCalled()
    const callsBeforeDispose = states.mock.calls.length
    await session.destroy()
    external.doc.transact(() => external.doc.getMap('meta').set('name', 'After dispose'), 'task')
    expect(states).toHaveBeenCalledTimes(callsBeforeDispose)
    external.destroy()
  })

  it('copies an external editor document once and never retains the caller document', async () => {
    const external = createCollaborativeCanvasDocument(snapshot)
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId, serverSession: editor, doc: external.doc,
      persistenceFactory: persistence().factory,
      webSocketFactory: () => collaborationSocket(),
    })
    external.transact(() => external.doc.getMap('meta').set('name', 'External mutation'))
    expect(session.getSnapshot()?.name).toBe('Seeded canvas')
    session.transact((doc) => doc.getMap('meta').set('name', 'Session mutation'))
    expect(external.doc.getMap('meta').get('name')).toBe('External mutation')
    await session.destroy()
    expect(() => external.doc.getMap('meta').set('after-dispose', true)).not.toThrow()
    external.destroy()
  })

  it('isolates failing status listeners from transport and stops notifications after destroy', async () => {
    const serverDoc = new Y.Doc()
    seedDocument(serverDoc)
    const sockets: FakeWebSocket[] = []
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
    })
    const observed: string[] = []
    session.subscribeStatus((status) => {
      if (status.state === 'synced') throw new Error('broken status observer')
    })
    session.subscribeStatus((status) => observed.push(status.state))

    attachServer(sockets[0]!, serverDoc)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(observed).toContain('synced')
    expect(session.status.state).toBe('synced')
    expect(sockets[0]!.closes).toEqual([])

    const notificationCount = observed.length
    await session.destroy()
    sockets[0]!.disconnect()
    sockets[0]!.receive(new Uint8Array([99]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(observed).toHaveLength(notificationCount)
    serverDoc.destroy()
  })

  it('keeps disconnected edits and uploads them after bounded exponential reconnect', async () => {
    const timers: Array<{ delay: number; callback: () => void; cancelled: boolean }> = []
    const sockets: FakeWebSocket[] = []
    const serverDoc = new Y.Doc()
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
      timers: {
        setTimeout(callback, delay) {
          const timer = { callback, delay, cancelled: false }
          timers.push(timer)
          return timer
        },
        clearTimeout(timer) { (timer as typeof timers[number]).cancelled = true },
      },
    })
    attachServer(sockets[0]!, serverDoc)
    sockets[0]!.disconnect()
    expect(session.status.state).toBe('offline')
    expect(timers[0]?.delay).toBe(250)

    session.transact((doc) => doc.getMap('meta').set('name', 'Edited offline'))
    timers[0]!.callback()
    attachServer(sockets[1]!, serverDoc)

    await vi.waitFor(() => expect(session.status.state).toBe('synced'))
    expect(serverDoc.getMap('meta').get('name')).toBe('Edited offline')
    session.destroy()
    serverDoc.destroy()
  })

  it('merges offline Y.Text edits with concurrent online text edits after reconnect', async () => {
    const { room, clock, first, second, secondSockets } = await highFidelityPair()
    const seeded: CanvasSnapshotV2 = {
      ...snapshot,
      nodes: [
        {
          id: 'text-a', type: 'text', name: 'Text A',
          position: { x: 20, y: 30 }, size: { width: 320, height: 180 },
          data: { text: 'First original' },
        },
        {
          id: 'text-b', type: 'text', name: 'Text B',
          position: { x: 380, y: 30 }, size: { width: 320, height: 180 },
          data: { text: 'Second original' },
        },
      ],
    }
    first.applySnapshot(seeded)
    await vi.waitFor(() => expect(second.getSnapshot()?.nodes).toHaveLength(2))

    secondSockets[0]!.disconnect()
    expect(second.status.state).toBe('offline')

    const offlineBefore = second.getSnapshot()!
    second.applySnapshotChange(offlineBefore, {
      ...offlineBefore,
      nodes: offlineBefore.nodes.map((node) => node.id === 'text-b'
        ? { ...node, data: { ...node.data, text: 'Edited offline' } }
        : node),
    })
    const onlineBefore = first.getSnapshot()!
    first.applySnapshotChange(onlineBefore, {
      ...onlineBefore,
      nodes: onlineBefore.nodes.map((node) => node.id === 'text-a'
        ? { ...node, data: { ...node.data, text: 'Edited online' } }
        : node),
    })

    clock.advance(250)
    room.open(secondSockets[1]!)

    await vi.waitFor(() => {
      expect(first.getSnapshot()?.nodes.map((node) => node.data.text))
        .toEqual(['Edited online', 'Edited offline'])
      expect(second.getSnapshot()?.nodes.map((node) => node.data.text))
        .toEqual(['Edited online', 'Edited offline'])
    })

    await first.destroy()
    await second.destroy()
    room.destroy()
  })

  it('does not send document updates for viewer sessions', async () => {
    const sockets: FakeWebSocket[] = []
    const viewer = { ...editor, role: 'viewer' as const }
    const session = await CanvasCollaborationSession.create({
      roomId: viewer.roomId,
      serverSession: viewer,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
    })
    sockets[0]!.open()
    const sentBeforeMutation = sockets[0]!.sent.length

    expect(() => session.transact((doc) => doc.getMap('meta').set('name', 'Forbidden')))
      .toThrow(/viewer/i)
    expect(sockets[0]!.sent).toHaveLength(sentBeforeMutation)
    session.destroy()
  })

  it('bounds protocol input and treats malformed messages as terminal errors', async () => {
    const sockets: FakeWebSocket[] = []
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      maxMessageBytes: 8,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
    })
    sockets[0]!.open()
    sockets[0]!.receive(new Uint8Array(9))
    await vi.waitFor(() => expect(sockets[0]!.closes.at(-1)).toEqual({
      code: 1009, reason: 'Collaboration message too large',
    }))
    expect(session.status.state).toBe('error')

    const malformedSockets: FakeWebSocket[] = []
    const malformed = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(malformedSockets),
    })
    malformedSockets[0]!.open()
    malformedSockets[0]!.receive(new Uint8Array([99]))
    await vi.waitFor(() => expect(malformedSockets[0]!.closes.at(-1)?.code).toBe(1002))
    expect(malformed.status.state).toBe('error')
    session.destroy()
    malformed.destroy()
  })

  it('accepts a valid initial room snapshot larger than one MiB', async () => {
    const sockets: FakeWebSocket[] = []
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
    })
    const largeText = 'x'.repeat(1_100_000)
    const largeServer = createCollaborativeCanvasDocument({
      ...snapshot,
      nodes: [{
        id: 'large-text', type: 'text', name: 'Large text',
        position: { x: 0, y: 0 }, size: { width: 320, height: 180 },
        data: { text: largeText },
      }],
    })
    const step2 = encoding.createEncoder()
    encoding.writeVarUint(step2, MESSAGE_SYNC)
    syncProtocol.writeSyncStep2(step2, largeServer.doc)
    const message = encoding.toUint8Array(step2)
    expect(message.byteLength).toBeGreaterThan(1024 * 1024)

    sockets[0]!.open()
    sockets[0]!.receive(message)
    await vi.waitFor(() => expect(session.status.state).toBe('synced'))
    expect(session.getSnapshot()?.nodes[0]?.data.text).toHaveLength(largeText.length)

    await session.destroy()
    largeServer.destroy()
  })

  it('uploads a valid offline difference larger than one MiB during resynchronization', async () => {
    const sockets: FakeWebSocket[] = []
    const largeText = 'x'.repeat(1_100_000)
    const offline = createCollaborativeCanvasDocument({
      ...snapshot,
      nodes: [{
        id: 'large-offline-text', type: 'text', name: 'Large offline text',
        position: { x: 0, y: 0 }, size: { width: 320, height: 180 },
        data: { text: largeText },
      }],
    })
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      doc: offline.doc,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
    })
    const serverDoc = new Y.Doc()

    attachServer(sockets[0]!, serverDoc)

    await vi.waitFor(() => expect(session.status.state).toBe('synced'))
    const largeUpload = sockets[0]!.sent.find((message) => message.byteLength > 1024 * 1024)
    expect(largeUpload).toBeDefined()
    expect(session.status.state).not.toBe('error')
    const serverDocument = createCollaborativeCanvasDocument(undefined, { doc: serverDoc })
    expect(exportCollaborativeCanvasSnapshot(serverDocument).nodes[0]?.data.text)
      .toHaveLength(largeText.length)

    await session.destroy()
    serverDocument.destroy()
    offline.destroy()
  })

  it('disposes persistence, listeners, reconnect timers and preserves an external Y.Doc', async () => {
    const externalDoc = new Y.Doc()
    const timers: Array<{ callback: () => void; cancelled: boolean }> = []
    const persistenceState = persistence()
    const sockets: FakeWebSocket[] = []
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      doc: externalDoc,
      persistenceFactory: persistenceState.factory,
      webSocketFactory: socketFactory(sockets),
      timers: {
        setTimeout(callback) {
          const timer = { callback, cancelled: false }
          timers.push(timer)
          return timer
        },
        clearTimeout(timer) { (timer as typeof timers[number]).cancelled = true },
      },
    })
    sockets[0]!.open()
    sockets[0]!.disconnect()

    await session.destroy()
    expect(timers[0]?.cancelled).toBe(true)
    expect(persistenceState.handle.destroy).toHaveBeenCalledTimes(1)
    expect(sockets[0]!.closes.at(-1)?.code).toBe(1000)
    expect(() => externalDoc.getMap('after-dispose').set('alive', true)).not.toThrow()
    externalDoc.destroy()
  })

  it('restores a refreshed session from persistent cache without seeding twice', async () => {
    let storedUpdate: Uint8Array | undefined
    const seedUpdates: number[] = []
    const persistenceFactory = vi.fn((_name: string, doc: Y.Doc) => {
      if (storedUpdate) Y.applyUpdate(doc, storedUpdate, 'indexeddb-cache')
      let observed = 0
      const onUpdate = () => {
        observed += 1
        storedUpdate = Y.encodeStateAsUpdate(doc)
      }
      doc.on('update', onUpdate)
      return {
        whenSynced: Promise.resolve(),
        destroy() {
          doc.off('update', onUpdate)
          seedUpdates.push(observed)
        },
      }
    })

    const firstSockets: FakeWebSocket[] = []
    const first = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      persistenceFactory,
      webSocketFactory: socketFactory(firstSockets),
    })
    const server = createCollaborativeCanvasDocument(snapshot)
    firstSockets[0]!.open()
    const step2 = encoding.createEncoder()
    encoding.writeVarUint(step2, MESSAGE_SYNC)
    syncProtocol.writeSyncStep2(step2, server.doc)
    firstSockets[0]!.receive(encoding.toUint8Array(step2))
    await vi.waitFor(() => expect(first.getSnapshot()).toEqual({ ...snapshot, version: 3 }))
    await first.destroy()

    const refreshed = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot: { ...snapshot, name: 'Must not reseed' },
      persistenceFactory,
      webSocketFactory: () => collaborationSocket(),
    })
    expect(refreshed.getSnapshot()).toEqual({ ...snapshot, version: 3 })
    await refreshed.destroy()

    expect(seedUpdates).toEqual([1, 0])
    server.destroy()
  })

  it('caps consecutive reconnect delays at 2500ms', async () => {
    const timers: Array<{ delay: number; callback: () => void; cancelled: boolean }> = []
    const sockets: FakeWebSocket[] = []
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
      timers: {
        setTimeout(callback, delay) {
          const timer = { callback, delay, cancelled: false }
          timers.push(timer)
          return timer
        },
        clearTimeout(timer) { (timer as typeof timers[number]).cancelled = true },
      },
    })

    for (let attempt = 0; attempt < 6; attempt += 1) {
      sockets[attempt]!.disconnect()
      timers[attempt]!.callback()
    }

    expect(timers.map((timer) => timer.delay)).toEqual([250, 500, 1000, 2000, 2500, 2500])
    await session.destroy()
  })

  it('marks a viewer synced from server step2 without ever sending a document update', async () => {
    const sockets: FakeWebSocket[] = []
    const viewer = { ...editor, role: 'viewer' as const }
    const serverDoc = new Y.Doc()
    const seededHandle = createCollaborativeCanvasDocument(snapshot)
    const seeded = seededHandle.doc
    Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(seeded))

    const session = await CanvasCollaborationSession.create({
      roomId: viewer.roomId,
      serverSession: viewer,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
    })
    sockets[0]!.open()
    const step2 = encoding.createEncoder()
    encoding.writeVarUint(step2, MESSAGE_SYNC)
    syncProtocol.writeSyncStep2(step2, serverDoc)
    sockets[0]!.receive(encoding.toUint8Array(step2))

    await vi.waitFor(() => expect(session.status.state).toBe('synced'))
    expect(session.getSnapshot()).toEqual({ ...snapshot, version: 3 })
    expect(() => session.transact((doc) => doc.getMap('meta').set('name', 'Viewer-local mutation')))
      .toThrow(/viewer/i)
    const sentSyncTypes = sockets[0]!.sent
      .filter((message) => collaborationMessageType(message) === MESSAGE_SYNC)
      .map((message) => {
      const decoder = decoding.createDecoder(message)
      expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC)
      return decoding.readVarUint(decoder)
      })
    expect(sentSyncTypes).toEqual([syncProtocol.messageYjsSyncStep1])
    await session.destroy()
    serverDoc.destroy()
    seededHandle.destroy()
  })

  it('does not expose mutable document handles and publishes serialized snapshots', async () => {
    const sockets: FakeWebSocket[] = []
    const serverDoc = new Y.Doc()
    seedDocument(serverDoc)
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
    })
    const snapshots: CanvasSnapshotV2[] = []
    const unsubscribe = session.subscribeSnapshot((value) => snapshots.push(value))

    expect(Object.prototype.hasOwnProperty.call(session, 'doc')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(session, 'document')).toBe(false)

    attachServer(sockets[0]!, serverDoc)
    await vi.waitFor(() => expect(session.status.state).toBe('synced'))
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(serverDoc))
    const before = Y.encodeStateVector(remote)
    remote.getMap('meta').set('name', 'Remote snapshot')
    const message = encoding.createEncoder()
    encoding.writeVarUint(message, MESSAGE_SYNC)
    syncProtocol.writeUpdate(message, Y.encodeStateAsUpdate(remote, before))
    sockets[0]!.receive(encoding.toUint8Array(message))

    await vi.waitFor(() => expect(snapshots.at(-1)?.name).toBe('Remote snapshot'))
    expect(session.getSnapshot()?.name).toBe('Remote snapshot')
    unsubscribe()
    await session.destroy()
    serverDoc.destroy()
    remote.destroy()
  })

  it('publishes entity changes for remote document updates after synchronization', async () => {
    const sockets: FakeWebSocket[] = []
    const serverDoc = new Y.Doc()
    seedDocument(serverDoc)
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
    })
    const changes = vi.fn()
    session.subscribeEntityChanges(changes)
    attachServer(sockets[0]!, serverDoc)
    await vi.waitFor(() => expect(session.status.state).toBe('synced'))

    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(serverDoc))
    const before = Y.encodeStateVector(remote)
    remote.getMap('meta').set('name', 'Entity update')
    const message = encoding.createEncoder()
    encoding.writeVarUint(message, MESSAGE_SYNC)
    syncProtocol.writeUpdate(message, Y.encodeStateAsUpdate(remote, before))
    sockets[0]!.receive(encoding.toUint8Array(message))

    await vi.waitFor(() => expect(changes).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'remote',
      name: 'Entity update',
      nodes: { upserted: [], removed: [] },
      edges: { upserted: [], removed: [] },
    })))
    await session.destroy()
    serverDoc.destroy()
    remote.destroy()
  })

  it('sends the Yjs update before isolating snapshot listener failures', async () => {
    const sockets: FakeWebSocket[] = []
    const serverDoc = new Y.Doc()
    seedDocument(serverDoc)
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
    })
    attachServer(sockets[0]!, serverDoc)
    await vi.waitFor(() => expect(session.status.state).toBe('synced'))
    const sentBefore = sockets[0]!.sent.length
    const secondListener = vi.fn()
    session.subscribeSnapshot(() => {
      expect(sockets[0]!.sent.length).toBeGreaterThan(sentBefore)
      throw new Error('isolated snapshot observer failure')
    })
    session.subscribeSnapshot(secondListener)

    expect(() => session.transact((doc) => doc.getMap('meta').set('name', 'Still sent')))
      .not.toThrow()
    expect(serverDoc.getMap('meta').get('name')).toBe('Still sent')
    expect(secondListener).toHaveBeenCalledTimes(1)
    expect(sockets[0]!.closes).toEqual([])
    expect(session.status.state).toBe('synced')
    await session.destroy()
    serverDoc.destroy()
  })

  it('ignores a stale malformed Blob after a newer socket generation connects', async () => {
    const timers: Array<{ callback: () => void; delay: number }> = []
    const sockets: FakeWebSocket[] = []
    const serverDoc = new Y.Doc()
    let releaseBlob!: (value: ArrayBuffer) => void
    const delayed = new Promise<ArrayBuffer>((resolve) => { releaseBlob = resolve })
    class DelayedBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> { return delayed }
    }
    const session = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      persistenceFactory: persistence().factory,
      webSocketFactory: socketFactory(sockets),
      timers: {
        setTimeout(callback, delay) {
          const timer = { callback, delay }
          timers.push(timer)
          return timer
        },
        clearTimeout() {},
      },
    })
    attachServer(sockets[0]!, serverDoc)
    await vi.waitFor(() => expect(session.status.state).toBe('synced'))
    sockets[0]!.receiveData(new DelayedBlob())
    sockets[0]!.disconnect()
    timers[0]!.callback()
    attachServer(sockets[1]!, serverDoc)
    await vi.waitFor(() => expect(session.status.state).toBe('synced'))

    releaseBlob(new Uint8Array([99]).buffer)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sockets[1]!.closes).toEqual([])
    expect(session.status.state).toBe('synced')
    await session.destroy()
    serverDoc.destroy()
  })

  it('isolates editor dirty cache from a viewer identity and persists only server viewer state', async () => {
    const stored = new Map<string, Uint8Array>()
    const namespaces: string[] = []
    const persistenceFactory = (name: string, doc: Y.Doc): CollaborationPersistenceHandle => {
      namespaces.push(name)
      const cached = stored.get(name)
      if (cached) Y.applyUpdate(doc, cached, 'indexeddb-cache')
      const onUpdate = () => stored.set(name, Y.encodeStateAsUpdate(doc))
      doc.on('update', onUpdate)
      return {
        whenSynced: Promise.resolve(),
        destroy() { doc.off('update', onUpdate) },
      }
    }
    const offlineEditor = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: editor,
      snapshot,
      persistenceFactory,
      webSocketFactory: () => collaborationSocket(),
    })
    offlineEditor.transact((doc) => doc.getMap('meta').set('name', 'Editor dirty cache'))
    await offlineEditor.destroy()

    const viewerSession = { ...editor, role: 'viewer' as const }
    const sockets: FakeWebSocket[] = []
    const viewer = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: viewerSession,
      snapshot: { ...snapshot, name: 'Viewer must not seed this' },
      persistenceFactory,
      webSocketFactory: socketFactory(sockets),
    })
    const cleanServer = createCollaborativeCanvasDocument({ ...snapshot, name: 'Server clean' })
    sockets[0]!.open()
    const step2 = encoding.createEncoder()
    encoding.writeVarUint(step2, MESSAGE_SYNC)
    syncProtocol.writeSyncStep2(step2, cleanServer.doc)
    sockets[0]!.receive(encoding.toUint8Array(step2))
    await vi.waitFor(() => expect(viewer.status.state).toBe('synced'))

    expect(viewer.getSnapshot().name).toBe('Server clean')
    const sentTypes = sockets[0]!.sent
      .filter((message) => collaborationMessageType(message) === MESSAGE_SYNC)
      .map((message) => {
      const decoder = decoding.createDecoder(message)
      decoding.readVarUint(decoder)
      return decoding.readVarUint(decoder)
      })
    expect(sentTypes).toEqual([syncProtocol.messageYjsSyncStep1])
    await viewer.destroy()

    const restoredViewer = await CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: viewerSession,
      persistenceFactory,
      webSocketFactory: () => collaborationSocket(),
    })
    expect(restoredViewer.getSnapshot().name).toBe('Server clean')
    expect(namespaces).toEqual([
      'libtv-collaboration:room-alpha:editor:member-editor',
      'libtv-collaboration:room-alpha:viewer:member-editor',
      'libtv-collaboration:room-alpha:viewer:member-editor',
    ])
    await restoredViewer.destroy()
    cleanServer.destroy()
  })

  it('rejects a dirty external document before a viewer cache can observe it', async () => {
    const dirtyHandle = createCollaborativeCanvasDocument({
      ...snapshot,
      name: 'Editor dirty external document',
    })
    const externalDoc = dirtyHandle.doc
    const persistenceFactory = vi.fn(persistence().factory)

    await expect(CanvasCollaborationSession.create({
      roomId: editor.roomId,
      serverSession: { ...editor, role: 'viewer' },
      doc: externalDoc,
      persistenceFactory,
      webSocketFactory: () => collaborationSocket(),
    })).rejects.toThrow(/viewer.*empty/i)

    expect(persistenceFactory).not.toHaveBeenCalled()
    expect(() => externalDoc.getMap('still-owned').set('alive', true)).not.toThrow()
    dirtyHandle.destroy()
  })
})
