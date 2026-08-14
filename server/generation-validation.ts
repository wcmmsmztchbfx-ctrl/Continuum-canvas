import type { CatalogModel, CatalogRange, GenerationRequest, ProviderCatalog } from '../src/contracts/generation.ts'
import {
  CATALOG_TTL_MS,
  isProviderCatalogFresh,
  selectCatalogModel,
} from '../src/contracts/catalog.ts'

export class GenerationValidationError extends Error {
  readonly code = 'invalid_generation_request'
}

export class CatalogChangedError extends Error {
  readonly code = 'catalog_changed'
  readonly catalogVersion: string

  constructor(catalogVersion: string) {
    super('Provider catalog changed; refresh capabilities before creating a task')
    this.catalogVersion = catalogVersion
  }
}

function fail(message: string): never {
  throw new GenerationValidationError(message)
}

function matchesRange(value: number | undefined, range: CatalogRange | undefined): boolean {
  if (value === undefined || !Number.isFinite(value) || range === undefined) return false
  if (range.min !== null && value < range.min) return false
  if (range.max !== null && value > range.max) return false
  return range.options === null || range.options.includes(value)
}

function validateRemoteReferenceUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail('Reference URL must be public HTTP(S)')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    fail('Reference URL must be public HTTP(S)')
  }
}

export function validateGenerationRequest(
  request: GenerationRequest,
  catalog: ProviderCatalog,
  options: { now?: () => Date; ttlMs?: number } = {},
): CatalogModel {
  const now = options.now?.().getTime() ?? Date.now()
  if (
    catalog.stale ||
    !isProviderCatalogFresh(catalog, now, options.ttlMs ?? CATALOG_TTL_MS) ||
    request.catalogVersion !== catalog.version
  ) {
    throw new CatalogChangedError(catalog.version)
  }
  if (request.providerId !== catalog.providerId) fail('Provider does not match the catalog')
  if (!request.clientRequestId.trim()) fail('clientRequestId is required')
  if (!request.prompt.trim() || request.prompt.length > 5_000) fail('Prompt must contain 1 to 5000 characters')
  const model = selectCatalogModel(catalog, request)
  if (!model) fail('Requested provider channel or model is unavailable')
  if (model.qualityOptions.length > 0 && !model.qualityOptions.some((option) => option.value === request.quality)) {
    fail('Requested quality is unavailable')
  }
  if (model.aspectRatios.length > 0 && !model.aspectRatios.includes(request.aspectRatio ?? '')) {
    fail('Requested aspect ratio is unavailable')
  }
  if (request.mediaType === 'image' && !matchesRange(request.n, model.countRange)) {
    fail('Requested image count is outside the supported range')
  }
  if (request.mediaType === 'video') {
    if (!matchesRange(request.duration, model.durationRange)) fail('Requested video duration is outside the supported options')
    if (!request.mode || !model.modes.includes(request.mode)) fail('Requested video mode is unavailable')
  }
  const aliases = new Set<number>()
  for (const reference of request.references) {
    if (!Number.isInteger(reference.alias) || reference.alias <= 0 || aliases.has(reference.alias)) fail('Reference aliases must be unique positive integers')
    aliases.add(reference.alias)
    if (Boolean(reference.assetId) === Boolean(reference.url)) fail('Each reference must contain exactly one assetId or URL')
    if (reference.url) validateRemoteReferenceUrl(reference.url)
  }
  const counts = {
    image: request.references.filter((reference) => reference.mediaType === 'image').length,
    video: request.references.filter((reference) => reference.mediaType === 'video').length,
    audio: request.references.filter((reference) => reference.mediaType === 'audio').length,
  }
  if (counts.image > model.inputLimits.images) fail('Request exceeds the image reference limit')
  if (counts.video > model.inputLimits.videos) fail('Request exceeds the video reference limit')
  if (counts.audio > model.inputLimits.audios) fail('Request exceeds the audio reference limit')
  if (request.mediaType === 'video') {
    if (request.mode === 'text2video' && request.references.length > 0) fail('text2video does not accept references')
    if (request.mode === 'image2video' && counts.image < 1) fail('image2video requires at least one image')
    if (request.mode === 'frames2video' && (counts.image !== 2 || request.references.length !== 2)) {
      fail('frames2video requires exactly two images')
    }
  }
  return model
}
