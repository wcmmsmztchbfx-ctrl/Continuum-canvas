import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { GenerationRequest, ProviderCatalog } from '../../src/contracts/generation.ts'
import type { ImageRequestMode } from '../../src/contracts/catalog.ts'
import { createFallbackOpenAICatalog, mapOpenAICompatibleCatalog } from '../catalog.ts'
import {
  ProviderRequestRejectedError,
  type LocalReference,
  type PresignedUpload,
  type StagedReference,
  type UpstreamTaskStatus,
} from './provider-adapter.ts'
import {
  isRecord,
  normalizedBaseUrl,
  operationSignal,
  rejectedRequest,
} from './request-utils.ts'

const REFERENCE_MAX_SIZE = 20 * 1024 * 1024
// RFC 2606 reserved domain: never resolvable, never leaves the gateway.
const STAGED_REF_PREFIX = 'https://local.invalid/ref/'
const FILE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
// OpenAI-compatible image endpoints return the output synchronously.
const STATUS_COMPLETE = 3

const IMAGE_SIZE_MAP: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
}

function imageMimeFromBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  return 'image/png'
}

function toDataUrl(bytes: Uint8Array): string {
  return `data:${imageMimeFromBytes(bytes)};base64,${Buffer.from(bytes).toString('base64')}`
}

type RequestMode = 'openai' | 'openai-json' | 'openai-responses'

type CreateResult =
  | { kind: 'sync'; outputs: string[] }
  | { kind: 'async'; taskId: string }

export class OpenAICompatibleAdapter {
  private readonly fetcher: typeof fetch
  private readonly providerId: string
  private readonly now: () => Date
  private readonly timeoutMs: number
  private readonly signalForTimeout: (timeoutMs: number) => AbortSignal
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly stagingDir: string
  private readonly mode: RequestMode

  constructor(options: {
    apiKey: string
    baseUrl: string
    providerId?: string
    fetcher?: typeof fetch
    now?: () => Date
    timeoutMs?: number
    signalForTimeout?: (timeoutMs: number) => AbortSignal
    stagingDir: string
    imageRequestMode?: ImageRequestMode
  }) {
    this.apiKey = options.apiKey
    this.fetcher = options.fetcher ?? fetch
    this.providerId = options.providerId ?? 'openai-compatible'
    this.now = options.now ?? (() => new Date())
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.signalForTimeout = options.signalForTimeout ?? AbortSignal.timeout
    this.baseUrl = normalizedBaseUrl(options.baseUrl)
    this.stagingDir = options.stagingDir
    const requestedMode = options.imageRequestMode ?? 'auto'
    this.mode = requestedMode === 'auto' || requestedMode === 'openai'
      ? 'openai'
      : requestedMode
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    try {
      await this.request('/models', {}, signal)
    } catch (error) {
      if (error instanceof ProviderRequestRejectedError) {
        if (
          error.providerCode === '401' ||
          error.providerCode === 'invalid_api_key' ||
          /invalid.*(api_key|key)|unauthorized|incorrect api key/i.test(error.message)
        ) {
          throw error
        }
        // When upstream API proxy rejects /models due to group restrictions (e.g. 403 image-4K) or 404,
        // the host is reachable and the key is recognized by the gateway, so the connection is valid!
        return
      }
      throw error
    }
  }

  async syncCatalog(signal?: AbortSignal): Promise<ProviderCatalog> {
    try {
      const payload = await this.request('/models', {}, signal)
      return mapOpenAICompatibleCatalog(this.providerId, payload, this.now().toISOString())
    } catch {
      return createFallbackOpenAICatalog(this.providerId, this.now().toISOString())
    }
  }

  async presignReference(reference: LocalReference, signal?: AbortSignal): Promise<PresignedUpload> {
    void reference
    void signal
    return {
      fileKey: `ref-${randomUUID()}`,
      uploadUrl: 'https://local.invalid/upload',
      method: 'PUT',
      headers: {},
      expiresAt: this.now().getTime() + 24 * 60 * 60 * 1_000,
    }
  }

  async uploadReference(reference: LocalReference, grant: PresignedUpload, signal?: AbortSignal): Promise<void> {
    if (!FILE_KEY_PATTERN.test(grant.fileKey)) throw new Error('Reference upload authorization was unsafe')
    if (reference.size > REFERENCE_MAX_SIZE) throw new Error('Reference exceeds the allowed limit')
    await mkdir(this.stagingDir, { recursive: true })
    await pipeline(reference.openStream(signal), createWriteStream(this.stagedPath(grant.fileKey)))
  }

  async completeReference(fileKey: string, signal?: AbortSignal): Promise<StagedReference> {
    void signal
    if (!FILE_KEY_PATTERN.test(fileKey)) throw new Error('Provider did not return a valid reference key')
    try {
      await readFile(this.stagedPath(fileKey))
    } catch {
      throw new Error('Provider did not return a reference URL')
    }
    return { url: `${STAGED_REF_PREFIX}${fileKey}` }
  }

  async createGeneration(request: GenerationRequest, references: StagedReference[], signal?: AbortSignal): Promise<string> {
    const stagedKeys = new Set<string>()
    const imageRefs = references.filter((item) => (item.mediaType ?? 'image') === 'image')
    for (const ref of imageRefs) {
      const key = stagedKeyFromUrl(ref.url)
      if (key) stagedKeys.add(key)
    }
    try {
      const result = imageRefs.length > 0
        ? await this.createEdits(request, imageRefs, signal)
        : await this.createGenerations(request, signal)
      if (result.kind === 'async') return result.taskId
      // 同步：本地 task 文件承载结果，跨进程可恢复
      const taskId = `sync-${randomUUID()}`
      await mkdir(join(this.stagingDir, 'tasks'), { recursive: true })
      await writeFile(
        join(this.stagingDir, 'tasks', `${taskId}.json`),
        JSON.stringify({ taskId, status: STATUS_COMPLETE, outputs: result.outputs }),
      )
      return taskId
    } finally {
      // Once createGeneration returns or fails with a terminal error the job
      // runner never restages these references, so the local copies can go.
      for (const key of stagedKeys) {
        await rm(this.stagedPath(key), { force: true }).catch(() => {})
      }
    }
  }

  async getGenerationStatus(taskIds: string[], signal?: AbortSignal): Promise<UpstreamTaskStatus[]> {
    const results: UpstreamTaskStatus[] = []
    for (const taskId of taskIds) {
      const status = isLocalTaskId(taskId)
        ? await this.readTask(taskId)
        : await this.queryTaskStatus(taskId, signal)
      if (status) results.push(status)
    }
    return results
  }

  async getGenerationDetail(taskId: string, signal?: AbortSignal): Promise<UpstreamTaskStatus> {
    if (!isLocalTaskId(taskId)) return this.queryTaskStatus(taskId, signal)
    return (await this.readTask(taskId)) ?? { taskId, status: 2 }
  }

  private async createGenerations(request: GenerationRequest, signal?: AbortSignal): Promise<CreateResult> {
    if (this.mode === 'openai-responses') {
      return this.createResponses(request, [], signal)
    }
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
    }
    if (request.n !== undefined && request.n > 1) body.n = request.n
    const size = IMAGE_SIZE_MAP[request.aspectRatio ?? '']
    if (size) body.size = size
    const payload = await this.request('/images/generations', {
      method: 'POST',
      body: JSON.stringify(body),
    }, signal)
    return this.classifyPayload(payload)
  }

  private async createEdits(
    request: GenerationRequest,
    references: StagedReference[],
    signal?: AbortSignal,
  ): Promise<CreateResult> {
    if (this.mode === 'openai-responses') {
      return this.createResponses(request, references, signal)
    }
    if (this.mode === 'openai-json') {
      // 本地直通桩 URL 不能发上游：读 staging 字节内联为 data URL（单图）
      let image: string | undefined
      const key = stagedKeyFromUrl(references[0]?.url)
      if (key) image = toDataUrl(await readFile(this.stagedPath(key)))
      const body: Record<string, unknown> = {
        model: request.model,
        prompt: request.prompt,
        ...(image ? { image } : {}),
      }
      if (request.n !== undefined && request.n > 1) body.n = request.n
      const size = IMAGE_SIZE_MAP[request.aspectRatio ?? '']
      if (size) body.size = size
      const payload = await this.request('/images/edits', {
        method: 'POST',
        body: JSON.stringify(body),
      }, signal)
      return this.classifyPayload(payload)
    }
    // openai：multipart FormData
    const form = new FormData()
    form.append('model', request.model)
    form.append('prompt', request.prompt)
    for (const ref of references) {
      const key = stagedKeyFromUrl(ref.url)
      if (!key) continue
      const bytes = await readFile(this.stagedPath(key))
      form.append('image', new Blob([bytes], { type: 'image/png' }), `${key}.png`)
    }
    if (request.n !== undefined && request.n > 1) form.append('n', String(request.n))
    const size = IMAGE_SIZE_MAP[request.aspectRatio ?? '']
    if (size) form.append('size', size)
    const payload = await this.request('/images/edits', {
      method: 'POST',
      body: form,
    }, signal)
    return this.classifyPayload(payload)
  }

  private async createResponses(
    request: GenerationRequest,
    references: StagedReference[],
    signal?: AbortSignal,
  ): Promise<CreateResult> {
    const content: unknown[] = [{ type: 'input_text', text: request.prompt }]
    for (const ref of references) {
      const key = stagedKeyFromUrl(ref.url)
      if (!key) continue
      content.push({ type: 'input_image', image_url: toDataUrl(await readFile(this.stagedPath(key))) })
    }
    const size = IMAGE_SIZE_MAP[request.aspectRatio ?? '']
    const tools: Record<string, unknown>[] = [{
      type: 'image_generation',
      action: references.length > 0 ? 'edit' : 'generate',
      ...(size ? { size } : {}),
    }]
    const payload = await this.request('/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: request.model,
        input: [{ role: 'user', content }],
        tools,
      }),
    }, signal)
    return this.classifyPayload(payload)
  }

  private classifyPayload(payload: unknown): CreateResult {
    const outputs = this.outputUrls(payload)
    if (outputs.length > 0) return { kind: 'sync', outputs }
    const taskId = taskIdFromPayload(payload)
    if (taskId) return { kind: 'async', taskId }
    throw new Error('Provider returned no output')
  }

  private outputUrls(payload: unknown): string[] {
    return this.mode === 'openai-responses'
      ? extractResponsesOutputUrls(payload)
      : extractOutputUrls(payload)
  }

  private async queryTaskStatus(taskId: string, signal?: AbortSignal): Promise<UpstreamTaskStatus> {
    let payload: unknown
    try {
      payload = await this.request(`/tasks/${encodeURIComponent(taskId)}`, {}, signal)
    } catch {
      // 404 / 网络异常 / 超时：视为进行中，由 jobs 的 maxRunTimeMs 兜底
      return { taskId, status: 2 }
    }
    return mapTaskPayload(taskId, payload)
  }

  private stagedPath(fileKey: string): string {
    if (!FILE_KEY_PATTERN.test(fileKey)) throw new Error('Reference key was invalid')
    return join(this.stagingDir, fileKey)
  }

  private async readTask(taskId: string): Promise<UpstreamTaskStatus | undefined> {
    if (!/^sync-[A-Za-z0-9-]{1,64}$/.test(taskId)) return undefined
    try {
      const parsed = JSON.parse(await readFile(join(this.stagingDir, 'tasks', `${taskId}.json`), 'utf8'))
      if (!isRecord(parsed) || parsed.taskId !== taskId || parsed.status !== STATUS_COMPLETE) return undefined
      const outputs = Array.isArray(parsed.outputs)
        ? parsed.outputs.filter((item): item is string => typeof item === 'string')
        : []
      return { taskId, status: STATUS_COMPLETE, ...(outputs.length > 0 ? { outputs } : {}) }
    } catch {
      return undefined
    }
  }

  private operationSignal(external?: AbortSignal): AbortSignal {
    return operationSignal(this.timeoutMs, this.signalForTimeout, external)
  }

  private async request(path: string, init: RequestInit = {}, externalSignal?: AbortSignal): Promise<unknown> {
    const signal = this.operationSignal(externalSignal ?? init.signal ?? undefined)
    const headers: Record<string, string> = {}
    for (const [key, value] of new Headers(init.headers).entries()) {
      headers[key] = value
    }
    // FormData must not force a content-type: undici supplies the boundary.
    if (!(init.body instanceof FormData)) headers['content-type'] = 'application/json'
    headers['Authorization'] = `Bearer ${this.apiKey}`
    let response: Response
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        signal,
        headers,
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
        throw rejectedRequest(payload, String(response.status))
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

function stagedKeyFromUrl(url: string): string | undefined {
  if (!url.startsWith(STAGED_REF_PREFIX)) return undefined
  const key = url.slice(STAGED_REF_PREFIX.length)
  return FILE_KEY_PATTERN.test(key) ? key : undefined
}

function b64ToDataUrl(value: string): string | undefined {
  let bytes: Buffer
  try {
    bytes = Buffer.from(value, 'base64')
  } catch {
    return undefined
  }
  if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) return undefined
  return toDataUrl(bytes)
}

function extractOutputUrls(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return []
  return payload.data.flatMap((entry) => {
    if (!isRecord(entry)) return []
    if (typeof entry.url === 'string' && entry.url) return [entry.url]
    if (typeof entry.b64_json === 'string' && entry.b64_json) {
      const dataUrl = b64ToDataUrl(entry.b64_json)
      return dataUrl ? [dataUrl] : []
    }
    return []
  })
}

function extractResponsesOutputUrls(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.output)) return []
  return payload.output.flatMap((item): string[] => {
    if (!isRecord(item)) return []
    if (Array.isArray(item.content)) {
      const fromContent = item.content.flatMap((part): string[] => {
        if (!isRecord(part)) return []
        const url = part.url ?? part.image_url
        if (typeof url === 'string' && url) return [url]
        if (typeof part.b64_json === 'string' && part.b64_json) {
          const dataUrl = b64ToDataUrl(part.b64_json)
          return dataUrl ? [dataUrl] : []
        }
        return []
      })
      if (fromContent.length > 0) return fromContent
    }
    if (Array.isArray(item.data)) {
      const wrapped = extractOutputUrls({ data: item.data })
      if (wrapped.length > 0) return wrapped
    }
    const url = item.url ?? item.image_url
    if (typeof url === 'string' && url) return [url]
    if (typeof item.b64_json === 'string' && item.b64_json) {
      const dataUrl = b64ToDataUrl(item.b64_json)
      return dataUrl ? [dataUrl] : []
    }
    return []
  })
}

function taskIdFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  for (const key of ['task_id', 'taskId', 'id']) {
    const value = payload[key]
    if (typeof value === 'string' && value) return value
  }
  if (Array.isArray(payload.data) && isRecord(payload.data[0])) {
    for (const key of ['task_id', 'taskId', 'id']) {
      const value = payload.data[0][key]
      if (typeof value === 'string' && value) return value
    }
  }
  return undefined
}

function isLocalTaskId(taskId: string): boolean {
  return /^sync-[A-Za-z0-9-]{1,64}$/.test(taskId)
}

function mapTaskStatus(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 4) return raw
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    if (/^(completed|succeeded|complete|success|done)$/.test(normalized)) return 3
    if (/^(failed|error|cancelled|canceled)$/.test(normalized)) return 4
    if (/^(queued|pending|created)$/.test(normalized)) return 1
    if (/^(running|processing|in_progress)$/.test(normalized)) return 2
  }
  return 2 // 未知 → 保轮询
}

function mapTaskPayload(taskId: string, payload: unknown): UpstreamTaskStatus {
  const root = isRecord(payload) ? payload : {}
  const data = isRecord(root.data) ? root.data : undefined
  const rawStatus = root.status ?? data?.status ?? root.task_status ?? data?.task_status
  const status = mapTaskStatus(rawStatus)
  if (status !== 3) return { taskId, status }
  if (Array.isArray(root.data)) {
    const outputs = extractOutputUrls({ data: root.data })
    return { taskId, status: 3, ...(outputs.length > 0 ? { outputs } : {}) }
  }
  for (const candidate of [root, data ?? {}]) {
    for (const key of ['outputs', 'output', 'result']) {
      const value = candidate[key]
      if (Array.isArray(value)) {
        const outputs = extractOutputUrls({ data: value })
        if (outputs.length > 0) return { taskId, status: 3, outputs }
      } else if (isRecord(value)) {
        const outputs = extractOutputUrls({ data: [value] })
        if (outputs.length > 0) return { taskId, status: 3, outputs }
      }
    }
  }
  return { taskId, status: 3 }
}

export const openaiCompatibleStagedRefPrefix = STAGED_REF_PREFIX
