import { createReadStream } from 'node:fs'
import { readdir, stat, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { BlockList, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { RemoteAssetTimeoutError, RemoteAssetValidationError } from './asset-store.ts'
import { resolveCollaborationNetworkConfig, type GatewayEnvironment } from './config.ts'
import type { ProviderRecord } from './provider-registry.ts'
import { IMAGE_REQUEST_MODES, type ImageRequestMode } from '../src/contracts/catalog.ts'
import {
  CatalogChangedError,
  GenerationValidationError,
} from './generation-validation.ts'
import {
  CorruptJobsFileError,
  IdempotencyConflictError,
  InvalidGenerationRequestError,
  RemoteReferenceImportError,
} from './jobs.ts'
import { DataDirectoryLockedError } from './data-directory-lock.ts'
import {
  GenerationHistoryConflictError,
  InvalidGenerationHistoryCursorError,
} from './generation-history.ts'
import {
  createGatewayRuntime,
  type AdapterFactory,
  type GatewayRuntime,
  ProviderOperationError,
  ProviderUnavailableError,
  RuntimeNotFoundError,
} from './runtime.ts'
import type { AddressLookup, PinnedRemoteFetcher } from './pinned-http.ts'
import { ProviderRequestRejectedError } from './providers/provider-adapter.ts'
import { XiaoYunqueAdapter } from './providers/xiaoyunque-adapter.ts'
import {
  authorizeCollaborationGeneration,
  CollaborationAuthorizationError,
  CollaborationConflictError,
  CollaborationInputError,
  CollaborationLimitError,
  CollaborationNotFoundError,
} from './collaboration-service.ts'
import type { CollaborationServiceOptions } from './collaboration-service.ts'
import { parseCanvasSnapshot } from '../src/model/project.ts'
import { attachCollaborationWebSocket } from './collaboration-websocket.ts'
import {
  collaborationCookieName,
  collaborationRoomIdsFromCookieHeader,
  collaborationTokenFromCookieHeader,
} from './collaboration-cookie.ts'
import {
  LOCAL_ADMIN_COOKIE,
  LocalAdminAuthorizationError,
  LocalAdminService,
  localAdminTokenFromCookie,
} from './local-admin-service.ts'
import { AgentAccessError, bearerToken } from './agent-access-store.ts'
import { CanvasRevisionConflictError } from './canvas-document-service.ts'
import { WorkflowInputError } from './workflow-service.ts'
import type { AgentScope, CanvasOperationBatch, DirectorLaunchSettings, WorkflowCandidate } from '../src/contracts/agent-api.ts'


class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: Record<string, string>

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, string>,
  ) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

class BodyLimitError extends ApiError {
  readonly destroyRequest = true

  constructor() {
    super(413, 'payload_too_large', 'Request body is too large')
  }
}

const JSON_LIMIT = 1024 * 1024
const RAW_LIMIT = 100 * 1024 * 1024
const COLLABORATION_ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

// XiaoYunque returns temporary CDN URLs. Keep one import promise per runtime and
// upstream URL so repeated polling does not download the same completed video.
const directorVideoAssetImports = new WeakMap<GatewayRuntime, Map<string, Promise<string>>>()

function directorVideoFilename(input: string, index: number): string {
  try {
    const parsed = new URL(input)
    const queryFilename = parsed.searchParams.get('filename')
    const candidate = basename(queryFilename || parsed.pathname)
    if (/\.(?:mp4|webm|mov)$/i.test(candidate)) return candidate
  } catch {
    // The caller will retain the original URL if importing fails.
  }
  return `xiaoyunque-video-${index + 1}.mp4`
}

async function localizeDirectorVideoOutputs<T extends Record<string, unknown>>(
  runtime: GatewayRuntime,
  result: T,
  signal?: AbortSignal,
): Promise<T> {
  if (!runtime.assets.canImportRemote()) return result

  const rawUrls = [
    ...(Array.isArray(result.videoUrls) ? result.videoUrls : []),
    result.videoUrl,
  ].filter((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value))
  const urls = Array.from(new Set(rawUrls))
  if (urls.length === 0) return result

  let cache = directorVideoAssetImports.get(runtime)
  if (!cache) {
    cache = new Map()
    directorVideoAssetImports.set(runtime, cache)
  }

  const localizedByRemote = new Map<string, string>()
  await Promise.all(urls.map(async (remoteUrl, index) => {
    let pending = cache!.get(remoteUrl)
    if (!pending) {
      pending = runtime.assets
        .importRemote(remoteUrl, directorVideoFilename(remoteUrl, index), signal)
        .then((asset) => asset.url)
      cache!.set(remoteUrl, pending)
      pending.catch(() => cache!.delete(remoteUrl))
    }
    try {
      localizedByRemote.set(remoteUrl, await pending)
    } catch (error) {
      console.warn('[XiaoYunque] 成片转存为本地画布资产失败，将保留原始地址:', error)
    }
  }))

  const localize = (value: unknown) =>
    typeof value === 'string' ? (localizedByRemote.get(value) ?? value) : value
  return {
    ...result,
    ...(Array.isArray(result.videoUrls)
      ? { videoUrls: result.videoUrls.map(localize) }
      : {}),
    ...(typeof result.videoUrl === 'string'
      ? { videoUrl: localize(result.videoUrl) }
      : {}),
  }
}
const LOOPBACK_ADDRESSES = new BlockList()
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6')
LOOPBACK_ADDRESSES.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

function sendJson(response: ServerResponse, status: number, payload: unknown, head = false): void {
  const body = Buffer.from(JSON.stringify(payload))
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(head ? undefined : body)
}

async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    throw new BodyLimitError()
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > limit) {
      throw new BodyLimitError()
    }
    chunks.push(bytes)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

async function rejectUnexpectedBody(request: IncomingMessage): Promise<void> {
  const bytes = await readBody(request, JSON_LIMIT)
  if (bytes.byteLength > 0) throw new ApiError(400, 'invalid_input', 'This route does not accept a request body')
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') throw new ApiError(400, 'invalid_input', 'Expected application/json')
  const bytes = await readBody(request, JSON_LIMIT)
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new ApiError(400, 'invalid_input', 'Request body is not valid JSON')
  }
}

async function readOptionalJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') return undefined
  const bytes = await readBody(request, JSON_LIMIT)
  if (bytes.byteLength === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    throw new ApiError(400, 'invalid_input', 'Request body is not valid JSON')
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_input', 'Request body must be an object')
  }
  return value as Record<string, unknown>
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ApiError(400, 'invalid_input', 'Request body contains unsupported fields')
  }
}

function collaborationSessionToken(request: IncomingMessage, roomId: string): string {
  return collaborationTokenFromCookieHeader(request.headers.cookie, roomId)
}

function collaborationCookie(roomId: string, token: string, secure: boolean, clear = false): string {
  return [
    `${collaborationCookieName(roomId)}=${clear ? '' : token}`,
    'Path=/api',
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
    ...(clear ? ['Max-Age=0'] : []),
  ].join('; ')
}

function authorizeSensitiveRequest(
  request: IncomingMessage,
  runtime: GatewayRuntime,
  localAdmin: LocalAdminService,
  localAdminAllowed: boolean,
  requiredRole: 'owner' | 'editor',
): { kind: 'local-admin' } | { kind: 'collaboration'; roomId: string; session: ReturnType<GatewayRuntime['collaboration']['authorizeSession']> } {
  const cookieRooms = collaborationRoomIdsFromCookieHeader(request.headers.cookie)
  const header = request.headers['x-collaboration-room']
  const roomId = typeof header === 'string' ? header : ''
  if (header === undefined) {
    if (localAdminAllowed && isLoopbackRemoteAddress(request.socket.remoteAddress)) {
      localAdmin.authorize(localAdminTokenFromCookie(request.headers.cookie))
      return { kind: 'local-admin' }
    }
    throw new CollaborationAuthorizationError('Explicit local administrator authorization is required')
  }
  if (!COLLABORATION_ROOM_ID.test(roomId) || !cookieRooms.includes(roomId)) {
    throw new CollaborationAuthorizationError('A matching collaboration room is required')
  }
  const session = runtime.collaboration.authorizeSession({
    roomId,
    sessionToken: collaborationSessionToken(request, roomId),
  })
  if (requiredRole === 'owner' && session.role !== 'owner') {
    throw new CollaborationAuthorizationError('Only owners can manage providers')
  }
  if (requiredRole === 'editor' && session.role === 'viewer') {
    throw new CollaborationAuthorizationError('Viewers cannot start generation tasks')
  }
  return { kind: 'collaboration', roomId, session }
}

function authorizeProviderWrite(
  request: IncomingMessage,
  runtime: GatewayRuntime,
  localAdmin: LocalAdminService,
  localAdminAllowed: boolean,
): void {
  authorizeSensitiveRequest(request, runtime, localAdmin, localAdminAllowed, 'owner')
}

function authorizeAgentRequest(
  request: IncomingMessage,
  runtime: GatewayRuntime,
  canvasId: string,
  scope: AgentScope,
  projectId?: string,
) {
  if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) {
    throw new AgentAccessError('Agent API is only available on this computer')
  }
  return runtime.agentAccess.authorize(bearerToken(request.headers.authorization), {
    canvasId,
    projectId,
    scope,
  })
}

const ACTIVE_GENERATION_STATUSES = new Set(['queued', 'uploading', 'submitted', 'running', 'downloading'])
const generationTargetQueues = new WeakMap<GatewayRuntime, Map<string, Promise<unknown>>>()

async function submitCollaborativeGeneration(
  runtime: GatewayRuntime,
  roomId: string,
  request: import('../src/contracts/generation.ts').GenerationRequest,
) {
  const targetNodeId = request.targetNodeId as string
  const key = `${roomId}\u0000${targetNodeId}`
  let queues = generationTargetQueues.get(runtime)
  if (!queues) {
    queues = new Map()
    generationTargetQueues.set(runtime, queues)
  }
  const previous = queues.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    const active = runtime.jobs.list().find((job) => (
      ACTIVE_GENERATION_STATUSES.has(job.status) &&
      'targetNodeId' in job.request && job.request.targetNodeId === targetNodeId &&
      'projectId' in job.request && job.request.projectId === request.projectId &&
      job.request.canvasId === request.canvasId
    ))
    if (active && active.clientRequestId !== request.clientRequestId) {
      throw new ApiError(409, 'target_busy', 'The target node already has an active generation task')
    }
    return runtime.submit(request, { roomId, targetNodeId })
  })
  queues.set(key, operation)
  try {
    return await operation
  } finally {
    if (queues.get(key) === operation) queues.delete(key)
  }
}

function setCollaborationCookie(
  response: ServerResponse,
  roomId: string,
  token: string,
  secure: boolean,
): void {
  response.setHeader('set-cookie', collaborationCookie(roomId, token, secure))
}

function clearCollaborationCookie(response: ServerResponse, roomId: string, secure: boolean): void {
  response.setHeader('set-cookie', collaborationCookie(roomId, '', secure, true))
}

function collaborationRoomInput(value: unknown) {
  const body = record(value)
  strictKeys(body, ['canvasId', 'projectId', 'snapshot', 'deviceId', 'displayName'])
  if (
    typeof body.canvasId !== 'string' || typeof body.projectId !== 'string' ||
    typeof body.deviceId !== 'string' || typeof body.displayName !== 'string'
  ) throw new ApiError(400, 'invalid_input', 'Collaboration room input is invalid')
  let snapshot
  try {
    snapshot = parseCanvasSnapshot(JSON.stringify(body.snapshot))
  } catch {
    throw new ApiError(400, 'invalid_input', 'Collaboration snapshot is invalid')
  }
  return {
    canvasId: body.canvasId,
    projectId: body.projectId,
    snapshot,
    deviceId: body.deviceId,
    displayName: body.displayName,
  }
}

function collaborationSessionInput(value: unknown) {
  const body = record(value)
  strictKeys(body, ['roomId', 'secret', 'deviceId', 'displayName'])
  if (
    typeof body.roomId !== 'string' || typeof body.secret !== 'string' ||
    typeof body.deviceId !== 'string' || typeof body.displayName !== 'string'
  ) throw new ApiError(400, 'invalid_input', 'Collaboration session input is invalid')
  return {
    roomId: body.roomId,
    secret: body.secret,
    deviceId: body.deviceId,
    displayName: body.displayName,
  }
}

function providerInput(id: string, value: unknown): ProviderRecord {
  const body = record(value)
  strictKeys(body, ['name', 'adapterType', 'baseUrl', 'enabled', 'preferred', 'imageRequestMode'])
  if (
    typeof body.name !== 'string' || typeof body.adapterType !== 'string' ||
    typeof body.baseUrl !== 'string' || typeof body.enabled !== 'boolean' || typeof body.preferred !== 'boolean'
  ) throw new ApiError(400, 'invalid_input', 'Provider metadata is invalid')
  if (
    body.imageRequestMode !== undefined &&
    !IMAGE_REQUEST_MODES.includes(body.imageRequestMode as ImageRequestMode)
  ) throw new ApiError(400, 'invalid_input', 'Provider image request mode is invalid')
  return {
    id,
    name: body.name,
    adapterType: body.adapterType,
    baseUrl: body.baseUrl,
    enabled: body.enabled,
    preferred: body.preferred,
    ...(typeof body.imageRequestMode === 'string'
      ? { imageRequestMode: body.imageRequestMode as ImageRequestMode }
      : {}),
  }
}

function historyBackfillInput(value: unknown): {
  projectId: string
  entries: Array<{ jobId: string; outputIndex: number; assetId: string }>
} {
  const body = record(value)
  strictKeys(body, ['projectId', 'entries'])
  if (typeof body.projectId !== 'string' || !body.projectId || body.projectId.length > 256) {
    throw new ApiError(400, 'invalid_input', 'History projectId is invalid')
  }
  if (!Array.isArray(body.entries) || body.entries.length < 1 || body.entries.length > 500) {
    throw new ApiError(400, 'invalid_input', 'History entries are invalid')
  }
  const entries = body.entries.map((value) => {
    const entry = record(value)
    strictKeys(entry, ['jobId', 'outputIndex', 'assetId'])
    if (typeof entry.jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.jobId) ||
      !Number.isInteger(entry.outputIndex) || (entry.outputIndex as number) < 0 ||
      typeof entry.assetId !== 'string' || !/^[0-9a-f-]{36}$/i.test(entry.assetId)) {
      throw new ApiError(400, 'invalid_input', 'History entry is invalid')
    }
    return {
      jobId: entry.jobId,
      outputIndex: entry.outputIndex as number,
      assetId: entry.assetId,
    }
  })
  if (new Set(entries.map((entry) => `${entry.jobId}\0${entry.outputIndex}`)).size !== entries.length) {
    throw new ApiError(400, 'invalid_input', 'History entries contain duplicate outputs')
  }
  return { projectId: body.projectId, entries }
}

function historyReassignmentInput(value: unknown): {
  operationId: string
  canvasId: string
  fromProjectId: string
  toProjectId: string
} {
  const body = record(value)
  strictKeys(body, ['operationId', 'canvasId', 'fromProjectId', 'toProjectId'])
  for (const key of ['operationId', 'canvasId', 'fromProjectId', 'toProjectId'] as const) {
    if (typeof body[key] !== 'string' || !body[key] || body[key].length > 256) {
      throw new ApiError(400, 'invalid_input', 'History reassignment input is invalid')
    }
  }
  return {
    operationId: body.operationId as string,
    canvasId: body.canvasId as string,
    fromProjectId: body.fromProjectId as string,
    toProjectId: body.toProjectId as string,
  }
}

function canvasAssetReferenceInput(value: unknown): { projectId: string; assetIds: string[] } {
  const body = record(value)
  strictKeys(body, ['projectId', 'assetIds'])
  if (typeof body.projectId !== 'string' || !body.projectId || body.projectId.length > 256 ||
    !Array.isArray(body.assetIds) || body.assetIds.length > 10_000 ||
    body.assetIds.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) ||
    new Set(body.assetIds).size !== body.assetIds.length) {
    throw new ApiError(400, 'invalid_input', 'Canvas asset references are invalid')
  }
  return { projectId: body.projectId, assetIds: body.assetIds as string[] }
}

function canvasScopeQuery(url: URL): { projectId: string; canvasId: string } {
  const projectId = url.searchParams.get('projectId')
  const canvasId = url.searchParams.get('canvasId')
  if (!projectId || projectId.length > 256 || !canvasId || canvasId.length > 256) {
    throw new ApiError(400, 'invalid_input', 'Canvas scope is invalid')
  }
  return { projectId, canvasId }
}

function canvasAssetReferenceCanvasId(path: string): string | undefined {
  const match = /^\/api\/canvas-asset-references\/([^/]+)$/.exec(path)
  if (!match) return undefined
  let canvasId: string
  try {
    canvasId = decodeURIComponent(match[1])
  } catch {
    throw new ApiError(400, 'invalid_input', 'canvasId is invalid')
  }
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(canvasId)) {
    throw new ApiError(400, 'invalid_input', 'canvasId is invalid')
  }
  return canvasId
}

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase()
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized
}

export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = normalizeHost(address)
  const family = isIP(normalized)
  if (family === 4) return LOOPBACK_ADDRESSES.check(normalized, 'ipv4')
  if (family === 6) return LOOPBACK_ADDRESSES.check(normalized, 'ipv6')
  return false
}

export function isPrivateLanRemoteAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = normalizeHost(address)
  const family = isIP(normalized)
  if (family === 4) {
    const octets = normalized.split('.').map(Number)
    return octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254)
  }
  return family === 6 && (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8'))
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host)
  return normalized === 'localhost' || isLoopbackRemoteAddress(normalized)
}

export function isPrivateLanHost(host: string): boolean {
  const normalized = normalizeHost(host)
  return isPrivateLanRemoteAddress(normalized)
}

const VIRTUAL_ADAPTER = /(vmware|virtual|vethernet|hyper-v|wsl|docker|loopback|tunnel|vpn|tap|tun)/i

export function selectPrivateLanAddress(): string | undefined {
  const adapters = networkInterfaces()
  const candidates = Object.entries(adapters).flatMap(([name, addresses = []]) =>
    addresses
      .filter((entry) => entry.family === 'IPv4' && !entry.internal && isPrivateLanRemoteAddress(entry.address))
      .map((entry) => ({ name, address: entry.address })),
  )
  return candidates.find((entry) => !VIRTUAL_ADAPTER.test(entry.name))?.address
    ?? candidates[0]?.address
}

export function isAllowedHost(
  request: IncomingMessage,
  dynamicAllowedOrigins: readonly string[] = [],
  dynamicPublicOrigin?: string,
): boolean {
  const host = request.headers.host
  if (!host || host.includes('@')) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return false
  }
  if (isLoopbackHost(hostname) || isPrivateLanHost(hostname) || hostname === '0.0.0.0') return true
  if (dynamicPublicOrigin) {
    try {
      if (new URL(dynamicPublicOrigin).hostname.toLowerCase() === hostname) return true
    } catch {}
  }
  for (const origin of dynamicAllowedOrigins) {
    try {
      if (new URL(origin).hostname.toLowerCase() === hostname) return true
    } catch {}
  }
  return false
}

export function isAllowedRemoteAddress(
  address: string | undefined,
  hasPublicOrigin: boolean,
  localHostOnly: boolean,
): boolean {
  if (!localHostOnly || hasPublicOrigin) return true
  return isLoopbackRemoteAddress(address) || isPrivateLanRemoteAddress(address)
}

function hasLoopbackBrowserOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (typeof origin !== 'string') return false
  try {
    const parsed = new URL(origin)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username && !parsed.password &&
      (isLoopbackHost(parsed.hostname) || isPrivateLanHost(parsed.hostname))
    )
  } catch {
    return false
  }
}

export function formatGatewayOrigin(host: string, port: number): string {
  const normalized = normalizeHost(host)
  if (normalized === '0.0.0.0') return `http://127.0.0.1:${port}`
  if (isIP(normalized) === 6) {
    const hostname = new URL(`http://[${normalized}]`).hostname
    return `http://${hostname === '[::]' ? '[::1]' : hostname}:${port}`
  }
  return `http://${normalized}:${port}`
}

async function calculateDirStats(dirPath: string): Promise<{ bytes: number; count: number }> {
  let bytes = 0
  let count = 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isFile()) {
        const s = await stat(fullPath)
        bytes += s.size
        count += 1
      } else if (entry.isDirectory()) {
        const sub = await calculateDirStats(fullPath)
        bytes += sub.bytes
        count += sub.count
      }
    }
  } catch {}
  return { bytes, count }
}

function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function assertAllowedOrigin(
  request: IncomingMessage,
  configured: readonly string[] = [],
  allowRequestHost = false,
  dynamicPublicOrigin?: string,
): void {
  const origin = request.headers.origin
  if (origin === undefined) return
  if (Array.isArray(origin)) throw new ApiError(403, 'origin_not_allowed', 'Request Origin is not allowed')
  const host = request.headers.host
  const values = configured.map((value) => value.toLowerCase())
  if (dynamicPublicOrigin) values.push(dynamicPublicOrigin.toLowerCase())
  if (allowRequestHost) {
    if (host) {
      values.push(`http://${host.toLowerCase()}`, `https://${host.toLowerCase()}`)
    }
    values.push(
      'http://127.0.0.1:4173',
      'http://localhost:4173',
    )
  }
  const allowed = new Set(values)
  if (!allowed.has(origin.toLowerCase())) {
    try {
      const parsedOrigin = new URL(origin)
      if (isLoopbackHost(parsedOrigin.hostname) || isPrivateLanHost(parsedOrigin.hostname)) {
        return
      }
    } catch {}
    throw new ApiError(403, 'origin_not_allowed', 'Request Origin is not allowed')
  }
}

function classifyApiPath(pathname: string): { reserved: boolean; encoded: boolean } {
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    if (!pathname.includes('%')) return { reserved: true, encoded: false }
    try {
      const decoded = decodeURIComponent(pathname)
      const segments = decoded.split('/')
      const encodedSeparator = decoded.includes('\\') || segments.length !== pathname.split('/').length
      const dotSegment = segments.some((segment) => segment === '.' || segment === '..')
      return { reserved: true, encoded: encodedSeparator || dotSegment }
    } catch {
      return { reserved: true, encoded: true }
    }
  }
  if (!pathname.includes('%')) return { reserved: false, encoded: false }
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname).replaceAll('\\', '/')
  } catch {
    return { reserved: pathname.toLowerCase().startsWith('/api%'), encoded: true }
  }
  const reserved = decoded === '/api' || decoded.startsWith('/api/')
  return { reserved, encoded: reserved }
}

function publicError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof RuntimeNotFoundError || /not found/i.test((error as Error).message)) {
    return new ApiError(404, 'not_found', 'Resource not found')
  }
  if (error instanceof CollaborationAuthorizationError) {
    return new ApiError(403, error.code, 'Collaboration access is not allowed')
  }
  if (error instanceof LocalAdminAuthorizationError) {
    return new ApiError(403, error.code, 'Local administrator access is not allowed')
  }
  if (error instanceof AgentAccessError) return new ApiError(403, error.code, error.message)
  if (error instanceof CanvasRevisionConflictError) {
    return new ApiError(409, error.code, error.message, {
      expectedRevision: String(error.expectedRevision),
      actualRevision: String(error.actualRevision),
    })
  }
  if (error instanceof WorkflowInputError) return new ApiError(400, error.code, error.message)
  if (error instanceof CollaborationLimitError) {
    return new ApiError(429, error.code, 'Collaboration capacity has been reached')
  }
  if (error instanceof CollaborationConflictError) {
    return new ApiError(
      409,
      error.code,
      'Collaboration session conflicts with the current state',
      error.existingRoomId ? { existingRoomId: error.existingRoomId } : undefined,
    )
  }
  if (error instanceof CollaborationNotFoundError) {
    return new ApiError(404, error.code, 'Collaboration room was not found')
  }
  if (error instanceof CollaborationInputError) {
    return new ApiError(400, error.code, 'Collaboration input is invalid')
  }
  if (error instanceof CatalogChangedError) return new ApiError(409, 'catalog_changed', error.message)
  if (error instanceof GenerationHistoryConflictError) {
    return new ApiError(409, error.code, 'Generation history conflicts with existing metadata')
  }
  if (error instanceof InvalidGenerationHistoryCursorError) {
    return new ApiError(400, error.code, 'Generation history cursor is invalid')
  }
  if (error instanceof IdempotencyConflictError) {
    return new ApiError(409, 'idempotency_conflict', 'clientRequestId is already used for a different request')
  }
  if (error instanceof DataDirectoryLockedError) return new ApiError(409, 'locked', 'Backend data is in use')
  if (error instanceof CorruptJobsFileError) return new ApiError(409, 'corruption_recovery', 'Generation data requires recovery')
  if (error instanceof RemoteAssetTimeoutError) {
    return new ApiError(504, error.code, 'Remote asset import timed out')
  }
  if (error instanceof RemoteAssetValidationError) {
    return new ApiError(400, error.code, 'Remote asset content does not match a supported media type')
  }
  if (
    error instanceof InvalidGenerationRequestError || error instanceof GenerationValidationError ||
    error instanceof RemoteReferenceImportError || error instanceof ProviderUnavailableError
  ) return new ApiError(400, 'invalid_input', 'Request could not be accepted')
  if (error instanceof ProviderOperationError) {
    return error.code === 'upstream_timeout'
      ? new ApiError(504, 'upstream_timeout', 'Provider operation timed out')
      : new ApiError(502, 'upstream_error', 'Provider operation failed')
  }
  if (error instanceof ProviderRequestRejectedError) {
    return new ApiError(502, error.code, error.message, {
      ...(error.providerCode ? { providerCode: error.providerCode } : {}),
    })
  }
  const message = (error as Error)?.message ?? ''
  if (/size|too large|exceeds the allowed limit/i.test(message)) return new ApiError(413, 'payload_too_large', 'Asset is too large')
  if (/timed out|timeout/i.test(message)) return new ApiError(504, 'upstream_timeout', 'Upstream operation timed out')
  if (/remote asset request failed/i.test(message)) return new ApiError(502, 'upstream_error', 'Upstream operation failed')
  if (/provider|upstream/i.test(message)) return new ApiError(502, 'upstream_error', 'Upstream operation failed')
  if (/invalid|unsupported|signature|mime|extension|public|redirect|filename/i.test(message)) {
    return new ApiError(400, 'invalid_input', 'Request input is invalid')
  }
  return new ApiError(500, 'internal_error', 'Internal server error')
}

async function serveAsset(
  runtime: GatewayRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  assetId: string,
): Promise<void> {
  const asset = runtime.assets.get(assetId)
  if (!asset) throw new RuntimeNotFoundError('Asset not found')
  try {
    const opened = await runtime.assets.openResponse(assetId, request.headers.range)
    response.writeHead(opened.status, { ...opened.headers, 'x-content-type-options': 'nosniff' })
    if (request.method === 'HEAD') {
      opened.stream.destroy()
      response.end()
      return
    }
    await pipeline(opened.stream, response)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    response.writeHead(416, {
      'content-range': `bytes */${asset.size}`,
      'accept-ranges': 'bytes',
      'content-length': '0',
    })
    response.end()
  }
}

async function serveStatic(
  distDir: string | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!distDir || (request.method !== 'GET' && request.method !== 'HEAD')) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    throw new ApiError(400, 'invalid_input', 'Invalid URL path')
  }
  const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  let target = resolve(distDir, requested)
  const within = relative(resolve(distDir), target)
  if (within.startsWith('..') || isAbsolute(within)) throw new ApiError(404, 'not_found', 'Resource not found')
  let info = await stat(target).catch(() => undefined)
  if ((!info || !info.isFile()) && !extname(requested)) {
    target = join(distDir, 'index.html')
    info = await stat(target).catch(() => undefined)
  }
  if (!info?.isFile()) return false
  response.writeHead(200, {
    'content-type': STATIC_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(info.size),
    'x-content-type-options': 'nosniff',
  })
  if (request.method === 'HEAD') response.end()
  else await pipeline(createReadStream(target), response)
  return true
}

async function routeApi(
  runtime: GatewayRuntime,
  localAdmin: LocalAdminService,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  rawBodyLimit: number,
  signal: AbortSignal,
  secureCollaborationCookies: boolean,
  localAdminAllowed: boolean,
  localAdminRecoveryAllowed: boolean,
  frontendPort: number = 4173,
  onReset?: () => Promise<void>,
  isE2eMode?: boolean,
): Promise<boolean> {
  const method = request.method ?? 'GET'
  const path = url.pathname
  if (path !== '/api' && !path.startsWith('/api/')) return false
  if (method === 'GET' && path === '/api/health') {
    sendJson(response, 200, { ok: true, version: 1 })
    return true
  }
  if (method === 'POST' && path === '/api/dev/reset-e2e-fixtures') {
    if (!isE2eMode) {
      sendJson(response, 404, { error: { code: 'not_found', message: 'Resource not found' } })
      return true
    }
    if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) {
      throw new ApiError(403, 'forbidden', 'Fixture reset is only available on loopback')
    }
    await rejectUnexpectedBody(request)
    if (onReset) await onReset()
    else await runtime.workspace.reset()
    sendJson(response, 200, { ok: true, state: { rooms: 0, jobs: 0, assets: 0, workspaceDocuments: 0 } })
    return true
  }
  if (method === 'POST' && path === '/api/local-admin/session') {
    if (!localAdminAllowed || !isLoopbackRemoteAddress(request.socket.remoteAddress)) {
      throw new LocalAdminAuthorizationError('Local administrator registration is unavailable')
    }
    await rejectUnexpectedBody(request)
    const result = await localAdmin.registerOrResume(
      localAdminTokenFromCookie(request.headers.cookie),
      { allowRecovery: localAdminRecoveryAllowed },
    )
    if (result.token) {
      response.setHeader('set-cookie', [
        `${LOCAL_ADMIN_COOKIE}=${result.token}`,
        'Path=/', 'HttpOnly', 'SameSite=Strict',
        ...(secureCollaborationCookies ? ['Secure'] : []),
      ].join('; '))
    }
    sendJson(response, 200, { ok: true, created: result.created })
    return true
  }
  if (path === '/api/agent/v1/tokens' && method === 'GET') {
    authorizeSensitiveRequest(request, runtime, localAdmin, localAdminAllowed, 'owner')
    sendJson(response, 200, { tokens: runtime.agentAccess.list() })
    return true
  }
  if (path === '/api/agent/v1/tokens' && method === 'POST') {
    authorizeSensitiveRequest(request, runtime, localAdmin, localAdminAllowed, 'owner')
    const body = record(await readJson(request))
    const created = await runtime.agentAccess.create({
      canvasId: String(body.canvasId ?? ''),
      projectId: String(body.projectId ?? ''),
      name: String(body.name ?? 'Codex'),
      scopes: Array.isArray(body.scopes) ? body.scopes as AgentScope[] : undefined,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined,
    })
    sendJson(response, 201, created)
    return true
  }
  const agentTokenMatch = /^\/api\/agent\/v1\/tokens\/([0-9a-f-]{36})$/i.exec(path)
  if (agentTokenMatch && method === 'DELETE') {
    authorizeSensitiveRequest(request, runtime, localAdmin, localAdminAllowed, 'owner')
    sendJson(response, 200, { token: await runtime.agentAccess.revoke(agentTokenMatch[1]) })
    return true
  }
  const agentCanvasMatch = /^\/api\/agent\/v1\/canvases\/([A-Za-z0-9._:-]+)$/.exec(path)
  if (agentCanvasMatch && method === 'GET') {
    const canvasId = agentCanvasMatch[1]
    const actor = authorizeAgentRequest(request, runtime, canvasId, 'canvas:read')
    const document = await runtime.canvasDocuments.get(canvasId)
    if (!document || document.snapshot.projectId !== actor.projectId) throw new RuntimeNotFoundError('Canvas not found')
    const nodeIds = url.searchParams.getAll('nodeId')
    const selectedNodes = nodeIds.length ? document.snapshot.nodes.filter((node) => nodeIds.includes(node.id)) : undefined
    const selectedIds = new Set(selectedNodes?.map((node) => node.id) ?? [])
    const adjacentEdges = selectedNodes ? document.snapshot.edges.filter((edge) => selectedIds.has(edge.source) || selectedIds.has(edge.target)) : undefined
    sendJson(response, 200, { version: 1, revision: document.revision, canvas: document.snapshot, selectedNodes, adjacentEdges })
    return true
  }
  const agentOperationsMatch = /^\/api\/agent\/v1\/canvases\/([A-Za-z0-9._:-]+)\/operations$/.exec(path)
  if (agentOperationsMatch && method === 'POST') {
    const canvasId = agentOperationsMatch[1]
    const body = record(await readJson(request)) as unknown as CanvasOperationBatch
    const actor = authorizeAgentRequest(request, runtime, canvasId, 'canvas:write')
    if (body.operations?.some((operation) => operation.type === 'node.delete' || operation.type === 'edge.delete')) {
      authorizeAgentRequest(request, runtime, canvasId, 'canvas:delete', actor.projectId)
    }
    sendJson(response, 200, { receipt: await runtime.canvasOperations.execute(canvasId, body, actor.id) })
    return true
  }
  if (path === '/api/agent/v1/workflows' && method === 'POST') {
    const body = record(await readJson(request))
    const canvasId = String(body.canvasId ?? '')
    const projectId = String(body.projectId ?? '')
    authorizeAgentRequest(request, runtime, canvasId, 'canvas:write', projectId)
    const workflow = await runtime.workflows.create({
      canvasId,
      projectId,
      candidates: body.candidates as WorkflowCandidate[],
      referenceNodeIds: Array.isArray(body.referenceNodeIds) ? body.referenceNodeIds as string[] : [],
      skillNodeIds: Array.isArray(body.skillNodeIds) ? body.skillNodeIds as string[] : [],
      settings: body.settings as DirectorLaunchSettings,
    })
    sendJson(response, 201, { workflow })
    return true
  }
  const workflowMatch = /^\/api\/agent\/v1\/workflows\/([0-9a-f-]{36})$/.exec(path)
  if (workflowMatch && method === 'GET') {
    const workflow = runtime.workflows.get(workflowMatch[1])
    if (!workflow) throw new RuntimeNotFoundError('Workflow not found')
    authorizeAgentRequest(request, runtime, workflow.canvasId, 'canvas:read', workflow.projectId)
    sendJson(response, 200, { workflow })
    return true
  }
  const workflowApproveMatch = /^\/api\/agent\/v1\/workflows\/([0-9a-f-]{36})\/approve$/.exec(path)
  if (workflowApproveMatch && method === 'POST') {
    const workflow = runtime.workflows.get(workflowApproveMatch[1])
    if (!workflow) throw new RuntimeNotFoundError('Workflow not found')
    authorizeAgentRequest(request, runtime, workflow.canvasId, 'workflow:approve', workflow.projectId)
    authorizeAgentRequest(request, runtime, workflow.canvasId, 'director:generate', workflow.projectId)
    const body = record(await readJson(request))
    const approvedNodeIds = Array.isArray(body.approvedNodeIds) ? body.approvedNodeIds.filter((item): item is string => typeof item === 'string') : []
    sendJson(response, 200, { workflow: await runtime.workflows.approve(workflow.id, approvedNodeIds) })
    return true
  }
  const workflowWaitMatch = /^\/api\/agent\/v1\/workflows\/([0-9a-f-]{36})\/wait$/.exec(path)
  if (workflowWaitMatch && method === 'GET') {
    const workflow = runtime.workflows.get(workflowWaitMatch[1])
    if (!workflow) throw new RuntimeNotFoundError('Workflow not found')
    authorizeAgentRequest(request, runtime, workflow.canvasId, 'canvas:read', workflow.projectId)
    const timeoutMs = Number(url.searchParams.get('timeoutMs') ?? 30_000)
    const after = url.searchParams.get('afterUpdatedAt') ?? undefined
    sendJson(response, 200, { workflow: await runtime.workflows.wait(workflow.id, after, timeoutMs) })
    return true
  }
  const directorAnswerMatch = /^\/api\/agent\/v1\/director-runs\/([0-9a-f-]{36})\/answer$/.exec(path)
  if (directorAnswerMatch && method === 'POST') {
    const body = record(await readJson(request))
    const workflow = runtime.workflows.list().find((item) => item.directorRuns.some((run) => run.id === directorAnswerMatch[1]))
    if (!workflow) throw new RuntimeNotFoundError('Director run not found')
    authorizeAgentRequest(request, runtime, workflow.canvasId, 'director:generate', workflow.projectId)
    sendJson(response, 200, { run: await runtime.workflows.answer(directorAnswerMatch[1], { optionId: typeof body.optionId === 'string' ? body.optionId : undefined, value: String(body.value ?? '') }) })
    return true
  }
  const directorRetryMatch = /^\/api\/agent\/v1\/director-runs\/([0-9a-f-]{36})\/retry$/.exec(path)
  if (directorRetryMatch && method === 'POST') {
    const workflow = runtime.workflows.list().find((item) => item.directorRuns.some((run) => run.id === directorRetryMatch[1]))
    if (!workflow) throw new RuntimeNotFoundError('Director run not found')
    authorizeAgentRequest(request, runtime, workflow.canvasId, 'director:generate', workflow.projectId)
    sendJson(response, 200, { run: await runtime.workflows.retry(directorRetryMatch[1]) })
    return true
  }
  if (path === '/api/agent/v1/events' && method === 'GET') {
    const canvasId = url.searchParams.get('canvasId') ?? ''
    const actor = authorizeAgentRequest(request, runtime, canvasId, 'canvas:read')
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const write = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`)
    write({ type: 'ready', canvasId, projectId: actor.projectId })
    const unsubscribeCanvas = runtime.canvasDocuments.subscribe(canvasId, (event) => write({ type: 'canvas.updated', event }))
    const unsubscribeWorkflow = runtime.workflows.subscribe((event) => {
      const eventCanvasId = event.workflow?.canvasId ?? event.run?.canvasId
      if (eventCanvasId === canvasId) write(event)
    })
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
    await new Promise<void>((resolve) => response.once('close', resolve))
    clearInterval(heartbeat)
    unsubscribeCanvas()
    unsubscribeWorkflow()
    response.end()
    return true
  }
  if (method === 'POST' && path === '/api/collaboration/rooms') {
    const body = collaborationRoomInput(await readJson(request))
    const enabled = await runtime.collaboration.enableRoom(body)
    setCollaborationCookie(
      response,
      enabled.room.roomId,
      enabled.sessionToken,
      secureCollaborationCookies,
    )
    sendJson(response, 201, {
      room: enabled.room,
      session: enabled.session,
      recoverySecret: enabled.recoverySecret,
    })
    return true
  }
  if (method === 'POST' && path === '/api/collaboration/sessions') {
    const input = collaborationSessionInput(await readJson(request))
    const exchanged = await runtime.collaboration.exchangeSession(input)
    setCollaborationCookie(response, input.roomId, exchanged.sessionToken, secureCollaborationCookies)
    sendJson(response, 200, { session: exchanged.session })
    return true
  }
  if (method === 'DELETE' && path === '/api/collaboration/sessions/current') {
    await rejectUnexpectedBody(request)
    const roomId = url.searchParams.get('roomId') ?? ''
    if (!COLLABORATION_ROOM_ID.test(roomId)) {
      throw new ApiError(400, 'invalid_input', 'A valid collaboration roomId is required')
    }
    const sessionToken = collaborationSessionToken(request, roomId)
    await runtime.collaboration.revokeSession(sessionToken)
    clearCollaborationCookie(response, roomId, secureCollaborationCookies)
    sendJson(response, 200, { revoked: true })
    return true
  }
  const roomMatch = /^\/api\/collaboration\/rooms\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(path)
  if (roomMatch && method === 'GET') {
    const sessionToken = collaborationSessionToken(request, roomMatch[1])
    sendJson(
      response,
      200,
      runtime.collaboration.getRoomContext(roomMatch[1], sessionToken),
    )
    return true
  }
  if (roomMatch && method === 'DELETE') {
    await rejectUnexpectedBody(request)
    const sessionToken = collaborationSessionToken(request, roomMatch[1])
    const forceParam = url.searchParams.get('force') === 'true'
    if (forceParam && localAdminAllowed && isLoopbackRemoteAddress(request.socket.remoteAddress)) {
      await runtime.collaboration.closeRoom({ roomId: roomMatch[1], force: true })
    } else {
      try {
        await runtime.collaboration.closeRoom({ roomId: roomMatch[1], sessionToken })
      } catch (error) {
        if (
          error instanceof CollaborationAuthorizationError &&
          localAdminAllowed &&
          isLoopbackRemoteAddress(request.socket.remoteAddress)
        ) {
          await runtime.collaboration.closeRoom({ roomId: roomMatch[1], force: true })
        } else {
          throw error
        }
      }
    }
    clearCollaborationCookie(response, roomMatch[1], secureCollaborationCookies)
    sendJson(response, 200, { closed: true })
    return true
  }
  const invitesMatch = /^\/api\/collaboration\/rooms\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/invites$/.exec(path)
  if (invitesMatch && method === 'POST') {
    const sessionToken = collaborationSessionToken(request, invitesMatch[1])
    const input = record(await readJson(request))
    strictKeys(input, ['role'])
    if (input.role !== 'editor' && input.role !== 'viewer') {
      throw new ApiError(400, 'invalid_input', 'Invite role is invalid')
    }
    sendJson(response, 201, await runtime.collaboration.createInvite({
      roomId: invitesMatch[1], sessionToken, role: input.role,
    }))
    return true
  }
  const inviteMatch = /^\/api\/collaboration\/rooms\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/invites\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(path)
  if (inviteMatch && method === 'DELETE') {
    await rejectUnexpectedBody(request)
    const sessionToken = collaborationSessionToken(request, inviteMatch[1])
    await runtime.collaboration.revokeInvite({
      roomId: inviteMatch[1], sessionToken, inviteId: inviteMatch[2],
    })
    sendJson(response, 200, { revoked: true })
    return true
  }
  const memberMatch = /^\/api\/collaboration\/rooms\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/members\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(path)
  if (memberMatch && method === 'PATCH') {
    const sessionToken = collaborationSessionToken(request, memberMatch[1])
    const input = record(await readJson(request))
    strictKeys(input, ['role'])
    if (input.role !== 'editor' && input.role !== 'viewer') {
      throw new ApiError(400, 'invalid_input', 'Member role is invalid')
    }
    await runtime.collaboration.setMemberRole({
      roomId: memberMatch[1], sessionToken, memberId: memberMatch[2], role: input.role,
    })
    sendJson(response, 200, { updated: true })
    return true
  }
  if (memberMatch && method === 'DELETE') {
    await rejectUnexpectedBody(request)
    const sessionToken = collaborationSessionToken(request, memberMatch[1])
    await runtime.collaboration.removeMember({
      roomId: memberMatch[1], sessionToken, memberId: memberMatch[2],
    })
    sendJson(response, 200, { removed: true })
    return true
  }
  if (method === 'GET' && path === '/api/network/lan-address') {
    const lanIp = selectPrivateLanAddress()
    sendJson(response, 200, {
      lanIp: lanIp ?? null,
      port: frontendPort,
      lanOrigin: lanIp ? `http://${lanIp}:${frontendPort}` : null,
    })
    return true
  }
  if (method === 'GET' && path === '/api/system/storage-info') {
    const stagingDir = join(runtime.dataDir, 'staging')
    const assetsDir = join(runtime.dataDir, 'assets')
    const stagingStats = await calculateDirStats(stagingDir)
    const assetsStats = await calculateDirStats(assetsDir)
    const totalBytes = stagingStats.bytes + assetsStats.bytes
    const totalFiles = stagingStats.count + assetsStats.count
    sendJson(response, 200, {
      storagePath: runtime.dataDir,
      stagingBytes: stagingStats.bytes,
      assetsBytes: assetsStats.bytes,
      totalCacheBytes: totalBytes,
      totalCacheFormatted: formatStorageBytes(totalBytes),
      fileCount: totalFiles,
    })
    return true
  }
  if (method === 'POST' && path === '/api/system/clear-cache') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const stagingDir = join(runtime.dataDir, 'staging')
    let freedBytes = 0
    try {
      const entries = await readdir(stagingDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile()) {
          const filePath = join(stagingDir, entry.name)
          try {
            const s = await stat(filePath)
            freedBytes += s.size
            await unlink(filePath)
          } catch {}
        }
      }
    } catch {}
    sendJson(response, 200, {
      success: true,
      freedBytes,
      freedFormatted: formatStorageBytes(freedBytes),
    })
    return true
  }
  if (method === 'GET' && path === '/api/system/version') {
    sendJson(response, 200, {
      version: '1.2.0',
      name: 'Continuum Canvas',
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
    })
    return true
  }
  if (method === 'GET' && path === '/api/collaboration/tunnel') {
    sendJson(response, 200, runtime.tunnel.getStatus())
    return true
  }
  if (method === 'POST' && path === '/api/collaboration/tunnel/start') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const body = await readOptionalJson(request)
    const mode = body?.mode === 'custom' ? 'custom' : 'auto'
    if (mode === 'custom') {
      if (typeof body?.customUrl === 'string') {
        await runtime.tunnel.setCustomUrl(body.customUrl)
      }
      const status = await runtime.tunnel.startCustomMode()
      sendJson(response, 200, status)
    } else {
      const status = await runtime.tunnel.startAutoTunnel(frontendPort)
      sendJson(response, 200, status)
    }
    return true
  }
  if (method === 'POST' && path === '/api/collaboration/tunnel/stop') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const status = await runtime.tunnel.stopTunnel()
    sendJson(response, 200, status)
    return true
  }
  if (method === 'PUT' && path === '/api/collaboration/tunnel/custom-url') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const body = record(await readJson(request))
    const customUrl = typeof body.customUrl === 'string' ? body.customUrl : undefined
    const status = await runtime.tunnel.setCustomUrl(customUrl)
    sendJson(response, 200, status)
    return true
  }
  if (method === 'GET' && path === '/api/providers') {
    sendJson(response, 200, { providers: runtime.providers.listPublic() })
    return true
  }

  const providerMatch = /^\/api\/providers\/([a-z][a-z0-9-]{0,47})$/.exec(path)
  if (providerMatch && method === 'PUT') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const provider = await runtime.updateProvider(providerInput(providerMatch[1], await readJson(request)))
    sendJson(response, 200, { provider })
    return true
  }
  if (providerMatch && method === 'DELETE') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const deleted = await runtime.deleteProvider(providerMatch[1])
    sendJson(response, 200, { ok: deleted })
    return true
  }
  const secretMatch = /^\/api\/providers\/([a-z][a-z0-9-]{0,47})\/secret$/.exec(path)
  if (secretMatch && method === 'GET') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const secret = await runtime.getProviderSecret(secretMatch[1])
    sendJson(response, 200, { apiKey: secret ?? '' })
    return true
  }
  if (secretMatch && method === 'PUT') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const body = record(await readJson(request))
    strictKeys(body, ['apiKey'])
    if (typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey.length > 16_384) {
      throw new ApiError(400, 'invalid_input', 'API key is invalid')
    }
    sendJson(response, 200, await runtime.setProviderSecret(secretMatch[1], body.apiKey))
    return true
  }
  if (secretMatch && method === 'DELETE') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    sendJson(response, 200, await runtime.deleteProviderSecret(secretMatch[1]))
    return true
  }
  const testMatch = /^\/api\/providers\/([a-z][a-z0-9-]{0,47})\/test$/.exec(path)
  if (testMatch && method === 'POST') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    await rejectUnexpectedBody(request)
    sendJson(response, 200, { ok: true, provider: await runtime.testProvider(testMatch[1]) })
    return true
  }
  const syncMatch = /^\/api\/providers\/([a-z][a-z0-9-]{0,47})\/sync$/.exec(path)
  if (syncMatch && method === 'POST') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    await rejectUnexpectedBody(request)
    sendJson(response, 200, { catalog: await runtime.syncProvider(syncMatch[1]) })
    return true
  }

  // Agent Providers REST API
  if (method === 'GET' && path === '/api/agent/providers') {
    const providers = runtime.agentConfig.listPublic()
    sendJson(response, 200, { providers })
    return true
  }

  if (method === 'POST' && path === '/api/agent/providers') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const body = record(await readJson(request))
    const id = typeof body.id === 'string' ? body.id : ''
    const name = typeof body.name === 'string' ? body.name : ''
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : ''
    const model = typeof body.model === 'string' ? body.model : ''
    if (!id || !name || !baseUrl || !model) {
      sendJson(response, 400, { error: { message: '供应商 ID、名称、接口地址与模型名称均为必填项' } })
      return true
    }
    const updated = await runtime.agentConfig.upsert({
      id,
      name,
      baseUrl,
      model,
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : true,
      preferred: Boolean(body.preferred),
      secret: typeof body.secret === 'string' ? body.secret : undefined,
    })
    sendJson(response, 200, { ok: true, provider: updated })
    return true
  }

  const agentProviderPreferredMatch = path.match(/^\/api\/agent\/providers\/([^/]+)\/preferred$/)
  if (method === 'POST' && agentProviderPreferredMatch) {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const targetId = decodeURIComponent(agentProviderPreferredMatch[1]!)
    const updated = await runtime.agentConfig.setPreferred(targetId)
    if (!updated) {
      sendJson(response, 404, { error: { message: '未找到该 Agent 供应商' } })
      return true
    }
    sendJson(response, 200, { ok: true, provider: updated })
    return true
  }

  const agentProviderSecretMatch = path.match(/^\/api\/agent\/providers\/([^/]+)\/secret$/)
  if (method === 'GET' && agentProviderSecretMatch) {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const targetId = decodeURIComponent(agentProviderSecretMatch[1]!)
    const secret = runtime.agentConfig.getSecret(targetId)
    sendJson(response, 200, { secret: secret || '' })
    return true
  }

  if (method === 'POST' && agentProviderSecretMatch) {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const targetId = decodeURIComponent(agentProviderSecretMatch[1]!)
    const body = record(await readJson(request))
    const secret = typeof body.secret === 'string' ? body.secret : ''
    await runtime.agentConfig.setSecret(targetId, secret)
    const updated = runtime.agentConfig.getPublic(targetId)
    sendJson(response, 200, { ok: true, provider: updated })
    return true
  }

  if (method === 'DELETE' && agentProviderSecretMatch) {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const targetId = decodeURIComponent(agentProviderSecretMatch[1]!)
    await runtime.agentConfig.deleteSecret(targetId)
    const updated = runtime.agentConfig.getPublic(targetId)
    sendJson(response, 200, { ok: true, provider: updated })
    return true
  }

  const agentProviderItemMatch = path.match(/^\/api\/agent\/providers\/([^/]+)$/)
  if (method === 'DELETE' && agentProviderItemMatch) {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const targetId = decodeURIComponent(agentProviderItemMatch[1]!)
    const deleted = await runtime.agentConfig.delete(targetId)
    sendJson(response, 200, { ok: deleted })
    return true
  }

  if (method === 'POST' && path === '/api/agent/test') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const body = record(await readJson(request))
    const result = await runtime.agentConfig.testConnection({
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : '',
      model: typeof body.model === 'string' ? body.model : '',
      secret: typeof body.secret === 'string' ? body.secret : undefined,
      id: typeof body.id === 'string' ? body.id : undefined,
    })
    sendJson(response, 200, result)
    return true
  }

  if (method === 'GET' && path === '/api/agent/status') {
    const preferred = runtime.agentConfig.getPreferred()
    if (preferred && preferred.enabled && preferred.secretConfigured) {
      sendJson(response, 200, {
        configured: true,
        providerId: preferred.id,
        providerName: preferred.name,
        baseUrl: preferred.baseUrl,
        model: preferred.model,
      })
      return true
    }

    const list = runtime.agentConfig.listPublic()
    const found = list.find((p) => p.enabled && p.secretConfigured)
    if (found) {
      sendJson(response, 200, {
        configured: true,
        providerId: found.id,
        providerName: found.name,
        baseUrl: found.baseUrl,
        model: found.model,
      })
      return true
    }

    sendJson(response, 200, {
      configured: false,
      message: '尚未接入 Agent 大模型，请在 API 管理中配置 API Key',
    })
    return true
  }

async function resolveMultimodalMessages(
  runtime: GatewayRuntime,
  rawMessages: unknown[],
): Promise<{ messages: unknown[]; hasVision: boolean }> {
  let hasVision = false

  const resolved = await Promise.all(
    rawMessages.map(async (msg) => {
      if (!msg || typeof msg !== 'object') return msg
      const messageObj = { ...(msg as Record<string, unknown>) }
      if (!Array.isArray(messageObj.content)) return messageObj

      const resolvedContent = await Promise.all(
        messageObj.content.map(async (part) => {
          if (!part || typeof part !== 'object') return part
          const partObj = { ...(part as Record<string, unknown>) }

          if (partObj.type === 'image_url') {
            hasVision = true
            let rawUrl: string | undefined
            if (typeof partObj.image_url === 'string') {
              rawUrl = partObj.image_url
            } else if (
              partObj.image_url &&
              typeof partObj.image_url === 'object' &&
              typeof (partObj.image_url as Record<string, unknown>).url === 'string'
            ) {
              rawUrl = (partObj.image_url as Record<string, unknown>).url as string
            }

            if (rawUrl) {
              const assetMatch =
                rawUrl.match(/(?:^|\/)api\/assets\/([^/?#]+)/i) ||
                rawUrl.match(/^assets\/([^/?#]+)/i)
              if (assetMatch) {
                const assetId = decodeURIComponent(assetMatch[1])
                const asset = runtime.assets.get(assetId)
                if (asset && asset.contentType.startsWith('image/')) {
                  try {
                    const bytes = await runtime.assets.readBytes(asset.id)
                    const base64 = Buffer.from(bytes).toString('base64')
                    const dataUrl = `data:${asset.contentType};base64,${base64}`
                    if (typeof partObj.image_url === 'string') {
                      partObj.image_url = dataUrl
                    } else if (partObj.image_url && typeof partObj.image_url === 'object') {
                      partObj.image_url = {
                        ...(partObj.image_url as Record<string, unknown>),
                        url: dataUrl,
                      }
                    }
                  } catch {
                    // Fall back to original url if reading fails
                  }
                }
              }
            }
          }
          return partObj
        }),
      )

      messageObj.content = resolvedContent
      return messageObj
    }),
  )

  return { messages: resolved, hasVision }
}

function stripVisionFromMessages(messages: unknown[]): unknown[] {
  return messages.map((msg) => {
    if (!msg || typeof msg !== 'object') return msg
    const m = { ...(msg as Record<string, unknown>) }
    if (Array.isArray(m.content)) {
      const textParts = m.content
        .filter((p) => p && typeof p === 'object' && (p as Record<string, unknown>).type === 'text')
        .map((p) => (p as Record<string, unknown>).text || '')
        .filter(Boolean)
      m.content = textParts.join('\n')
    }
    return m
  })
}

  if (method === 'POST' && path === '/api/agent/chat') {
    if (request.headers['x-collaboration-room'] !== undefined) {
      authorizeSensitiveRequest(request, runtime, localAdmin, localAdminAllowed, 'editor')
    }
    const body = record(await readJson(request))
    const rawMessages = Array.isArray(body.messages) ? body.messages : []
    const { messages, hasVision } = await resolveMultimodalMessages(runtime, rawMessages)
    const tools = Array.isArray(body.tools) ? body.tools : undefined
    const stream = body.stream === true
    const explicitProviderId = typeof body.providerId === 'string' ? body.providerId : undefined

    let chosen = explicitProviderId ? runtime.agentConfig.getPublic(explicitProviderId) : runtime.agentConfig.getPreferred()
    let secret = chosen ? runtime.agentConfig.getSecret(chosen.id) : undefined

    if (!chosen || !secret || !chosen.enabled) {
      // fallback to any configured and enabled in agentConfig
      const list = runtime.agentConfig.listPublic()
      const found = list.find((p) => p.enabled && p.secretConfigured)
      if (found) {
        chosen = found
        secret = runtime.agentConfig.getSecret(found.id)
      }
    }

    if (!chosen || !secret) {
      sendJson(response, 400, { error: { code: 'not_configured', message: '尚未接入 Agent 大模型，请在「管理 API 接入」中配置大模型的 API Key' } })
      return true
    }

    const chatEndpoint = `${chosen.baseUrl.replace(/\/+$/, '')}/chat/completions`
    let model = chosen.model
    if (typeof body.model === 'string' && body.model.trim()) {
      model = body.model.trim()
    }

    try {
      let outgoing = await fetch(chatEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Authorization': `Bearer ${secret}`,
        },
        body: JSON.stringify({
          model,
          messages,
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
          stream,
        }),
      })

      if (!outgoing.ok && hasVision && outgoing.status === 400) {
        // 尝试降级为纯文本，防止部分不支持视觉输入的大模型报错中断
        const fallbackMessages = stripVisionFromMessages(messages)
        const retry = await fetch(chatEndpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Authorization': `Bearer ${secret}`,
          },
          body: JSON.stringify({
            model,
            messages: fallbackMessages,
            ...(tools ? { tools, tool_choice: 'auto' } : {}),
            stream,
          }),
        }).catch(() => null)
        if (retry && retry.ok) {
          outgoing = retry
        }
      }

      if (!outgoing.ok) {
        const errText = await outgoing.text().catch(() => '')
        sendJson(response, outgoing.status, { error: { message: errText || 'LLM provider request failed' } })
        return true
      }

      if (stream && outgoing.body) {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        })
        const reader = outgoing.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          response.write(value)
        }
        response.end()
        return true
      }

      const data = await outgoing.json()
      sendJson(response, 200, data)
      return true
    } catch (err: unknown) {
      sendJson(response, 502, { error: { message: err instanceof Error ? err.message : 'Failed to reach upstream LLM' } })
      return true
    }
  }

  if (method === 'POST' && path === '/api/director/chat') {
    if (request.headers['x-collaboration-room'] !== undefined) {
      authorizeSensitiveRequest(request, runtime, localAdmin, localAdminAllowed, 'editor')
    }
    const body = record(await readJson(request))
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    const providerId = typeof body.providerId === 'string' && body.providerId ? body.providerId : 'xiaoyunque'
    const threadId = typeof body.threadId === 'string' ? body.threadId : undefined
    const rawReferences = Array.isArray(body.references) ? (body.references as Array<Record<string, unknown>>) : []

    if (!message) {
      throw new ApiError(400, 'invalid_input', 'Message is required')
    }

    // 提取画布挂载的参考素材与图片 URL
    const imageReferences: Array<{ alias?: number; name?: string; url: string }> = []
    const refDescriptions: string[] = []

    for (const ref of rawReferences) {
      if (!ref || typeof ref !== 'object') continue
      const aliasStr = ref.referenceAlias !== undefined ? `@${ref.referenceAlias}` : ''
      const nameStr = typeof ref.name === 'string' ? ref.name : '参考素材'
      const kindStr = ref.kind === 'video' ? '视频素材' : '图片素材'
      refDescriptions.push(`${aliasStr ? `${aliasStr} ` : ''}"${nameStr}" (${kindStr})`)

      let candidateUrl: string | undefined
      if (typeof ref.url === 'string' && ref.url.trim()) {
        candidateUrl = ref.url.trim()
      } else if (typeof ref.poster === 'string' && ref.poster.trim()) {
        candidateUrl = ref.poster.trim()
      }

      if (candidateUrl) {
        imageReferences.push({
          alias: typeof ref.referenceAlias === 'number' ? ref.referenceAlias : undefined,
          name: nameStr,
          url: candidateUrl,
        })
      }
    }

    const preferenceMode =
      typeof body.preferenceMode === 'string' && (body.preferenceMode === 'image' || body.preferenceMode === 'video')
        ? (body.preferenceMode as 'image' | 'video')
        : undefined
    const model = typeof body.model === 'string' ? body.model : undefined
    const imageModel = typeof body.imageModel === 'string' ? body.imageModel : undefined
    const aspectRatio = typeof body.aspectRatio === 'string' ? body.aspectRatio : undefined
    const duration = typeof body.duration === 'number' ? body.duration : undefined
    const resolution = typeof body.resolution === 'string' ? body.resolution : undefined

    let adapter: unknown
    try {
      adapter = runtime.adapterFor(providerId)
    } catch {
      adapter = undefined
    }

    if (!adapter) {
      throw new ApiError(404, 'provider_not_found', `导演智能体平台未就绪或未配置: ${providerId}`)
    }

    if (adapter instanceof XiaoYunqueAdapter && typeof adapter.chat === 'function') {
      try {
        // 若有本地素材，预上传至小云雀并建立索引映射
        const assetIds: string[] = []
        const aliasMappingLines: string[] = []

        for (let i = 0; i < imageReferences.length; i++) {
          const ref = imageReferences[i]
          let uploadedId: string | undefined

          const match = ref.url.match(/(?:^|\/)api\/assets\/([^/?#]+)/i) || ref.url.match(/^assets\/([^/?#]+)/i)
          if (match) {
            const assetId = decodeURIComponent(match[1])
            const asset = runtime.assets.get(assetId)
            if (asset) {
              try {
                const bytes = await runtime.assets.readBytes(asset.id)
                uploadedId = await adapter.uploadAsset(bytes, asset.filename, asset.contentType, signal)
              } catch (uploadErr) {
                console.warn(`[XiaoYunque] 上传素材 ${asset.filename} 到小云雀失败:`, uploadErr)
              }
            }
          } else if (ref.url.startsWith('data:image/')) {
            const commaIdx = ref.url.indexOf(',')
            if (commaIdx !== -1) {
              try {
                const header = ref.url.slice(0, commaIdx)
                const base64Data = ref.url.slice(commaIdx + 1)
                const mimeMatch = header.match(/data:([^;]+)/)
                const mime = mimeMatch ? mimeMatch[1] : 'image/png'
                const bytes = Buffer.from(base64Data, 'base64')
                uploadedId = await adapter.uploadAsset(bytes, `${ref.name || 'image'}.png`, mime, signal)
              } catch (uploadErr) {
                console.warn(`[XiaoYunque] 上传 Base64 素材到小云雀失败:`, uploadErr)
              }
            }
          }

          if (uploadedId) {
            assetIds.push(uploadedId)
            const aliasTag = ref.alias !== undefined ? `@${ref.alias}` : `@${assetIds.length}`
            aliasMappingLines.push(`- ${aliasTag}: 图片素材《${ref.name || '参考素材'}》（对应已挂载上传素材 ${assetIds.length}）`)
          }
        }

        let messageToSend = message
        if (aliasMappingLines.length > 0) {
          const mappingHeader = `【画布挂载参考素材与索引对照】:\n${aliasMappingLines.join('\n')}\n\n用户指令:\n`
          if (!messageToSend.includes('【画布挂载参考素材与索引对照】')) {
            messageToSend = `${mappingHeader}${messageToSend}`
          }
        }

        const res = await adapter.chat(
          messageToSend,
          threadId,
          signal,
          assetIds.length > 0 ? assetIds : undefined,
          {
            preferenceMode,
            model,
            imageModel,
            aspectRatio,
            duration,
            resolution,
          },
        )
        const localized = await localizeDirectorVideoOutputs(runtime, res, signal)
        sendJson(response, 200, localized)
        return true
      } catch (err: unknown) {
        if (err instanceof ProviderRequestRejectedError) {
          throw new ApiError(400, err.code, err.message)
        }
        throw new ApiError(500, 'director_chat_failed', err instanceof Error ? err.message : '小云雀视频智能体响应失败')
      }
    }

    sendJson(response, 200, {
      reply: '导演智能体已就绪，请输入具体成片需求。',
      threadId: threadId || `th-${Date.now().toString(36)}`,
    })
    return true
  }

  if (method === 'GET' && path === '/api/director/poll') {
    if (request.headers['x-collaboration-room'] !== undefined) {
      authorizeSensitiveRequest(request, runtime, localAdmin, localAdminAllowed, 'editor')
    }
    const threadId = url.searchParams.get('threadId')
    const runId = url.searchParams.get('runId')
    const providerId = url.searchParams.get('providerId') || 'xiaoyunque'
    const preferenceMode = url.searchParams.get('preferenceMode') === 'image' ? 'image' : 'video'

    if (!threadId || !runId) {
      throw new ApiError(400, 'invalid_input', 'threadId and runId are required')
    }

    let adapter: unknown
    try {
      adapter = runtime.adapterFor(providerId)
    } catch {
      adapter = undefined
    }

    if (!adapter) {
      throw new ApiError(404, 'provider_not_found', `导演智能体平台未就绪或未配置: ${providerId}`)
    }

    if (adapter instanceof XiaoYunqueAdapter && typeof adapter.checkRunStatus === 'function') {
      try {
        const res = await adapter.checkRunStatus(threadId, runId, preferenceMode)
        const localized = await localizeDirectorVideoOutputs(runtime, res, signal)
        sendJson(response, 200, localized)
        return true
      } catch (err: unknown) {
        if (err instanceof ProviderRequestRejectedError) {
          throw new ApiError(400, err.code, err.message)
        }
        throw new ApiError(500, 'director_poll_failed', err instanceof Error ? err.message : '小云雀任务轮询失败')
      }
    }

    sendJson(response, 200, {
      reply: '任务处理中...',
      threadId,
      runId,
      pending: false,
    })
    return true
  }

  if (method === 'GET' && path === '/api/catalog') {
    const providerId = url.searchParams.get('providerId')
    if (!providerId) throw new ApiError(400, 'invalid_input', 'providerId is required')
    const catalog = runtime.catalogs.get(providerId)
    if (!catalog) throw new RuntimeNotFoundError('Catalog not found')
    sendJson(response, 200, { catalog })
    return true
  }
  if (method === 'GET' && path === '/api/generation-history') {
    const projectId = url.searchParams.get('projectId')
    if (!projectId || projectId.length > 256) throw new ApiError(400, 'invalid_input', 'projectId is invalid')
    const limitInput = url.searchParams.get('limit')
    const limit = limitInput === null ? 50 : Number(limitInput)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ApiError(400, 'invalid_input', 'limit must be an integer between 1 and 200')
    }
    const mediaType = url.searchParams.get('mediaType')
    if (mediaType !== null && mediaType !== 'image' && mediaType !== 'video' && mediaType !== 'audio') {
      throw new ApiError(400, 'invalid_input', 'mediaType is invalid')
    }
    sendJson(response, 200, runtime.history.list({
      projectId,
      limit,
      ...(mediaType ? { mediaType } : {}),
      ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') as string } : {}),
    }))
    return true
  }
  if (method === 'POST' && path === '/api/generation-history/reassign-canvas') {
    const input = historyReassignmentInput(await readJson(request))
    if (runtime.jobs.activityForCanvas({
      projectId: input.fromProjectId,
      canvasId: input.canvasId,
    }).active) {
      throw new ApiError(409, 'canvas_busy', 'Canvas has active generation jobs')
    }
    sendJson(
      response,
      200,
      await runtime.trackOperation(() => runtime.history.reassignCanvas(input)),
    )
    return true
  }
  if (method === 'POST' && path === '/api/generation-history/backfill') {
    const body = historyBackfillInput(await readJson(request))
    const validated = body.entries.map((entry) => {
      const job = runtime.jobs.get(entry.jobId)
      if (!job) throw new RuntimeNotFoundError('Generation job not found')
      if (job.status !== 'complete') {
        throw new ApiError(400, 'invalid_input', 'Only completed generation outputs can be backfilled')
      }
      if ('projectId' in job.request && job.request.projectId !== body.projectId) {
        throw new ApiError(409, 'history_project_conflict', 'Generation job belongs to another project')
      }
      const asset = runtime.assets.get(entry.assetId)
      if (!asset) throw new RuntimeNotFoundError('Asset not found')
      const output = job.outputs[entry.outputIndex]
      if (!output || output.assetId !== asset.id || output.url !== asset.url ||
        output.contentType !== asset.contentType || output.size !== asset.size) {
        throw new ApiError(400, 'invalid_input', 'History asset does not match the completed output')
      }
      return { job, outputIndex: entry.outputIndex, asset }
    })
    const entries = await runtime.trackOperation(() => runtime.history.recordOutputs(
      validated.map((item) => ({ ...item, projectId: body.projectId })),
    ))
    if (entries.some((entry) => !entry)) {
      throw new ApiError(500, 'internal_error', 'Generation history could not be registered')
    }
    sendJson(response, 200, { entries })
    return true
  }
  const historyEntryMatch = /^\/api\/generation-history\/([a-f0-9]{64})$/i.exec(path)
  if (historyEntryMatch && method === 'DELETE') {
    const projectId = url.searchParams.get('projectId')
    if (!projectId || projectId.length > 256) throw new ApiError(400, 'invalid_input', 'projectId is invalid')
    if (!await runtime.trackOperation(() => runtime.history.remove(projectId, historyEntryMatch[1]))) {
      throw new RuntimeNotFoundError('Generation history entry not found')
    }
    sendJson(response, 200, { deleted: true })
    return true
  }
  if (method === 'GET' && path === '/api/canvas-activity') {
    const scope = canvasScopeQuery(url)
    sendJson(response, 200, runtime.jobs.activityForCanvas(scope))
    return true
  }
  const canvasReferenceId = canvasAssetReferenceCanvasId(path)
  if (canvasReferenceId && method === 'PUT') {
    const input = canvasAssetReferenceInput(await readJson(request))
    for (const assetId of input.assetIds) {
      if (!runtime.assets.get(assetId)) throw new RuntimeNotFoundError('Asset not found')
    }
    sendJson(response, 200, await runtime.trackOperation(() => runtime.canvasAssetReferences.set({
      canvasId: canvasReferenceId,
      projectId: input.projectId,
      assetIds: input.assetIds,
    })))
    return true
  }
  if (canvasReferenceId && method === 'DELETE') {
    const projectId = url.searchParams.get('projectId')
    if (!projectId || projectId.length > 256) {
      throw new ApiError(400, 'invalid_input', 'projectId is invalid')
    }
    const canvasId = canvasReferenceId
    if (runtime.jobs.activityForCanvas({ projectId, canvasId }).active) {
      throw new ApiError(409, 'canvas_busy', 'Canvas has active generation jobs')
    }
    const deletedAssetIds = await runtime.trackOperation(async () => {
      const candidates = await runtime.canvasAssetReferences.release({ projectId, canvasId })
      const protectedIds = runtime.canvasAssetReferences.referencedAssetIds()
      for (const id of runtime.history.referencedAssetIds()) protectedIds.add(id)
      for (const id of runtime.jobs.referencedAssetIds()) protectedIds.add(id)
      return runtime.assets.deleteUnreferenced(candidates, protectedIds)
    })
    sendJson(response, 200, { canvasId, deletedAssetIds })
    return true
  }
  if (method === 'GET' && path === '/api/workspace/manifest') {
    const manifest = await runtime.workspace.getManifest()
    sendJson(response, 200, { manifest })
    return true
  }
  if (method === 'POST' && path === '/api/workspace/commit') {
    const body = await readJson(request) as {
      manifest?: unknown
      putDocuments?: Array<{ canvasId: string; serialized: string }>
      deleteCanvasIds?: string[]
    }
    if (!body || typeof body !== 'object') {
      throw new ApiError(400, 'invalid_input', 'Invalid workspace commit payload')
    }
    const manifest = await runtime.workspace.commit(body as import('../src/workspace/model.ts').WorkspaceCommit)
    if (Array.isArray(body.putDocuments)) {
      for (const doc of body.putDocuments) {
        if (doc && typeof doc.serialized === 'string') {
          const snapshot = parseCanvasSnapshot(doc.serialized)
          const baseRevision = typeof (doc as unknown as { baseRevision?: unknown }).baseRevision === 'number'
            ? (doc as unknown as { baseRevision: number }).baseRevision
            : undefined
          await runtime.canvasDocuments.importSnapshot(snapshot, baseRevision, 'browser')
        }
      }
    }
    if (Array.isArray(body.deleteCanvasIds)) {
      for (const canvasId of body.deleteCanvasIds) {
        if (typeof canvasId === 'string') {
          await runtime.canvases.deleteCanvas(canvasId)
        }
      }
    }
    sendJson(response, 200, { manifest })
    return true
  }
  const canvasPathMatch = /^\/api\/canvases\/([A-Za-z0-9._:-]+)$/.exec(path)
  if (canvasPathMatch && method === 'GET') {
    const canvasId = canvasPathMatch[1]
    const liveDocument = await runtime.canvasDocuments.get(canvasId)
    let canvas = liveDocument?.snapshot
    if (!canvas) {
      const doc = await runtime.workspace.getCanvasDocument(canvasId)
      if (doc) {
        try {
          canvas = parseCanvasSnapshot(doc)
        } catch {
          // ignore
        }
      }
    }
    if (!canvas) {
      throw new ApiError(404, 'canvas_not_found', `Canvas ${canvasId} not found`)
    }
    sendJson(response, 200, { canvas, revision: liveDocument?.revision ?? 0 })
    return true
  }
  if (canvasPathMatch && method === 'PUT') {
    const canvasId = canvasPathMatch[1]
    const body = await readJson(request) as { canvas?: unknown } | Record<string, unknown>
    const serialized = JSON.stringify(body && typeof body === 'object' && 'canvas' in body ? (body as { canvas: unknown }).canvas : body)
    const snapshot = parseCanvasSnapshot(serialized)
    if (snapshot.canvasId !== canvasId) {
      throw new ApiError(400, 'invalid_input', 'Canvas ID mismatch')
    }
    const revisionHeader = request.headers['if-match']
    const baseRevision = typeof revisionHeader === 'string' && /^\d+$/.test(revisionHeader)
      ? Number(revisionHeader)
      : undefined
    const revision = await runtime.canvasDocuments.importSnapshot(snapshot, baseRevision, 'browser')
    sendJson(response, 200, { canvas: snapshot, revision })
    return true
  }
  const canvasAgentChatMatch = /^\/api\/canvases\/([A-Za-z0-9._:-]+)\/agent-chat$/.exec(path)
  if (canvasAgentChatMatch && method === 'GET') {
    const canvasId = canvasAgentChatMatch[1]
    const messages = await runtime.canvases.getAgentChat(canvasId)
    sendJson(response, 200, { messages })
    return true
  }
  if (canvasAgentChatMatch && method === 'PUT') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const canvasId = canvasAgentChatMatch[1]
    const body = await readJson(request) as { messages?: unknown[] }
    const messages = Array.isArray(body?.messages) ? body.messages : []
    await runtime.canvases.saveAgentChat(canvasId, messages)
    sendJson(response, 200, { ok: true })
    return true
  }
  if (canvasAgentChatMatch && method === 'DELETE') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const canvasId = canvasAgentChatMatch[1]
    await runtime.canvases.clearAgentChat(canvasId)
    sendJson(response, 200, { ok: true })
    return true
  }
  if (method === 'POST' && path === '/api/assets') {
    const filenameHeader = request.headers['x-filename']
    let filename = Array.isArray(filenameHeader) ? undefined : filenameHeader
    if (filename) {
      try {
        filename = decodeURIComponent(filename)
      } catch {}
    }
    const contentType = request.headers['content-type']
    if (!filename || filename.length > 255 || basename(filename) !== filename || !contentType) {
      throw new ApiError(400, 'invalid_input', 'Asset filename or Content-Type is invalid')
    }
    const declaredHeader = request.headers['content-length']
    if (Array.isArray(declaredHeader) || (declaredHeader !== undefined && !/^\d+$/.test(declaredHeader))) {
      throw new ApiError(400, 'invalid_input', 'Content-Length is invalid')
    }
    const expectedSize = declaredHeader === undefined ? undefined : Number(declaredHeader)
    if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize > rawBodyLimit)) {
      throw new BodyLimitError()
    }
    const asset = await runtime.trackOperation(() => runtime.assets.saveStream({
      filename,
      contentType,
      stream: request,
      maxSize: rawBodyLimit,
      signal,
      ...(expectedSize !== undefined ? { expectedSize } : {}),
    }))
    sendJson(response, 201, { asset })
    return true
  }
  if (method === 'POST' && path === '/api/assets/import') {
    const body = record(await readJson(request))
    strictKeys(body, ['url', 'filename'])
    if (typeof body.url !== 'string' || (body.filename !== undefined && typeof body.filename !== 'string')) {
      throw new ApiError(400, 'invalid_input', 'Remote asset input is invalid')
    }
    const sourceUrl = body.url
    const filename = body.filename
    const asset = await runtime.trackOperation(() => runtime.assets.importRemote(sourceUrl, filename, signal))
    sendJson(response, 201, { asset })
    return true
  }
  if (method === 'GET' && path === '/api/assets') {
    const assets = runtime.assets.list()
    sendJson(response, 200, { assets })
    return true
  }
  if (method === 'POST' && path === '/api/assets/clean-unreferenced') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const refMap = await runtime.workspace.getReferencedAssetMap()
    const referencedIds = new Set(refMap.keys())
    const candidateIds = runtime.assets.list().map((a) => a.id)
    const deletedIds = await runtime.trackOperation(() =>
      runtime.assets.deleteUnreferenced(candidateIds, referencedIds),
    )
    sendJson(response, 200, { ok: true, deletedIds, count: deletedIds.length })
    return true
  }
  const assetMatch = /^\/api\/assets\/([0-9a-f-]{36})$/i.exec(path)
  if (assetMatch && (method === 'GET' || method === 'HEAD')) {
    await serveAsset(runtime, request, response, assetMatch[1])
    return true
  }
  if (assetMatch && method === 'DELETE') {
    authorizeProviderWrite(request, runtime, localAdmin, localAdminAllowed)
    const assetId = assetMatch[1].toLowerCase()
    const asset = runtime.assets.get(assetId)
    if (!asset) throw new RuntimeNotFoundError('Asset not found')
    const refMap = await runtime.workspace.getReferencedAssetMap()
    const refs = refMap.get(assetId)
    if (refs && refs.length > 0) {
      throw new ApiError(
        409,
        'asset_in_use',
        `资产正在被画布“${refs[0].canvasName}”的节点“${refs[0].nodeName}”引用，无法删除`,
      )
    }
    await runtime.trackOperation(() =>
      runtime.assets.deleteUnreferenced([assetId], new Set()),
    )
    sendJson(response, 200, { ok: true, deletedId: assetId })
    return true
  }
  if (method === 'POST' && path === '/api/generation-jobs') {
    const input = record(await readJson(request))
    const authorization = authorizeSensitiveRequest(request, runtime, localAdmin, localAdminAllowed, 'editor')
    let job
    if (authorization.kind === 'collaboration') {
      if (
        typeof input.canvasId !== 'string' || typeof input.projectId !== 'string' ||
        typeof input.targetNodeId !== 'string' || !input.targetNodeId.trim()
      ) throw new ApiError(400, 'invalid_input', 'Collaborative generation requires a target node and canvas scope')
      const session = authorizeCollaborationGeneration(runtime.collaboration, {
        roomId: authorization.roomId,
        canvasId: input.canvasId,
        sessionToken: collaborationSessionToken(request, authorization.roomId),
      })
      if (session.projectId !== input.projectId) {
        throw new CollaborationAuthorizationError('Generation scope does not match the collaboration room')
      }
      job = await submitCollaborativeGeneration(runtime, authorization.roomId, input as never)
    } else {
      job = await runtime.submit(input as never)
    }
    sendJson(response, 202, { job })
    return true
  }
  const jobMatch = /^\/api\/generation-jobs\/([0-9a-f-]{36})$/i.exec(path)
  if (jobMatch && method === 'GET') {
    const job = runtime.jobs.get(jobMatch[1])
    if (!job) throw new RuntimeNotFoundError('Generation job not found')
    sendJson(response, 200, { job })
    return true
  }
  throw new ApiError(404, 'not_found', 'API route not found')
}

export interface GatewayHandle {
  readonly origin: string
  readonly dataDir: string
  readonly runtime: GatewayRuntime
  close(): Promise<void>
}

export async function startGateway(options: {
  rootDir?: string
  dataDir?: string
  envFile?: string
  processEnv?: GatewayEnvironment
  env?: GatewayEnvironment
  assetImportTimeoutMs?: number
  generationMaxRunTimeMs?: number
  adapterFactory?: AdapterFactory
  pinnedFetcher?: PinnedRemoteFetcher
  lookup?: AddressLookup
  log?: (entry: { event: string; message: string }) => void
  host?: string
  port?: number
  distDir?: string
  rawBodyLimit?: number
  localHostOnly?: boolean
  publicOrigin?: string
  allowedOrigins?: string[]
  allowInsecureLan?: boolean
  collaborationMaxMessageBytes?: number
  collaborationHeartbeatMs?: number
  collaborationOptions?: Omit<CollaborationServiceOptions, 'dataDir'>
} = {}): Promise<GatewayHandle> {
  const host = options.host ?? '127.0.0.1'
  const network = resolveCollaborationNetworkConfig(host, {
    ...(options.publicOrigin ? { CANVAS_PUBLIC_ORIGIN: options.publicOrigin } : {}),
    ...(options.allowedOrigins ? { CANVAS_ALLOWED_ORIGINS: options.allowedOrigins.join(',') } : {}),
    ...(options.allowInsecureLan ? { CANVAS_ALLOW_INSECURE_LAN: 'true' } : {}),
  })
  const publicOrigin = network.publicOrigin
  const allowedOrigins = network.allowedOrigins
  const dynamicAllowedOrigins = [...allowedOrigins]
  let dynamicPublicOrigin = publicOrigin
  const localHostOnly = options.localHostOnly ?? isLoopbackHost(host)
  let runtime: GatewayRuntime
  let localAdmin: LocalAdminService
  try {
    runtime = await createGatewayRuntime(options)
    runtime.tunnel.onOriginChange((dynamicOrigin) => {
      if (dynamicOrigin) {
        if (!dynamicAllowedOrigins.includes(dynamicOrigin)) {
          dynamicAllowedOrigins.push(dynamicOrigin)
        }
        dynamicPublicOrigin = dynamicOrigin
      }
    })
    try {
      localAdmin = await LocalAdminService.open({ dataDir: runtime.dataDir })
    } catch (error) {
      await runtime.close().catch(() => {})
      throw error
    }
  } catch (error) {
    const mapped = publicError(error)
    if (mapped.status === 409) throw mapped
    throw error
  }
  const server = createServer(async (request, response) => {
    const clientAbort = new AbortController()
    const abortClient = () => {
      if (!clientAbort.signal.aborted) {
        clientAbort.abort(new DOMException('HTTP client disconnected', 'AbortError'))
      }
    }
    const abortIncompleteResponse = () => {
      if (!response.writableFinished) abortClient()
    }
    request.once('aborted', abortClient)
    response.once('close', abortIncompleteResponse)
    const signal = AbortSignal.any([runtime.signal, clientAbort.signal])
    try {
      if (localHostOnly && !isAllowedRemoteAddress(request.socket.remoteAddress, Boolean(dynamicPublicOrigin), localHostOnly)) {
        throw new ApiError(403, 'remote_not_allowed', 'Remote address is not allowed')
      }
      if (localHostOnly && !isAllowedHost(request, dynamicAllowedOrigins, dynamicPublicOrigin)) {
        throw new ApiError(400, 'invalid_host', 'Request Host is not allowed')
      }
      const rawPath = (request.url ?? '/').split('?', 1)[0]
      const rawApiPath = classifyApiPath(rawPath)
      if (rawApiPath.encoded) {
        throw new ApiError(400, 'invalid_api_path', 'Encoded API paths are not allowed')
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      const apiPath = classifyApiPath(url.pathname)
      if (apiPath.encoded) throw new ApiError(400, 'invalid_api_path', 'Encoded API paths are not allowed')
      if (apiPath.reserved) {
        if (
          request.method === 'POST' || request.method === 'PUT' ||
          request.method === 'PATCH' || request.method === 'DELETE'
        ) {
          assertAllowedOrigin(request, dynamicAllowedOrigins, localHostOnly, dynamicPublicOrigin)
        }
        const loopbackBrowserOrigin = hasLoopbackBrowserOrigin(request)
        const frontendPort = options.distDir
          ? (options.port ?? 4173)
          : (Number(process.env.CANVAS_VITE_PORT) || 4173)
        await routeApi(
          runtime,
          localAdmin,
          request,
          response,
          url,
          options.rawBodyLimit ?? RAW_LIMIT,
          signal,
          (dynamicPublicOrigin ?? publicOrigin)?.toLowerCase().startsWith('https://') ?? false,
          (localHostOnly && isLoopbackHost(host)) || loopbackBrowserOrigin,
          loopbackBrowserOrigin,
          frontendPort,
          async () => {
            await runtime.workspace.reset()
            runtime.jobs.clear?.()
            runtime.canvases.clear?.()
            await (runtime.assets as { clear?: () => Promise<void> }).clear?.()
            const { rm } = await import('node:fs/promises')
            await rm(join(runtime.dataDir, 'canvases'), { recursive: true, force: true }).catch(() => {})
            await rm(join(runtime.dataDir, 'jobs.json'), { force: true }).catch(() => {})
            await runtime.collaboration.reset?.()
            // The product now has an intentionally empty cold start. The legacy
            // browser smoke suite still exercises the rich reference canvas, so
            // restore that fixture only inside the isolated E2E runtime.
            if (options.processEnv?.CONTINUUM_E2E === '1') {
              const [{ referenceProjectSnapshot }, { upgradeProjectSnapshot }] = await Promise.all([
                import('../src/fixtures/reference.ts'),
                import('../src/model/project.ts'),
              ])
              const now = new Date().toISOString()
              const canvasId = 'reference'
              const document = upgradeProjectSnapshot(referenceProjectSnapshot, canvasId)
              await runtime.workspace.commit({
                manifest: JSON.stringify({
                  version: 1,
                  viewport: { x: 0, y: 0, zoom: 1 },
                  projects: [{
                    projectId: referenceProjectSnapshot.projectId,
                    name: referenceProjectSnapshot.name,
                    position: { x: 0, y: 0 },
                    size: { width: 620, height: 380 },
                    favorite: false,
                    createdAt: now,
                    updatedAt: now,
                  }],
                  canvases: [{
                    canvasId,
                    projectId: referenceProjectSnapshot.projectId,
                    name: '画布 1',
                    position: { x: 32, y: 80 },
                    nodeCount: document.nodes.length,
                    favorite: false,
                    createdAt: now,
                    updatedAt: now,
                  }],
                  pendingOperations: [],
                }),
                putDocuments: [{ canvasId, serialized: JSON.stringify(document) }],
              })
            }
          },
          options.processEnv?.CONTINUUM_E2E === '1',
        )
        return
      }
      if (await serveStatic(options.distDir, request, response, url.pathname)) return
      sendJson(response, 404, { error: { code: 'not_found', message: 'Resource not found' } })
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy()
        return
      }
      const mapped = publicError(error)
      if (error instanceof BodyLimitError) response.once('finish', () => request.destroy())
      sendJson(response, mapped.status, {
        error: { code: mapped.code, message: mapped.message, ...mapped.details },
      })
    } finally {
      request.removeListener('aborted', abortClient)
      response.removeListener('close', abortIncompleteResponse)
    }
  })
  const collaborationWebSocket = attachCollaborationWebSocket({
    server,
    service: runtime.collaboration,
    allowedOrigins: dynamicAllowedOrigins,
    maxMessageBytes: options.collaborationMaxMessageBytes,
    heartbeatMs: options.collaborationHeartbeatMs,
    validateRequest: (request) => {
      if (!localHostOnly) return true
      const remoteAllowed = isAllowedRemoteAddress(request.socket.remoteAddress, Boolean(dynamicPublicOrigin), localHostOnly)
      return remoteAllowed && isAllowedHost(request, dynamicAllowedOrigins, dynamicPublicOrigin)
    },
    allowRequestHostOrigin: localHostOnly,
  })
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })

  server.keepAliveTimeout = 65_000
  server.headersTimeout = 66_000

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 4174, host, () => {
        server.off('error', reject)
        resolveListen()
      })
    })
  } catch (error) {
    await collaborationWebSocket.close().catch(() => {})
    await runtime.close().catch(() => {})
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    await runtime.close()
    throw new Error('Gateway did not acquire a TCP port')
  }
  let closing: Promise<void> | undefined
  return {
    origin: formatGatewayOrigin(host, address.port),
    dataDir: runtime.dataDir,
    get runtime() { return runtime },
    close() {
      closing ??= (async () => {
        const serverClosed = new Promise<void>((resolveClose, reject) => {
          server.close((error) => error ? reject(error) : resolveClose())
        })
        const results = await Promise.allSettled([
          collaborationWebSocket.close(),
          runtime.close(),
        ])
        server.closeIdleConnections()
        server.closeAllConnections()
        const serverResult = await Promise.allSettled([serverClosed])
        const failure = [...results, ...serverResult].find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      })()
      return closing
    },
  }
}
