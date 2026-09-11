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
} from './request-utils.ts'

const REFERENCE_MAX_SIZE = 200 * 1024 * 1024
const STAGED_REF_PREFIX = 'https://local.invalid/ref/'
const FILE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const STATUS_QUEUED = 1
const STATUS_RUNNING = 1
const STATUS_COMPLETE = 3
const STATUS_FAILED = 4

const VIDEO_MODEL_ALIASES: Record<string, string> = {
  'seedance 2.0 fast vip': 'seedance2.0_fast_vision',
  'seedance 2.0 fast vip (极速推理)': 'seedance2.0_fast_vision',
  'seedance 2.0 vip': 'seedance2.0_vision',
  'seedance 2.0 vip (效果无损)': 'seedance2.0_vision',
  'seedance 2.0': 'seedance2.0_vision',
  'seedance_2.0': 'seedance2.0_vision',
  'seedance2.0': 'seedance2.0_vision',
  'seedance 2.5': 'Seedance_2.5',
}

function normalizeVideoModel(value: string | undefined): string {
  const model = value?.trim() || 'seedance2.0_fast_vision'
  return VIDEO_MODEL_ALIASES[model.toLowerCase()] ?? model
}

function stagedKeyFromUrl(url: string | undefined): string | undefined {
  if (!url || !url.startsWith(STAGED_REF_PREFIX)) return undefined
  const key = url.slice(STAGED_REF_PREFIX.length)
  return FILE_KEY_PATTERN.test(key) ? key : undefined
}

function mimeFromBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'video/mp4'
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'audio/wav'
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x43 && bytes[2] === 0x33) return 'audio/mp3'
  return 'image/png'
}

function extractXiaoYunqueText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim()
  if (Array.isArray(raw)) {
    const parts: string[] = []
    for (const item of raw) {
      if (typeof item === 'string' && item.trim()) {
        parts.push(item.trim())
      } else if (isRecord(item)) {
        const subType = typeof item.sub_type === 'string' ? item.sub_type : ''
        if (
          subType === 'biz/x_data_prompt_text' ||
          subType === 'biz/general_agent_settings' ||
          subType.includes('artifact_slots') ||
          subType.includes('tool_call') ||
          subType.includes('x_data_image') ||
          subType.includes('x_data_video') ||
          subType.includes('upload')
        ) {
          continue
        }
        if (typeof item.data === 'string' && item.data.trim()) {
          try {
            const parsed = JSON.parse(item.data) as unknown
            if (isRecord(parsed) && typeof parsed.content === 'string' && parsed.content.trim()) {
              parts.push(parsed.content.trim())
              continue
            }
            if (
              isRecord(parsed) &&
              (typeof parsed.questionnaire_id === 'string' || typeof parsed.questionnaireId === 'string') &&
              Array.isArray(parsed.questions)
            ) {
              parts.push(item.data.trim())
              continue
            }
            // Structured transport data is metadata, not assistant prose.
            continue
          } catch {
            parts.push(item.data.trim())
          }
        } else if (typeof item.text === 'string' && item.text.trim()) {
          parts.push(item.text.trim())
        } else if (typeof item.content === 'string' && item.content.trim()) {
          parts.push(item.content.trim())
        }
      }
    }
    return parts.join('\n').trim()
  }
  return ''
}

export class XiaoYunqueAdapter implements ProviderAdapter {
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
    this.apiKey = options.apiKey.trim()
    this.fetcher = options.fetcher ?? fetch
    this.providerId = options.providerId ?? 'xiaoyunque'
    this.now = options.now ?? (() => new Date())
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.signalForTimeout = options.signalForTimeout ?? AbortSignal.timeout
    this.baseUrl = normalizedBaseUrl(options.baseUrl || 'https://xyq.jianying.com')
    this.stagingDir = options.stagingDir
  }

  private stagedPath(fileKey: string): string {
    return join(this.stagingDir, fileKey)
  }

  private async requestJson(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const combinedSignal = operationSignal(this.timeoutMs, this.signalForTimeout, signal)

    const response = await this.fetcher(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    })

    if (!response.ok) {
      throw new Error(`小云雀服务返回异常状态码: HTTP ${response.status} ${response.statusText}`)
    }

    const payload = (await response.json()) as unknown
    if (!isRecord(payload)) {
      throw new Error('小云雀返回了无效的数据格式')
    }
    return payload
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    const probe = await this.requestJson(
      '/api/biz/v1/skill/get_thread',
      { thread_id: 'probe_test', run_id: 'probe_test', after_seq: 0 },
      signal,
    )

    // ret === "2" 表示 "未查询到有效的Ak明细"，说明 Key 无效
    if (probe.ret === '2' || probe.ret === 2) {
      throw new ProviderRequestRejectedError(
        typeof probe.errmsg === 'string' ? probe.errmsg : '未查询到有效的小云雀 AccessKey',
        'invalid_ak',
      )
    }

    // ret === "0" 或 ret === "5" (获取会话失败，但AK有效) 都说明 AK 通过了身份校验
    if (probe.ret !== '0' && probe.ret !== 0 && probe.ret !== '5' && probe.ret !== 5) {
      throw new ProviderRequestRejectedError(
        typeof probe.errmsg === 'string' ? probe.errmsg : '小云雀连接探测失败',
        String(probe.ret),
      )
    }
  }

  async syncCatalog(signal?: AbortSignal): Promise<ProviderCatalog> {
    void signal
    const videoQualityOptions = [
      { value: '480p', label: '480P 流畅', pricing: { type: 'fixed_total' as const, credits: 5 } },
      { value: '720p', label: '720P 高清', pricing: { type: 'fixed_total' as const, credits: 10 } },
      { value: '1080p', label: '1080P 超清', pricing: { type: 'fixed_total' as const, credits: 15 } },
    ]
    const imageQualityOptions = [
      { value: '1k', label: '1K 标清', pricing: { type: 'fixed_total' as const, credits: 3 } },
      { value: '2k', label: '2K 高清', pricing: { type: 'fixed_total' as const, credits: 5 } },
      { value: '4k', label: '4K 超清', pricing: { type: 'fixed_total' as const, credits: 8 } },
    ]
    const videoAspectRatios = ['adaptive', '16:9', '21:9', '9:16', '4:3', '3:4', '1:1']
    const videoDurations = [4, 5, 10, 15]

    const catalog: ProviderCatalog = {
      providerId: this.providerId,
      version: createHash('sha256').update('xiaoyunque-official-v1').digest('hex'),
      fetchedAt: this.now().toISOString(),
      stale: false,
      models: [
        {
          model: 'seedance2.0_fast_vision',
          title: 'Seedance 2.0 Fast VIP',
          label: 'Seedance 2.0 Fast VIP (极速推理)',
          mediaType: 'video',
          channel: 'video',
          qualityOptions: videoQualityOptions,
          aspectRatios: videoAspectRatios,
          countOptions: [1],
          countRange: { min: 1, max: 1, options: [1] },
          durationOptions: videoDurations,
          durationRange: { min: 4, max: 15, options: videoDurations },
          modes: ['text2video', 'image2video', 'video2video'],
          inputLimits: { images: 4, videos: 2, audios: 1 },
          raw: {
            badge: 'Fast VIP',
            description: '小云雀官方极速推理通道，响应迅捷，单次消耗 15~45 积分',
          },
        },
        {
          model: 'seedance2.0_vision',
          title: 'Seedance 2.0 VIP',
          label: 'Seedance 2.0 VIP (效果无损)',
          mediaType: 'video',
          channel: 'video',
          qualityOptions: videoQualityOptions,
          aspectRatios: videoAspectRatios,
          countOptions: [1],
          countRange: { min: 1, max: 1, options: [1] },
          durationOptions: videoDurations,
          durationRange: { min: 4, max: 15, options: videoDurations },
          modes: ['text2video', 'image2video', 'video2video'],
          inputLimits: { images: 4, videos: 2, audios: 1 },
          raw: {
            badge: 'VIP',
            description: '小云雀官方效果无损通道，细节极致还原，单次消耗 60~90 积分',
          },
        },
        {
          model: 'Seedance_2.5',
          title: 'Seedance 2.5',
          label: 'Seedance 2.5 (官方最新旗舰)',
          mediaType: 'video',
          channel: 'video',
          qualityOptions: videoQualityOptions,
          aspectRatios: videoAspectRatios,
          countOptions: [1],
          countRange: { min: 1, max: 1, options: [1] },
          durationOptions: videoDurations,
          durationRange: { min: 4, max: 15, options: videoDurations },
          modes: ['text2video', 'image2video', 'video2video'],
          inputLimits: { images: 4, videos: 2, audios: 1 },
          raw: {
            badge: '官方旗舰',
            description: '新一代高动态多机位视频生成，具备极强光影表现与镜头质感',
          },
        },
        {
          model: 'Seedance_2.0_mini',
          title: 'Seedance 2.0 Mini',
          label: 'Seedance 2.0 Mini (轻量极速)',
          mediaType: 'video',
          channel: 'video',
          qualityOptions: videoQualityOptions,
          aspectRatios: videoAspectRatios,
          countOptions: [1],
          countRange: { min: 1, max: 1, options: [1] },
          durationOptions: videoDurations,
          durationRange: { min: 4, max: 15, options: videoDurations },
          modes: ['text2video', 'image2video', 'video2video'],
          inputLimits: { images: 4, videos: 2, audios: 1 },
          raw: {
            badge: '轻量极速',
            description: '低能耗秒级极速渲染通道',
          },
        },
        {
          model: 'seedream_5.0_pro',
          title: 'Seedream 5.0 Pro',
          label: 'Seedream 5.0 Pro (超清设计)',
          mediaType: 'image',
          channel: 'image',
          qualityOptions: imageQualityOptions,
          aspectRatios: videoAspectRatios,
          countOptions: [1, 2, 4],
          countRange: { min: 1, max: 4, options: [1, 2, 4] },
          durationOptions: [],
          durationRange: { min: 0, max: 0, options: [] },
          modes: ['text2image', 'image2image'],
          inputLimits: { images: 4, videos: 0, audios: 0 },
          raw: {
            badge: '超清4K',
            description: '小云雀官方旗舰图像设计模型，支持 2K/4K 超清画质，单次消耗 8 积分',
          },
        },
        {
          model: 'seedream_5.0',
          title: 'Seedream 5.0',
          label: 'Seedream 5.0 (标准绘图)',
          mediaType: 'image',
          channel: 'image',
          qualityOptions: imageQualityOptions,
          aspectRatios: videoAspectRatios,
          countOptions: [1, 2, 4],
          countRange: { min: 1, max: 4, options: [1, 2, 4] },
          durationOptions: [],
          durationRange: { min: 0, max: 0, options: [] },
          modes: ['text2image', 'image2image'],
          inputLimits: { images: 4, videos: 0, audios: 0 },
          raw: {
            badge: '标准绘图',
            description: '小云雀官方标准绘图大模型，单次消耗 5~6 积分',
          },
        },
        {
          model: 'nova_pro',
          title: 'Nova Pro',
          label: 'Nova Pro (拟真画风)',
          mediaType: 'image',
          channel: 'image',
          qualityOptions: imageQualityOptions,
          aspectRatios: videoAspectRatios,
          countOptions: [1, 2, 4],
          countRange: { min: 1, max: 4, options: [1, 2, 4] },
          durationOptions: [],
          durationRange: { min: 0, max: 0, options: [] },
          modes: ['text2image', 'image2image'],
          inputLimits: { images: 4, videos: 0, audios: 0 },
          raw: {
            badge: '拟真设计',
            description: '超拟真视觉设计大模型',
          },
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
    if (reference.size > REFERENCE_MAX_SIZE) throw new Error('Reference exceeds the allowed limit (200MB)')
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

  async uploadAsset(
    bytes: Uint8Array,
    filename: string,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const url = `${this.baseUrl}/api/biz/v1/skill/upload_file`
    const combinedSignal = operationSignal(this.timeoutMs, this.signalForTimeout, signal)

    const formData = new FormData()
    formData.append('accessKey', this.apiKey)
    formData.append('file', new Blob([bytes], { type: mimeType }), filename)

    const response = await this.fetcher(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: formData,
      signal: combinedSignal,
    })

    if (!response.ok) {
      throw new Error(`上传素材到小云雀失败: HTTP ${response.status}`)
    }

    const payload = (await response.json()) as unknown
    if (!isRecord(payload) || (payload.ret !== '0' && payload.ret !== 0)) {
      const msg = isRecord(payload) && typeof payload.errmsg === 'string' ? payload.errmsg : '上传素材失败'
      throw new ProviderRequestRejectedError(msg)
    }

    const data = isRecord(payload.data) ? payload.data : undefined
    const pippitAssetId =
      typeof data?.pippit_asset_id === 'string' && data.pippit_asset_id.trim()
        ? data.pippit_asset_id.trim()
        : typeof data?.pippit_asset_id === 'number'
          ? String(data.pippit_asset_id)
          : undefined
    const assetId = typeof data?.asset_id === 'string' && data.asset_id.trim() ? data.asset_id.trim() : undefined
    const finalId = pippitAssetId || assetId
    if (!finalId) {
      throw new Error('小云雀未返回有效的素材 asset_id')
    }
    return finalId
  }

  async createGeneration(
    request: GenerationRequest,
    references: StagedReference[],
    signal?: AbortSignal,
  ): Promise<string> {
    const assetIds: string[] = []

    for (const ref of references) {
      const key = stagedKeyFromUrl(ref.url)
      if (key) {
        try {
          const bytes = await readFile(this.stagedPath(key))
          const mime = mimeFromBytes(bytes)
          const assetId = await this.uploadAsset(bytes, `${key}.${mime.split('/')[1] || 'png'}`, mime, signal)
          assetIds.push(assetId)
        } catch (error) {
          if (error instanceof ProviderRequestRejectedError) throw error
          // 忽略单个读取失败
        }
      }
    }

    const promptText = (request.prompt || '').trim() || '生成一段电影级镜头视频'
    const payloadBody: Record<string, unknown> = {
      message: promptText,
    }
    if (assetIds.length > 0) {
      payloadBody.asset_ids = assetIds
    }

    const generalSettings: Record<string, unknown> = {}
    if (request.model) {
      generalSettings.video_model = normalizeVideoModel(request.model)
    }
    if (request.aspectRatio && request.aspectRatio !== 'adaptive') {
      generalSettings.aspect_ratio = request.aspectRatio
    }
    if (request.quality) {
      const q = request.quality.toLowerCase()
      generalSettings.resolution = q === '1080p' || q.includes('1080') ? '1080p' : q === '480p' || q.includes('480') ? '480p' : '720p'
    }
    if (typeof request.duration === 'number' && request.duration > 0) {
      generalSettings.duration_start = request.duration
      generalSettings.duration_end = request.duration
    }
    if (Object.keys(generalSettings).length > 0) {
      payloadBody.general_agent_settings = generalSettings
    }

    const result = await this.requestJson('/api/biz/v1/skill/submit_run', payloadBody, signal)

    if (result.ret !== '0' && result.ret !== 0) {
      throw new ProviderRequestRejectedError(
        typeof result.errmsg === 'string' ? result.errmsg : '小云雀视频生成任务提交失败',
        String(result.ret),
      )
    }

    const data = isRecord(result.data) ? result.data : undefined
    const run = isRecord(data?.run) ? data.run : undefined
    const threadId = run?.thread_id
    const runId = run?.run_id

    if (typeof threadId !== 'string' || typeof runId !== 'string') {
      throw new Error('小云雀未返回有效的会话任务 ID')
    }

    return `${threadId}:${runId}`
  }

  async getGenerationStatus(taskIds: string[], signal?: AbortSignal): Promise<UpstreamTaskStatus[]> {
    return Promise.all(taskIds.map((taskId) => this.getGenerationDetail(taskId, signal)))
  }

  async getGenerationDetail(taskId: string, signal?: AbortSignal): Promise<UpstreamTaskStatus> {
    const parts = taskId.split(':')
    if (parts.length < 2) {
      return {
        taskId,
        status: STATUS_FAILED,
        errorMessage: '无效的小云雀任务标识符格式',
      }
    }
    const [threadId, runId] = parts

    const result = await this.requestJson(
      '/api/biz/v1/skill/get_thread',
      {
        thread_id: threadId,
        run_id: runId,
        after_seq: 0,
      },
      signal,
    )

    if (result.ret !== '0' && result.ret !== 0) {
      return {
        taskId,
        status: STATUS_FAILED,
        errorMessage: typeof result.errmsg === 'string' ? result.errmsg : '查询任务状态失败',
      }
    }

    const data = isRecord(result.data) ? result.data : undefined
    const thread = isRecord(data?.thread) ? data.thread : undefined
    const runList = Array.isArray(thread?.run_list) ? thread.run_list : []
    const run = (runList.find((r) => isRecord(r) && r.run_id === runId) || runList[0]) as
      | Record<string, unknown>
      | undefined

    if (!run) {
      return {
        taskId,
        status: STATUS_QUEUED,
        progress: 10,
      }
    }

    // 检查失败原因
    if (run.state === 4 || (run.fail_reason && isRecord(run.fail_reason) && (run.fail_reason.message || run.fail_reason.code))) {
      const msg =
        run.fail_reason && isRecord(run.fail_reason) && typeof run.fail_reason.message === 'string' && run.fail_reason.message
          ? run.fail_reason.message
          : '视频生成失败'
      return {
        taskId,
        status: STATUS_FAILED,
        errorMessage: msg,
      }
    }

    // 从条目中提取产物视频
    const entryList = Array.isArray(run.entry_list) ? run.entry_list : []
    let videoUrl: string | undefined

    for (const entry of entryList) {
      if (!isRecord(entry)) continue

      // 1. 检查 artifact
      if (isRecord(entry.artifact)) {
        const art = entry.artifact
        if (typeof art.download_url === 'string' && art.download_url) videoUrl = art.download_url
        else if (typeof art.url === 'string' && art.url) videoUrl = art.url

        // 1a. 检查 artifact.content 中的结构化视频数据
        if (!videoUrl && Array.isArray(art.content)) {
          for (const item of art.content) {
            if (!isRecord(item)) continue
            if (typeof item.data === 'string' && item.data) {
              try {
                const parsed = JSON.parse(item.data) as unknown
                if (isRecord(parsed) && isRecord(parsed.video)) {
                  const v = parsed.video
                  if (typeof v.download_url === 'string' && v.download_url) videoUrl = v.download_url
                  else if (typeof v.url === 'string' && v.url) videoUrl = v.url
                  else if (typeof v.preview_url === 'string' && v.preview_url) videoUrl = v.preview_url
                }
              } catch {
                // ignore
              }
            }
            if (videoUrl) break
          }
        }

        // 1b. 检查 artifact.tool_info_list 中的响应
        if (!videoUrl && Array.isArray(art.tool_info_list)) {
          for (const tool of art.tool_info_list) {
            if (!isRecord(tool)) continue
            if (typeof tool.tool_resp === 'string' && tool.tool_resp) {
              try {
                const parsed = JSON.parse(tool.tool_resp) as unknown
                if (isRecord(parsed)) {
                  if (isRecord(parsed.Video)) {
                    if (typeof parsed.Video.URL === 'string' && parsed.Video.URL) videoUrl = parsed.Video.URL
                    else if (typeof parsed.Video.PreviewUrl === 'string' && parsed.Video.PreviewUrl) videoUrl = parsed.Video.PreviewUrl
                  }
                  if (!videoUrl && typeof parsed.url === 'string' && parsed.url) videoUrl = parsed.url
                  if (!videoUrl && typeof parsed.download_url === 'string' && parsed.download_url) videoUrl = parsed.download_url
                }
              } catch {
                // ignore
              }
            }
            if (videoUrl) break
          }
        }
      }

      // 2. 检查 entry.tool_info_list
      if (!videoUrl && Array.isArray(entry.tool_info_list)) {
        for (const tool of entry.tool_info_list) {
          if (!isRecord(tool)) continue
          if (typeof tool.tool_resp === 'string') {
            try {
              const respObj = JSON.parse(tool.tool_resp) as unknown
              if (isRecord(respObj)) {
                if (isRecord(respObj.Video)) {
                  if (typeof respObj.Video.URL === 'string') videoUrl = respObj.Video.URL
                  else if (typeof respObj.Video.PreviewUrl === 'string') videoUrl = respObj.Video.PreviewUrl
                }
                if (!videoUrl && typeof respObj.url === 'string') videoUrl = respObj.url
              }
            } catch {
              // ignore json parse error
            }
          }
          if (videoUrl) break
        }
      }

      // 3. 检查 message 内嵌 tool_info_list 或 client_tool_calls
      if (!videoUrl && isRecord(entry.message)) {
        const toolList = Array.isArray(entry.message.tool_info_list)
          ? entry.message.tool_info_list
          : Array.isArray(entry.message.client_tool_calls)
            ? entry.message.client_tool_calls
            : []
        for (const call of toolList) {
          if (!isRecord(call)) continue
          if (typeof call.tool_resp === 'string' && call.tool_resp) {
            try {
              const respObj = JSON.parse(call.tool_resp) as unknown
              if (isRecord(respObj)) {
                if (isRecord(respObj.Video)) {
                  if (typeof respObj.Video.URL === 'string') videoUrl = respObj.Video.URL
                  else if (typeof respObj.Video.PreviewUrl === 'string') videoUrl = respObj.Video.PreviewUrl
                }
                if (!videoUrl && typeof respObj.url === 'string') videoUrl = respObj.url
              }
            } catch {
              // ignore
            }
          }
          if (videoUrl) break
        }
      }

      if (videoUrl) break
    }

    // 提取智能体回复文本
    let assistantMessage: string | undefined
    for (const entry of entryList) {
      if (!isRecord(entry)) continue
      if (isRecord(entry.message)) {
        const msg = entry.message
        const role = typeof msg.role === 'string' ? msg.role : ''
        const content = extractXiaoYunqueText(msg.content)
        if ((role === 'assistant' || role === 'bot' || !role) && content) {
          assistantMessage = content
        }
      }
      const entryContent = extractXiaoYunqueText(entry.content)
      if (entryContent && !assistantMessage) {
        assistantMessage = entryContent
      }
      if (typeof entry.text === 'string' && entry.text.trim() && !assistantMessage) {
        assistantMessage = entry.text.trim()
      }
    }

    if (videoUrl) {
      return {
        taskId,
        status: STATUS_COMPLETE,
        progress: 100,
        outputs: [videoUrl],
        errorMessage: assistantMessage,
      }
    }

    // 检查完成状态但未提取到产物的情况（纯对话或未产生视频）
    if (run.state === 3 || run.completed_at) {
      if (assistantMessage) {
        return {
          taskId,
          status: STATUS_COMPLETE,
          progress: 100,
          outputs: [],
          errorMessage: assistantMessage,
        }
      }
      return {
        taskId,
        status: STATUS_FAILED,
        errorMessage: '小云雀任务已结束但未生成有效内容',
      }
    }

    // 排队与运行中估算
    const queueInfo = isRecord(run.RunQueueInfo) ? run.RunQueueInfo : undefined
    const estimatedWait = typeof queueInfo?.expected_wait_time_seconds === 'number' ? queueInfo.expected_wait_time_seconds : 60
    const progress = Math.min(Math.max(20, Math.round(100 - estimatedWait / 2)), 95)

    return {
      taskId,
      status: STATUS_RUNNING,
      progress,
    }
  }

  async chat(
    message: string,
    threadId?: string,
    signal?: AbortSignal,
    assetIds?: string[],
    preferences?: {
      preferenceMode?: 'video' | 'image'
      model?: string
      imageModel?: string
      aspectRatio?: string
      duration?: number
      resolution?: string
    },
  ): Promise<{
    reply: string
    videoUrl?: string
    videoUrls?: string[]
    imageUrl?: string
    imageUrls?: string[]
    aspectRatio?: string
    width?: number
    height?: number
    threadId: string
    runId: string
    threadUrl: string
    thinking?: string
    executionSteps?: Array<{ id: string; title: string; status: 'pending' | 'running' | 'completed' | 'failed' }>
    pending?: boolean
  }> {
    const generalSettings: Record<string, unknown> = {}
    const isImageMode =
      preferences?.preferenceMode === 'image' ||
      Boolean(preferences?.model && (preferences.model.startsWith('seedream') || preferences.model.startsWith('nova')))

    const messageToSend = message.trim()

    if (isImageMode) {
      const selectedImgModel = preferences?.imageModel || preferences?.model || 'seedream_5.0_pro'
      generalSettings.image_model = selectedImgModel
      if (preferences?.aspectRatio && preferences.aspectRatio !== 'adaptive') {
        generalSettings.aspect_ratio = preferences.aspectRatio
      }
      if (preferences?.resolution) {
        const q = preferences.resolution.toUpperCase()
        generalSettings.resolution = q.includes('4K') ? '4K' : q.includes('1K') ? '1K' : '2K'
      }
    } else {
      generalSettings.video_model = normalizeVideoModel(preferences?.model)

      if (preferences?.aspectRatio && preferences.aspectRatio !== 'adaptive') {
        generalSettings.aspect_ratio = preferences.aspectRatio
      }
      if (preferences?.resolution) {
        const q = preferences.resolution.toLowerCase()
        generalSettings.resolution = q === '1080p' || q.includes('1080') ? '1080p' : q === '480p' || q.includes('480') ? '480p' : '720p'
      }
      if (typeof preferences?.duration === 'number' && preferences.duration > 0) {
        generalSettings.duration_start = preferences.duration
        generalSettings.duration_end = preferences.duration
      }
    }

    const payloadBody: Record<string, unknown> = {
      message: messageToSend,
    }
    if (threadId) {
      payloadBody.thread_id = threadId
    }
    if (assetIds && assetIds.length > 0) {
      payloadBody.asset_ids = assetIds
    }
    if (Object.keys(generalSettings).length > 0) {
      payloadBody.general_agent_settings = generalSettings
    }

    const result = await this.requestJson('/api/biz/v1/skill/submit_run', payloadBody, signal)
    if (result.ret !== '0' && result.ret !== 0) {
      throw new ProviderRequestRejectedError(
        typeof result.errmsg === 'string' ? result.errmsg : '小云雀对话任务提交失败',
        String(result.ret),
      )
    }

    const data = isRecord(result.data) ? result.data : undefined
    const run = isRecord(data?.run) ? data.run : undefined
    const resThreadId = (typeof run?.thread_id === 'string' ? run.thread_id : threadId) || ''
    const resRunId = (typeof run?.run_id === 'string' ? run.run_id : '') || ''

    if (!resThreadId || !resRunId) {
      throw new Error('小云雀未返回有效的会话任务 ID')
    }

    // 轮询等待运行结果（纯对话通常 1~3 秒完成，成片/图像渲染通常 30~50 秒，最多等待 55 秒后转为客户端接力轮询）
    const startTime = Date.now()
    const maxWaitMs = 55_000

    while (Date.now() - startTime < maxWaitMs) {
      if (signal?.aborted) throw new DOMException('Chat request was aborted', 'AbortError')

      await new Promise((resolve) => setTimeout(resolve, 1000))

      const statusResult = await this.requestJson(
        '/api/biz/v1/skill/get_thread',
        {
          thread_id: resThreadId,
          run_id: resRunId,
          after_seq: 0,
        },
        signal,
      )

      if (statusResult.ret !== '0' && statusResult.ret !== 0) {
        continue
      }

      const sData = isRecord(statusResult.data) ? statusResult.data : undefined
      const sThread = isRecord(sData?.thread) ? sData.thread : undefined
      const sRunList = Array.isArray(sThread?.run_list) ? sThread.run_list : []
      const currentRun = (sRunList.find((r) => isRecord(r) && r.run_id === resRunId) || sRunList[0]) as
        | Record<string, unknown>
        | undefined

      if (!currentRun) continue

      const parsed = parseRunOutput(currentRun, isImageMode)
      if (parsed.isFailed) {
        throw new ProviderRequestRejectedError(parsed.failMsg || '小云雀会话处理失败')
      }

      if (parsed.isComplete) {
        return {
          reply: parsed.reply,
          videoUrl: parsed.videoUrl,
          videoUrls: parsed.videoUrls,
          imageUrl: parsed.imageUrl,
          imageUrls: parsed.imageUrls,
          aspectRatio: parsed.aspectRatio,
          width: parsed.width,
          height: parsed.height,
          threadId: resThreadId,
          runId: resRunId,
          threadUrl: `https://xyq.jianying.com/home?tab_name=integrated-agent&thread_id=${resThreadId}`,
          thinking: parsed.thinking,
          executionSteps: parsed.executionSteps,
          pending: false,
        }
      }
    }

    return {
      reply: '正在深度构思与渲染中，请稍候...',
      threadId: resThreadId,
      runId: resRunId,
      threadUrl: `https://xyq.jianying.com/home?tab_name=integrated-agent&thread_id=${resThreadId}`,
      pending: true,
    }
  }

  async checkRunStatus(
    threadId: string,
    runId: string,
    preferenceMode?: 'image' | 'video',
    signal?: AbortSignal,
  ): Promise<{
    reply: string
    videoUrl?: string
    videoUrls?: string[]
    imageUrl?: string
    imageUrls?: string[]
    aspectRatio?: string
    width?: number
    height?: number
    threadId: string
    runId: string
    threadUrl: string
    thinking?: string
    executionSteps?: Array<{ id: string; title: string; status: 'pending' | 'running' | 'completed' | 'failed' }>
    pending: boolean
  }> {
    const statusResult = await this.requestJson(
      '/api/biz/v1/skill/get_thread',
      {
        thread_id: threadId,
        run_id: runId,
        after_seq: 0,
      },
      signal,
    )

    if (statusResult.ret !== '0' && statusResult.ret !== 0) {
      throw new ProviderRequestRejectedError(
        typeof statusResult.errmsg === 'string' ? statusResult.errmsg : '获取任务状态失败',
        String(statusResult.ret),
      )
    }

    const sData = isRecord(statusResult.data) ? statusResult.data : undefined
    const sThread = isRecord(sData?.thread) ? sData.thread : undefined
    const sRunList = Array.isArray(sThread?.run_list) ? sThread.run_list : []
    const currentRun = (sRunList.find((r) => isRecord(r) && r.run_id === runId) || sRunList[0]) as
      | Record<string, unknown>
      | undefined

    if (!currentRun) {
      return {
        reply: '正在深度构思与渲染中，请稍候...',
        threadId,
        runId,
        threadUrl: `https://xyq.jianying.com/home?tab_name=integrated-agent&thread_id=${threadId}`,
        pending: true,
      }
    }

    const isImageMode = preferenceMode === 'image'
    const parsed = parseRunOutput(currentRun, isImageMode)

    if (parsed.isFailed) {
      throw new ProviderRequestRejectedError(parsed.failMsg || '小云雀任务处理失败')
    }

    if (parsed.isComplete) {
      return {
        reply: parsed.reply,
        videoUrl: parsed.videoUrl,
        videoUrls: parsed.videoUrls,
        imageUrl: parsed.imageUrl,
        imageUrls: parsed.imageUrls,
        aspectRatio: parsed.aspectRatio,
        width: parsed.width,
        height: parsed.height,
        thinking: parsed.thinking,
        executionSteps: parsed.executionSteps,
        threadId,
        runId,
        threadUrl: `https://xyq.jianying.com/home?tab_name=integrated-agent&thread_id=${threadId}`,
        pending: false,
      }
    }

    return {
      reply: parsed.reply || '正在深度构思与渲染中，请稍候...',
      videoUrl: parsed.videoUrl,
      videoUrls: parsed.videoUrls,
      imageUrl: parsed.imageUrl,
      imageUrls: parsed.imageUrls,
      aspectRatio: parsed.aspectRatio,
      width: parsed.width,
      height: parsed.height,
      thinking: parsed.thinking,
      executionSteps: parsed.executionSteps,
      threadId,
      runId,
      threadUrl: `https://xyq.jianying.com/home?tab_name=integrated-agent&thread_id=${threadId}`,
      pending: true,
    }
  }
}

function parseRunOutput(
  currentRun: Record<string, unknown>,
  isImageMode: boolean,
): {
  isFailed: boolean
  failMsg?: string
  isComplete: boolean
  reply: string
  videoUrl?: string
  videoUrls: string[]
  imageUrl?: string
  imageUrls: string[]
  aspectRatio?: string
  width?: number
  height?: number
  thinking?: string
  executionSteps: Array<{ id: string; title: string; status: 'pending' | 'running' | 'completed' | 'failed' }>
} {
  if (currentRun.state === 4) {
    const failMsg =
      currentRun.fail_reason && isRecord(currentRun.fail_reason) && typeof currentRun.fail_reason.message === 'string'
        ? currentRun.fail_reason.message
        : '小云雀会话处理失败'
    return {
      isFailed: true,
      failMsg,
      isComplete: false,
      reply: '',
      videoUrls: [],
      imageUrls: [],
      executionSteps: [{ id: 'step-1', title: failMsg, status: 'failed' }],
    }
  }

  const entryList = Array.isArray(currentRun.entry_list) ? currentRun.entry_list : []
  let reply = ''
  const videoUrls: string[] = []
  const imageUrls: string[] = []
  let aspectRatio: string | undefined
  let width: number | undefined
  let height: number | undefined
  let thinking: string | undefined
  const reasoningParts: string[] = []
  const assistantProgressParts: string[] = []
  const executionSteps: Array<{ id: string; title: string; status: 'pending' | 'running' | 'completed' | 'failed' }> = []

  const addStep = (title: string, status: 'pending' | 'running' | 'completed' | 'failed' = 'completed') => {
    const normalized = title.trim()
    if (!normalized || executionSteps.some((step) => step.title === normalized)) return
    executionSteps.push({ id: `step-${executionSteps.length + 1}`, title: normalized, status })
  }

  const classifyAndAssign = (url: string, explicitHint?: 'image' | 'video') => {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) return
    const isImg =
      explicitHint === 'image' ||
      /\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(url) ||
      url.includes('origin_aigc.image') ||
      url.includes('tplv-wipe09lpyt-origin_aigc') ||
      url.includes('tplv-wipe09lpyt-resize')
    const isVid =
      explicitHint === 'video' ||
      /\.(mp4|mov|webm|mkv|avi)(\?|$)/i.test(url) ||
      url.includes('tplv-wipe09lpyt-video')

    if (isImg) {
      if (!imageUrls.includes(url)) {
        imageUrls.push(url)
        addStep(`完成图片产物 ${imageUrls.length}`)
      }
      return
    }
    if (isVid) {
      if (!videoUrls.includes(url)) {
        videoUrls.push(url)
        addStep(`完成视频产物 ${videoUrls.length}`)
      }
      return
    }
    if (isImageMode) {
      if (!imageUrls.includes(url)) {
        imageUrls.push(url)
        addStep(`完成图片产物 ${imageUrls.length}`)
      }
    } else {
      if (!videoUrls.includes(url)) {
        videoUrls.push(url)
        addStep(`完成视频产物 ${videoUrls.length}`)
      }
    }
  }

  const inspectToolResp = (rawResp: unknown) => {
    if ((typeof rawResp !== 'string' || !rawResp.trim()) && !isRecord(rawResp)) return
    try {
      const parsed = typeof rawResp === 'string' ? JSON.parse(rawResp) as unknown : rawResp
      if (!isRecord(parsed)) return

      // 1. ImageInfoList (常用小云雀生图工具产物)
      if (Array.isArray(parsed.ImageInfoList)) {
        for (const item of parsed.ImageInfoList) {
          if (!isRecord(item)) continue
          if (typeof item.ImageURL === 'string') classifyAndAssign(item.ImageURL, 'image')
          else if (typeof item.DownsapmleImageURL === 'string') classifyAndAssign(item.DownsapmleImageURL, 'image')
          if (isRecord(item.MetaData)) {
            if (typeof item.MetaData.Width === 'number' && item.MetaData.Width > 0) width = item.MetaData.Width
            if (typeof item.MetaData.Height === 'number' && item.MetaData.Height > 0) height = item.MetaData.Height
            if (typeof item.MetaData.Ratio === 'string' && item.MetaData.Ratio.trim()) aspectRatio = item.MetaData.Ratio.trim()
          }
        }
      }

      // 2. VideoInfoList (小云雀视频工具产物)
      if (Array.isArray(parsed.VideoInfoList)) {
        for (const item of parsed.VideoInfoList) {
          if (!isRecord(item)) continue
          if (typeof item.VideoURL === 'string') classifyAndAssign(item.VideoURL, 'video')
          else if (typeof item.URL === 'string') classifyAndAssign(item.URL, 'video')
        }
      }

      // 3. Image 结构体
      if (isRecord(parsed.Image) && typeof parsed.Image.URL === 'string') {
        classifyAndAssign(parsed.Image.URL, 'image')
      }
      if (isRecord(parsed.image) && typeof parsed.image.url === 'string') {
        classifyAndAssign(parsed.image.url, 'image')
      }
      if (typeof parsed.image_url === 'string') {
        classifyAndAssign(parsed.image_url, 'image')
      }
      if (typeof parsed.imageUrl === 'string') {
        classifyAndAssign(parsed.imageUrl, 'image')
      }
      if (Array.isArray(parsed.images)) {
        for (const item of parsed.images) {
          if (isRecord(item) && typeof item.url === 'string') classifyAndAssign(item.url, 'image')
        }
      }

      // 4. Video 结构体
      if (isRecord(parsed.Video)) {
        if (typeof parsed.Video.URL === 'string') classifyAndAssign(parsed.Video.URL, 'video')
        else if (typeof parsed.Video.PreviewUrl === 'string') classifyAndAssign(parsed.Video.PreviewUrl, 'video')
      }
      if (isRecord(parsed.video) && typeof parsed.video.url === 'string') {
        classifyAndAssign(parsed.video.url, 'video')
      }
      if (typeof parsed.video_url === 'string') {
        classifyAndAssign(parsed.video_url, 'video')
      }
      if (Array.isArray(parsed.videos)) {
        for (const item of parsed.videos) {
          if (isRecord(item) && typeof item.url === 'string') classifyAndAssign(item.url, 'video')
        }
      }

      // 5. _ToolArguments (常见工具入参回显)
      if (isRecord(parsed._ToolArguments)) {
        if (typeof parsed._ToolArguments.OutputRatio === 'string' && parsed._ToolArguments.OutputRatio.trim()) {
          aspectRatio = parsed._ToolArguments.OutputRatio.trim()
        }
      }

      // 6. 通用 URL 字段
      if (typeof parsed.url === 'string') {
        classifyAndAssign(parsed.url)
      }
    } catch {}
  }

  const inspectToolReq = (rawReq: unknown) => {
    if (typeof rawReq !== 'string' || !rawReq.trim()) return
    try {
      const parsed = JSON.parse(rawReq) as unknown
      if (!isRecord(parsed)) return
      if (typeof parsed.OutputRatio === 'string' && parsed.OutputRatio.trim()) {
        aspectRatio = parsed.OutputRatio.trim()
      } else if (typeof parsed.output_ratio === 'string' && parsed.output_ratio.trim()) {
        aspectRatio = parsed.output_ratio.trim()
      } else if (typeof parsed.ratio === 'string' && parsed.ratio.trim()) {
        aspectRatio = parsed.ratio.trim()
      }
    } catch {}
  }

  for (const entry of entryList) {
    if (!isRecord(entry)) continue

    // 检查 message
    if (isRecord(entry.message)) {
      const msg = entry.message
      const content = extractXiaoYunqueText(msg.content)
      const role = typeof msg.role === 'string' ? msg.role : ''
      if ((role === 'assistant' || role === 'bot' || !role) && content) {
        if (!content.includes('questionnaire_id') && !assistantProgressParts.includes(content)) {
          assistantProgressParts.push(content)
        }
        if (!reply) {
          reply = content
        } else if (content.includes('questionnaire_id') && !reply.includes('questionnaire_id')) {
          reply = `${reply}\n\n${content}`
        } else if (!content.includes('questionnaire_id') && reply.includes('questionnaire_id')) {
          reply = `${content}\n\n${reply}`
        } else {
          reply = content
        }
      }
      if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
        const reasoning = msg.reasoning_content.trim()
        if (!reasoningParts.includes(reasoning)) reasoningParts.push(reasoning)
        addStep('分析创作要求与参考素材')
      }

      // 提取 message.content 中的多媒体产物与元数据
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (!isRecord(item)) continue
          const subType = typeof item.sub_type === 'string' ? item.sub_type : ''
          if (subType.includes('upload')) continue

          // 提取 biz/x_artifact_slots_part (包含明确 ratio: "3:4")
          if (subType === 'biz/x_artifact_slots_part' && typeof item.data === 'string') {
            try {
              const slotsParsed = JSON.parse(item.data) as unknown
              if (isRecord(slotsParsed) && Array.isArray(slotsParsed.slots) && slotsParsed.slots[0] && isRecord(slotsParsed.slots[0])) {
                const s = slotsParsed.slots[0]
                if (typeof s.ratio === 'string' && s.ratio.trim()) {
                  aspectRatio = s.ratio.trim()
                }
              }
            } catch {}
          }

          // 提取 tool_call_req
          if (subType === 'tool_call_req' && typeof item.data === 'string') {
            try {
              const callParsed = JSON.parse(item.data) as unknown
              if (isRecord(callParsed) && typeof callParsed.request_data === 'string') {
                const reqParsed = JSON.parse(callParsed.request_data) as unknown
                if (isRecord(reqParsed) && typeof reqParsed.OutputRatio === 'string' && reqParsed.OutputRatio.trim()) {
                  aspectRatio = reqParsed.OutputRatio.trim()
                }
              }
            } catch {}
          }

          if (item.type === 'image' && typeof item.data === 'string') {
            classifyAndAssign(item.data, 'image')
          }

          if (typeof item.data === 'string') {
            const mdMatch = item.data.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/)
            if (mdMatch) {
              classifyAndAssign(mdMatch[1], 'image')
            }
            if (item.data.trim().startsWith('{')) {
              inspectToolResp(item.data)
            }
          }
        }
      }
    }

    const entryContent = extractXiaoYunqueText(entry.content)
    if (entryContent) {
      if (!reply) {
        reply = entryContent
      } else if (entryContent.includes('questionnaire_id') && !reply.includes('questionnaire_id')) {
        reply = `${reply}\n\n${entryContent}`
      }
    }

    // 检查 artifact（小云雀生图的核心产物容器）
    if (isRecord(entry.artifact)) {
      const art = entry.artifact
      const artUrl =
        (typeof art.download_url === 'string' && art.download_url) ||
        (typeof art.url === 'string' && art.url) ||
        undefined

      if (artUrl) {
        const artType = typeof art.type === 'string' ? art.type : ''
        const mime = typeof art.mime_type === 'string' ? art.mime_type : ''
        const explicitHint = artType === 'image' || mime.startsWith('image/') ? 'image' : artType === 'video' || mime.startsWith('video/') ? 'video' : undefined
        classifyAndAssign(artUrl, explicitHint)
      }

      // 检查 artifact.content (如 biz/x_data_image 结构，包含 width/height)
      if (Array.isArray(art.content)) {
        for (const item of art.content) {
          if (!isRecord(item) || typeof item.data !== 'string') continue
          const str = item.data.trim()
          if (str.startsWith('http')) {
            classifyAndAssign(str)
          } else if (str.startsWith('{')) {
            try {
              const parsed = JSON.parse(str) as unknown
              if (isRecord(parsed)) {
                if (isRecord(parsed.image)) {
                  if (typeof parsed.image.url === 'string') {
                    classifyAndAssign(parsed.image.url, 'image')
                  }
                  if (isRecord(parsed.image.metadata)) {
                    if (typeof parsed.image.metadata.width === 'number' && parsed.image.metadata.width > 0) {
                      width = parsed.image.metadata.width
                    }
                    if (typeof parsed.image.metadata.height === 'number' && parsed.image.metadata.height > 0) {
                      height = parsed.image.metadata.height
                    }
                    if (typeof parsed.image.metadata.ratio === 'string' && parsed.image.metadata.ratio.trim()) {
                      aspectRatio = parsed.image.metadata.ratio.trim()
                    }
                  }
                }
                if (isRecord(parsed.video) && typeof parsed.video.url === 'string') {
                  classifyAndAssign(parsed.video.url, 'video')
                }
                if (typeof parsed.url === 'string') {
                  classifyAndAssign(parsed.url)
                }
              }
            } catch {}
          }
        }
      }

      // 检查 artifact.tool_info_list
      if (Array.isArray(art.tool_info_list)) {
        for (const tool of art.tool_info_list) {
          if (!isRecord(tool)) continue
          if (typeof tool.tool_name === 'string' && tool.tool_name.trim()) {
            addStep(`执行 ${tool.tool_name.trim()}`)
          }
          inspectToolReq(tool.tool_req)
          inspectToolResp(tool.tool_resp)
        }
      }
    }

    // 检查 entry 顶层的 tool_info_list
    if (Array.isArray(entry.tool_info_list)) {
      for (const tool of entry.tool_info_list) {
        if (!isRecord(tool)) continue
        if (typeof tool.tool_name === 'string' && tool.tool_name.trim()) {
          addStep(`执行 ${tool.tool_name.trim()}`)
        }
        inspectToolReq(tool.tool_req)
        inspectToolResp(tool.tool_resp)
      }
    }
  }

  // 如果未在结构化数据中提取到图片，从 reply markdown 中兜底提取
  if (imageUrls.length === 0 && reply) {
    const mdImg = reply.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/)
    if (mdImg) {
      classifyAndAssign(mdImg[1], 'image')
    }
  }

  const detailedProgress = assistantProgressParts.filter((part) => part !== reply)
  const thinkingSections = [...reasoningParts, ...detailedProgress]
  if (thinkingSections.length > 0) {
    thinking = thinkingSections.slice(-12).join('\n\n').slice(-8_000)
  }

  // 如果有宽高但尚未确定标准宽高比，推导标准宽高比
  if (!aspectRatio && width && height && width > 0 && height > 0) {
    const val = width / height
    const standardRatios: Array<[string, number]> = [
      ['1:1', 1.0],
      ['3:4', 3 / 4],
      ['4:3', 4 / 3],
      ['9:16', 9 / 16],
      ['16:9', 16 / 9],
      ['21:9', 21 / 9],
    ]
    for (const [name, target] of standardRatios) {
      if (Math.abs(val - target) / target < 0.03) {
        aspectRatio = name
        break
      }
    }
  }

  const awaitingInput = reply.includes('questionnaire_id')
  // A structured questionnaire ends the current Agent turn even if the wider
  // thread remains active: the canvas must surface it and let the user answer.
  const isComplete = Boolean(currentRun.state === 3 || currentRun.completed_at || awaitingInput)

  if (reply && executionSteps.length === 0) addStep('完成需求分析与导演回复')
  if (!isComplete) addStep('等待小云雀完成生成', 'running')

  const videoUrl = videoUrls[0]
  const imageUrl = imageUrls[0]

  return {
    isFailed: false,
    isComplete,
    reply: reply || (videoUrl ? '成片已为您生成完成。' : imageUrl ? '图片已为您生成完成。' : '你好！已为您确认需求，随时准备为您创作。'),
    videoUrl,
    videoUrls,
    imageUrl,
    imageUrls,
    aspectRatio,
    width,
    height,
    thinking,
    executionSteps,
  }
}
