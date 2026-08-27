import { createHash, randomUUID } from 'node:crypto'
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
  rejectedRequest,
} from './request-utils.ts'

const REFERENCE_MAX_SIZE = 50 * 1024 * 1024
const STAGED_REF_PREFIX = 'https://local.invalid/ref/'
const FILE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const STATUS_QUEUED = 1
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

export class MiniMaxAdapter implements ProviderAdapter {
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
    this.providerId = options.providerId ?? 'minimax'
    this.now = options.now ?? (() => new Date())
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.signalForTimeout = options.signalForTimeout ?? AbortSignal.timeout
    this.baseUrl = normalizedBaseUrl(options.baseUrl || 'https://api.minimaxi.com')
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
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    const response = await this.fetcher(url, {
      ...init,
      headers,
      signal: operationSignal(this.timeoutMs, this.signalForTimeout, signal),
    })

    if (!response.ok) {
      let body: unknown
      try {
        body = await response.json()
      } catch {
        try {
          body = await response.text()
        } catch {
          body = undefined
        }
      }
      throw rejectedRequest(body, String(response.status))
    }

    try {
      return await response.json()
    } catch {
      return undefined
    }
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    try {
      // Query a dummy task to test Bearer auth
      await this.request('/v2/query/video_generation/000000000000000', {}, signal)
    } catch (error) {
      if (error instanceof ProviderRequestRejectedError) {
        if (
          error.providerCode === '401' ||
          error.providerCode === '1004' ||
          /login fail|unauthorized|invalid.*api.*key|auth/i.test(error.message)
        ) {
          throw new ProviderRequestRejectedError('API Key 无效或鉴权失败 (401)，请检查 Key 是否正确')
        }
        if (
          error.providerCode === '400' ||
          error.providerCode === '404' ||
          error.providerCode === '2013' ||
          /task|resource|not found|not_found/i.test(error.message)
        ) {
          return
        }
      }
      throw error
    }
  }

  async syncCatalog(signal?: AbortSignal): Promise<ProviderCatalog> {
    await this.testConnection(signal)

    const catalog: ProviderCatalog = {
      providerId: this.providerId,
      version: createHash('sha256').update('minimax-h3-v2').digest('hex'),
      fetchedAt: this.now().toISOString(),
      stale: false,
      models: [
        {
          model: 'MiniMax-H3',
          title: 'MiniMax-H3',
          label: 'MiniMax-H3 (海螺3代视频)',
          mediaType: 'video',
          channel: 'video',
          qualityOptions: [
            {
              value: '2K',
              label: '2K 超清直出',
              pricing: { type: 'fixed_total', credits: 24 },
            },
            {
              value: '768P',
              label: '768P 高清',
              pricing: { type: 'fixed_total', credits: 12 },
            },
          ],
          aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
          countOptions: [1],
          countRange: { min: 1, max: 1, options: [1] },
          durationOptions: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          durationRange: { min: 4, max: 15, options: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
          modes: ['text2video', 'image2video', 'frames2video'],
          inputLimits: {
            images: 9,
            videos: 0,
            audios: 0,
          },
          raw: {},
        },
      ],
    }

    return catalog
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
    if (reference.size > REFERENCE_MAX_SIZE) throw new Error('Reference exceeds the allowed limit (50MB)')
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

  async createGeneration(
    request: GenerationRequest,
    references: StagedReference[],
    signal?: AbortSignal,
  ): Promise<string> {
    const content: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: request.prompt || '生成一段电影级镜头视频',
      },
    ]

    const stagedImageUrls: string[] = []
    for (const ref of references) {
      let resolvedUrl = ref.url
      const key = stagedKeyFromUrl(ref.url)
      if (key) {
        try {
          const bytes = await readFile(this.stagedPath(key))
          resolvedUrl = toDataUrl(bytes)
        } catch {
          // ignore
        }
      }
      stagedImageUrls.push(resolvedUrl)
    }

    const mode = request.mode ?? 'text2video'

    if (mode === 'frames2video' && stagedImageUrls.length >= 2) {
      content.push({
        type: 'image_url',
        image_url: { url: stagedImageUrls[0] },
        role: 'first_frame',
      })
      content.push({
        type: 'image_url',
        image_url: { url: stagedImageUrls[1] },
        role: 'last_frame',
      })
    } else if (mode === 'image2video' || stagedImageUrls.length > 0) {
      for (const imgUrl of stagedImageUrls.slice(0, 9)) {
        content.push({
          type: 'image_url',
          image_url: { url: imgUrl },
          role: 'reference_image',
        })
      }
    }

    const resolution = request.quality === '768P' ? '768P' : '2K'
    const duration = Math.min(15, Math.max(4, Math.round(request.duration ?? 5)))
    const ratio = content.some((c) => c.role === 'first_frame' || c.role === 'last_frame')
      ? 'adaptive'
      : request.aspectRatio && request.aspectRatio !== 'Auto'
        ? request.aspectRatio
        : '16:9'

    const payload = {
      model: 'MiniMax-H3',
      content,
      resolution,
      duration,
      ratio,
      aigc_watermark: false,
    }

    const response = await this.request('/v2/video_generation', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, signal)

    if (isRecord(response) && typeof response.task_id === 'string') {
      return response.task_id
    }

    throw new ProviderRequestRejectedError('MiniMax 未返回有效的任务 ID (task_id)')
  }

  async getGenerationStatus(taskIds: string[], signal?: AbortSignal): Promise<UpstreamTaskStatus[]> {
    return Promise.all(taskIds.map((id) => this.getGenerationDetail(id, signal)))
  }

  async getGenerationDetail(taskId: string, signal?: AbortSignal): Promise<UpstreamTaskStatus> {
    const response = await this.request(`/v2/query/video_generation/${encodeURIComponent(taskId)}`, {}, signal)

    if (isRecord(response) && isRecord(response.task)) {
      const task = response.task as {
        id: string
        status: string
        content?: { url?: string }
        error?: { code?: string; message?: string }
      }

      if (task.status === 'succeeded' && task.content?.url) {
        return {
          taskId,
          status: STATUS_COMPLETE,
          progress: 100,
          outputs: [task.content.url],
        }
      }

      if (task.status === 'failed') {
        return {
          taskId,
          status: STATUS_FAILED,
          errorCode: task.error?.code ?? '1000',
          errorMessage: task.error?.message ?? 'MiniMax 视频生成失败',
        }
      }

      if (task.status === 'cancelled') {
        return {
          taskId,
          status: STATUS_FAILED,
          errorCode: 'cancelled',
          errorMessage: '任务已被取消',
        }
      }

      return {
        taskId,
        status: task.status === 'running' ? STATUS_RUNNING : STATUS_QUEUED,
        progress: task.status === 'running' ? 50 : 10,
      }
    }

    throw new ProviderRequestRejectedError(`查询 MiniMax 任务详情失败：无效的任务响应格式`)
  }
}