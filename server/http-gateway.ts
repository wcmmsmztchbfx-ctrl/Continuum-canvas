import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { BlockList, isIP } from 'node:net'
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

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host)
  return normalized === 'localhost' || isLoopbackRemoteAddress(normalized)
}

function isLocalHost(request: IncomingMessage): boolean {
  const host = request.headers.host
  if (!host || host.includes('@')) return false
  try {
    return isLoopbackHost(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

function hasLoopbackBrowserOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (typeof origin !== 'string') return false
  try {
    const parsed = new URL(origin)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username && !parsed.password &&
      isLoopbackHost(parsed.hostname)
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

function assertAllowedOrigin(
  request: IncomingMessage,
  configured: readonly string[] = [],
  allowRequestHost = false,
): void {
  const origin = request.headers.origin
  if (origin === undefined) return
  if (Array.isArray(origin)) throw new ApiError(403, 'origin_not_allowed', 'Request Origin is not allowed')
  const host = request.headers.host
  const values = configured.map((value) => value.toLowerCase())
  if (allowRequestHost) {
    values.push(
      host ? `http://${host.toLowerCase()}` : '',
      'http://127.0.0.1:4173',
      'http://localhost:4173',
    )
  }
  const allowed = new Set(values)
  if (!allowed.has(origin.toLowerCase())) throw new ApiError(403, 'origin_not_allowed', 'Request Origin is not allowed')
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
): Promise<boolean> {
  const method = request.method ?? 'GET'
  const path = url.pathname
  if (path !== '/api' && !path.startsWith('/api/')) return false
  if (method === 'GET' && path === '/api/health') {
    sendJson(response, 200, { ok: true, version: 1 })
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
  const secretMatch = /^\/api\/providers\/([a-z][a-z0-9-]{0,47})\/secret$/.exec(path)
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
  if (method === 'POST' && path === '/api/assets') {
    const filenameHeader = request.headers['x-filename']
    const filename = Array.isArray(filenameHeader) ? undefined : filenameHeader
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
  const assetMatch = /^\/api\/assets\/([0-9a-f-]{36})$/i.exec(path)
  if (assetMatch && (method === 'GET' || method === 'HEAD')) {
    await serveAsset(runtime, request, response, assetMatch[1])
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
  const localHostOnly = options.localHostOnly ?? isLoopbackHost(host)
  let runtime: GatewayRuntime
  let localAdmin: LocalAdminService
  try {
    runtime = await createGatewayRuntime(options)
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
      if (localHostOnly && !isLoopbackRemoteAddress(request.socket.remoteAddress)) {
        throw new ApiError(403, 'remote_not_allowed', 'Remote address is not allowed')
      }
      if (localHostOnly && !isLocalHost(request)) {
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
          assertAllowedOrigin(request, allowedOrigins, localHostOnly)
        }
        const loopbackBrowserOrigin = hasLoopbackBrowserOrigin(request)
        await routeApi(
          runtime,
          localAdmin,
          request,
          response,
          url,
          options.rawBodyLimit ?? RAW_LIMIT,
          signal,
          publicOrigin?.toLowerCase().startsWith('https://') ?? false,
          (localHostOnly && isLoopbackHost(host)) || loopbackBrowserOrigin,
          loopbackBrowserOrigin,
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
    allowedOrigins,
    maxMessageBytes: options.collaborationMaxMessageBytes,
    heartbeatMs: options.collaborationHeartbeatMs,
    validateRequest: (request) => {
      if (!localHostOnly) return true
      return isLoopbackRemoteAddress(request.socket.remoteAddress) && isLocalHost(request)
    },
    allowRequestHostOrigin: localHostOnly,
  })
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })

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
    runtime,
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
