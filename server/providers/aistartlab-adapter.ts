import { lookup as dnsLookup } from 'node:dns/promises'
import type { GenerationRequest, ProviderCatalog } from '../../src/contracts/generation.ts'
import { OFFICIAL_AISTARTLAB_BASE_URL } from '../../src/contracts/catalog.ts'
import { mapAIStartLabCatalog } from '../catalog.ts'
import {
  createPinnedRemoteFetcher,
  resolvePinnedPublicAddress,
  type AddressLookup,
  type PinnedRemoteFetcher,
} from '../pinned-http.ts'
import type {
  LocalReference,
  PresignedUpload,
  StagedReference,
  UpstreamTaskStatus,
} from './provider-adapter.ts'
import {
  dataRecord,
  isRecord,
  normalizedBaseUrl,
  operationSignal,
  rejectedRequest,
} from './request-utils.ts'

const SAFE_UPLOAD_HEADERS = new Set([
  'authorization', 'cache-control', 'content-length', 'content-md5', 'content-type', 'x-content-sha256',
])
const SAFE_UPLOAD_HEADER_PREFIXES = ['x-amz-', 'x-goog-', 'x-oss-', 'x-ms-', 'x-upload-', 'x-cos-', 'x-qiniu-']

function officialBaseUrl(value: string): string {
  let normalized: string
  try {
    normalized = normalizedBaseUrl(value)
  } catch {
    throw new Error('AIStartLab OpenAPI must use the official AIStartLab endpoint')
  }
  if (normalized !== OFFICIAL_AISTARTLAB_BASE_URL) {
    throw new Error('AIStartLab OpenAPI must use the official AIStartLab endpoint')
  }
  return OFFICIAL_AISTARTLAB_BASE_URL
}

function isSafeUploadHeader(name: string): boolean {
  const normalized = name.toLowerCase()
  return SAFE_UPLOAD_HEADERS.has(normalized) || SAFE_UPLOAD_HEADER_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export class AIStartLabAdapter {
  private readonly fetcher: typeof fetch
  private readonly providerId: string
  private readonly now: () => Date
  private readonly timeoutMs: number
  private readonly signalForTimeout: (timeoutMs: number) => AbortSignal
  private readonly baseUrl: string
  private readonly options: { apiKey: string }
  private readonly pinnedFetcher: PinnedRemoteFetcher
  private readonly lookup: AddressLookup

  constructor(options: {
    apiKey: string
    baseUrl?: string
    fetcher?: typeof fetch
    providerId?: string
    now?: () => Date
    timeoutMs?: number
    signalForTimeout?: (timeoutMs: number) => AbortSignal
    pinnedFetcher?: PinnedRemoteFetcher
    lookup?: AddressLookup
  }) {
    this.options = options
    this.fetcher = options.fetcher ?? fetch
    this.providerId = options.providerId ?? 'aistartlab'
    this.now = options.now ?? (() => new Date())
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.signalForTimeout = options.signalForTimeout ?? AbortSignal.timeout
    this.baseUrl = officialBaseUrl(options.baseUrl ?? OFFICIAL_AISTARTLAB_BASE_URL)
    this.pinnedFetcher = options.pinnedFetcher ?? createPinnedRemoteFetcher()
    this.lookup = options.lookup ?? (async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }))
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    await this.request('/generation/config', {}, signal)
  }

  async syncCatalog(signal?: AbortSignal): Promise<ProviderCatalog> {
    const payload = await this.request('/generation/config', {}, signal)
    return mapAIStartLabCatalog(this.providerId, payload, this.now().toISOString())
  }

  async presignReference(reference: LocalReference, signal?: AbortSignal): Promise<PresignedUpload> {
    const payload = await this.request('/uploads/presign', {
      method: 'POST',
      body: JSON.stringify({
        filename: reference.filename,
        contentType: reference.contentType,
        size: reference.size,
      }),
    }, signal)
    const presign = dataRecord(payload)
    if (
      typeof presign.uploadUrl !== 'string' ||
      typeof presign.fileKey !== 'string' ||
      typeof presign.method !== 'string' ||
      !isRecord(presign.headers) ||
      typeof presign.expireSeconds !== 'number' ||
      !Number.isFinite(presign.expireSeconds) ||
      presign.expireSeconds <= 0
    ) {
      throw new Error('Provider upload authorization was incomplete')
    }
    const headers = Object.fromEntries(Object.entries(presign.headers).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key, value]] : []))
    if (Object.keys(headers).length !== Object.keys(presign.headers).length) {
      throw new Error('Provider upload headers were invalid')
    }
    let uploadUrl: URL
    try {
      uploadUrl = new URL(presign.uploadUrl)
    } catch {
      throw new Error('Provider upload URL must use HTTPS')
    }
    if (uploadUrl.protocol !== 'https:' || uploadUrl.username || uploadUrl.password || uploadUrl.hash) {
      throw new Error('Provider upload URL must use HTTPS without credentials or fragments')
    }
    if (presign.method.toUpperCase() !== 'PUT') throw new Error('Provider upload method must be PUT')
    if (Object.keys(headers).some((name) => !isSafeUploadHeader(name))) {
      throw new Error('Provider upload headers were not allowed')
    }
    return {
      fileKey: presign.fileKey,
      uploadUrl: uploadUrl.href,
      method: 'PUT',
      headers,
      expiresAt: this.now().getTime() + presign.expireSeconds * 1_000,
    }
  }

  async uploadReference(reference: LocalReference, grant: PresignedUpload, externalSignal?: AbortSignal): Promise<void> {
    if (this.now().getTime() >= grant.expiresAt) throw new Error('Provider upload authorization expired')
    const uploadUrl = new URL(grant.uploadUrl)
    if (
      uploadUrl.protocol !== 'https:' || uploadUrl.username || uploadUrl.password || uploadUrl.hash ||
      grant.method.toUpperCase() !== 'PUT' || Object.keys(grant.headers).some((name) => !isSafeUploadHeader(name))
    ) throw new Error('Provider upload authorization was unsafe')
    const signal = this.operationSignal(externalSignal)
    let response: Response
    try {
      const pinnedAddress = await resolvePinnedPublicAddress(uploadUrl, this.lookup, signal)
      response = await this.pinnedFetcher(uploadUrl.href, {
        method: 'PUT',
        headers: grant.headers,
        body: reference.openStream(signal),
        signal,
        redirect: 'error',
      }, pinnedAddress)
    } catch (error) {
      if (!externalSignal?.aborted && (signal.aborted || (error instanceof DOMException && error.name === 'TimeoutError'))) {
        throw new Error('Reference upload timed out')
      }
      if (externalSignal?.aborted) throw externalSignal.reason ?? new DOMException('Operation aborted', 'AbortError')
      if (error instanceof Error && error.message.startsWith('Remote URL must ')) throw error
      throw new Error('Reference upload failed')
    }
    try {
      if (response.status >= 300 && response.status < 400) throw new Error('Reference upload redirect was rejected')
      if (!response.ok) throw new Error(`Reference upload failed (${response.status})`)
    } finally {
      await response.body?.cancel().catch(() => {})
    }
  }

  async completeReference(fileKey: string, signal?: AbortSignal): Promise<StagedReference> {
    const payload = await this.request('/uploads/complete', {
      method: 'POST',
      body: JSON.stringify({ fileKey }),
    }, signal)
    const complete = dataRecord(payload)
    if (typeof complete.url !== 'string') throw new Error('Provider did not return a reference URL')
    return { url: complete.url }
  }

  async createGeneration(request: GenerationRequest, references: StagedReference[], signal?: AbortSignal): Promise<string> {
    const sorted = [...references].sort((left, right) => (left.alias ?? Number.MAX_SAFE_INTEGER) - (right.alias ?? Number.MAX_SAFE_INTEGER))
    const referenceFields = {
      inputImages: sorted.filter((item) => (item.mediaType ?? 'image') === 'image').map((item) => item.url),
      inputVideos: sorted.filter((item) => item.mediaType === 'video').map((item) => item.url),
      inputAudios: sorted.filter((item) => item.mediaType === 'audio').map((item) => item.url),
    }
    const body: Record<string, unknown> = {
      channel: request.channel,
      model: request.model,
      prompt: request.prompt,
      quality: request.quality,
      aspectRatio: request.aspectRatio,
      ...(request.mediaType === 'image'
        ? { n: request.n }
        : { duration: request.duration, mode: request.mode, generateAudio: request.generateAudio }),
    }
    for (const [key, values] of Object.entries(referenceFields)) {
      if (values.length > 0) body[key] = values
    }
    for (const key of Object.keys(body)) {
      if (body[key] === undefined) delete body[key]
    }
    const payload = await this.request(`/generation/create/${request.mediaType}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, signal)
    const task = dataRecord(payload)
    if (typeof task.taskId !== 'string') throw new Error('Provider did not return a task id')
    return task.taskId
  }

  async getGenerationStatus(taskIds: string[], signal?: AbortSignal): Promise<UpstreamTaskStatus[]> {
    const payload = await this.request('/generation/status/batch', {
      method: 'POST',
      body: JSON.stringify({ taskIds }),
    }, signal)
    if (!isRecord(payload)) throw new Error('Provider returned an invalid status response')
    const statuses = Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload.data) && Array.isArray(payload.data.tasks)
        ? payload.data.tasks
        : []
    return statuses.filter((status): status is UpstreamTaskStatus =>
      isRecord(status) && typeof status.taskId === 'string' && typeof status.status === 'number')
  }

  async getGenerationDetail(taskId: string, signal?: AbortSignal): Promise<UpstreamTaskStatus> {
    const payload = await this.request(`/generation/detail?taskId=${encodeURIComponent(taskId)}`, {}, signal)
    const detail = dataRecord(payload)
    if (typeof detail.taskId !== 'string' || typeof detail.status !== 'number') {
      throw new Error('Provider returned an invalid task detail')
    }
    return detail as unknown as UpstreamTaskStatus
  }

  private operationSignal(external?: AbortSignal): AbortSignal {
    return operationSignal(this.timeoutMs, this.signalForTimeout, external)
  }

  private async request(path: string, init: RequestInit = {}, externalSignal?: AbortSignal): Promise<unknown> {
    const signal = this.operationSignal(externalSignal ?? init.signal ?? undefined)
    let response: Response
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        signal,
        headers: {
          'content-type': 'application/json',
          ...Object.fromEntries(new Headers(init.headers)),
          Authorization: `Bearer ${this.options.apiKey}`,
        },
      })
    } catch (error) {
      if (!externalSignal?.aborted && (signal.aborted || (error instanceof DOMException && error.name === 'TimeoutError'))) {
        throw new Error('Provider request timed out')
      }
      if (externalSignal?.aborted) throw externalSignal.reason ?? new DOMException('Operation aborted', 'AbortError')
      throw new Error('Provider request failed')
    }
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        let payload: unknown
        try {
          payload = await response.json()
        } catch {
          await response.body?.cancel().catch(() => {})
        }
        throw rejectedRequest(payload)
      }
      await response.body?.cancel().catch(() => {})
      throw new Error(`Provider request failed (${response.status})`)
    }
    const payload: unknown = await response.json()
    if (isRecord(payload) && typeof payload.code === 'number' && payload.code !== 0) {
      throw rejectedRequest(payload)
    }
    return payload
  }
}
