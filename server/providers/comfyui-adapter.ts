import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
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

export class ComfyUIAdapter implements ProviderAdapter {
  private readonly fetcher: typeof fetch
  private readonly providerId: string
  private readonly now: () => Date
  private readonly timeoutMs: number
  private readonly signalForTimeout: (timeoutMs: number) => AbortSignal
  private readonly baseUrl: string
  private readonly stagingDir: string

  constructor(options: {
    apiKey?: string
    baseUrl?: string
    providerId?: string
    fetcher?: typeof fetch
    now?: () => Date
    timeoutMs?: number
    signalForTimeout?: (timeoutMs: number) => AbortSignal
    stagingDir: string
  }) {
    this.fetcher = options.fetcher ?? fetch
    this.providerId = options.providerId ?? 'comfyui'
    this.now = options.now ?? (() => new Date())
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.signalForTimeout = options.signalForTimeout ?? AbortSignal.timeout
    this.baseUrl = normalizedBaseUrl(options.baseUrl || 'http://127.0.0.1:8188')
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
      throw new Error(`ComfyUI HTTP ${response.status}: ${raw.slice(0, 200)}`)
    }

    if (!response.ok) {
      const message = (isRecord(parsed) && (parsed.error || parsed.message)) as string || `HTTP ${response.status}`
      throw new ProviderRequestRejectedError(message)
    }

    return parsed
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    try {
      await this.request('/system_stats', { method: 'GET' }, signal)
    } catch (err) {
      throw new ProviderRequestRejectedError(
        `无法连接到本地 ComfyUI (${this.baseUrl})，请确认已启动 ComfyUI 服务（如 run_nvidia_gpu.bat）`,
      )
    }
  }

  async syncCatalog(_signal?: AbortSignal): Promise<ProviderCatalog> {
    const fetchedAt = this.now().toISOString()
    return {
      providerId: this.providerId,
      version: `comfyui-catalog-${fetchedAt.slice(0, 10)}`,
      fetchedAt,
      stale: false,
      models: [
        {
          model: 'comfyui-flux-local',
          label: 'FLUX.1 本地工作流 (ComfyUI 0 成本)',
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
          model: 'comfyui-sdxl-local',
          label: 'SDXL 1.0 本地工作流',
          mediaType: 'image',
          channel: 1,
          qualityOptions: [
            { value: '1K', label: '1K 标准', pricing: { type: 'fixed_total', credits: 0 } },
          ],
          aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
          countOptions: [1],
          durationOptions: [],
          modes: ['reference_image'],
          inputLimits: { images: 2, videos: 0, audios: 0 },
          raw: {},
        },
        {
          model: 'comfyui-animatediff-local',
          label: 'AnimateDiff 本地生视频 (ComfyUI)',
          mediaType: 'video',
          channel: 2,
          qualityOptions: [
            { value: '720p', label: '720p 高清', pricing: { type: 'fixed_total', credits: 0 } },
          ],
          aspectRatios: ['16:9', '9:16', '1:1'],
          countOptions: [1],
          durationOptions: [4, 8],
          modes: ['first_frame'],
          inputLimits: { images: 1, videos: 0, audios: 0 },
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
    _references: StagedReference[],
    signal?: AbortSignal,
  ): Promise<string> {
    const clientId = `continuum_${randomUUID()}`
    const promptPayload: Record<string, unknown> = {
      '3': {
        inputs: {
          seed: Math.floor(Math.random() * 1_000_000),
          steps: 20,
          cfg: 8,
          sampler_name: 'euler',
          scheduler: 'normal',
          denoise: 1,
          model: ['4', 0],
          positive: ['6', 0],
          negative: ['7', 0],
          latent_image: ['5', 0],
        },
        class_type: 'KSampler',
      },
      '4': {
        inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' },
        class_type: 'CheckpointLoaderSimple',
      },
      '5': {
        inputs: { width: 512, height: 512, batch_size: 1 },
        class_type: 'EmptyLatentImage',
      },
      '6': {
        inputs: { text: request.prompt, clip: ['4', 1] },
        class_type: 'CLIPTextEncode',
      },
      '7': {
        inputs: { text: 'text, watermark, blur, low quality', clip: ['4', 1] },
        class_type: 'CLIPTextEncode',
      },
      '8': {
        inputs: { samples: ['3', 0], vae: ['4', 2] },
        class_type: 'VAEDecode',
      },
      '9': {
        inputs: { filename_prefix: 'Continuum', images: ['8', 0] },
        class_type: 'SaveImage',
      },
    }

    const res = await this.request(
      '/prompt',
      {
        method: 'POST',
        body: JSON.stringify({
          client_id: clientId,
          prompt: promptPayload,
        }),
      },
      signal,
    )

    if (!isRecord(res)) {
      throw new ProviderRequestRejectedError('ComfyUI 未返回有效响应')
    }

    const promptId = String(res.prompt_id || res.id || '')
    if (!promptId) {
      throw new ProviderRequestRejectedError('ComfyUI 未返回 prompt_id')
    }

    return promptId
  }

  async getGenerationStatus(
    taskIds: string[],
    signal?: AbortSignal,
  ): Promise<UpstreamTaskStatus[]> {
    const results: UpstreamTaskStatus[] = []

    for (const taskId of taskIds) {
      try {
        const res = await this.request(
          `/history/${encodeURIComponent(taskId)}`,
          { method: 'GET' },
          signal,
        )

        if (!isRecord(res) || !res[taskId]) {
          results.push({ taskId, status: STATUS_RUNNING, progress: 30 })
          continue
        }

        const taskHistory = res[taskId] as Record<string, unknown>
        const outputsObj = isRecord(taskHistory.outputs) ? taskHistory.outputs : {}
        const outputUrls: string[] = []

        for (const nodeId of Object.keys(outputsObj)) {
          const nodeOutput = outputsObj[nodeId] as Record<string, unknown>
          if (Array.isArray(nodeOutput.images)) {
            for (const img of nodeOutput.images) {
              if (isRecord(img) && typeof img.filename === 'string') {
                const subfolder = typeof img.subfolder === 'string' ? img.subfolder : ''
                const type = typeof img.type === 'string' ? img.type : 'output'
                const viewUrl = `${this.baseUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`
                outputUrls.push(viewUrl)
              }
            }
          }
        }

        if (outputUrls.length > 0) {
          results.push({
            taskId,
            status: STATUS_COMPLETE,
            progress: 100,
            outputs: outputUrls,
          })
        } else {
          results.push({
            taskId,
            status: STATUS_RUNNING,
            progress: 60,
          })
        }
      } catch (error) {
        results.push({
          taskId,
          status: STATUS_FAILED,
          errorMessage: error instanceof Error ? error.message : '查询 ComfyUI 历史失败',
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
