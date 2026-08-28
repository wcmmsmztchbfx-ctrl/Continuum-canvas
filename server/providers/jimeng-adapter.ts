import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { GenerationRequest, ProviderCatalog } from '../../src/contracts/generation.ts'
import {
  ProviderRequestRejectedError,
  type LocalReference,
  type PresignedUpload,
  type StagedReference,
  type UpstreamTaskStatus,
  type ProviderAdapter,
} from './provider-adapter.ts'

const execFileAsync = promisify(execFile)

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

export class JimengAdapter implements ProviderAdapter {
  private readonly providerId: string
  private readonly now: () => Date
  private readonly stagingDir: string
  private readonly cliPath: string

  constructor(options: {
    apiKey?: string
    baseUrl?: string
    providerId?: string
    now?: () => Date
    stagingDir: string
    cliPath?: string
  }) {
    this.providerId = options.providerId ?? 'jimeng'
    this.now = options.now ?? (() => new Date())
    this.stagingDir = options.stagingDir
    this.cliPath = options.cliPath || options.baseUrl || 'dreamina'
  }

  private stagedPath(fileKey: string): string {
    return join(this.stagingDir, fileKey)
  }

  async testConnection(_signal?: AbortSignal): Promise<void> {
    try {
      const { stdout } = await execFileAsync(this.cliPath, ['user_credit'], { timeout: 10_000 })
      if (!stdout || stdout.includes('login fail') || stdout.includes('未登录')) {
        throw new ProviderRequestRejectedError('即梦 CLI 尚未登录，请先运行【登录即梦CLI】完成网页扫码/验证码授权')
      }
    } catch (err) {
      if (err instanceof ProviderRequestRejectedError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('not recognized')) {
        throw new ProviderRequestRejectedError('未检测到 dreamina CLI，请先执行【安装即梦CLI.bat】安装依赖')
      }
      throw new ProviderRequestRejectedError(`即梦 CLI 检测异常: ${msg}`)
    }
  }

  async syncCatalog(_signal?: AbortSignal): Promise<ProviderCatalog> {
    const fetchedAt = this.now().toISOString()
    return {
      providerId: this.providerId,
      version: `jimeng-catalog-${fetchedAt.slice(0, 10)}`,
      fetchedAt,
      stale: false,
      models: [
        {
          model: 'jimeng-image-v3.0',
          label: '即梦 3.0 高清生图 (Dreamina 会员/积分)',
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
          model: 'jimeng-video-v3.0',
          label: '即梦 3.0 视频生成 (Dreamina 会员/积分)',
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
          model: 'jimeng-image-v2.1',
          label: '即梦 2.1 极速版生图',
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

  private pendingTasks = new Map<string, { status: number; outputs?: string[]; error?: string }>()

  async createGeneration(
    request: GenerationRequest,
    _references: StagedReference[],
    _signal?: AbortSignal,
  ): Promise<string> {
    const taskId = `jimeng-task-${randomUUID()}`
    const isVideo = request.mediaType === 'video'
    const command = isVideo ? 'text2video' : 'text2image'
    const args = [command, '--prompt', request.prompt, '--ratio', request.aspectRatio || '1:1']

    this.pendingTasks.set(taskId, { status: STATUS_RUNNING })

    // Execute in background
    execFileAsync(this.cliPath, args, { timeout: 300_000 })
      .then(({ stdout }) => {
        const urls = stdout.match(/https?:\/\/[^\s"']+/g) || []
        this.pendingTasks.set(taskId, {
          status: STATUS_COMPLETE,
          outputs: urls,
        })
      })
      .catch((err) => {
        this.pendingTasks.set(taskId, {
          status: STATUS_FAILED,
          error: err instanceof Error ? err.message : String(err),
        })
      })

    return taskId
  }

  async getGenerationStatus(
    taskIds: string[],
    _signal?: AbortSignal,
  ): Promise<UpstreamTaskStatus[]> {
    const results: UpstreamTaskStatus[] = []
    for (const taskId of taskIds) {
      const task = this.pendingTasks.get(taskId)
      if (!task) {
        results.push({ taskId, status: STATUS_FAILED, errorMessage: '任务未找到' })
        continue
      }
      results.push({
        taskId,
        status: task.status,
        progress: task.status === STATUS_COMPLETE ? 100 : 50,
        outputs: task.outputs,
        errorMessage: task.error,
      })
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
