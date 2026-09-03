import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import * as Y from 'yjs'
import {
  COLLABORATION_MAX_DOCUMENT_BYTES,
  type CollaborationRole,
  type CollaborationSession,
} from '../src/contracts/collaboration.ts'
import type { GenerationJob, GenerationRequest } from '../src/contracts/generation.ts'
import type { CanvasSnapshotV2 } from '../src/model/project.ts'
import {
  createCollaborativeCanvasDocument,
  exportCollaborativeCanvasSnapshot,
} from '../src/collaboration/document.ts'
import { atomicWriteJson } from './atomic-json.ts'

const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SESSION_STATUS = 'connected' as const
const MAX_ACTIVE_MEMBERS = 10
const MAX_ACTIVE_SESSIONS_PER_MEMBER = 3
const MAX_SESSION_RECORDS_PER_MEMBER = 12
const MAX_ACTIVE_INVITES = 20
const SERVER_TASK_ORIGIN = 'server-task'
const LOCAL_ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const WORKSPACE_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export class CollaborationInputError extends Error {
  readonly code = 'invalid_collaboration_input'
}

export class CollaborationAuthorizationError extends Error {
  readonly code = 'collaboration_forbidden'
}

export class CollaborationNotFoundError extends Error {
  readonly code = 'collaboration_not_found'
}

export class CollaborationLimitError extends Error {
  readonly code = 'collaboration_limit_reached'
}

export class CollaborationConflictError extends Error {
  readonly code = 'collaboration_conflict'
  readonly existingRoomId?: string

  constructor(message: string, existingRoomId?: string) {
    super(message)
    if (existingRoomId) this.existingRoomId = existingRoomId
  }
}

interface StoredInvite {
  id: string
  role: 'editor' | 'viewer'
  secretDigest: string
  createdAt: string
  revokedAt?: string
}

interface StoredMember {
  id: string
  deviceId: string
  displayName: string
  role: CollaborationRole
  createdAt: string
  removedAt?: string
}

interface StoredSession {
  id: string
  memberId: string
  tokenDigest: string
  createdAt: string
  revokedAt?: string
}

interface StoredRoomMetadata {
  version: 1
  roomId: string
  canvasId: string
  projectId: string
  ownerId: string
  recoverySecretDigest: string
  createdAt: string
  updatedAt: string
  enabled: boolean
  /** Workspace namespace that owns the room (used by workstation mode). */
  workspaceNamespace?: string
  closedAt?: string
  invites: StoredInvite[]
  members: StoredMember[]
  sessions: StoredSession[]
}

interface ActiveRoom {
  metadata: StoredRoomMetadata
  document: ReturnType<typeof createCollaborativeCanvasDocument>
  validationDocument?: ReturnType<typeof createCollaborativeCanvasDocument>
  directory: string
  updateCount: number
  updateBytes: number
  writeQueue: Promise<void>
  dirty: boolean
  persistenceError?: CollaborationPersistenceError
  onUpdate: (update: Uint8Array, origin: unknown) => void
}

export interface PublicCollaborationRoom {
  roomId: string
  canvasId: string
  projectId: string
  ownerId: string
  createdAt: string
  updatedAt: string
  enabled: boolean
  members: Array<{
    id: string
    displayName: string
    role: CollaborationRole
    removed: boolean
  }>
  invites: Array<{
    id: string
    role: 'editor' | 'viewer'
    createdAt: string
    revoked: boolean
  }>
}

export interface CollaborationPersistence {
  append(path: string, bytes: Uint8Array): Promise<void>
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
  writeJson(path: string, value: unknown): Promise<void>
}

export interface CollaborationServiceOptions {
  dataDir: string
  now?: () => Date
  id?: () => string
  secret?: () => string
  compactAfterUpdates?: number
  compactAfterBytes?: number
  exportIntervalMs?: number
  maxCandidateUpdateBytes?: number
  maxDocumentBytes?: number
  persistence?: CollaborationPersistence
  onSnapshotSaved?: (
    snapshot: CanvasSnapshotV2,
    context?: { workspaceNamespace?: string },
  ) => Promise<void> | void
}

export class CollaborationPersistenceError extends Error {
  readonly code = 'collaboration_persistence_failed'

  constructor(cause?: unknown) {
    super('Collaboration persistence failed', { cause })
  }
}

export class CollaborationUpdateError extends Error {
  readonly code = 'collaboration_invalid_update'

  constructor(cause?: unknown) {
    super('Collaboration update is invalid', { cause })
  }
}

function digest(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function equalDigest(expected: string, secret: string): boolean {
  const actual = digest(secret)
  const left = Buffer.from(expected, 'hex')
  const right = Buffer.from(actual, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

function defaultSecret(): string {
  return randomBytes(32).toString('base64url')
}

function childMap(parent: Y.Map<unknown>, key: string): Y.Map<unknown> {
  const current = parent.get(key)
  if (current instanceof Y.Map) return current
  const next = new Y.Map<unknown>()
  parent.set(key, next)
  return next
}

function replacePlainMap(parent: Y.Map<unknown>, key: string, value: Record<string, unknown>): void {
  const next = new Y.Map<unknown>()
  for (const [field, item] of Object.entries(value)) {
    if (item !== undefined) next.set(field, item)
  }
  parent.set(key, next)
}

function replaceOutputs(parent: Y.Map<unknown>, outputs: GenerationJob['outputs']): void {
  const next = new Y.Array<unknown>()
  next.insert(0, outputs.map((output) => {
    const record = new Y.Map<unknown>()
    record.set('assetId', output.assetId)
    record.set('url', output.url)
    record.set('contentType', output.contentType)
    record.set('size', output.size)
    return record
  }))
  parent.set('outputs', next)
}

function assertLocalGenerationOutputs(
  outputs: GenerationJob['outputs'],
  mediaType: GenerationRequest['mediaType'],
): void {
  if (outputs.length === 0) {
    throw new CollaborationInputError('Completed generation output is not a local asset')
  }
  for (const output of outputs) {
    if (
      !LOCAL_ASSET_ID.test(output.assetId) ||
      output.url !== `/api/assets/${output.assetId}`
    ) {
      throw new CollaborationInputError('Completed generation output is not a local asset')
    }
    if (
      (mediaType === 'image' && !output.contentType.startsWith('image/')) ||
      (mediaType === 'video' && !output.contentType.startsWith('video/'))
    ) {
      throw new CollaborationInputError('Completed output media does not match the target node')
    }
  }
}

function actualSettings(request: GenerationRequest): Record<string, unknown> {
  const common = {
    providerId: request.providerId,
    catalogVersion: request.catalogVersion,
    channel: request.channel,
    model: request.model,
    mode: request.mode ?? (request.mediaType === 'image' ? 'text2image' : 'image2video'),
    resolution: request.quality ?? '',
    aspectRatio: request.aspectRatio ?? '',
    count: request.n ?? 1,
  }
  return request.mediaType === 'image'
    ? { kind: 'image', ...common, quality: request.quality ?? '' }
    : {
        kind: 'video', ...common, durationSec: request.duration ?? 1,
        generateAudio: request.generateAudio ?? false,
      }
}

function collaborationScope(projectId: string, canvasId: string): string {
  return JSON.stringify([projectId, canvasId])
}

function assertIdentifier(value: string, name: string, expression: RegExp): void {
  if (!expression.test(value) || basename(value) !== value) {
    throw new CollaborationInputError(`${name} is invalid`)
  }
}

function assertDisplayName(value: string): void {
  if (!value.trim() || value.trim().length > 32) {
    throw new CollaborationInputError('displayName must contain between 1 and 32 characters')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value)
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return !Number.isNaN(Date.parse(value))
  } catch {
    return false
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length
}

function parseStoredRoomMetadata(value: unknown, expectedRoomId: string): StoredRoomMetadata {
  const roomKeys = [
    'version', 'roomId', 'canvasId', 'projectId', 'ownerId', 'recoverySecretDigest',
    'createdAt', 'updatedAt', 'enabled', 'invites', 'members', 'sessions',
  ]
  if (!isRecord(value) || !hasExactKeys(value, roomKeys, ['closedAt', 'workspaceNamespace']) ||
    value.version !== 1 || value.roomId !== expectedRoomId ||
    typeof value.roomId !== 'string' || !ROOM_ID.test(value.roomId) ||
    typeof value.canvasId !== 'string' || !SCOPE_ID.test(value.canvasId) ||
    typeof value.projectId !== 'string' || !SCOPE_ID.test(value.projectId) ||
    typeof value.ownerId !== 'string' || !ROOM_ID.test(value.ownerId) ||
    !isDigest(value.recoverySecretDigest) || !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) || typeof value.enabled !== 'boolean' ||
    (value.closedAt !== undefined && !isTimestamp(value.closedAt)) ||
    (value.workspaceNamespace !== undefined &&
      (typeof value.workspaceNamespace !== 'string' || !WORKSPACE_NAMESPACE.test(value.workspaceNamespace))) ||
    !Array.isArray(value.invites) || !Array.isArray(value.members) || !Array.isArray(value.sessions)) {
    throw new Error('Invalid collaboration room metadata')
  }

  const invites: StoredInvite[] = value.invites.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ['id', 'role', 'secretDigest', 'createdAt'], ['revokedAt']) ||
      typeof item.id !== 'string' || !ROOM_ID.test(item.id) ||
      (item.role !== 'editor' && item.role !== 'viewer') || !isDigest(item.secretDigest) ||
      !isTimestamp(item.createdAt) || (item.revokedAt !== undefined && !isTimestamp(item.revokedAt))) {
      throw new Error('Invalid collaboration room metadata')
    }
    return item as unknown as StoredInvite
  })
  const members: StoredMember[] = value.members.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ['id', 'deviceId', 'displayName', 'role', 'createdAt'], ['removedAt']) ||
      typeof item.id !== 'string' || !ROOM_ID.test(item.id) ||
      typeof item.deviceId !== 'string' || !DEVICE_ID.test(item.deviceId) ||
      typeof item.displayName !== 'string' || !item.displayName.trim() || item.displayName.length > 32 ||
      (item.role !== 'owner' && item.role !== 'editor' && item.role !== 'viewer') ||
      !isTimestamp(item.createdAt) || (item.removedAt !== undefined && !isTimestamp(item.removedAt))) {
      throw new Error('Invalid collaboration room metadata')
    }
    return item as unknown as StoredMember
  })
  const sessions: StoredSession[] = value.sessions.map((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ['id', 'memberId', 'tokenDigest', 'createdAt'], ['revokedAt']) ||
      typeof item.id !== 'string' || !ROOM_ID.test(item.id) ||
      typeof item.memberId !== 'string' || !ROOM_ID.test(item.memberId) ||
      !isDigest(item.tokenDigest) || !isTimestamp(item.createdAt) ||
      (item.revokedAt !== undefined && !isTimestamp(item.revokedAt))) {
      throw new Error('Invalid collaboration room metadata')
    }
    return item as unknown as StoredSession
  })
  const memberIds = members.map((member) => member.id)
  const sessionRecordCounts = new Map<string, number>()
  for (const session of sessions) {
    sessionRecordCounts.set(session.memberId, (sessionRecordCounts.get(session.memberId) ?? 0) + 1)
  }
  if (!unique(invites.map((invite) => invite.id)) || !unique(invites.map((invite) => invite.secretDigest)) ||
    !unique(memberIds) || !unique(members.map((member) => member.deviceId)) ||
    !unique(sessions.map((session) => session.id)) || !unique(sessions.map((session) => session.tokenDigest)) ||
    !sessions.every((session) => memberIds.includes(session.memberId)) ||
    [...sessionRecordCounts.values()].some((count) => count > MAX_SESSION_RECORDS_PER_MEMBER) ||
    !members.some((member) => member.id === value.ownerId && member.role === 'owner')) {
    throw new Error('Invalid collaboration room metadata')
  }
  return { ...value, invites, members, sessions } as StoredRoomMetadata
}

function publicRoom(metadata: StoredRoomMetadata): PublicCollaborationRoom {
  return {
    roomId: metadata.roomId,
    canvasId: metadata.canvasId,
    projectId: metadata.projectId,
    ownerId: metadata.ownerId,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    enabled: metadata.enabled,
    members: metadata.members.map((member) => ({
      id: member.id,
      displayName: member.displayName,
      role: member.role,
      removed: member.removedAt !== undefined,
    })),
    invites: metadata.invites.map((invite) => ({
      id: invite.id,
      role: invite.role,
      createdAt: invite.createdAt,
      revoked: invite.revokedAt !== undefined,
    })),
  }
}

function sessionFor(room: StoredRoomMetadata, member: StoredMember): CollaborationSession {
  return {
    roomId: room.roomId,
    canvasId: room.canvasId,
    projectId: room.projectId,
    memberId: member.id,
    displayName: member.displayName,
    role: member.role,
    status: SESSION_STATUS,
  }
}

function encodeRecord(update: Uint8Array): Uint8Array {
  const record = Buffer.allocUnsafe(4 + update.byteLength)
  record.writeUInt32BE(update.byteLength, 0)
  record.set(update, 4)
  return record
}

function decodeRecords(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = []
  let offset = 0
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) throw new Error('Invalid collaboration update log')
    const size = Buffer.from(bytes.buffer, bytes.byteOffset + offset, 4).readUInt32BE(0)
    offset += 4
    if (size < 1 || offset + size > bytes.byteLength) throw new Error('Invalid collaboration update log')
    records.push(bytes.slice(offset, offset + size))
    offset += size
  }
  return records
}

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function atomicWriteBytes(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { mode: 0o600 })
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export class CollaborationService {
  readonly dataDir: string
  private readonly rooms = new Map<string, ActiveRoom>()
  private readonly activeRoomIdsByScope = new Map<string, string>()
  private readonly now: () => Date
  private readonly id: () => string
  private readonly secret: () => string
  private readonly compactAfterUpdates: number
  private readonly compactAfterBytes: number
  private readonly maxCandidateUpdateBytes: number
  private readonly maxDocumentBytes: number
  private readonly persistence: CollaborationPersistence
  private readonly onSnapshotSaved?: (
    snapshot: CanvasSnapshotV2,
    context?: { workspaceNamespace?: string },
  ) => Promise<void> | void
  private readonly persistenceErrorListeners = new Set<(
    roomId: string,
    error: CollaborationPersistenceError,
  ) => void>()
  private readonly exportTimer: NodeJS.Timeout
  private lifecycle: 'open' | 'closing' | 'closed' = 'open'
  private closePromise?: Promise<void>
  private enableQueue: Promise<void> = Promise.resolve()

  private constructor(options: CollaborationServiceOptions) {
    this.dataDir = join(options.dataDir, 'collaboration')
    this.now = options.now ?? (() => new Date())
    this.id = options.id ?? randomUUID
    this.secret = options.secret ?? defaultSecret
    this.compactAfterUpdates = options.compactAfterUpdates ?? 1_000
    this.compactAfterBytes = options.compactAfterBytes ?? 1024 * 1024
    this.maxCandidateUpdateBytes = options.maxCandidateUpdateBytes ?? COLLABORATION_MAX_DOCUMENT_BYTES
    this.maxDocumentBytes = options.maxDocumentBytes ?? COLLABORATION_MAX_DOCUMENT_BYTES
    this.onSnapshotSaved = options.onSnapshotSaved
    this.persistence = options.persistence ?? {
      append: (path, bytes) => appendFile(path, bytes),
      writeBytes: atomicWriteBytes,
      writeJson: atomicWriteJson,
    }
    this.exportTimer = setInterval(() => {
      void this.flushDirtyRooms().catch(() => {})
    }, options.exportIntervalMs ?? 30_000)
    this.exportTimer.unref()
  }

  static async open(options: CollaborationServiceOptions): Promise<CollaborationService> {
    const service = new CollaborationService(options)
    try {
      await mkdir(service.dataDir, { recursive: true })
      const entries = await readdir(service.dataDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || !ROOM_ID.test(entry.name)) continue
        await service.loadRoom(entry.name)
      }
      return service
    } catch (error) {
      clearInterval(service.exportTimer)
      for (const room of service.rooms.values()) room.document.destroy()
      throw error
    }
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  private room(roomId: string): ActiveRoom {
    assertIdentifier(roomId, 'roomId', ROOM_ID)
    const room = this.rooms.get(roomId)
    if (!room || !room.metadata.enabled) throw new CollaborationNotFoundError('Collaboration room not found')
    return room
  }

  private async loadRoom(roomId: string): Promise<void> {
    const directory = join(this.dataDir, roomId)
    let metadataValue: unknown
    try {
      metadataValue = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'))
    } catch (error) {
      throw new Error('Invalid collaboration room metadata', { cause: error })
    }
    const metadata = parseStoredRoomMetadata(metadataValue, roomId)
    if (!metadata.enabled) return
    const scope = collaborationScope(metadata.projectId, metadata.canvasId)
    const existingRoomId = this.activeRoomIdsByScope.get(scope)
    if (existingRoomId) {
      throw new CollaborationConflictError(
        'An active collaboration room already exists for this canvas',
        existingRoomId,
      )
    }
    const document = createCollaborativeCanvasDocument()
    const snapshot = await readOptional(join(directory, 'snapshot.bin'))
    if (snapshot?.byteLength) Y.applyUpdate(document.doc, snapshot, 'restore')
    const log = await readOptional(join(directory, 'updates.bin'))
    const records = log ? decodeRecords(log) : []
    for (const update of records) Y.applyUpdate(document.doc, update, 'restore')
    const room = this.createActiveRoom(metadata, document, directory)
    room.updateCount = records.length
    room.updateBytes = log?.byteLength ?? 0
    this.rooms.set(roomId, room)
    this.activeRoomIdsByScope.set(scope, roomId)
  }

  private createActiveRoom(
    metadata: StoredRoomMetadata,
    document: ReturnType<typeof createCollaborativeCanvasDocument>,
    directory: string,
  ): ActiveRoom {
    const room: ActiveRoom = {
      metadata, document, directory, updateCount: 0, updateBytes: 0,
      writeQueue: Promise.resolve(), dirty: false,
      onUpdate: () => {},
    }
    room.onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === 'restore' || this.lifecycle !== 'open') return
      void this.enqueuePersistence(room, async () => {
        await this.persistence.append(join(directory, 'updates.bin'), encodeRecord(update))
        room.updateCount += 1
        room.updateBytes += update.byteLength + 4
        room.dirty = true
        if (
          room.updateCount >= this.compactAfterUpdates ||
          room.updateBytes >= this.compactAfterBytes
        ) await this.compactExclusive(room)
      }).catch(() => {})
    }
    document.doc.on('update', room.onUpdate)
    return room
  }

  private async mutateMetadata<T>(
    room: ActiveRoom,
    mutation: (metadata: StoredRoomMetadata) => T,
  ): Promise<T> {
    let result!: T
    let mutationError: unknown
    await this.enqueuePersistence(room, async () => {
      const next = structuredClone(room.metadata)
      try {
        result = mutation(next)
      } catch (error) {
        mutationError = error
        return
      }
      next.updatedAt = this.timestamp()
      await this.persistence.writeJson(join(room.directory, 'metadata.json'), next)
      room.metadata = next
    })
    if (mutationError !== undefined) throw mutationError
    return result
  }

  private async compactExclusive(room: ActiveRoom): Promise<void> {
    const binarySnapshot = Y.encodeStateAsUpdate(room.document.doc)
    const canvasSnapshot = exportCollaborativeCanvasSnapshot(room.document)
    await this.writeCompactedSnapshot(room, binarySnapshot, canvasSnapshot)
  }

  private async writeCompactedSnapshot(
    room: ActiveRoom,
    binarySnapshot: Uint8Array,
    canvasSnapshot: CanvasSnapshotV2,
  ): Promise<void> {
    await this.persistence.writeBytes(join(room.directory, 'snapshot.bin'), binarySnapshot)
    await this.persistence.writeBytes(join(room.directory, 'updates.bin'), new Uint8Array())
    await this.persistence.writeJson(join(room.directory, 'canvas.snapshot.json'), canvasSnapshot)
    try {
      await this.onSnapshotSaved?.(canvasSnapshot, {
        workspaceNamespace: room.metadata.workspaceNamespace,
      })
    } catch {
      // Snapshot mirror failures do not fail collaboration persistence
    }
    room.updateCount = 0
    room.updateBytes = 0
    room.dirty = false
  }

  private recordPersistenceError(room: ActiveRoom, cause: unknown): CollaborationPersistenceError {
    const error = cause instanceof CollaborationPersistenceError
      ? cause
      : new CollaborationPersistenceError(cause)
    if (!room.persistenceError) {
      room.persistenceError = error
      for (const listener of this.persistenceErrorListeners) {
        try { listener(room.metadata.roomId, error) } catch { /* Error observers are isolated. */ }
      }
    }
    return room.persistenceError
  }

  private enqueuePersistence(
    room: ActiveRoom,
    operation: () => Promise<void>,
    recover = false,
  ): Promise<void> {
    const result = room.writeQueue.then(async () => {
      if (room.persistenceError && !recover) throw room.persistenceError
      try {
        await operation()
      } catch (error) {
        throw this.recordPersistenceError(room, error)
      }
    })
    room.writeQueue = result.catch(() => {})
    return result
  }

  private async flushDirtyRooms(): Promise<void> {
    await Promise.all([...this.rooms.values()].map((room) =>
      this.enqueuePersistence(room, async () => {
        if (room.dirty) await this.compactExclusive(room)
      }),
    ))
  }

  enableRoom(input: {
    canvasId: string
    projectId: string
    snapshot: CanvasSnapshotV2
    deviceId: string
    displayName: string
    workspaceNamespace?: string
  }): Promise<{
    room: PublicCollaborationRoom
    session: CollaborationSession
    sessionToken: string
    recoverySecret: string
  }> {
    const result = this.enableQueue.then(() => this.enableRoomExclusive(input))
    this.enableQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async enableRoomExclusive(input: {
    canvasId: string
    projectId: string
    snapshot: CanvasSnapshotV2
    deviceId: string
    displayName: string
    workspaceNamespace?: string
  }): Promise<{
    room: PublicCollaborationRoom
    session: CollaborationSession
    sessionToken: string
    recoverySecret: string
  }> {
    if (this.lifecycle !== 'open') {
      throw new CollaborationAuthorizationError('Collaboration service is closing')
    }
    assertIdentifier(input.canvasId, 'canvasId', SCOPE_ID)
    assertIdentifier(input.projectId, 'projectId', SCOPE_ID)
    assertIdentifier(input.deviceId, 'deviceId', DEVICE_ID)
    assertDisplayName(input.displayName)
    if (input.workspaceNamespace !== undefined && !WORKSPACE_NAMESPACE.test(input.workspaceNamespace)) {
      throw new CollaborationInputError('Workspace namespace is invalid')
    }
    if (input.snapshot.canvasId !== input.canvasId || input.snapshot.projectId !== input.projectId) {
      throw new CollaborationInputError('Snapshot scope does not match collaboration scope')
    }
    const scope = collaborationScope(input.projectId, input.canvasId)
    const existingRoomId = this.activeRoomIdsByScope.get(scope)
    if (existingRoomId) {
      throw new CollaborationConflictError(
        'An active collaboration room already exists for this canvas',
        existingRoomId,
      )
    }
    const roomId = this.id()
    assertIdentifier(roomId, 'roomId', ROOM_ID)
    const ownerId = this.id()
    const sessionId = this.id()
    const recoverySecret = this.secret()
    const sessionToken = this.secret()
    const createdAt = this.timestamp()
    const member: StoredMember = {
      id: ownerId, deviceId: input.deviceId, displayName: input.displayName.trim(),
      role: 'owner', createdAt,
    }
    const metadata: StoredRoomMetadata = {
      version: 1, roomId, canvasId: input.canvasId, projectId: input.projectId,
      ownerId, recoverySecretDigest: digest(recoverySecret), createdAt, updatedAt: createdAt,
      enabled: true, invites: [], members: [member],
      sessions: [{ id: sessionId, memberId: ownerId, tokenDigest: digest(sessionToken), createdAt }],
      ...(input.workspaceNamespace ? { workspaceNamespace: input.workspaceNamespace } : {}),
    }
    const directory = join(this.dataDir, roomId)
    await mkdir(directory, { recursive: false })
    const document = createCollaborativeCanvasDocument(input.snapshot)
    const room = this.createActiveRoom(metadata, document, directory)
    this.rooms.set(roomId, room)
    this.activeRoomIdsByScope.set(scope, roomId)
    try {
      await this.persistence.writeJson(join(directory, 'metadata.json'), metadata)
      await this.enqueuePersistence(room, () => this.compactExclusive(room))
    } catch (error) {
      this.rooms.delete(roomId)
      if (this.activeRoomIdsByScope.get(scope) === roomId) this.activeRoomIdsByScope.delete(scope)
      room.document.doc.off('update', room.onUpdate)
      room.document.destroy()
      await rm(directory, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    return { room: publicRoom(metadata), session: sessionFor(metadata, member), sessionToken, recoverySecret }
  }

  getActiveRoomForScope(projectId: string, canvasId: string): PublicCollaborationRoom | undefined {
    assertIdentifier(projectId, 'projectId', SCOPE_ID)
    assertIdentifier(canvasId, 'canvasId', SCOPE_ID)
    const roomId = this.activeRoomIdsByScope.get(collaborationScope(projectId, canvasId))
    if (!roomId) return undefined
    const room = this.rooms.get(roomId)
    if (!room || !room.metadata.enabled) return undefined
    return publicRoom(room.metadata)
  }

  /**
   * Returns the workspace namespace that owns a room. The room id is already
   * an explicit collaboration capability in the current LAN deployment, so
   * this lookup intentionally does not require a second session token.
   */
  getRoomWorkspaceNamespace(roomId: string): string | undefined {
    return this.room(roomId).metadata.workspaceNamespace
  }

  /** Return the public canvas scope for an existing room before a session is exchanged. */
  getRoomScope(roomId: string): Pick<PublicCollaborationRoom, 'roomId' | 'canvasId' | 'projectId'> {
    const metadata = this.room(roomId).metadata
    return { roomId: metadata.roomId, canvasId: metadata.canvasId, projectId: metadata.projectId }
  }

  hasActiveRooms(): boolean {
    return this.activeRoomIdsByScope.size > 0
  }

  getRoomStatus(roomId: string, sessionToken: string): PublicCollaborationRoom {
    const room = this.room(roomId)
    this.authorizeSession({ roomId, sessionToken })
    return publicRoom(room.metadata)
  }

  getRoomContext(roomId: string, sessionToken: string): {
    room: PublicCollaborationRoom
    session: CollaborationSession
  } {
    const room = this.room(roomId)
    const session = this.authorizeSession({ roomId, sessionToken })
    return { room: publicRoom(room.metadata), session }
  }

  authorizeSession(input: {
    roomId?: string
    canvasId?: string
    sessionToken: string
    write?: boolean
  }): CollaborationSession {
    if (!input.sessionToken) throw new CollaborationAuthorizationError('Collaboration session is required')
    const candidates = input.roomId ? [this.room(input.roomId)] : [...this.rooms.values()]
    for (const room of candidates) {
      if (!room.metadata.enabled || (input.canvasId && room.metadata.canvasId !== input.canvasId)) continue
      const stored = room.metadata.sessions.find((session) =>
        !session.revokedAt && equalDigest(session.tokenDigest, input.sessionToken),
      )
      const member = stored && room.metadata.members.find((candidate) =>
        candidate.id === stored.memberId && !candidate.removedAt,
      )
      if (!member) continue
      if (input.write) this.assertWritable(room)
      if (input.write && member.role === 'viewer') {
        throw new CollaborationAuthorizationError('Viewer sessions cannot modify collaboration rooms')
      }
      return sessionFor(room.metadata, member)
    }
    throw new CollaborationAuthorizationError('Collaboration session is invalid or revoked')
  }

  private assertWritable(room: ActiveRoom): void {
    if (this.lifecycle !== 'open') {
      throw new CollaborationAuthorizationError('Collaboration service is closing')
    }
    if (room.persistenceError) throw room.persistenceError
  }

  async createInvite(input: {
    roomId: string
    sessionToken: string
    role: 'editor' | 'viewer'
  }): Promise<{ invite: PublicCollaborationRoom['invites'][number]; secret: string }> {
    const room = this.room(input.roomId)
    const actor = this.authorizeSession({
      roomId: input.roomId,
      sessionToken: input.sessionToken,
      write: true,
    })
    if (actor.role !== 'owner') throw new CollaborationAuthorizationError('Only owners can create invites')
    if (input.role !== 'editor' && input.role !== 'viewer') throw new CollaborationInputError('Invite role is invalid')
    return this.mutateMetadata(room, (metadata) => {
      if (metadata.invites.filter((invite) => !invite.revokedAt).length >= MAX_ACTIVE_INVITES) {
        throw new CollaborationLimitError('Collaboration invite limit reached')
      }
      const secret = this.secret()
      const invite: StoredInvite = {
        id: this.id(), role: input.role, secretDigest: digest(secret), createdAt: this.timestamp(),
      }
      metadata.invites.push(invite)
      return {
        invite: { id: invite.id, role: invite.role, createdAt: invite.createdAt, revoked: false },
        secret,
      }
    })
  }

  async exchangeSession(input: {
    roomId: string
    secret: string
    deviceId: string
    displayName: string
  }): Promise<{ session: CollaborationSession; sessionToken: string }> {
    assertIdentifier(input.deviceId, 'deviceId', DEVICE_ID)
    assertDisplayName(input.displayName)
    const room = this.room(input.roomId)
    this.assertWritable(room)
    return this.mutateMetadata(room, (metadata) => {
      const invite = metadata.invites.find((candidate) =>
        !candidate.revokedAt && equalDigest(candidate.secretDigest, input.secret),
      )
      const recovery = equalDigest(metadata.recoverySecretDigest, input.secret)
      if (!invite && !recovery) throw new CollaborationAuthorizationError('Invite is invalid or revoked')
      let member = metadata.members.find((candidate) => candidate.deviceId === input.deviceId)
      if (
        (!member || member.removedAt) &&
        metadata.members.filter((candidate) => !candidate.removedAt).length >= MAX_ACTIVE_MEMBERS
      ) {
        throw new CollaborationLimitError('Collaboration member limit reached')
      }
      const memberId = member?.id
      const memberSessions = memberId
        ? metadata.sessions.filter((session) => session.memberId === memberId)
        : []
      if (memberSessions.filter((session) => !session.revokedAt).length >= MAX_ACTIVE_SESSIONS_PER_MEMBER) {
        throw new CollaborationConflictError('Collaboration session limit reached')
      }
      const recordsToRemove = Math.max(
        0,
        memberSessions.length - (MAX_SESSION_RECORDS_PER_MEMBER - 1),
      )
      const revokedSessionIds = new Set(memberSessions
        .filter((session) => session.revokedAt)
        .sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        )
        .slice(0, recordsToRemove)
        .map((session) => session.id))
      if (revokedSessionIds.size < recordsToRemove) {
        throw new CollaborationConflictError('Collaboration session limit reached')
      }
      if (!member) {
        member = {
          id: this.id(), deviceId: input.deviceId, displayName: input.displayName.trim(),
          role: recovery ? 'owner' : (invite as StoredInvite).role, createdAt: this.timestamp(),
        }
        metadata.members.push(member)
      } else {
        member.removedAt = undefined
        member.displayName = input.displayName.trim()
        if (member.role !== 'owner') member.role = recovery ? 'owner' : (invite as StoredInvite).role
      }
      if (revokedSessionIds.size > 0) {
        metadata.sessions = metadata.sessions.filter((session) =>
          !revokedSessionIds.has(session.id),
        )
      }
      const sessionToken = this.secret()
      metadata.sessions.push({
        id: this.id(), memberId: member.id, tokenDigest: digest(sessionToken), createdAt: this.timestamp(),
      })
      return { session: sessionFor(metadata, member), sessionToken }
    })
  }

  async openSession(input: {
    roomId: string
    deviceId: string
    displayName: string
  }): Promise<{ session: CollaborationSession; sessionToken: string }> {
    assertIdentifier(input.roomId, 'roomId', ROOM_ID)
    assertIdentifier(input.deviceId, 'deviceId', DEVICE_ID)
    assertDisplayName(input.displayName)
    const room = this.room(input.roomId)
    this.assertWritable(room)
    return this.mutateMetadata(room, (metadata) => {
      let member = metadata.members.find((candidate) => candidate.deviceId === input.deviceId)
      if (
        (!member || member.removedAt) &&
        metadata.members.filter((candidate) => !candidate.removedAt).length >= MAX_ACTIVE_MEMBERS
      ) {
        throw new CollaborationLimitError('Collaboration member limit reached')
      }
      const memberSessions = member
        ? metadata.sessions.filter((session) => session.memberId === member?.id)
        : []
      if (memberSessions.filter((session) => !session.revokedAt).length >= MAX_ACTIVE_SESSIONS_PER_MEMBER) {
        throw new CollaborationConflictError('Collaboration session limit reached')
      }
      const recordsToRemove = Math.max(
        0,
        memberSessions.length - (MAX_SESSION_RECORDS_PER_MEMBER - 1),
      )
      const revokedSessionIds = new Set(memberSessions
        .filter((session) => session.revokedAt)
        .sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        )
        .slice(0, recordsToRemove)
        .map((session) => session.id))
      if (revokedSessionIds.size < recordsToRemove) {
        throw new CollaborationConflictError('Collaboration session limit reached')
      }
      if (!member) {
        member = {
          id: this.id(), deviceId: input.deviceId, displayName: input.displayName.trim(),
          role: 'editor', createdAt: this.timestamp(),
        }
        metadata.members.push(member)
      } else {
        member.removedAt = undefined
        member.displayName = input.displayName.trim()
        if (member.role !== 'owner') member.role = 'editor'
      }
      if (revokedSessionIds.size > 0) {
        metadata.sessions = metadata.sessions.filter((session) =>
          !revokedSessionIds.has(session.id),
        )
      }
      const sessionToken = this.secret()
      metadata.sessions.push({
        id: this.id(), memberId: member.id, tokenDigest: digest(sessionToken), createdAt: this.timestamp(),
      })
      return { session: sessionFor(metadata, member), sessionToken }
    })
  }

  private owner(roomId: string, sessionToken: string): ActiveRoom {
    const room = this.room(roomId)
    if (this.authorizeSession({ roomId, sessionToken, write: true }).role !== 'owner') {
      throw new CollaborationAuthorizationError('Only owners can manage collaboration rooms')
    }
    return room
  }

  async revokeInvite(input: { roomId: string; sessionToken: string; inviteId: string }): Promise<void> {
    const room = this.owner(input.roomId, input.sessionToken)
    const invite = room.metadata.invites.find((candidate) => candidate.id === input.inviteId)
    if (!invite) throw new CollaborationNotFoundError('Invite not found')
    await this.mutateMetadata(room, (metadata) => {
      const stored = metadata.invites.find((candidate) => candidate.id === input.inviteId)
      if (!stored) throw new CollaborationNotFoundError('Invite not found')
      stored.revokedAt = this.timestamp()
    })
  }

  async setMemberRole(input: {
    roomId: string
    sessionToken: string
    memberId: string
    role: 'editor' | 'viewer'
  }): Promise<void> {
    const room = this.owner(input.roomId, input.sessionToken)
    const member = room.metadata.members.find((candidate) => candidate.id === input.memberId && !candidate.removedAt)
    if (!member) throw new CollaborationNotFoundError('Member not found')
    if (member.role === 'owner') throw new CollaborationInputError('Owner role cannot be changed')
    await this.mutateMetadata(room, (metadata) => {
      const stored = metadata.members.find((candidate) => candidate.id === input.memberId && !candidate.removedAt)
      if (!stored) throw new CollaborationNotFoundError('Member not found')
      if (stored.role === 'owner') throw new CollaborationInputError('Owner role cannot be changed')
      stored.role = input.role
    })
  }

  async removeMember(input: { roomId: string; sessionToken: string; memberId: string }): Promise<void> {
    const room = this.owner(input.roomId, input.sessionToken)
    const member = room.metadata.members.find((candidate) => candidate.id === input.memberId && !candidate.removedAt)
    if (!member) throw new CollaborationNotFoundError('Member not found')
    if (member.role === 'owner') throw new CollaborationInputError('Owner cannot be removed')
    await this.mutateMetadata(room, (metadata) => {
      const stored = metadata.members.find((candidate) => candidate.id === input.memberId && !candidate.removedAt)
      if (!stored) throw new CollaborationNotFoundError('Member not found')
      if (stored.role === 'owner') throw new CollaborationInputError('Owner cannot be removed')
      stored.removedAt = this.timestamp()
      for (const session of metadata.sessions) {
        if (session.memberId === stored.id && !session.revokedAt) session.revokedAt = this.timestamp()
      }
    })
  }

  async revokeSession(sessionToken: string): Promise<void> {
    if (!sessionToken) throw new CollaborationAuthorizationError('Collaboration session is required')
    for (const room of this.rooms.values()) {
      const session = room.metadata.sessions.find((candidate) =>
        !candidate.revokedAt && equalDigest(candidate.tokenDigest, sessionToken),
      )
      if (!session) continue
      this.assertWritable(room)
      await this.mutateMetadata(room, (metadata) => {
        const stored = metadata.sessions.find((candidate) =>
          !candidate.revokedAt && equalDigest(candidate.tokenDigest, sessionToken),
        )
        if (!stored) throw new CollaborationAuthorizationError('Collaboration session is invalid or revoked')
        stored.revokedAt = this.timestamp()
      })
      return
    }
    throw new CollaborationAuthorizationError('Collaboration session is invalid or revoked')
  }

  async closeRoom(input: { roomId: string; sessionToken?: string; force?: boolean }): Promise<void> {
    const room = input.force ? this.room(input.roomId) : this.owner(input.roomId, input.sessionToken ?? '')
    await this.enqueuePersistence(room, () => this.compactExclusive(room))
    await this.mutateMetadata(room, (metadata) => {
      metadata.enabled = false
      metadata.closedAt = this.timestamp()
      for (const session of metadata.sessions) session.revokedAt ??= metadata.closedAt
    })
    room.document.doc.off('update', room.onUpdate)
    this.rooms.delete(input.roomId)
    const scope = collaborationScope(room.metadata.projectId, room.metadata.canvasId)
    if (this.activeRoomIdsByScope.get(scope) === input.roomId) {
      this.activeRoomIdsByScope.delete(scope)
    }
    room.validationDocument?.destroy()
    room.document.destroy()
  }

  documentForRoom(roomId: string): Y.Doc {
    return this.room(roomId).document.doc
  }

  applyGenerationJobUpdate(job: GenerationJob): boolean {
    if (!job.roomId || !job.targetNodeId || !('projectId' in job.request)) {
      throw new CollaborationInputError('协同生成任务标识信息不完整 (Collaborative generation identity is incomplete)')
    }
    const request = job.request as GenerationRequest
    if (request.targetNodeId !== job.targetNodeId) {
      throw new CollaborationInputError('生成任务目标节点不匹配 (Generation job target identity does not match)')
    }
    const room = this.room(job.roomId)
    if (request.projectId !== room.metadata.projectId || request.canvasId !== room.metadata.canvasId) {
      throw new CollaborationInputError('协同作用域与房间不匹配 (Generation scope does not match the collaboration room)')
    }
    const node = room.document.doc.getMap<Y.Map<unknown>>('nodes').get(job.targetNodeId)
    if (!(node instanceof Y.Map)) throw new CollaborationInputError('未找到生成目标节点 (Generation target node was not found)')
    const nodeType = node.get('type')
    if (nodeType !== request.mediaType || (nodeType !== 'image' && nodeType !== 'video')) {
      throw new CollaborationInputError('生成媒体类型与目标节点不匹配 (Generation media does not match the target node)')
    }
    const data = childMap(node, 'data')
    const generation = childMap(data, 'generation')
    const currentJobId = generation.get('jobId')
    const currentClientRequestId = generation.get('clientRequestId')
    if (typeof currentClientRequestId === 'string' && currentClientRequestId !== job.clientRequestId) {
      return false
    }
    if (typeof currentJobId === 'string' && currentJobId !== job.id) {
      if (job.status !== 'queued' || currentClientRequestId !== job.clientRequestId) return false
    }
    if (job.status === 'complete') {
      assertLocalGenerationOutputs(job.outputs, request.mediaType)
    }

    room.document.doc.transact(() => {
      generation.set('jobId', job.id)
      generation.set('clientRequestId', job.clientRequestId)
      generation.set('status', job.status === 'complete' ? 'complete' : job.status === 'failed' ? 'failed' : 'generating')
      generation.set('phase', job.status)
      generation.set('progress', Math.max(0, Math.min(100, job.progress)))
      generation.set('providerId', request.providerId)
      generation.set('createdAt', job.createdAt)
      if (job.status === 'failed') {
        generation.delete('pendingRequest')
        if (job.error) replacePlainMap(generation, 'error', job.error)
        else generation.delete('error')
      } else {
        generation.delete('error')
      }
      if (job.status === 'complete') {
        const output = job.outputs[0]!
        data.set('assetId', output.assetId)
        data.set('url', output.url)
        if (request.mediaType === 'video') data.delete('poster')
        generation.delete('pendingRequest')
        replaceOutputs(generation, job.outputs)
        replacePlainMap(generation, 'actualSettings', actualSettings(request))
        if (request.aspectRatio) generation.set('outputAspectRatio', request.aspectRatio)
      }
    }, SERVER_TASK_ORIGIN)
    if (room.validationDocument) {
      room.validationDocument.destroy()
      room.validationDocument = undefined
    }
    return true
  }

  private getOrCreateValidationDocument(
    room: ActiveRoom,
  ): ReturnType<typeof createCollaborativeCanvasDocument> {
    if (room.validationDocument) return room.validationDocument
    const validationDoc = new Y.Doc()
    const validationDocument = createCollaborativeCanvasDocument(undefined, { doc: validationDoc })
    Y.applyUpdate(validationDoc, Y.encodeStateAsUpdate(room.document.doc), 'validation-init')
    room.validationDocument = validationDocument
    return validationDocument
  }

  applyValidatedUpdate(roomId: string, update: Uint8Array, origin: unknown): void {
    const room = this.room(roomId)
    this.assertWritable(room)
    if (
      update.byteLength > this.maxCandidateUpdateBytes ||
      room.updateBytes + update.byteLength > this.maxDocumentBytes
    ) {
      throw new CollaborationUpdateError()
    }
    const candidateDocument = this.getOrCreateValidationDocument(room)
    try {
      Y.applyUpdate(candidateDocument.doc, update, 'validation')
      exportCollaborativeCanvasSnapshot(candidateDocument)
    } catch (error) {
      room.validationDocument?.destroy()
      room.validationDocument = undefined
      throw error instanceof CollaborationUpdateError ? error : new CollaborationUpdateError(error)
    }
    Y.applyUpdate(room.document.doc, update, origin)
  }

  exportSnapshot(roomId: string): CanvasSnapshotV2 {
    return exportCollaborativeCanvasSnapshot(this.room(roomId).document)
  }

  async settlePersistence(roomId: string): Promise<void> {
    const room = this.room(roomId)
    await room.writeQueue
    if (room.persistenceError) throw room.persistenceError
  }

  async recoverRoomPersistence(roomId: string): Promise<void> {
    if (this.lifecycle !== 'open') {
      throw new CollaborationAuthorizationError('Collaboration service is closing')
    }
    const room = this.room(roomId)
    await room.writeQueue
    await this.enqueuePersistence(room, async () => {
      await this.compactExclusive(room)
      await this.persistence.writeJson(join(room.directory, 'metadata.json'), room.metadata)
      room.persistenceError = undefined
    }, true)
  }

  onPersistenceError(listener: (
    roomId: string,
    error: CollaborationPersistenceError,
  ) => void): () => void {
    this.persistenceErrorListeners.add(listener)
    return () => this.persistenceErrorListeners.delete(listener)
  }

  close(): Promise<void> {
    if (this.lifecycle === 'closed') return Promise.resolve()
    if (this.closePromise) return this.closePromise
    this.lifecycle = 'closing'
    clearInterval(this.exportTimer)
    const closingRooms = [...this.rooms.values()].map((room) => {
      room.document.doc.off('update', room.onUpdate)
      return {
        room,
        binarySnapshot: Y.encodeStateAsUpdate(room.document.doc),
        canvasSnapshot: exportCollaborativeCanvasSnapshot(room.document),
      }
    })
    this.closePromise = (async () => {
      let failure: unknown
      try {
        for (const { room, binarySnapshot, canvasSnapshot } of closingRooms) {
          await this.waitForStableQueue(room)
          await this.enqueuePersistence(
            room,
            () => this.writeCompactedSnapshot(room, binarySnapshot, canvasSnapshot),
          )
          await this.waitForStableQueue(room)
        }
      } catch (error) {
        failure = error
      } finally {
        for (const { room } of closingRooms) {
          room.validationDocument?.destroy()
          room.document.destroy()
        }
        this.rooms.clear()
        this.activeRoomIdsByScope.clear()
        this.lifecycle = 'closed'
      }
      if (failure) throw failure
    })()
    return this.closePromise
  }

  private async waitForStableQueue(room: ActiveRoom): Promise<void> {
    while (true) {
      const queue = room.writeQueue
      await queue
      if (queue === room.writeQueue) return
    }
  }
}

export function authorizeCollaborationGeneration(
  service: CollaborationService,
  input: { roomId: string; canvasId: string; sessionToken: string },
): CollaborationSession {
  return service.authorizeSession({ ...input, write: true })
}
