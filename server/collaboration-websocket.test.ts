import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import type { CanvasSnapshotV2 } from '../src/model/project.ts'
import type { CollaborationSession } from '../src/contracts/collaboration.ts'
import {
  CanvasCollaborationSession,
  type CollaborationWebSocket,
} from '../src/collaboration/session.ts'
import { createCollaborativeCanvasDocument } from '../src/collaboration/document.ts'
import { startGateway, type GatewayHandle } from './http-gateway.ts'
import { atomicWriteJson } from './atomic-json.ts'

const handles: GatewayHandle[] = []

function snapshot(): CanvasSnapshotV2 {
  return {
    version: 2, canvasId: 'canvas-alpha', projectId: 'project-alpha', name: 'Shared',
    viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
  }
}

async function start(options: Parameters<typeof startGateway>[0] = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'libtv-collaboration-ws-'))
  for (let attempt = 0; attempt < 20; attempt++) {
    const gateway = await startGateway({
      dataDir, envFile: join(dataDir, '.env.local'),
      env: { API_PROVIDER_AISTARTLAB_KEY: 'test-key' },
      host: '127.0.0.1', port: 0, ...options,
    })
    try {
      // These socket tests also use Fetch for room setup and checkpoint reads.
      await fetch(`${gateway.origin}/api/health`)
    } catch (error) {
      await gateway.close()
      if (!options.port && /bad port/i.test(String((error as Error & { cause?: unknown }).cause ?? error))) continue
      throw error
    }
    handles.push(gateway)
    return gateway
  }
  throw new Error('Could not allocate a Fetch-compatible test port')
}

function cookie(response: Response): string {
  const value = response.headers.get('set-cookie')
  if (!value) throw new Error('Missing cookie')
  return value.split(';', 1)[0]
}

async function createRoom(
  gateway: GatewayHandle,
  scope: { canvasId: string; projectId: string } = {
    canvasId: 'canvas-alpha', projectId: 'project-alpha',
  },
  requestOrigin: string = gateway.origin,
) {
  const response = await fetch(`${gateway.origin}/api/collaboration/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: requestOrigin },
    body: JSON.stringify({
      ...scope, snapshot: { ...snapshot(), ...scope },
      deviceId: 'device-owner', displayName: 'Owner',
    }),
  })
  return { payload: await response.json() as any, cookie: cookie(response) }
}

async function invite(
  gateway: GatewayHandle,
  roomId: string,
  ownerCookie: string,
  role: 'editor' | 'viewer',
) {
  const created = await fetch(`${gateway.origin}/api/collaboration/rooms/${roomId}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: gateway.origin, cookie: ownerCookie },
    body: JSON.stringify({ role }),
  })
  const inviteBody = await created.json() as any
  const exchanged = await fetch(`${gateway.origin}/api/collaboration/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: gateway.origin },
    body: JSON.stringify({
      roomId, secret: inviteBody.secret, deviceId: `device-${role}`, displayName: role,
    }),
  })
  return cookie(exchanged)
}

async function inviteSession(
  gateway: GatewayHandle,
  roomId: string,
  ownerCookie: string,
  role: 'editor' | 'viewer',
) {
  const created = await fetch(`${gateway.origin}/api/collaboration/rooms/${roomId}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: gateway.origin, cookie: ownerCookie },
    body: JSON.stringify({ role }),
  })
  const inviteBody = await created.json() as any
  const exchanged = await fetch(`${gateway.origin}/api/collaboration/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: gateway.origin },
    body: JSON.stringify({
      roomId, secret: inviteBody.secret, deviceId: `device-${role}-session`, displayName: role,
    }),
  })
  return {
    cookie: cookie(exchanged),
    session: (await exchanged.json() as { session: CollaborationSession }).session,
  }
}

function sessionSocketFactory(cookieValue: string, origin: string, sockets: WebSocket[]) {
  return (url: string) => {
    const socket = new WebSocket(url, { headers: { cookie: cookieValue, origin } })
    sockets.push(socket)
    return socket as unknown as CollaborationWebSocket
  }
}

function memoryPersistence() {
  return {
    whenSynced: Promise.resolve(),
    async destroy() {},
  }
}

function wsUrl(gateway: GatewayHandle, roomId: string): string {
  return `${gateway.origin.replace(/^http/, 'ws')}/api/collaboration/ws?roomId=${roomId}`
}

function openSocket(
  url: string,
  sessionCookie: string,
  origin: string,
  options: { autoPong?: boolean; host?: string } = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      autoPong: options.autoPong,
      headers: { cookie: sessionCookie, origin, ...(options.host ? { host: options.host } : {}) },
    })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)))
}

function syncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

function awarenessUpdate(awareness: awarenessProtocol.Awareness): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
  )
  return encoding.toUint8Array(encoder)
}

function awarenessIds(count: number): Uint8Array {
  const update = encoding.createEncoder()
  encoding.writeVarUint(update, count)
  for (let index = 0; index < count; index += 1) {
    encoding.writeVarUint(update, index + 1)
    encoding.writeVarUint(update, 1)
    encoding.writeVarString(update, JSON.stringify({ cursor: { x: index, y: index } }))
  }
  const message = encoding.createEncoder()
  encoding.writeVarUint(message, 1)
  encoding.writeVarUint8Array(message, encoding.toUint8Array(update))
  return encoding.toUint8Array(message)
}

function maliciousUpdate(
  kind: 'root' | 'version' | 'deep' | 'oversized',
  baseUpdate: Uint8Array,
): Uint8Array {
  const document = new Y.Doc()
  Y.applyUpdate(document, baseUpdate)
  const beforeMutation = Y.encodeStateVector(document)
  if (kind === 'root') document.getMap('unexpectedRoot').set('value', true)
  if (kind === 'version') document.getMap('meta').set('version', 999)
  if (kind === 'deep') {
    const root = new Y.Map<unknown>()
    let cursor = root
    for (let index = 0; index < 40; index += 1) {
      const child = new Y.Map<unknown>()
      cursor.set('child', child)
      cursor = child
    }
    document.getMap<Y.Map<unknown>>('nodes').set('deep-node', root)
  }
  if (kind === 'oversized') document.getMap('meta').set('name', 'x'.repeat(600_000))
  return Y.encodeStateAsUpdate(document, beforeMutation)
}

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((gateway) => gateway.close()))
})

describe('collaboration WebSocket gateway', () => {
  it('uses Yjs sync semantics and broadcasts editor updates to peers', async () => {
    const gateway = await start()
    const owner = await createRoom(gateway)
    const roomId = owner.payload.room.roomId as string
    const editorCookie = await invite(gateway, roomId, owner.cookie, 'editor')
    const ownerSocket = await openSocket(wsUrl(gateway, roomId), owner.cookie, gateway.origin)
    const editorSocket = await openSocket(wsUrl(gateway, roomId), editorCookie, gateway.origin)
    const peer = new Y.Doc()
    editorSocket.on('message', (raw) => {
      const decoder = decoding.createDecoder(new Uint8Array(raw as Buffer))
      if (decoding.readVarUint(decoder) !== 0) return
      const response = encoding.createEncoder()
      encoding.writeVarUint(response, 0)
      syncProtocol.readSyncMessage(decoder, response, peer, 'server')
      if (encoding.length(response) > 1) editorSocket.send(encoding.toUint8Array(response))
    })
    const local = new Y.Doc()
    local.getMap('meta').set('collaborative-test', 'received')
    ownerSocket.send(syncUpdate(Y.encodeStateAsUpdate(local)))

    await expect.poll(() => peer.getMap('meta').get('collaborative-test')).toBe('received')
    ownerSocket.close()
    editorSocket.close()
  })

  it('acknowledges the checkpoint barrier only after earlier socket updates are durable and readable', async () => {
    let blockSnapshot = false
    let checkpointStarted = false
    let releaseCheckpoint = () => {}
    const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve })
    const gateway = await start({
      collaborationOptions: {
        persistence: {
          append: (path, bytes) => appendFile(path, bytes),
          writeBytes: (path, bytes) => writeFile(path, bytes),
          async writeJson(path, value) {
            if (blockSnapshot && path.endsWith('canvas.snapshot.json')) {
              checkpointStarted = true
              await checkpointGate
            }
            await atomicWriteJson(path, value)
          },
        },
      },
    })
    const owner = await createRoom(gateway)
    const roomId = owner.payload.room.roomId as string
    const session = await CanvasCollaborationSession.create({
      roomId, serverSession: owner.payload.session,
      webSocketUrl: wsUrl(gateway, roomId),
      webSocketFactory: sessionSocketFactory(owner.cookie, gateway.origin, []),
      persistenceFactory: memoryPersistence,
    })
    try {
      await expect.poll(() => session.status.state).toBe('synced')
      blockSnapshot = true
      session.applySnapshot({ ...snapshot(), name: 'Final socket update' })
      let acknowledged = false
      let failed: unknown
      const completion = session.flush().then(() => { acknowledged = true }, (error) => { failed = error })
      await expect.poll(() => checkpointStarted || !!failed).toBe(true)
      expect(failed).toBeUndefined()
      expect(acknowledged).toBe(false)
      releaseCheckpoint()
      await completion
      expect(acknowledged).toBe(true)
      const response = await fetch(`${gateway.origin}/api/canvases/canvas-alpha`)
      expect(response.status).toBe(200)
      const document = await response.json() as { canvas: CanvasSnapshotV2; revision: number }
      expect(document.canvas.name).toBe('Final socket update')
      expect(document.revision).toBeGreaterThan(0)
    } finally {
      releaseCheckpoint()
      await session.destroy()
    }
  })

  it('uploads offline nested text edits while merging concurrent online text edits', async () => {
    const gateway = await start()
    const owner = await createRoom(gateway)
    const roomId = owner.payload.room.roomId as string
    const editor = await inviteSession(gateway, roomId, owner.cookie, 'editor')
    const ownerSockets: WebSocket[] = []
    const editorSockets: WebSocket[] = []
    const ownerSession = await CanvasCollaborationSession.create({
      roomId,
      serverSession: owner.payload.session,
      webSocketUrl: wsUrl(gateway, roomId),
      webSocketFactory: sessionSocketFactory(owner.cookie, gateway.origin, ownerSockets),
      persistenceFactory: memoryPersistence,
    })
    const editorSession = await CanvasCollaborationSession.create({
      roomId,
      serverSession: editor.session,
      webSocketUrl: wsUrl(gateway, roomId),
      webSocketFactory: sessionSocketFactory(editor.cookie, gateway.origin, editorSockets),
      persistenceFactory: memoryPersistence,
    })
    await expect.poll(() => [ownerSession.status.state, editorSession.status.state])
      .toEqual(['synced', 'synced'])

    const seeded: CanvasSnapshotV2 = {
      ...snapshot(),
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
    ownerSession.applySnapshot(seeded)
    await expect.poll(() => editorSession.getSnapshot()?.nodes.length).toBe(2)

    editorSockets[0]!.close(1000)
    await expect.poll(() => editorSession.status.state).toBe('offline')
    const offlineBefore = editorSession.getSnapshot()!
    editorSession.applySnapshotChange(offlineBefore, {
      ...offlineBefore,
      nodes: offlineBefore.nodes.map((node) => node.id === 'text-b'
        ? { ...node, data: { ...node.data, text: 'Edited offline' } }
        : node),
    })
    const onlineBefore = ownerSession.getSnapshot()!
    ownerSession.applySnapshotChange(onlineBefore, {
      ...onlineBefore,
      nodes: onlineBefore.nodes.map((node) => node.id === 'text-a'
        ? { ...node, data: { ...node.data, text: 'Edited online' } }
        : node),
    })

    await expect.poll(() => editorSession.status.state, { timeout: 5_000 }).toBe('synced')
    await expect.poll(() => gateway.runtime.collaboration.exportSnapshot(roomId).nodes
      .map((node) => node.data.text), { timeout: 5_000 })
      .toEqual(['Edited online', 'Edited offline'])
    expect(ownerSession.getSnapshot()?.nodes.map((node) => node.data.text))
      .toEqual(['Edited online', 'Edited offline'])

    await ownerSession.destroy()
    await editorSession.destroy()
  })

  it('closes a viewer that forges a Yjs update without mutating the room', async () => {
    const gateway = await start()
    const owner = await createRoom(gateway)
    const roomId = owner.payload.room.roomId as string
    const viewerCookie = await invite(gateway, roomId, owner.cookie, 'viewer')
    const viewer = await openSocket(wsUrl(gateway, roomId), viewerCookie, gateway.origin)
    const forged = new Y.Doc()
    forged.getMap('meta').set('forged', true)
    const closed = waitForClose(viewer)
    viewer.send(syncUpdate(Y.encodeStateAsUpdate(forged)))

    expect(await closed).toBe(1008)
    expect(gateway.runtime.collaboration.exportSnapshot(roomId).name).toBe('Shared')
    expect(gateway.runtime.collaboration.documentForRoom(roomId).getMap('meta').get('forged')).toBeUndefined()
  })

  it.each(['root', 'version', 'deep', 'oversized'] as const)(
    'validates a candidate %s update before applying or persisting it',
    async (kind) => {
      const gateway = await start(kind === 'oversized'
        ? { collaborationOptions: { maxCandidateUpdateBytes: 512 * 1024 } }
        : {})
      const owner = await createRoom(gateway)
      const roomId = owner.payload.room.roomId as string
      const updatesPath = join(gateway.runtime.dataDir, 'collaboration', roomId, 'updates.bin')
      const beforeLog = await readFile(updatesPath)
      const socket = await openSocket(wsUrl(gateway, roomId), owner.cookie, gateway.origin)
      const closed = waitForClose(socket)
      socket.send(syncUpdate(maliciousUpdate(
        kind,
        Y.encodeStateAsUpdate(gateway.runtime.collaboration.documentForRoom(roomId)),
      )))

      expect(await closed).toBe(1008)
      expect(await readFile(updatesPath)).toEqual(beforeLog)
      expect(gateway.runtime.collaboration.exportSnapshot(roomId)).toEqual({ ...snapshot(), version: 3 })
      expect(gateway.runtime.collaboration.documentForRoom(roomId).share.has('unexpectedRoot')).toBe(false)
    },
  )

  it('rejects disallowed origins and messages beyond the configured byte limit', async () => {
    const gateway = await start({ collaborationMaxMessageBytes: 128 })
    const owner = await createRoom(gateway)
    const roomId = owner.payload.room.roomId as string
    await expect(openSocket(wsUrl(gateway, roomId), owner.cookie, 'https://evil.example')).rejects.toThrow()

    const socket = await openSocket(wsUrl(gateway, roomId), owner.cookie, gateway.origin)
    const closed = waitForClose(socket)
    socket.send(new Uint8Array(129))
    expect(await closed).toBe(1009)
  })

  it('accepts a valid offline sync update larger than one MiB', async () => {
    const gateway = await start()
    const owner = await createRoom(gateway)
    const roomId = owner.payload.room.roomId as string
    const socket = await openSocket(wsUrl(gateway, roomId), owner.cookie, gateway.origin)
    const largeText = 'x'.repeat(1_100_000)
    const offline = createCollaborativeCanvasDocument({
      ...snapshot(),
      nodes: [{
        id: 'large-offline-text', type: 'text', name: 'Large offline text',
        position: { x: 0, y: 0 }, size: { width: 320, height: 180 },
        data: { text: largeText },
      }],
    })
    const message = syncUpdate(Y.encodeStateAsUpdate(offline.doc))
    expect(message.byteLength).toBeGreaterThan(1024 * 1024)

    socket.send(message)

    await expect.poll(() => gateway.runtime.collaboration
      .exportSnapshot(roomId).nodes[0]?.data.text?.length).toBe(largeText.length)
    expect(socket.readyState).toBe(WebSocket.OPEN)
    offline.destroy()
    socket.close()
  })

  it('does not derive a public WebSocket origin from an attacker-controlled Host header', async () => {
    const gateway = await start({
      host: '0.0.0.0',
      publicOrigin: 'https://canvas.example',
      allowedOrigins: ['https://canvas.example'],
    })
    const owner = await createRoom(
      gateway,
      { canvasId: 'canvas-public', projectId: 'project-public' },
      'https://canvas.example',
    )
    await expect(openSocket(
      wsUrl(gateway, owner.payload.room.roomId as string),
      owner.cookie,
      'https://attacker.example',
      { host: 'attacker.example' },
    )).rejects.toThrow()
  })

  it('limits a room to ten simultaneous connections', async () => {
    const gateway = await start()
    const owner = await createRoom(gateway)
    const roomId = owner.payload.room.roomId as string
    const sockets: WebSocket[] = []
    for (let index = 0; index < 10; index += 1) {
      sockets.push(await openSocket(wsUrl(gateway, roomId), owner.cookie, gateway.origin))
    }
    await expect(openSocket(wsUrl(gateway, roomId), owner.cookie, gateway.origin)).rejects.toThrow()
    for (const socket of sockets) socket.close()
  })

  it('broadcasts awareness updates without persisting them into the canvas document', async () => {
    const gateway = await start()
    const owner = await createRoom(gateway)
    const roomId = owner.payload.room.roomId as string
    const editorCookie = await invite(gateway, roomId, owner.cookie, 'editor')
    const ownerSocket = await openSocket(wsUrl(gateway, roomId), owner.cookie, gateway.origin)
    const editorSocket = await openSocket(wsUrl(gateway, roomId), editorCookie, gateway.origin)
    const remoteAwareness = new awarenessProtocol.Awareness(new Y.Doc())
    remoteAwareness.setLocalState(null)
    editorSocket.on('message', (raw) => {
      const decoder = decoding.createDecoder(new Uint8Array(raw as Buffer))
      if (decoding.readVarUint(decoder) !== 1) return
      awarenessProtocol.applyAwarenessUpdate(
        remoteAwareness,
        decoding.readVarUint8Array(decoder),
        'server',
      )
    })
    const localAwareness = new awarenessProtocol.Awareness(new Y.Doc())
    localAwareness.setLocalState({
      memberId: 'forged-member', displayName: 'Impostor', role: 'viewer', color: '#000000',
      cursor: { x: 10, y: 20 },
      unexpected: 'must-not-be-broadcast',
    })
    ownerSocket.send(awarenessUpdate(localAwareness))

    await expect.poll(() => [...remoteAwareness.getStates().values()]).toContainEqual(
      expect.objectContaining({
        memberId: owner.payload.session.memberId,
        displayName: 'Owner',
        role: 'owner',
        color: expect.stringMatching(/^#[0-9a-f]{6}$/),
        cursor: { x: 10, y: 20 },
      }),
    )
    expect(gateway.runtime.collaboration.exportSnapshot(roomId)).toEqual({ ...snapshot(), version: 3 })
    const ownerState = [...remoteAwareness.getStates().values()]
      .find((state) => state.memberId === owner.payload.session.memberId)
    expect(ownerState).not.toHaveProperty('unexpected')
    ownerSocket.close()
    await expect.poll(() => remoteAwareness.getStates().has(localAwareness.clientID)).toBe(false)
    editorSocket.close()
    localAwareness.destroy()
    remoteAwareness.destroy()
  })

  it('rejects oversized awareness before parsing or broadcasting it', async () => {
    const gateway = await start()
    const owner = await createRoom(gateway)
    const roomId = owner.payload.room.roomId as string
    const viewerCookie = await invite(gateway, roomId, owner.cookie, 'viewer')
    const viewerSocket = await openSocket(wsUrl(gateway, roomId), viewerCookie, gateway.origin)
    const oversized = new awarenessProtocol.Awareness(new Y.Doc())
    oversized.setLocalState({ cursor: { x: 1, y: 2 }, padding: 'x'.repeat(70 * 1024) })
    const closed = waitForClose(viewerSocket)

    viewerSocket.send(awarenessUpdate(oversized))

    expect(await closed).toBe(1009)
    oversized.destroy()
  })

  it('rejects an oversized sync handshake while preserving large authenticated updates', async () => {
    const gateway = await start()
    const owner = await createRoom(gateway)
    const roomId = owner.payload.room.roomId as string
    const socket = await openSocket(wsUrl(gateway, roomId), owner.cookie, gateway.origin)
    const oversized = encoding.createEncoder()
    encoding.writeVarUint(oversized, 0)
    encoding.writeVarUint(oversized, syncProtocol.messageYjsSyncStep1)
    encoding.writeVarUint8Array(oversized, new Uint8Array(70 * 1024))
    const closed = waitForClose(socket)

    socket.send(encoding.toUint8Array(oversized))

    expect(await closed).toBe(1009)
  })

  it('strips forged viewer leases and previews while preserving basic awareness fields', async () => {
    const gateway = await start()
    const owner = await createRoom(gateway)
    const roomId = owner.payload.room.roomId as string
    const viewerCookie = await invite(gateway, roomId, owner.cookie, 'viewer')
    const ownerSocket = await openSocket(wsUrl(gateway, roomId), owner.cookie, gateway.origin)
    const viewerSocket = await openSocket(wsUrl(gateway, roomId), viewerCookie, gateway.origin)
    const observed = new awarenessProtocol.Awareness(new Y.Doc())
    observed.setLocalState(null)
    ownerSocket.on('message', (raw) => {
      const decoder = decoding.createDecoder(new Uint8Array(raw as Buffer))
      if (decoding.readVarUint(decoder) !== 1) return
      awarenessProtocol.applyAwarenessUpdate(observed, decoding.readVarUint8Array(decoder), 'server')
    })
    const forged = new awarenessProtocol.Awareness(new Y.Doc())
    forged.setLocalState({
      cursor: { x: 1, y: 2 }, selection: { nodeIds: ['node-a'] },
      viewport: { x: 3, y: 4, zoom: 1 }, interaction: { kind: 'idle', nodeIds: [] },
      interactionPreview: { kind: 'drag', coordinateSpace: 'canvas-absolute', nodes: [{ nodeId: 'node-a' }] },
      lease: { leaseId: 'forged', nodeIds: ['node-a'] },
    })
    viewerSocket.send(awarenessUpdate(forged))
    await expect.poll(() => [...observed.getStates().values()]).toContainEqual(
      expect.objectContaining({
        role: 'viewer', cursor: { x: 1, y: 2 }, selection: { nodeIds: ['node-a'] },
        viewport: { x: 3, y: 4, zoom: 1 }, interaction: { kind: 'idle', nodeIds: [] },
      }),
    )
    const viewerState = [...observed.getStates().values()].find((state) => state.role === 'viewer')!
    expect(viewerState).not.toHaveProperty('lease')
    expect(viewerState).not.toHaveProperty('interactionPreview')
    ownerSocket.close()
    viewerSocket.close()
    forged.destroy()
    observed.destroy()
  })

  it('rejects awareness batches and a connection that rotates client ids', async () => {
    const gateway = await start()
    const owner = await createRoom(gateway)
    const roomId = owner.payload.room.roomId as string
    const batchSocket = await openSocket(wsUrl(gateway, roomId), owner.cookie, gateway.origin)
    const batchClosed = waitForClose(batchSocket)
    batchSocket.send(awarenessIds(30))
    expect(await batchClosed).toBe(1008)

    const rotatingSocket = await openSocket(wsUrl(gateway, roomId), owner.cookie, gateway.origin)
    const first = new awarenessProtocol.Awareness(new Y.Doc())
    const second = new awarenessProtocol.Awareness(new Y.Doc())
    first.setLocalState({ cursor: { x: 1, y: 1 } })
    second.setLocalState({ cursor: { x: 2, y: 2 } })
    rotatingSocket.send(awarenessUpdate(first))
    const rotatingClosed = waitForClose(rotatingSocket)
    rotatingSocket.send(awarenessUpdate(second))
    expect(await rotatingClosed).toBe(1008)
    first.destroy()
    second.destroy()
  })

  it('terminates a connection that misses the bounded heartbeat', async () => {
    const gateway = await start({ collaborationHeartbeatMs: 20 })
    const owner = await createRoom(gateway)
    const socket = await openSocket(
      wsUrl(gateway, owner.payload.room.roomId),
      owner.cookie,
      gateway.origin,
      { autoPong: false },
    )

    expect(await waitForClose(socket)).toBe(1006)
  })

  it('closes an already connected socket after its session is revoked', async () => {
    const gateway = await start({ collaborationHeartbeatMs: 20 })
    const owner = await createRoom(gateway)
    const socket = await openSocket(
      wsUrl(gateway, owner.payload.room.roomId), owner.cookie, gateway.origin,
    )
    const closed = waitForClose(socket)
    const revoked = await fetch(`${gateway.origin}/api/collaboration/sessions/current?roomId=${owner.payload.room.roomId}`, {
      method: 'DELETE', headers: { origin: gateway.origin, cookie: owner.cookie },
    })
    expect(revoked.status).toBe(200)
    expect(await closed).toBe(1008)
  })

  it('closes room sockets with 1011 when durable persistence fails', async () => {
    let failAppend = false
    const gateway = await start({
      collaborationOptions: {
        persistence: {
          async append(path, bytes) {
            if (failAppend) throw new Error('injected websocket append failure')
            await appendFile(path, bytes)
          },
          writeBytes: (path, bytes) => writeFile(path, bytes).then(() => undefined),
          writeJson: atomicWriteJson,
        },
      },
    })
    const owner = await createRoom(gateway)
    const socket = await openSocket(
      wsUrl(gateway, owner.payload.room.roomId), owner.cookie, gateway.origin,
    )
    const closed = waitForClose(socket)
    failAppend = true
    const update = new Y.Doc()
    update.getMap('meta').set('will-fail-persistence', true)
    socket.send(syncUpdate(Y.encodeStateAsUpdate(update)))

    expect(await closed).toBe(1011)
  })

  it('authenticates two room WebSockets from isolated cookies at the same time', async () => {
    const gateway = await start()
    const first = await createRoom(gateway)
    const second = await createRoom(gateway, {
      canvasId: 'canvas-beta', projectId: 'project-beta',
    })
    const combinedCookies = `${first.cookie}; ${second.cookie}`
    const firstSocket = await openSocket(
      wsUrl(gateway, first.payload.room.roomId), combinedCookies, gateway.origin,
    )
    const secondSocket = await openSocket(
      wsUrl(gateway, second.payload.room.roomId), combinedCookies, gateway.origin,
    )
    expect(firstSocket.readyState).toBe(WebSocket.OPEN)
    expect(secondSocket.readyState).toBe(WebSocket.OPEN)
    firstSocket.close()
    secondSocket.close()
  })
})
