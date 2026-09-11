import type {
  CatalogModel,
  CatalogPricing,
  CatalogRange,
  ProviderCatalog,
} from './generation.ts'

export const OFFICIAL_AISTARTLAB_BASE_URL =
  'https://api.video.aistarslab.com/openapi'

// Adapter types that can actually run generation. Frontend and server share
// this truth source; providers with other adapter types stay configured but
// are never usable for generation.
export const GENERATION_ADAPTER_TYPES: ReadonlySet<string> = new Set([
  'aistartlab-openapi',
  'openai-compatible',
  'minimax-video',
  'runninghub-api',
  'volcengine-ark',
  'modelscope-api',
  'jimeng-cli',
  'dashscope-api',
  'kling-api',
  'comfyui-direct',
  'xiaoyunque-video',
])

// Dedicated Agent Director adapters for the Agent Director Console
export const DIRECTOR_ADAPTER_TYPES: ReadonlySet<string> = new Set([
  'xiaoyunque-video',
])


// Request shape variants accepted by OpenAI-compatible platforms. `auto`
// resolves to the standard OpenAI shape inside the adapter; the other values
// are stored on the provider record so users can pick what their platform
// expects. video-proxy is reserved for the future video stage.
export const IMAGE_REQUEST_MODES = [
  'auto',
  'openai',
  'openai-json',
  'openai-responses',
] as const

export type ImageRequestMode = (typeof IMAGE_REQUEST_MODES)[number]

// A generation catalog is a price and capability quote. Never use it for paid
// work after one day without obtaining a fresh copy from the provider.
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1_000

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString)
}

function isFiniteNumberArray(value: unknown, integer = false): value is number[] {
  return Array.isArray(value) && value.every((item) =>
    isFiniteNonNegative(item) && (!integer || Number.isInteger(item)),
  )
}

function isCatalogRange(value: unknown): value is CatalogRange {
  if (!isRecord(value)) return false
  const min = value.min
  const max = value.max
  if (min !== null && !isFiniteNonNegative(min)) return false
  if (max !== null && !isFiniteNonNegative(max)) return false
  if (typeof min === 'number' && typeof max === 'number' && min > max) return false
  if (value.options !== null && !isFiniteNumberArray(value.options)) return false
  return value.options === null || value.options.every((item) =>
    (min === null || item >= min) && (max === null || item <= max),
  )
}

export function isCatalogPricing(value: unknown): value is CatalogPricing {
  return (
    isRecord(value) &&
    (value.type === 'per_second' ||
      value.type === 'per_item' ||
      value.type === 'fixed_total') &&
    isFiniteNonNegative(value.credits) &&
    (value.inputVideoMultiplier === undefined ||
      isFiniteNonNegative(value.inputVideoMultiplier))
  )
}

function isCatalogModel(value: unknown): value is CatalogModel {
  if (!isRecord(value) || !isRecord(value.inputLimits) || !isRecord(value.raw)) {
    return false
  }
  const channelValid =
    (typeof value.channel === 'number' && Number.isFinite(value.channel)) ||
    isNonEmptyString(value.channel)
  const limits = value.inputLimits
  return (
    (value.mediaType === 'image' || value.mediaType === 'video') &&
    channelValid &&
    isNonEmptyString(value.model) &&
    Array.isArray(value.qualityOptions) &&
    value.qualityOptions.length > 0 &&
    value.qualityOptions.every((option) =>
      isRecord(option) &&
      isNonEmptyString(option.value) &&
      isNonEmptyString(option.label) &&
      isCatalogPricing(option.pricing),
    ) &&
    isStringArray(value.aspectRatios) &&
    isFiniteNumberArray(value.countOptions, true) &&
    value.countOptions.every((count) => count > 0) &&
    isFiniteNumberArray(value.durationOptions) &&
    value.durationOptions.every((duration) => duration > 0) &&
    isStringArray(value.modes) &&
    ['images', 'videos', 'audios'].every((key) =>
      isFiniteNonNegative(limits[key]) && Number.isInteger(limits[key]),
    ) &&
    (value.countRange === undefined || isCatalogRange(value.countRange)) &&
    (value.durationRange === undefined || isCatalogRange(value.durationRange))
  )
}

export function isProviderCatalog(value: unknown): value is ProviderCatalog {
  return (
    isRecord(value) &&
    isNonEmptyString(value.providerId) &&
    isNonEmptyString(value.version) &&
    typeof value.fetchedAt === 'string' &&
    Number.isFinite(Date.parse(value.fetchedAt)) &&
    typeof value.stale === 'boolean' &&
    Array.isArray(value.models) &&
    value.models.every(isCatalogModel)
  )
}

export function isProviderCatalogFresh(
  catalog: Pick<ProviderCatalog, 'fetchedAt'>,
  now = Date.now(),
  ttlMs = CATALOG_TTL_MS,
): boolean {
  const fetchedAt = Date.parse(catalog.fetchedAt)
  return (
    Number.isFinite(fetchedAt) &&
    Number.isFinite(now) &&
    Number.isFinite(ttlMs) &&
    ttlMs > 0 &&
    fetchedAt <= now &&
    now - fetchedAt < ttlMs
  )
}

export function deriveCatalogStale(
  catalog: ProviderCatalog,
  now = Date.now(),
  ttlMs = CATALOG_TTL_MS,
): ProviderCatalog {
  return {
    ...structuredClone(catalog),
    stale: catalog.stale || !isProviderCatalogFresh(catalog, now, ttlMs),
  }
}

export interface CatalogPriceSelection {
  duration?: number
  count?: number
  inputVideos?: number
}

export function estimateCatalogCredits(
  pricing: CatalogPricing,
  selection: CatalogPriceSelection,
): number | undefined {
  if (!isCatalogPricing(pricing)) return undefined
  const inputVideos = selection.inputVideos ?? 0
  if (!isFiniteNonNegative(inputVideos) || !Number.isInteger(inputVideos)) {
    return undefined
  }

  let quantity: number
  if (pricing.type === 'fixed_total') {
    quantity = 1
  } else if (pricing.type === 'per_second') {
    if (!isFiniteNonNegative(selection.duration)) return undefined
    quantity = selection.duration
  } else {
    const count = selection.count ?? 1
    if (!isFiniteNonNegative(count) || !Number.isInteger(count)) return undefined
    quantity = count
  }

  const multiplier =
    inputVideos > 0 && pricing.inputVideoMultiplier !== undefined
      ? pricing.inputVideoMultiplier
      : 1
  const total = pricing.credits * quantity * multiplier
  return Number.isFinite(total) && total >= 0 ? total : undefined
}

export function estimateModelCredits(
  model: CatalogModel,
  selection: CatalogPriceSelection & { quality?: string },
): number | undefined {
  const quality = selection.quality === undefined
    ? model.qualityOptions.length === 1
      ? model.qualityOptions[0]
      : undefined
    : model.qualityOptions.find((option) => option.value === selection.quality)
  return quality ? estimateCatalogCredits(quality.pricing, selection) : undefined
}

export function selectCatalogModel(
  catalog: ProviderCatalog,
  selection: {
    providerId: string
    channel: string | number | undefined
    model: string | undefined
    mediaType?: CatalogModel['mediaType']
  },
): CatalogModel | undefined {
  if (catalog.providerId !== selection.providerId) return undefined
  return catalog.models.find((candidate) =>
    String(candidate.channel) === String(selection.channel) &&
    candidate.model === selection.model &&
    (selection.mediaType === undefined || candidate.mediaType === selection.mediaType),
  )
}
