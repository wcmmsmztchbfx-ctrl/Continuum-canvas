import type {
  CollaborationInvite,
  CollaborationRole,
  CollaborationRoom,
  CollaborationSession,
  CreateCollaborationInviteResponse,
  EnableCollaborationRoomResponse,
} from '../contracts/collaboration.ts'
import type { CanvasSnapshotV2 } from '../model/project.ts'
import { createBrowserUuid } from '../utils/id.ts'

const DEVICE_STORAGE_KEY = 'libtv-collaboration-device-id'
export const COLLABORATION_DISPLAY_NAME_STORAGE_KEY = 'libtv-collaboration-display-name'
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const ROOM_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const COLLABORATION_ERROR_MESSAGES = {
  invalid_collaboration_input: 'The collaboration request is invalid',
  collaboration_forbidden: 'Collaboration access was denied',
  collaboration_not_found: 'The collaboration room was not found',
  collaboration_limit_reached: 'The collaboration room limit was reached',
  collaboration_conflict: '该画布已经开启协作，正在尝试恢复原协作房间',
  collaboration_persistence_failed: 'The collaboration room could not be saved',
  collaboration_invalid_update: 'The collaboration update was rejected',
} as const

type CollaborationGatewayErrorCode = keyof typeof COLLABORATION_ERROR_MESSAGES

type UnknownRecord = Record<string, unknown>

interface CollaborationErrorEnvelope {
  error?: { code?: unknown; message?: unknown; existingRoomId?: unknown }
}

export interface CollaborationClientOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  storage?: Storage
  createDeviceId?: () => string
}

export interface CollaborationRequestOptions {
  signal?: AbortSignal
}

export interface InviteFragmentLocation {
  hash: string
  pathname: string
  search: string
}

export interface InviteFragmentHistory {
  replaceState(state: unknown, unused: string, url?: string | URL | null): void
}

export class CollaborationClientError extends Error {
  readonly status: number
  readonly code: string
  readonly existingRoomId?: string

  constructor(status: number, code: string, message: string, existingRoomId?: string) {
    super(message)
    this.name = 'CollaborationClientError'
    this.status = status
    this.code = code
    if (existingRoomId && ROOM_IDENTIFIER.test(existingRoomId)) {
      this.existingRoomId = existingRoomId
    }
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collaborationGatewayErrorCode(value: unknown): CollaborationGatewayErrorCode | 'request_failed' {
  return typeof value === 'string' && value in COLLABORATION_ERROR_MESSAGES
    ? value as CollaborationGatewayErrorCode
    : 'request_failed'
}

function collaborationGatewayErrorMessage(code: CollaborationGatewayErrorCode | 'request_failed'): string {
  return code === 'request_failed'
    ? 'The collaboration request failed'
    : COLLABORATION_ERROR_MESSAGES[code]
}

function failInvalidResponse(message: string): never {
  throw new CollaborationClientError(200, 'invalid_response', message)
}

function isRole(value: unknown): value is CollaborationRole {
  return value === 'owner' || value === 'editor' || value === 'viewer'
}

function isInviteRole(value: unknown): value is 'editor' | 'viewer' {
  return value === 'editor' || value === 'viewer'
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isSession(value: unknown): value is CollaborationSession {
  return isRecord(value) &&
    typeof value.roomId === 'string' && ROOM_IDENTIFIER.test(value.roomId) &&
    typeof value.canvasId === 'string' && IDENTIFIER.test(value.canvasId) &&
    typeof value.projectId === 'string' && IDENTIFIER.test(value.projectId) &&
    typeof value.memberId === 'string' && ROOM_IDENTIFIER.test(value.memberId) &&
    typeof value.displayName === 'string' && value.displayName.length > 0 &&
    value.displayName.length <= 32 && isRole(value.role) && value.status === 'connected'
}

function isInvite(value: unknown): value is CollaborationInvite {
  return isRecord(value) &&
    typeof value.id === 'string' && ROOM_IDENTIFIER.test(value.id) &&
    isInviteRole(value.role) && isIsoDate(value.createdAt) && typeof value.revoked === 'boolean'
}

function isRoom(value: unknown): value is CollaborationRoom {
  return isRecord(value) &&
    typeof value.roomId === 'string' && ROOM_IDENTIFIER.test(value.roomId) &&
    typeof value.canvasId === 'string' && IDENTIFIER.test(value.canvasId) &&
    typeof value.projectId === 'string' && IDENTIFIER.test(value.projectId) &&
    typeof value.ownerId === 'string' && ROOM_IDENTIFIER.test(value.ownerId) &&
    isIsoDate(value.createdAt) && isIsoDate(value.updatedAt) &&
    typeof value.enabled === 'boolean' &&
    Array.isArray(value.members) && value.members.every((member) =>
      isRecord(member) && typeof member.id === 'string' && ROOM_IDENTIFIER.test(member.id) &&
      typeof member.displayName === 'string' && member.displayName.length > 0 &&
      member.displayName.length <= 32 && isRole(member.role) && typeof member.removed === 'boolean') &&
    Array.isArray(value.invites) && value.invites.every(isInvite)
}

function normalizedDisplayName(displayName: string): string {
  const normalized = displayName.trim()
  if (!normalized || normalized.length > 32) {
    throw new CollaborationClientError(
      0,
      'invalid_display_name',
      'Display name must contain between 1 and 32 characters',
    )
  }
  return normalized
}

function assertIdentifier(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw new CollaborationClientError(0, 'invalid_identifier', `${label} is invalid`)
  }
}

function defaultStorage(): Storage {
  if (!globalThis.localStorage) {
    throw new CollaborationClientError(0, 'storage_unavailable', 'Local storage is unavailable')
  }
  return globalThis.localStorage
}

export function getOrCreateCollaborationDeviceId(
  storage: Storage,
  createDeviceId: () => string = createBrowserUuid,
): string {
  const existing = storage.getItem(DEVICE_STORAGE_KEY)
  if (existing && ROOM_IDENTIFIER.test(existing)) return existing
  const created = createDeviceId()
  if (!ROOM_IDENTIFIER.test(created)) {
    throw new CollaborationClientError(0, 'invalid_device_id', 'Generated device id is invalid')
  }
  storage.setItem(DEVICE_STORAGE_KEY, created)
  return created
}

export function getCollaborationDisplayName(storage: Storage): string | undefined {
  const value = storage.getItem(COLLABORATION_DISPLAY_NAME_STORAGE_KEY)
  if (!value) return undefined
  const normalized = value.trim()
  return normalized && normalized.length <= 32 ? normalized : undefined
}

export function setCollaborationDisplayName(storage: Storage, displayName: string): string {
  const normalized = normalizedDisplayName(displayName)
  storage.setItem(COLLABORATION_DISPLAY_NAME_STORAGE_KEY, normalized)
  return normalized
}

function inviteSecret(hash: string): string {
  const parameters = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const secret = parameters.get('invite') ?? ''
  if (!secret) {
    throw new CollaborationClientError(0, 'invite_missing', 'Collaboration invite is missing')
  }
  if (secret.length > 512) {
    throw new CollaborationClientError(0, 'invite_invalid', 'Collaboration invite is invalid')
  }
  return secret
}

export class CollaborationClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly storage: Storage
  private readonly createDeviceId: () => string

  constructor(options: CollaborationClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/$/, '') ?? ''
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.storage = options.storage ?? defaultStorage()
    this.createDeviceId = options.createDeviceId ?? createBrowserUuid
  }

  private deviceId(): string {
    return getOrCreateCollaborationDeviceId(this.storage, this.createDeviceId)
  }

  private async request(
    path: string,
    init: RequestInit = {},
    options: CollaborationRequestOptions = {},
  ): Promise<UnknownRecord> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        credentials: 'same-origin',
        signal: options.signal,
      })
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok) {
        const envelope = isRecord(payload) ? payload as CollaborationErrorEnvelope : {}
        const code = collaborationGatewayErrorCode(envelope.error?.code)
        const existingRoomId =
          code === 'collaboration_conflict' &&
          typeof envelope.error?.existingRoomId === 'string' &&
          ROOM_IDENTIFIER.test(envelope.error.existingRoomId)
            ? envelope.error.existingRoomId
            : undefined
        throw new CollaborationClientError(
          response.status,
          code,
          collaborationGatewayErrorMessage(code),
          existingRoomId,
        )
      }
      if (!isRecord(payload)) failInvalidResponse('Collaboration gateway returned an invalid response')
      return payload
    } catch (error) {
      if (error instanceof CollaborationClientError) throw error
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      throw new CollaborationClientError(0, 'network_error', 'Unable to reach collaboration gateway')
    }
  }

  async enableRoom(
    input: { snapshot: CanvasSnapshotV2; displayName: string },
    options?: CollaborationRequestOptions,
  ): Promise<EnableCollaborationRoomResponse> {
    const displayName = normalizedDisplayName(input.displayName)
    const payload = await this.request('/api/collaboration/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        canvasId: input.snapshot.canvasId,
        projectId: input.snapshot.projectId,
        snapshot: input.snapshot,
        deviceId: this.deviceId(),
        displayName,
      }),
    }, options)
    if (!isRoom(payload.room) || !isSession(payload.session) ||
      typeof payload.recoverySecret !== 'string' || !payload.recoverySecret) {
      failInvalidResponse('Collaboration gateway returned an invalid room')
    }
    setCollaborationDisplayName(this.storage, displayName)
    return payload as unknown as EnableCollaborationRoomResponse
  }

  async getRoom(roomId: string, options?: CollaborationRequestOptions): Promise<CollaborationRoom> {
    assertIdentifier(roomId, ROOM_IDENTIFIER, 'roomId')
    const payload = await this.request(`/api/collaboration/rooms/${encodeURIComponent(roomId)}`, {}, options)
    if (!isRoom(payload.room)) failInvalidResponse('Collaboration gateway returned an invalid room')
    return payload.room
  }

  async resumeRoom(
    roomId: string,
    options?: CollaborationRequestOptions,
  ): Promise<{ room: CollaborationRoom; session: CollaborationSession }> {
    assertIdentifier(roomId, ROOM_IDENTIFIER, 'roomId')
    const payload = await this.request(
      `/api/collaboration/rooms/${encodeURIComponent(roomId)}`,
      {},
      options,
    )
    if (!isRoom(payload.room) || !isSession(payload.session)) {
      failInvalidResponse('Collaboration gateway returned an invalid room session')
    }
    return {
      room: payload.room,
      session: payload.session,
    }
  }

  async createInvite(
    roomId: string,
    role: 'editor' | 'viewer',
    options?: CollaborationRequestOptions,
  ): Promise<CreateCollaborationInviteResponse> {
    assertIdentifier(roomId, ROOM_IDENTIFIER, 'roomId')
    const payload = await this.request(
      `/api/collaboration/rooms/${encodeURIComponent(roomId)}/invites`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      },
      options,
    )
    if (!isInvite(payload.invite) || typeof payload.secret !== 'string' || !payload.secret) {
      failInvalidResponse('Collaboration gateway returned an invalid invite')
    }
    return payload as unknown as CreateCollaborationInviteResponse
  }

  async revokeInvite(
    roomId: string,
    inviteId: string,
    options?: CollaborationRequestOptions,
  ): Promise<void> {
    assertIdentifier(roomId, ROOM_IDENTIFIER, 'roomId')
    assertIdentifier(inviteId, ROOM_IDENTIFIER, 'inviteId')
    const payload = await this.request(
      `/api/collaboration/rooms/${encodeURIComponent(roomId)}/invites/${encodeURIComponent(inviteId)}`,
      { method: 'DELETE' }, options,
    )
    if (payload.revoked !== true) failInvalidResponse('Collaboration invite was not revoked')
  }

  async joinRoom(
    input: { roomId: string; secret: string; displayName: string },
    options?: CollaborationRequestOptions,
  ): Promise<CollaborationSession> {
    assertIdentifier(input.roomId, ROOM_IDENTIFIER, 'roomId')
    const displayName = normalizedDisplayName(input.displayName)
    const payload = await this.request('/api/collaboration/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: input.roomId,
        secret: input.secret,
        deviceId: this.deviceId(),
        displayName,
      }),
    }, options)
    if (!isSession(payload.session)) failInvalidResponse('Collaboration gateway returned an invalid session')
    setCollaborationDisplayName(this.storage, displayName)
    return payload.session
  }

  async joinFromInviteFragment(input: {
    roomId: string
    displayName: string
    location: InviteFragmentLocation
    history: InviteFragmentHistory
    signal?: AbortSignal
  }): Promise<CollaborationSession> {
    const session = await this.joinRoom({
      roomId: input.roomId,
      secret: inviteSecret(input.location.hash),
      displayName: input.displayName,
    }, { signal: input.signal })
    input.history.replaceState(null, '', `${input.location.pathname}${input.location.search}`)
    return session
  }

  async setMemberRole(
    roomId: string,
    memberId: string,
    role: 'editor' | 'viewer',
    options?: CollaborationRequestOptions,
  ): Promise<void> {
    assertIdentifier(roomId, ROOM_IDENTIFIER, 'roomId')
    assertIdentifier(memberId, ROOM_IDENTIFIER, 'memberId')
    const payload = await this.request(
      `/api/collaboration/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      }, options,
    )
    if (payload.updated !== true) failInvalidResponse('Collaboration member role was not updated')
  }

  async removeMember(
    roomId: string,
    memberId: string,
    options?: CollaborationRequestOptions,
  ): Promise<void> {
    assertIdentifier(roomId, ROOM_IDENTIFIER, 'roomId')
    assertIdentifier(memberId, ROOM_IDENTIFIER, 'memberId')
    const payload = await this.request(
      `/api/collaboration/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}`,
      { method: 'DELETE' }, options,
    )
    if (payload.removed !== true) failInvalidResponse('Collaboration member was not removed')
  }

  async leaveRoom(roomId: string, options?: CollaborationRequestOptions): Promise<void> {
    assertIdentifier(roomId, ROOM_IDENTIFIER, 'roomId')
    const payload = await this.request(
      `/api/collaboration/sessions/current?roomId=${encodeURIComponent(roomId)}`,
      { method: 'DELETE' }, options,
    )
    if (payload.revoked !== true) failInvalidResponse('Collaboration session was not revoked')
  }

  async closeRoom(roomId: string, options?: CollaborationRequestOptions): Promise<void> {
    assertIdentifier(roomId, ROOM_IDENTIFIER, 'roomId')
    const payload = await this.request(
      `/api/collaboration/rooms/${encodeURIComponent(roomId)}`,
      { method: 'DELETE' }, options,
    )
    if (payload.closed !== true) failInvalidResponse('Collaboration room was not closed')
  }
}
