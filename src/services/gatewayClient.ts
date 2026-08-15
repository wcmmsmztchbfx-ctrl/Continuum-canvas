import type {
  GenerationHistoryEntry,
  GenerationHistoryMediaType,
  GenerationHistoryPage,
  GenerationJob,
  PersistedGenerationRequest,
  GenerationRequest,
  ProviderCatalog,
  ProviderMetadata,
} from '../contracts/generation'
import { isProviderCatalog, type ImageRequestMode } from '../contracts/catalog'

export interface AssetRecord {
  id: string
  filename: string
  contentType: string
  size: number
  url: string
  createdAt: string
}

export interface ProviderUpdate {
  name: string
  adapterType: string
  baseUrl: string
  enabled: boolean
  preferred: boolean
  imageRequestMode?: ImageRequestMode
}

export interface GatewayRequestOptions {
  signal?: AbortSignal
}

export interface GatewayClientOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class GatewayClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'GatewayClientError'
    this.status = status
    this.code = code
  }
}

export function isMissingCatalogError(
  error: unknown,
): error is GatewayClientError {
  return error instanceof GatewayClientError && error.status === 404
}

export class CatalogChangedGatewayError extends GatewayClientError {
  constructor(message: string) {
    super(409, 'catalog_changed', message)
    this.name = 'CatalogChangedGatewayError'
  }
}

export class IdempotencyConflictGatewayError extends GatewayClientError {
  constructor(message: string) {
    super(409, 'idempotency_conflict', message)
    this.name = 'IdempotencyConflictGatewayError'
  }
}

interface GatewayErrorEnvelope {
  error?: { code?: unknown; message?: unknown }
}

type UnknownRecord = Record<string, unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const JOB_STATUSES = new Set([
  'queued',
  'uploading',
  'submitted',
  'running',
  'downloading',
  'complete',
  'failed',
])
const HISTORY_ID = /^[0-9a-f]{64}$/i

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isHistoryMediaType(value: unknown): value is GenerationHistoryMediaType {
  return value === 'image' || value === 'video' || value === 'audio'
}

function optionalString(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string'
}

function invalidResponse(message = 'Gateway returned an invalid response'): never {
  throw new GatewayClientError(200, 'invalid_response', message)
}

function isProviderMetadata(value: unknown): value is ProviderMetadata {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.adapterType === 'string' &&
    typeof value.baseUrl === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.preferred === 'boolean' &&
    typeof value.secretEnvName === 'string' &&
    typeof value.secretConfigured === 'boolean' &&
    typeof value.available === 'boolean' &&
    optionalString(value, 'maskedSecret') &&
    optionalString(value, 'lastSyncedAt') &&
    optionalString(value, 'imageRequestMode')
  )
}

function isLocalAssetIdentity(id: unknown, url: unknown): id is string {
  return (
    typeof id === 'string' &&
    UUID.test(id) &&
    url === `/api/assets/${id}`
  )
}

function isAssetRecord(value: unknown): value is AssetRecord {
  return (
    isRecord(value) &&
    isLocalAssetIdentity(value.id, value.url) &&
    typeof value.filename === 'string' &&
    typeof value.contentType === 'string' &&
    isFiniteNumber(value.size) &&
    value.size >= 0 &&
    typeof value.createdAt === 'string'
  )
}

function isGenerationHistoryEntry(value: unknown): value is GenerationHistoryEntry {
  if (!isRecord(value) || !isRecord(value.asset) || !isRecord(value.settings)) {
    return false
  }
  const settings = value.settings
  return (
    typeof value.id === 'string' &&
    HISTORY_ID.test(value.id) &&
    typeof value.projectId === 'string' &&
    value.projectId.length > 0 &&
    value.projectId.length <= 256 &&
    (value.canvasId === undefined ||
      (typeof value.canvasId === 'string' && value.canvasId.length > 0 && value.canvasId.length <= 256)) &&
    typeof value.jobId === 'string' &&
    UUID.test(value.jobId) &&
    Number.isInteger(value.outputIndex) &&
    Number(value.outputIndex) >= 0 &&
    isHistoryMediaType(value.mediaType) &&
    isLocalAssetIdentity(value.asset.id, value.asset.url) &&
    typeof value.asset.filename === 'string' &&
    typeof value.asset.contentType === 'string' &&
    isFiniteNumber(value.asset.size) &&
    value.asset.size >= 0 &&
    isIsoDate(value.asset.createdAt) &&
    typeof value.prompt === 'string' &&
    typeof value.providerId === 'string' &&
    (typeof value.channel === 'string' || isFiniteNumber(value.channel)) &&
    typeof value.model === 'string' &&
    optionalString(settings, 'quality') &&
    optionalString(settings, 'aspectRatio') &&
    optionalString(settings, 'mode') &&
    (settings.count === undefined ||
      (Number.isInteger(settings.count) && Number(settings.count) > 0)) &&
    (settings.duration === undefined ||
      (isFiniteNumber(settings.duration) && settings.duration > 0)) &&
    Array.isArray(value.references) &&
    value.references.every((reference) =>
      isRecord(reference) &&
      Number.isInteger(reference.alias) &&
      Number(reference.alias) > 0 &&
      isHistoryMediaType(reference.mediaType) &&
      (reference.assetId === undefined ||
        (typeof reference.assetId === 'string' && UUID.test(reference.assetId))),
    ) &&
    isIsoDate(value.completedAt)
  )
}

function isPersistedGenerationRequest(value: unknown): value is PersistedGenerationRequest {
  return (
    isRecord(value) &&
    typeof value.clientRequestId === 'string' &&
    (value.projectId === undefined || typeof value.projectId === 'string') &&
    (value.canvasId === undefined || typeof value.canvasId === 'string') &&
    typeof value.providerId === 'string' &&
    typeof value.catalogVersion === 'string' &&
    (value.mediaType === 'image' || value.mediaType === 'video') &&
    (typeof value.channel === 'string' || isFiniteNumber(value.channel)) &&
    typeof value.model === 'string' &&
    typeof value.prompt === 'string' &&
    optionalString(value, 'quality') &&
    optionalString(value, 'aspectRatio') &&
    optionalString(value, 'mode') &&
    (value.n === undefined ||
      (isFiniteNumber(value.n) && Number.isInteger(value.n) && value.n > 0)) &&
    (value.duration === undefined ||
      (isFiniteNumber(value.duration) && value.duration > 0)) &&
    Array.isArray(value.references) &&
    value.references.every(
      (reference) =>
        isRecord(reference) &&
        isFiniteNumber(reference.alias) &&
        Number.isInteger(reference.alias) &&
        reference.alias > 0 &&
        (reference.mediaType === 'image' ||
          reference.mediaType === 'video' ||
          reference.mediaType === 'audio') &&
        optionalString(reference, 'assetId') &&
        optionalString(reference, 'url'),
    )
  )
}

function isGenerationJob(value: unknown): value is GenerationJob {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    UUID.test(value.id) &&
    typeof value.clientRequestId === 'string' &&
    typeof value.requestDigest === 'string' &&
    isPersistedGenerationRequest(value.request) &&
    JOB_STATUSES.has(String(value.status)) &&
    isFiniteNumber(value.progress) &&
    value.progress >= 0 &&
    value.progress <= 100 &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    optionalString(value, 'createAttemptedAt') &&
    optionalString(value, 'upstreamTaskId') &&
    Array.isArray(value.outputs) &&
    value.outputs.every(
      (output) =>
        isRecord(output) &&
        isLocalAssetIdentity(output.assetId, output.url) &&
        typeof output.contentType === 'string' &&
        isFiniteNumber(output.size) &&
        output.size >= 0,
    ) &&
    (value.error === undefined ||
      (isRecord(value.error) &&
        typeof value.error.code === 'string' &&
        typeof value.error.message === 'string'))
  )
}

export interface CanvasGenerationActivity {
  active: boolean
  jobs: Array<Pick<GenerationJob, 'id' | 'status' | 'updatedAt'>>
}

function isCanvasGenerationActivity(value: unknown): value is CanvasGenerationActivity {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === 'active' || key === 'jobs') &&
    typeof value.active === 'boolean' &&
    Array.isArray(value.jobs) &&
    value.jobs.every((job) =>
      isRecord(job) &&
      Object.keys(job).every((key) => key === 'id' || key === 'status' || key === 'updatedAt') &&
      typeof job.id === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.id) &&
      JOB_STATUSES.has(String(job.status)) &&
      job.status !== 'complete' &&
      job.status !== 'failed' &&
      isIsoDate(job.updatedAt),
    ) &&
    value.active === (value.jobs.length > 0)
  )
}

function safeErrorMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127 ? ' ' : character
  })
    .join('')
    .trim()
  return normalized ? normalized.slice(0, 512) : fallback
}

function gatewayError(status: number, payload: GatewayErrorEnvelope): GatewayClientError {
  const code =
    typeof payload.error?.code === 'string'
      ? payload.error.code.slice(0, 128)
      : 'request_failed'
  const message = safeErrorMessage(payload.error?.message, `Gateway request failed (${status})`)
  if (status === 409 && code === 'catalog_changed') {
    return new CatalogChangedGatewayError(message)
  }
  if (status === 409 && code === 'idempotency_conflict') {
    return new IdempotencyConflictGatewayError(message)
  }
  return new GatewayClientError(status, code, message)
}

function createRequestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController()
  let timeoutTriggered = false
  const abortFromCaller = () => {
    controller.abort(callerSignal?.reason ?? new DOMException('Aborted', 'AbortError'))
  }
  if (callerSignal?.aborted) abortFromCaller()
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })

  const timer = globalThis.setTimeout(() => {
    timeoutTriggered = true
    controller.abort(new DOMException('Gateway request timed out', 'TimeoutError'))
  }, timeoutMs)

  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      globalThis.clearTimeout(timer)
      callerSignal?.removeEventListener('abort', abortFromCaller)
    },
  }
}

export class GatewayClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private collaborationRoomId?: string
  private localAdminSessionReady = false
  private localAdminSessionFlight?: Promise<void>

  constructor(options: GatewayClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/$/, '') ?? ''
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  setCollaborationRoomId(roomId?: string): void {
    this.collaborationRoomId = roomId
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: GatewayRequestOptions = {},
  ): Promise<T> {
    const requestSignal = createRequestSignal(options.signal, this.timeoutMs)
    try {
      if (requestSignal.signal.aborted) {
        throw requestSignal.signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      const headers = new Headers(init.headers)
      if (this.collaborationRoomId) {
        headers.set('x-collaboration-room', this.collaborationRoomId)
      }
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        credentials: init.credentials ?? 'same-origin',
        signal: requestSignal.signal,
      })
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok) {
        throw gatewayError(
          response.status,
          payload && typeof payload === 'object'
            ? (payload as GatewayErrorEnvelope)
            : {},
        )
      }
      if (!payload || typeof payload !== 'object') {
        throw new GatewayClientError(
          response.status,
          'invalid_response',
          '网关返回了无效的响应数据 (Gateway returned an invalid response)',
        )
      }
      return payload as T
    } catch (error) {
      if (error instanceof GatewayClientError) throw error
      if (requestSignal.timedOut()) {
        throw new GatewayClientError(0, 'timeout', '网关请求超时 (Gateway request timed out)')
      }
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      if (requestSignal.signal.aborted) {
        throw requestSignal.signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      throw new GatewayClientError(0, 'network_error', '无法连接到本地网关服务器 (Unable to reach local gateway)')
    } finally {
      requestSignal.dispose()
    }
  }

  private async ensureLocalAdminSession(options?: GatewayRequestOptions): Promise<void> {
    if (this.collaborationRoomId || this.localAdminSessionReady) return
    if (!this.localAdminSessionFlight) {
      this.localAdminSessionFlight = this.request<{ ok: boolean; created: boolean }>(
        '/api/local-admin/session',
        { method: 'POST' },
        options,
      ).then((response) => {
        if (response.ok !== true || typeof response.created !== 'boolean') invalidResponse('Gateway returned an invalid local administrator session')
        this.localAdminSessionReady = true
      }).finally(() => { this.localAdminSessionFlight = undefined })
    }
    return this.localAdminSessionFlight
  }

  private async ensureSensitiveAccess(options?: GatewayRequestOptions): Promise<void> {
    if (!this.collaborationRoomId) await this.ensureLocalAdminSession(options)
  }

  async listProviders(options?: GatewayRequestOptions): Promise<ProviderMetadata[]> {
    const response = await this.request<{ providers: ProviderMetadata[] }>(
      '/api/providers',
      {},
      options,
    )
    if (!Array.isArray(response.providers) || !response.providers.every(isProviderMetadata)) {
      invalidResponse('Gateway returned invalid providers')
    }
    return response.providers
  }

  async updateProvider(
    providerId: string,
    update: ProviderUpdate,
    options?: GatewayRequestOptions,
  ): Promise<ProviderMetadata> {
    await this.ensureSensitiveAccess(options)
    const response = await this.request<{ provider: ProviderMetadata }>(
      `/api/providers/${encodeURIComponent(providerId)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(update),
      },
      options,
    )
    if (!isProviderMetadata(response.provider)) invalidResponse('Gateway returned an invalid provider')
    return response.provider
  }

  async setProviderSecret(
    providerId: string,
    apiKey: string,
    options?: GatewayRequestOptions,
  ): Promise<ProviderMetadata> {
    await this.ensureSensitiveAccess(options)
    return this.providerSecretRequest(providerId, 'PUT', apiKey, options)
  }

  async clearProviderSecret(
    providerId: string,
    options?: GatewayRequestOptions,
  ): Promise<ProviderMetadata> {
    await this.ensureSensitiveAccess(options)
    return this.providerSecretRequest(providerId, 'DELETE', undefined, options)
  }

  private async providerSecretRequest(
    providerId: string,
    method: 'PUT' | 'DELETE',
    apiKey: string | undefined,
    options?: GatewayRequestOptions,
  ): Promise<ProviderMetadata> {
    const response = await this.request<ProviderMetadata>(
      `/api/providers/${encodeURIComponent(providerId)}/secret`,
      {
        method,
        ...(apiKey !== undefined
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ apiKey }),
            }
          : {}),
      },
      options,
    )
    if (!isProviderMetadata(response)) invalidResponse('Gateway returned an invalid provider')
    return response
  }

  async testProvider(
    providerId: string,
    options?: GatewayRequestOptions,
  ): Promise<ProviderMetadata> {
    await this.ensureSensitiveAccess(options)
    const response = await this.request<{
      ok: boolean
      provider: ProviderMetadata
    }>(
      `/api/providers/${encodeURIComponent(providerId)}/test`,
      { method: 'POST' },
      options,
    )
    if (!isProviderMetadata(response.provider)) invalidResponse('Gateway returned an invalid provider')
    return response.provider
  }

  async syncProvider(
    providerId: string,
    options?: GatewayRequestOptions,
  ): Promise<ProviderCatalog> {
    await this.ensureSensitiveAccess(options)
    const response = await this.request<{ catalog: ProviderCatalog }>(
      `/api/providers/${encodeURIComponent(providerId)}/sync`,
      { method: 'POST' },
      options,
    )
    if (!isProviderCatalog(response.catalog)) invalidResponse('Gateway returned an invalid catalog')
    return response.catalog
  }

  async getCatalog(
    providerId: string,
    options?: GatewayRequestOptions,
  ): Promise<ProviderCatalog> {
    const response = await this.request<{ catalog: ProviderCatalog }>(
      `/api/catalog?providerId=${encodeURIComponent(providerId)}`,
      {},
      options,
    )
    if (!isProviderCatalog(response.catalog)) invalidResponse('Gateway returned an invalid catalog')
    return response.catalog
  }

  async uploadAsset(
    body: Blob,
    filename: string,
    options?: GatewayRequestOptions,
  ): Promise<AssetRecord> {
    const response = await this.request<{ asset: AssetRecord }>(
      '/api/assets',
      {
        method: 'POST',
        headers: {
          'content-type': body.type || 'application/octet-stream',
          'x-filename': encodeURIComponent(filename || 'asset'),
        },
        body,
      },
      options,
    )
    if (!isAssetRecord(response.asset)) invalidResponse('Gateway returned an invalid asset')
    return response.asset
  }

  async importAsset(
    url: string,
    filename?: string,
    options?: GatewayRequestOptions,
  ): Promise<AssetRecord> {
    const response = await this.request<{ asset: AssetRecord }>(
      '/api/assets/import',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, ...(filename ? { filename } : {}) }),
      },
      options,
    )
    if (!isAssetRecord(response.asset)) invalidResponse('Gateway returned an invalid asset')
    return response.asset
  }

  async createGenerationJob(
    request: GenerationRequest,
    options?: GatewayRequestOptions,
  ): Promise<GenerationJob> {
    await this.ensureSensitiveAccess(options)
    const response = await this.request<{ job: GenerationJob }>(
      '/api/generation-jobs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
      options,
    )
    if (!isGenerationJob(response.job)) invalidResponse('Gateway returned an invalid job')
    return response.job
  }

  async reassignGenerationHistory(
    input: {
      operationId: string
      canvasId: string
      fromProjectId: string
      toProjectId: string
    },
    options?: GatewayRequestOptions,
  ): Promise<{ moved: number; bound: number }> {
    const response = await this.request<{ moved: number; bound: number }>(
      '/api/generation-history/reassign-canvas',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
      options,
    )
    if (!Number.isInteger(response.moved) || response.moved < 0 ||
      !Number.isInteger(response.bound) || response.bound < 0) {
      invalidResponse('Gateway returned an invalid history reassignment result')
    }
    return response
  }

  async syncCanvasAssetReferences(
    input: { projectId: string; canvasId: string; assetIds: string[] },
    options?: GatewayRequestOptions,
  ): Promise<{ canvasId: string; assetCount: number }> {
    const response = await this.request<{ canvasId: string; assetCount: number }>(
      `/api/canvas-asset-references/${encodeURIComponent(input.canvasId)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: input.projectId, assetIds: input.assetIds }),
      },
      options,
    )
    if (response.canvasId !== input.canvasId || !Number.isInteger(response.assetCount) ||
      response.assetCount !== input.assetIds.length) {
      invalidResponse('Gateway returned invalid canvas asset references')
    }
    return response
  }

  async getCanvasActivity(
    projectId: string,
    canvasId: string,
    options?: GatewayRequestOptions,
  ): Promise<CanvasGenerationActivity> {
    const search = new URLSearchParams({ projectId, canvasId })
    const response = await this.request<CanvasGenerationActivity>(
      `/api/canvas-activity?${search.toString()}`,
      {},
      options,
    )
    if (!isCanvasGenerationActivity(response)) {
      invalidResponse('Gateway returned invalid canvas activity')
    }
    return response
  }

  async releaseCanvasAssetReferences(
    projectId: string,
    canvasId: string,
    options?: GatewayRequestOptions,
  ): Promise<{ canvasId: string; deletedAssetIds: string[] }> {
    const search = new URLSearchParams({ projectId })
    const response = await this.request<{
      canvasId: string
      deletedAssetIds: string[]
    }>(
      `/api/canvas-asset-references/${encodeURIComponent(canvasId)}?${search.toString()}`,
      { method: 'DELETE' },
      options,
    )
    if (
      response.canvasId !== canvasId ||
      !Array.isArray(response.deletedAssetIds) ||
      !response.deletedAssetIds.every(
        (assetId) => typeof assetId === 'string' && UUID.test(assetId),
      )
    ) {
      invalidResponse('Gateway returned invalid released canvas assets')
    }
    return response
  }

  async backfillGenerationHistory(
    input: {
      projectId: string
      canvasId?: string
      entries: Array<{ jobId: string; outputIndex: number; assetId: string }>
    },
    options?: GatewayRequestOptions,
  ): Promise<void> {
    const response = await this.request<{ entries: unknown[] }>(
      '/api/generation-history/backfill',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
      options,
    )
    if (
      !Array.isArray(response.entries) ||
      response.entries.length !== input.entries.length ||
      !response.entries.every(
        (entry) => isGenerationHistoryEntry(entry) &&
          entry.projectId === input.projectId &&
          input.entries.some((expected) =>
            expected.jobId === entry.jobId &&
            expected.outputIndex === entry.outputIndex &&
            expected.assetId === entry.asset.id,
          ),
      )
    ) {
      invalidResponse('Gateway returned invalid history entries')
    }
  }

  async listGenerationHistory(
    input: {
      projectId: string
      mediaType?: GenerationHistoryMediaType
      cursor?: string
      limit?: number
    },
    options?: GatewayRequestOptions,
  ): Promise<GenerationHistoryPage> {
    const search = new URLSearchParams({ projectId: input.projectId })
    if (input.mediaType) search.set('mediaType', input.mediaType)
    if (input.cursor) search.set('cursor', input.cursor)
    if (input.limit !== undefined) search.set('limit', String(input.limit))
    const response = await this.request<GenerationHistoryPage>(
      `/api/generation-history?${search.toString()}`,
      {},
      options,
    )
    if (
      !Array.isArray(response.entries) ||
      !response.entries.every(
        (entry) => isGenerationHistoryEntry(entry) && entry.projectId === input.projectId,
      ) ||
      (response.nextCursor !== undefined &&
        (typeof response.nextCursor !== 'string' || response.nextCursor.length === 0))
    ) {
      invalidResponse('Gateway returned invalid generation history')
    }
    return response
  }

  async deleteGenerationHistoryEntry(
    projectId: string,
    entryId: string,
    options?: GatewayRequestOptions,
  ): Promise<void> {
    const search = new URLSearchParams({ projectId })
    const response = await this.request<{ deleted: boolean }>(
      `/api/generation-history/${encodeURIComponent(entryId)}?${search.toString()}`,
      { method: 'DELETE' },
      options,
    )
    if (response.deleted !== true) {
      invalidResponse('Gateway did not confirm history deletion')
    }
  }

  async getGenerationJob(
    jobId: string,
    options?: GatewayRequestOptions,
  ): Promise<GenerationJob> {
    const response = await this.request<{ job: GenerationJob }>(
      `/api/generation-jobs/${encodeURIComponent(jobId)}`,
      {},
      options,
    )
    if (!isGenerationJob(response.job)) invalidResponse('Gateway returned an invalid job')
    return response.job
  }
}

export const gatewayClient = new GatewayClient()
