import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { GenerationRequest, ProviderCatalog } from '../../src/contracts/generation.ts'
import {
  ProviderRequestRejectedError,
  type LocalReference,
  type PresignedUpload,
  type StagedReference,
  type UpstreamTaskStatus,
  type ProviderAdapter,
} from './provider-adapter.ts'
import {
  isRecord,
  normalizedBaseUrl,
  operationSignal,
} from './request-utils.ts'

const REFERENCE_MAX_SIZE = 50 * 1024 * 1024
const STAGED_REF_PREFIX = 'https://local.invalid/ref/'
const FILE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const STATUS_RUNNING = 1
const STATUS_COMPLETE = 3
const STATUS_FAILED = 4

function stagedKeyFromUrl(url: string | undefined): string | undefined {
  if (!url || !url.startsWith(STAGED_REF_PREFIX)) return undefined
  const key = url.slice(STAGED_REF_PREFIX.length)
  return FILE_KEY_PATTERN.test(key) ? key : undefined
}

function mimeFromBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 4 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'video/mp4'
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'audio/wav'
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'audio/mp3'
  return 'image/png'
}

function toDataUrl(bytes: Uint8Array): string {
  return `data:${mimeFromBytes(bytes)};base64,${Buffer.from(bytes).toString('base64')}`
}

export class RunningHubAdapter implements ProviderAdapter {
  private readonly fetcher: typeof fetch
  private readonly providerId: string
  private readonly now: () => Date
  private readonly timeoutMs: number
  private readonly signalForTimeout: (timeoutMs: number) => AbortSignal
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly stagingDir: string

  constructor(options: {
    apiKey: string
    baseUrl?: string
    providerId?: string
    fetcher?: typeof fetch
    now?: () => Date
    timeoutMs?: number
    signalForTimeout?: (timeoutMs: number) => AbortSignal
    stagingDir: string
  }) {
    this.apiKey = options.apiKey
    this.fetcher = options.fetcher ?? fetch
    this.providerId = options.providerId ?? 'runninghub'
    this.now = options.now ?? (() => new Date())
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.signalForTimeout = options.signalForTimeout ?? AbortSignal.timeout
    this.baseUrl = normalizedBaseUrl(options.baseUrl || 'https://www.runninghub.cn')
    this.stagingDir = options.stagingDir
  }

  private stagedPath(fileKey: string): string {
    return join(this.stagingDir, fileKey)
  }

  private async request(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const headers = new Headers(init.headers)
    if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
      headers.set('Content-Type', 'application/json')
    }

    const response = await this.fetcher(url, {
      ...init,
      headers,
      signal: operationSignal(this.timeoutMs, this.signalForTimeout, signal),
    })

    const raw = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`RunningHub HTTP ${response.status}: ${raw.slice(0, 200)}`)
    }

    if (!response.ok) {
      const message = (isRecord(parsed) && (parsed.msg || parsed.message)) as string || `HTTP ${response.status}`
      throw new ProviderRequestRejectedError(message)
    }

    return parsed
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    if (!this.apiKey.trim()) {
      throw new ProviderRequestRejectedError('RunningHub API Key 不能为空')
    }
    try {
      const res = await this.request(
        '/task/openapi/outputs',
        {
          method: 'POST',
          body: JSON.stringify({ apiKey: this.apiKey, taskId: 'connection-probe-test' }),
        },
        signal,
      )
      if (isRecord(res)) {
        const code = Number(res.code)
        if (code === 401 || code === 403 || String(res.msg || '').includes('key') || String(res.msg || '').includes('Key')) {
          throw new ProviderRequestRejectedError(String(res.msg || 'API Key 无效'))
        }
      }
    } catch (err) {
      if (err instanceof ProviderRequestRejectedError) throw err
    }
  }

  async syncCatalog(_signal?: AbortSignal): Promise<ProviderCatalog> {
    const fetchedAt = this.now().toISOString()
    return {
      providerId: this.providerId,
      version: `runninghub-catalog-${fetchedAt.slice(0, 10)}`,
      fetchedAt,
      stale: false,
      models: [
        {
          model: 'runninghub-flux-schnell',
          label: 'FLUX.1 Schnell (极速生图)',
          mediaType: 'image',
          channel: 1,
          qualityOptions: [
            { value: '1K', label: '1K 标准', pricing: { type: 'fixed_total', credits: 0 } },
            { value: '2K', label: '2K 高清', pricing: { type: 'fixed_total', credits: 0 } },
          ],
          aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
          countOptions: [1],
          durationOptions: [],
          modes: ['reference_image'],
          inputLimits: { images: 4, videos: 0, audios: 0 },
          raw: {},
        },
        {
          model: 'runninghub-flux-dev',
          label: 'FLUX.1 Dev (精细生图)',
          mediaType: 'image',
          channel: 1,
          qualityOptions: [
            { value: '1K', label: '1K 标准', pricing: { type: 'fixed_total', credits: 0 } },
            { value: '2K', label: '2K 超清', pricing: { type: 'fixed_total', credits: 0 } },
          ],
          aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
          countOptions: [1],
          durationOptions: [],
          modes: ['reference_image'],
          inputLimits: { images: 4, videos: 0, audios: 0 },
          raw: {},
        },
        {
          model: 'runninghub-kling-video',
          label: 'Kling 快手可灵视频 (RunningHub)',
          mediaType: 'video',
          channel: 2,
          qualityOptions: [
            { value: '720p', label: '720p 高清', pricing: { type: 'fixed_total', credits: 0 } },
            { value: '1080p', label: '1080p 超清', pricing: { type: 'fixed_total', credits: 0 } },
          ],
          aspectRatios: ['16:9', '9:16', '1:1'],
          countOptions: [1],
          durationOptions: [5, 10],
          modes: ['first_frame', 'last_frame', 'reference_image'],
          inputLimits: { images: 2, videos: 0, audios: 0 },
          raw: {},
        },
        {
          model: 'runninghub-minimax-video',
          label: 'MiniMax 海螺视频 (RunningHub)',
          mediaType: 'video',
          channel: 2,
          qualityOptions: [
            { value: '720p', label: '720p 高清', pricing: { type: 'fixed_total', credits: 0 } },
          ],
          aspectRatios: ['16:9', '9:16'],
          countOptions: [1],
          durationOptions: [6],
          modes: ['first_frame'],
          inputLimits: { images: 1, videos: 0, audios: 0 },
          raw: {},
        },
        {
          model: 'runninghub-luma-video',
          label: 'Luma Dream Machine (RunningHub)',
          mediaType: 'video',
          channel: 2,
          qualityOptions: [
            { value: '720p', label: '720p 高清', pricing: { type: 'fixed_total', credits: 0 } },
          ],
          aspectRatios: ['16:9', '9:16'],
          countOptions: [1],
          durationOptions: [5],
          modes: ['first_frame', 'last_frame'],
          inputLimits: { images: 2, videos: 0, audios: 0 },
          raw: {},
        },
      ],
    }
  }

  async presignReference(
    reference: LocalReference,
    _signal?: AbortSignal,
  ): Promise<PresignedUpload> {
    if (reference.size > REFERENCE_MAX_SIZE) {
      throw new Error(`File exceeds maximum reference size (${REFERENCE_MAX_SIZE} bytes)`)
    }
    const fileKey = randomUUID()
    return {
      fileKey,
      uploadUrl: `${STAGED_REF_PREFIX}${fileKey}`,
      method: 'PUT',
      headers: { 'Content-Type': reference.contentType },
      expiresAt: Date.now() + 600_000,
    }
  }

  async uploadReference(
    reference: LocalReference,
    grant: PresignedUpload,
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(this.stagingDir, { recursive: true })
    const target = this.stagedPath(grant.fileKey)
    const source = reference.openStream(signal)
    const out = createWriteStream(target)
    await pipeline(source, out, { signal })
  }

  async completeReference(
    fileKey: string,
    _signal?: AbortSignal,
  ): Promise<StagedReference> {
    const key = stagedKeyFromUrl(fileKey) ?? fileKey
    if (!FILE_KEY_PATTERN.test(key)) throw new Error('Invalid staged file key')
    return {
      url: `${STAGED_REF_PREFIX}${key}`,
    }
  }

  async createGeneration(
    request: GenerationRequest,
    references: StagedReference[],
    signal?: AbortSignal,
  ): Promise<string> {
    const isVideo = request.mediaType === 'video'
    const imageUrls: string[] = []

    for (const ref of references) {
      const key = stagedKeyFromUrl(ref.url)
      if (key) {
        try {
          const bytes = await readFile(this.stagedPath(key))
          imageUrls.push(toDataUrl(bytes))
        } catch {
          // ignore
        }
      } else if (ref.url.startsWith('http://') || ref.url.startsWith('https://') || ref.url.startsWith('data:')) {
        imageUrls.push(ref.url)
      }
    }

    const payload: Record<string, unknown> = {
      apiKey: this.apiKey,
      model: request.model,
      prompt: request.prompt,
      aspectRatio: request.aspectRatio || '1:1',
      size: request.aspectRatio || '1:1',
    }

    if (isVideo) {
      payload.duration = request.duration || 5
      payload.resolution = request.quality || '720p'
      if (imageUrls.length > 0) {
        payload.firstFrameImage = imageUrls[0]
        if (imageUrls.length > 1) {
          payload.lastFrameImage = imageUrls[1]
        }
      }
    } else {
      if (imageUrls.length > 0) {
        payload.imageUrls = imageUrls
        payload.referenceImages = imageUrls
      }
    }

    const endpoint = '/openapi/v2/task/openapi/create'
    const res = await this.request(
      endpoint,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      signal,
    )

    if (!isRecord(res)) {
      throw new ProviderRequestRejectedError('RunningHub 未返回有效数据')
    }

    const code = Number(res.code)
    if (code !== 0 && code !== 200) {
      const msg = String(res.msg || res.message || `Code ${code}`)
      throw new ProviderRequestRejectedError(`RunningHub 任务提交失败: ${msg}`, String(code))
    }

    const data = isRecord(res.data) ? res.data : res
    const taskId = String(data.taskId || data.task_id || data.id || '')
    if (!taskId) {
      throw new ProviderRequestRejectedError('RunningHub 未返回 taskId')
    }

    return taskId
  }

  async getGenerationStatus(
    taskIds: string[],
    signal?: AbortSignal,
  ): Promise<UpstreamTaskStatus[]> {
    const results: UpstreamTaskStatus[] = []

    for (const taskId of taskIds) {
      try {
        const res = await this.request(
          '/task/openapi/outputs',
          {
            method: 'POST',
            body: JSON.stringify({ apiKey: this.apiKey, taskId }),
          },
          signal,
        )

        if (!isRecord(res)) {
          results.push({ taskId, status: STATUS_RUNNING, progress: 30 })
          continue
        }

        const code = Number(res.code)
        if (code === 0) {
          const data = res.data
          let outputs: string[] = []
          if (Array.isArray(data)) {
            outputs = data.map((item) => (isRecord(item) ? String(item.fileUrl || item.url || '') : String(item))).filter(Boolean)
          } else if (isRecord(data)) {
            if (Array.isArray(data.outputs)) {
              outputs = data.outputs.map((item) => (isRecord(item) ? String(item.fileUrl || item.url || '') : String(item))).filter(Boolean)
            } else if (typeof data.fileUrl === 'string') {
              outputs = [data.fileUrl]
            }
          }
          results.push({
            taskId,
            status: STATUS_COMPLETE,
            progress: 100,
            outputs,
          })
        } else if (code === 805) {
          results.push({
            taskId,
            status: STATUS_FAILED,
            errorMessage: String(res.msg || 'RunningHub 任务生成失败'),
          })
        } else {
          results.push({
            taskId,
            status: STATUS_RUNNING,
            progress: code === 813 ? 10 : 50,
          })
        }
      } catch (error) {
        results.push({
          taskId,
          status: STATUS_FAILED,
          errorMessage: error instanceof Error ? error.message : '查询任务失败',
        })
      }
    }

    return results
  }

  async getGenerationDetail(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<UpstreamTaskStatus> {
    const statuses = await this.getGenerationStatus([taskId], signal)
    return statuses[0] || { taskId, status: STATUS_FAILED, errorMessage: 'Task status unavailable' }
  }
}
