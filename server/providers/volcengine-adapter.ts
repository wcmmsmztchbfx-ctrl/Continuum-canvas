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

export class VolcengineAdapter implements ProviderAdapter {
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
    this.providerId = options.providerId ?? 'volcengine'
    this.now = options.now ?? (() => new Date())
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.signalForTimeout = options.signalForTimeout ?? AbortSignal.timeout
    this.baseUrl = normalizedBaseUrl(options.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3')
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
    headers.set('Authorization', `Bearer ${this.apiKey}`)
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
      throw new Error(`Volcengine HTTP ${response.status}: ${raw.slice(0, 200)}`)
    }

    if (!response.ok) {
      const message = (isRecord(parsed) && isRecord(parsed.error) && parsed.error.message) as string
        || (isRecord(parsed) && (parsed.message || parsed.msg)) as string
        || `HTTP ${response.status}`
      throw new ProviderRequestRejectedError(message)
    }

    return parsed
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    if (!this.apiKey.trim()) {
      throw new ProviderRequestRejectedError('火山引擎 / 字节方舟 API Key 不能为空')
    }
    await this.request('/models', { method: 'GET' }, signal)
  }

  async syncCatalog(_signal?: AbortSignal): Promise<ProviderCatalog> {
    const fetchedAt = this.now().toISOString()
    return {
      providerId: this.providerId,
      version: `volcengine-catalog-${fetchedAt.slice(0, 10)}`,
      fetchedAt,
      stale: false,
      models: [
        {
          model: 'doubao-seedance-2.0',
          label: 'Doubao Seedance 2.0 视频生成 (字节跳动)',
          mediaType: 'video',
          channel: 2,
          qualityOptions: [
            { value: '720p', label: '720p 高清', pricing: { type: 'fixed_total', credits: 0 } },
            { value: '1080p', label: '1080p 超清', pricing: { type: 'fixed_total', credits: 0 } },
          ],
          aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
          countOptions: [1],
          durationOptions: [3, 5, 10],
          modes: ['first_frame', 'last_frame', 'reference_image'],
          inputLimits: { images: 2, videos: 0, audios: 0 },
          raw: {},
        },
        {
          model: 'cv_seedance_general',
          label: 'Seedance 通用生视频 (火山引擎)',
          mediaType: 'video',
          channel: 2,
          qualityOptions: [
            { value: '720p', label: '720p 高清', pricing: { type: 'fixed_total', credits: 0 } },
          ],
          aspectRatios: ['16:9', '9:16', '1:1'],
          countOptions: [1],
          durationOptions: [5],
          modes: ['first_frame', 'last_frame'],
          inputLimits: { images: 2, videos: 0, audios: 0 },
          raw: {},
        },
        {
          model: 'doubao-image-generation',
          label: 'Doubao 豆包文生图 / 图生图',
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
          model: 'doubao-image-edit',
          label: 'Doubao 图像局部编辑 / 扩图',
          mediaType: 'image',
          channel: 1,
          qualityOptions: [
            { value: '1K', label: '1K 标准', pricing: { type: 'fixed_total', credits: 0 } },
            { value: '2K', label: '2K 高清', pricing: { type: 'fixed_total', credits: 0 } },
          ],
          aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
          countOptions: [1],
          durationOptions: [],
          modes: ['reference_image'],
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

    if (isVideo) {
      // Submit video generation task to Volcengine Ark: POST /contents/generations/tasks
      const contentList: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
        { type: 'text', text: request.prompt },
      ]
      if (imageUrls.length > 0) {
        contentList.push({ type: 'image_url', image_url: { url: imageUrls[0] } })
        if (imageUrls.length > 1) {
          contentList.push({ type: 'image_url', image_url: { url: imageUrls[1] } })
        }
      }

      const res = await this.request(
        '/contents/generations/tasks',
        {
          method: 'POST',
          body: JSON.stringify({
            model: request.model,
            content: contentList,
            duration: request.duration || 5,
            aspect_ratio: request.aspectRatio || '16:9',
          }),
        },
        signal,
      )

      if (!isRecord(res)) throw new ProviderRequestRejectedError('火山方舟未返回有效响应')
      const taskId = String(res.id || res.task_id || '')
      if (!taskId) throw new ProviderRequestRejectedError('火山方舟未返回任务 ID')
      return taskId
    } else {
      // Submit image generation task to Volcengine Ark: POST /images/generations
      const res = await this.request(
        '/images/generations',
        {
          method: 'POST',
          body: JSON.stringify({
            model: request.model,
            prompt: request.prompt,
            size: request.aspectRatio === '16:9' ? '1920x1080' : request.aspectRatio === '9:16' ? '1080x1920' : '1024x1024',
            response_format: 'url',
            ...(imageUrls.length > 0 ? { image: imageUrls[0] } : {}),
          }),
        },
        signal,
      )

      if (!isRecord(res)) throw new ProviderRequestRejectedError('火山方舟未返回有效响应')
      // If task_id is returned, return taskId; if direct data array returned, return a synthesized complete taskId
      if (typeof res.id === 'string' && res.id) return res.id
      if (Array.isArray(res.data) && res.data.length > 0) {
        const directTaskId = `volc-direct-${randomUUID()}`
        this.directOutputs.set(directTaskId, res.data.map((item) => (isRecord(item) ? String(item.url || item.b64_json || '') : String(item))).filter(Boolean))
        return directTaskId
      }
      throw new ProviderRequestRejectedError('火山方舟未返回图片结果或任务 ID')
    }
  }

  private directOutputs = new Map<string, string[]>()

  async getGenerationStatus(
    taskIds: string[],
    signal?: AbortSignal,
  ): Promise<UpstreamTaskStatus[]> {
    const results: UpstreamTaskStatus[] = []

    for (const taskId of taskIds) {
      if (this.directOutputs.has(taskId)) {
        const outputs = this.directOutputs.get(taskId)!
        this.directOutputs.delete(taskId)
        results.push({
          taskId,
          status: STATUS_COMPLETE,
          progress: 100,
          outputs,
        })
        continue
      }

      try {
        const res = await this.request(
          `/contents/generations/tasks/${encodeURIComponent(taskId)}`,
          { method: 'GET' },
          signal,
        )

        if (!isRecord(res)) {
          results.push({ taskId, status: STATUS_RUNNING, progress: 30 })
          continue
        }

        const taskStatus = String(res.status || '').toUpperCase()
        if (taskStatus === 'SUCCEEDED' || taskStatus === 'SUCCESS') {
          const content = isRecord(res.content) ? res.content : isRecord(res.result) ? res.result : res
          let outputs: string[] = []
          if (Array.isArray(res.content)) {
            outputs = res.content.map((item) => {
              if (isRecord(item)) {
                if (typeof item.video_url === 'string') return item.video_url
                if (isRecord(item.video_url) && typeof item.video_url.url === 'string') return item.video_url.url
                if (typeof item.image_url === 'string') return item.image_url
                if (isRecord(item.image_url) && typeof item.image_url.url === 'string') return item.image_url.url
              }
              return ''
            }).filter(Boolean)
          } else if (typeof content.video_url === 'string') {
            outputs = [content.video_url]
          } else if (typeof content.image_url === 'string') {
            outputs = [content.image_url]
          }

          results.push({
            taskId,
            status: STATUS_COMPLETE,
            progress: 100,
            outputs,
          })
        } else if (taskStatus === 'FAILED' || taskStatus === 'ERROR') {
          const errorMsg = (isRecord(res.error) && res.error.message) as string || '火山方舟任务失败'
          results.push({
            taskId,
            status: STATUS_FAILED,
            errorMessage: errorMsg,
          })
        } else {
          results.push({
            taskId,
            status: STATUS_RUNNING,
            progress: 50,
          })
        }
      } catch (error) {
        results.push({
          taskId,
          status: STATUS_FAILED,
          errorMessage: error instanceof Error ? error.message : '查询火山方舟任务失败',
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
