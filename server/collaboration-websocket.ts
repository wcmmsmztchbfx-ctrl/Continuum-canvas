import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import type * as Y from 'yjs'
import { COLLABORATION_MAX_CLIENT_MESSAGE_BYTES } from '../src/contracts/collaboration.ts'
import { getCollaboratorColor } from '../src/collaboration/colors.ts'
import { collaborationTokenFromCookieHeader } from './collaboration-cookie.ts'
import {
  CollaborationAuthorizationError,
  CollaborationNotFoundError,
  CollaborationPersistenceError,
  CollaborationUpdateError,
  type CollaborationService,
} from './collaboration-service.ts'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024

interface CollaborationSocket extends WebSocket {
  collaborationAlive: boolean
  collaborationMissedHeartbeats: number
  collaborationRoomId: string
  collaborationToken: string
  awarenessClientId?: number
}

interface RoomConnections {
  document: Y.Doc
  awareness: awarenessProtocol.Awareness
  sockets: Set<CollaborationSocket>
  onDocumentUpdate: (update: Uint8Array, origin: unknown) => void
  onAwarenessUpdate: (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void
}

function allowedOrigin(
  request: IncomingMessage,
  configured: readonly string[],
  allowRequestHost: boolean,
): boolean {
  const origin = request.headers.origin
  if (!origin || Array.isArray(origin)) return false
  const host = request.headers.host?.toLowerCase()
  const allowed = configured.map((item) => item.toLowerCase())
  if (allowRequestHost) {
    allowed.push(
      host ? `http://${host}` : '',
      host ? `https://${host}` : '',
      'http://127.0.0.1:4173',
      'http://localhost:4173',
    )
  }
  return new Set(allowed).has(origin.toLowerCase())
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = Buffer.from(message)
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.byteLength}\r\n\r\n${message}`,
  )
}

function send(socket: WebSocket, bytes: Uint8Array): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(bytes, { binary: true })
}

function syncStep1(document: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, document)
  return encoding.toUint8Array(encoder)
}

function syncStep2(document: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep2(encoder, document)
  return encoding.toUint8Array(encoder)
}

function syncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

function awarenessMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

function authenticatedAwarenessUpdate(
  update: Uint8Array,
  session: { memberId: string; displayName: string; role: string },
): { clientId: number; update: Uint8Array } {
  const decoder = decoding.createDecoder(update)
  const count = decoding.readVarUint(decoder)
  if (count !== 1) {
    throw new CollaborationAuthorizationError('A connection may publish only one awareness client')
  }
  const clientId = decoding.readVarUint(decoder)
  const clock = decoding.readVarUint(decoder)
  const state = JSON.parse(decoding.readVarString(decoder)) as unknown
  if (state !== null && (typeof state !== 'object' || Array.isArray(state))) {
    throw new CollaborationAuthorizationError('Awareness state is invalid')
  }
  let sanitized: Record<string, unknown> | null = null
  if (state !== null) {
    const candidate = state as Record<string, unknown>
    sanitized = {
      memberId: session.memberId,
      displayName: session.displayName,
      role: session.role,
      color: getCollaboratorColor(session.memberId),
    }
    const sharedFields = ['cursor', 'selection', 'viewport', 'interaction'] as const
    for (const field of sharedFields) {
      if (Object.hasOwn(candidate, field)) sanitized[field] = candidate[field]
    }
    if (session.role !== 'viewer') {
      const editorFields = ['lease', 'interactionPreview'] as const
      for (const field of editorFields) {
        if (Object.hasOwn(candidate, field)) sanitized[field] = candidate[field]
      }
    }
  }
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1)
  encoding.writeVarUint(encoder, clientId)
  encoding.writeVarUint(encoder, clock)
  encoding.writeVarString(encoder, JSON.stringify(sanitized))
  const authenticated = encoding.toUint8Array(encoder)
  if (authenticated.byteLength > MAX_CONTROL_MESSAGE_BYTES) {
    throw new CollaborationAuthorizationError('Awareness state is too large')
  }
  return { clientId, update: authenticated }
}

export interface CollaborationWebSocketHandle {
  connectionCount(roomId: string): number
  close(): Promise<void>
}

export function attachCollaborationWebSocket(options: {
  server: HttpServer
  service: CollaborationService
  allowedOrigins?: string[]
  maxMessageBytes?: number
  maxConnectionsPerRoom?: number
  heartbeatMs?: number
  validateRequest?: (request: IncomingMessage) => boolean
  allowRequestHostOrigin?: boolean
}): CollaborationWebSocketHandle {
  const maxConnections = options.maxConnectionsPerRoom ?? 10
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxMessageBytes ?? COLLABORATION_MAX_CLIENT_MESSAGE_BYTES,
    perMessageDeflate: false,
  })
  const rooms = new Map<string, RoomConnections>()
  const stopPersistenceErrors = options.service.onPersistenceError((roomId) => {
    const room = rooms.get(roomId)
    if (!room) return
    for (const socket of room.sockets) socket.close(1011, 'Collaboration persistence failed')
  })

  const roomConnections = (roomId: string): RoomConnections => {
    const existing = rooms.get(roomId)
    if (existing) return existing
    const document = options.service.documentForRoom(roomId)
    const awareness = new awarenessProtocol.Awareness(document)
    awareness.setLocalState(null)
    const room: RoomConnections = {
      document,
      awareness,
      sockets: new Set<CollaborationSocket>(),
      onDocumentUpdate: () => {},
      onAwarenessUpdate: () => {},
    }
    room.onDocumentUpdate = (update: Uint8Array, origin: unknown) => {
      const message = syncUpdate(update)
      for (const socket of room.sockets) {
        if (socket !== origin) send(socket, message)
      }
    }
    room.onAwarenessUpdate = ({ added, updated, removed }, origin: unknown) => {
      const changed = added.concat(updated, removed)
      if (changed.length === 0) return
      const message = awarenessMessage(awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
      for (const socket of room.sockets) {
        if (socket !== origin) send(socket, message)
      }
    }
    document.on('update', room.onDocumentUpdate)
    awareness.on('update', room.onAwarenessUpdate)
    rooms.set(roomId, room)
    return room
  }

  const releaseRoom = (roomId: string): void => {
    const room = rooms.get(roomId)
    if (!room || room.sockets.size > 0) return
    room.document.off('update', room.onDocumentUpdate)
    room.awareness.off('update', room.onAwarenessUpdate)
    room.awareness.destroy()
    rooms.delete(roomId)
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'invalid'}`)
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    if (url.pathname !== '/api/collaboration/ws') {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    if (options.validateRequest && !options.validateRequest(request)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    if (!allowedOrigin(
      request,
      options.allowedOrigins ?? [],
      options.allowRequestHostOrigin ?? false,
    )) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    const roomId = url.searchParams.get('roomId') ?? ''
    if (!ROOM_ID.test(roomId)) {
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    const token = collaborationTokenFromCookieHeader(request.headers.cookie, roomId)
    let session
    try {
      session = options.service.authorizeSession({ roomId, sessionToken: token })
    } catch (error) {
      const status = error instanceof CollaborationNotFoundError ? 404 : 403
      rejectUpgrade(socket, status, status === 404 ? 'Not Found' : 'Forbidden')
      return
    }
    let room: RoomConnections
    try {
      room = roomConnections(roomId)
    } catch {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    if (room.sockets.size >= maxConnections) {
      rejectUpgrade(socket, 503, 'Room Full')
      return
    }
    websocket.handleUpgrade(request, socket, head, (rawSocket) => {
      const connection = rawSocket as CollaborationSocket
      connection.collaborationAlive = true
      connection.collaborationMissedHeartbeats = 0
      connection.collaborationRoomId = roomId
      connection.collaborationToken = token
      connection.awarenessClientId = undefined
      room.sockets.add(connection)
      connection.on('error', () => {
        // Protocol and payload errors are represented by the WebSocket close code.
      })
      connection.on('pong', () => {
        connection.collaborationAlive = true
        connection.collaborationMissedHeartbeats = 0
      })
      connection.on('message', (raw, binary) => {
        if (!binary) {
          connection.close(1003, 'Binary messages only')
          return
        }
        try {
          const current = options.service.authorizeSession({ roomId, sessionToken: token })
          const bytes = new Uint8Array(raw as Buffer)
          const decoder = decoding.createDecoder(bytes)
          const type = decoding.readVarUint(decoder)
          if (type === MESSAGE_SYNC) {
            const inspector = decoding.createDecoder(bytes)
            decoding.readVarUint(inspector)
            const syncType = decoding.readVarUint(inspector)
            if (
              syncType === syncProtocol.messageYjsSyncStep1 &&
              bytes.byteLength > MAX_CONTROL_MESSAGE_BYTES
            ) {
              connection.close(1009, 'Collaboration control message too large')
              return
            }
            if (syncType === syncProtocol.messageYjsSyncStep2 || syncType === syncProtocol.messageYjsUpdate) {
              options.service.authorizeSession({ roomId, sessionToken: token, write: true })
              options.service.applyValidatedUpdate(
                roomId,
                decoding.readVarUint8Array(inspector),
                connection,
              )
              return
            }
            const response = encoding.createEncoder()
            encoding.writeVarUint(response, MESSAGE_SYNC)
            syncProtocol.readSyncMessage(decoder, response, room.document, connection)
            if (encoding.length(response) > 1) send(connection, encoding.toUint8Array(response))
            return
          }
          if (type === MESSAGE_AWARENESS) {
            if (bytes.byteLength > MAX_CONTROL_MESSAGE_BYTES) {
              connection.close(1009, 'Collaboration awareness message too large')
              return
            }
            const authenticated = authenticatedAwarenessUpdate(
              decoding.readVarUint8Array(decoder),
              current,
            )
            if (
              connection.awarenessClientId !== undefined &&
              connection.awarenessClientId !== authenticated.clientId
            ) {
              throw new CollaborationAuthorizationError('A connection cannot change awareness client')
            }
            const claimed = [...room.sockets].some((candidate) =>
              candidate !== connection && candidate.awarenessClientId === authenticated.clientId,
            )
            if (claimed) throw new CollaborationAuthorizationError('Awareness client is already claimed')
            connection.awarenessClientId = authenticated.clientId
            awarenessProtocol.applyAwarenessUpdate(room.awareness, authenticated.update, connection)
            return
          }
          connection.close(1002, 'Unknown collaboration message')
        } catch (error) {
          const persistenceFailure = error instanceof CollaborationPersistenceError
          const rejectedUpdate = error instanceof CollaborationUpdateError
          connection.close(
            persistenceFailure
              ? 1011
              : rejectedUpdate || error instanceof CollaborationAuthorizationError
                ? 1008
                : 1002,
            persistenceFailure
              ? 'Collaboration persistence failed'
              : rejectedUpdate
                ? 'Collaboration update rejected'
                : error instanceof CollaborationAuthorizationError
                ? 'Forbidden'
                : 'Invalid collaboration message',
          )
        }
      })
      connection.once('close', () => {
        room.sockets.delete(connection)
        if (connection.awarenessClientId !== undefined) {
          awarenessProtocol.removeAwarenessStates(
            room.awareness,
            [connection.awarenessClientId],
            connection,
          )
        }
        releaseRoom(roomId)
      })
      send(connection, session.role === 'viewer' ? syncStep2(room.document) : syncStep1(room.document))
      const awarenessIds = [...room.awareness.getStates().keys()]
      if (awarenessIds.length > 0) {
        send(connection, awarenessMessage(
          awarenessProtocol.encodeAwarenessUpdate(room.awareness, awarenessIds),
        ))
      }
    })
  }
  options.server.on('upgrade', onUpgrade)

  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const socket of room.sockets) {
        try {
          options.service.authorizeSession({
            roomId: socket.collaborationRoomId,
            sessionToken: socket.collaborationToken,
          })
        } catch {
          socket.close(1008, 'Session revoked')
          continue
        }
        if (!socket.collaborationAlive) {
          socket.collaborationMissedHeartbeats += 1
          if (socket.collaborationMissedHeartbeats >= 3) {
            socket.terminate()
            continue
          }
        }
        socket.collaborationAlive = false
        socket.ping()
      }
    }
  }, options.heartbeatMs ?? 30_000)
  heartbeat.unref()

  let closing: Promise<void> | undefined
  return {
    connectionCount(roomId) {
      return rooms.get(roomId)?.sockets.size ?? 0
    },
    close() {
      closing ??= Promise.resolve().then(() => {
        clearInterval(heartbeat)
        stopPersistenceErrors()
        options.server.off('upgrade', onUpgrade)
        for (const room of rooms.values()) {
          for (const socket of room.sockets) socket.terminate()
          room.document.off('update', room.onDocumentUpdate)
          room.awareness.off('update', room.onAwarenessUpdate)
          room.awareness.destroy()
        }
        rooms.clear()
        websocket.close()
      })
      return closing
    },
  }
}
