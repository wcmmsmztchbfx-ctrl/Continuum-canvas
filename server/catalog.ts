import { createHash } from 'node:crypto'
import type {
  CatalogModel,
  CatalogPricing,
  CatalogQualityOption,
  CatalogRange,
  ProviderCatalog,
} from '../src/contracts/generation.ts'
import { estimateModelCredits, isCatalogPricing } from '../src/contracts/catalog.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function range(value: unknown): CatalogRange | undefined {
  if (!isRecord(value)) return undefined
  const min = value.min === null ? null : typeof value.min === 'number' && Number.isFinite(value.min) ? value.min : undefined
  const max = value.max === null ? null : typeof value.max === 'number' && Number.isFinite(value.max) ? value.max : undefined
  if (min === undefined || max === undefined || (min !== null && max !== null && min > max)) return undefined
  let options: number[] | null
  if (value.options === null) {
    options = null
  } else if (Array.isArray(value.options) && value.options.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    options = [...new Set(value.options)]
    if (options.some((item) => (min !== null && item < min) || (max !== null && item > max))) return undefined
  } else {
    return undefined
  }
  return { min, max, options }
}

function rangeOptions(value: CatalogRange | undefined): number[] {
  if (!value) return []
  if (value.options !== null) return value.options
  if (value.min === null || value.max === null || !Number.isInteger(value.min) || !Number.isInteger(value.max)) return []
  if (value.max - value.min > 999) return []
  return Array.from({ length: value.max - value.min + 1 }, (_, index) => value.min as number + index)
}

function pricing(value: unknown): CatalogPricing | undefined {
  return isCatalogPricing(value) ? { ...value } : undefined
}

function qualityOptions(value: unknown): CatalogQualityOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((option) => {
    if (!isRecord(option) || typeof option.quality !== 'string' || !option.quality) return []
    const optionPricing = pricing(option.pricing)
    return optionPricing ? [{ value: option.quality, label: option.quality, pricing: optionPricing }] : []
  })
}

function nonNegativeLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function mapSection(mediaType: CatalogModel['mediaType'], section: unknown): CatalogModel[] {
  if (!Array.isArray(section)) return []
  return section.flatMap((channelValue) => {
    if (!isRecord(channelValue)) return []
    const channel = channelValue.channel
    if (typeof channel !== 'string' && typeof channel !== 'number') return []
    const candidates = Array.isArray(channelValue.models) ? channelValue.models : [channelValue]
    return candidates.flatMap((candidate) => {
      if (!isRecord(candidate) || typeof candidate.model !== 'string') return []
      const qualities = qualityOptions(candidate.qualities)
      if (qualities.length === 0) return []
      const countRange = range(candidate.n)
      const durationRange = range(candidate.duration)
      return [{
        mediaType,
        channel,
        channelTitle: typeof channelValue.title === 'string' ? channelValue.title : undefined,
        channelLabel: typeof channelValue.label === 'string' ? channelValue.label : undefined,
        channelDescription: typeof channelValue.description === 'string' ? channelValue.description : undefined,
        channelDefaultOption: channelValue.defaultOption === undefined
          ? undefined
          : structuredClone(channelValue.defaultOption),
        model: candidate.model,
        title: typeof candidate.label === 'string' ? candidate.label : undefined,
        label: typeof candidate.label === 'string' ? candidate.label : undefined,
        qualityOptions: qualities,
        aspectRatios: strings(candidate.aspectRatios),
        countOptions: rangeOptions(countRange),
        durationOptions: rangeOptions(durationRange),
        countRange,
        durationRange,
        modes: strings(candidate.modes),
        inputLimits: {
          images: nonNegativeLimit(candidate.inputImagesMax),
          videos: nonNegativeLimit(candidate.inputVideosMax),
          audios: nonNegativeLimit(candidate.inputAudiosMax),
        },
        raw: structuredClone(candidate),
      }]
    })
  })
}

// OpenAI-compatible model classification: a model is an image model when its
// id looks like an image generator and does not look like a video generator.
const IMAGE_MODEL_PATTERN = /dall-e|gpt-image|image|flux|stable-diffusion|\bsd[0-9]|schnell|kolors|playground|seedream|midjourney|nano-banana/i
const VIDEO_MODEL_PATTERN = /video|kling|veo|sora|wan|hunyuan|seedance|pixverse|runway|luma|dreamina|minimax|hailuo/i

export function mapOpenAICompatibleCatalog(
  providerId: string,
  payload: unknown,
  fetchedAt: string,
): ProviderCatalog {
  const root = isRecord(payload) ? payload : {}
  const entries = Array.isArray(root.data) ? root.data : []
  const models = entries.flatMap((entry): CatalogModel[] => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) return []
    const id = entry.id
    if (VIDEO_MODEL_PATTERN.test(id) || !IMAGE_MODEL_PATTERN.test(id)) return []
    // /v1/models carries no pricing; the fixed placeholder keeps the catalog
    // contract satisfied. A per-provider pricing table can come later.
    return [{
      mediaType: 'image',
      channel: 'image',
      channelTitle: '图片生成',
      model: id,
      title: id,
      label: id,
      qualityOptions: [{
        value: 'standard',
        label: '标准',
        pricing: { type: 'fixed_total', credits: 1 },
      }],
      aspectRatios: ['Auto', '1:1', '16:9', '9:16'],
      countOptions: [1],
      durationOptions: [1],
      countRange: { min: 1, max: 1, options: [1] },
      modes: ['text2image', 'image2image'],
      inputLimits: { images: 4, videos: 0, audios: 0 },
      raw: structuredClone(entry),
    }]
  })
  if (models.length === 0) throw new Error('Provider config contained no compatible models')
  return {
    providerId,
    version: createHash('sha256').update(canonical(models)).digest('hex'),
    fetchedAt,
    stale: false,
    models,
  }
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function mapAIStartLabCatalog(
  providerId: string,
  payload: unknown,
  fetchedAt: string,
): ProviderCatalog {
  const root = isRecord(payload) && isRecord(payload.data) ? payload.data : payload
  const data = isRecord(root) ? root : {}
  const models = [
    ...mapSection('image', data.imageConfig),
    ...mapSection('video', data.videoConfig),
  ]
  if (models.length === 0) throw new Error('Provider config contained no compatible models')
  return {
    providerId,
    version: createHash('sha256').update(canonical(models)).digest('hex'),
    fetchedAt,
    stale: false,
    models,
  }
}

export function estimateCredits(
  model: CatalogModel,
  selection: { quality?: string; duration?: number; n?: number; inputVideos?: number },
): number | undefined {
  return estimateModelCredits(model, {
    quality: selection.quality,
    duration: selection.duration,
    count: selection.n,
    inputVideos: selection.inputVideos,
  })
}
