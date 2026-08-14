import type { CatalogModel, ProviderCatalog } from '../../contracts/generation'
import { estimateModelCredits } from '../../contracts/catalog'
import type {
  MediaGenerationSettings,
  VideoGenerationSettings,
} from '../../model/project'
import { parsePromptReferenceMentions } from '../../model/project'

export type VideoReferenceRule = 'none' | 'at-least-one' | 'exactly-two'

export interface ResolvedVideoMode {
  value: string
  label: '文生视频' | '全能参考' | '首尾帧'
  referenceRule: VideoReferenceRule
}

export function canEditReferencesWithCatalog(
  catalog: ProviderCatalog | undefined,
): catalog is ProviderCatalog {
  return Boolean(catalog?.models.length)
}

export function modelCanGenerateAudio(
  model: Pick<CatalogModel, 'raw'>,
): boolean {
  return model.raw.supportsAudio === true || model.raw.generateAudio === true
}

function firstOr<T>(values: readonly T[], fallback: T): T {
  return values[0] ?? fallback
}

function includesValue<T>(values: readonly T[], value: T): boolean {
  return values.some((candidate) => candidate === value)
}

export function resolveVideoMode(value: string): ResolvedVideoMode | null {
  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_')
  if (
    normalized.includes('first_last') ||
    normalized.includes('start_end') ||
    normalized.includes('firstlast')
  ) {
    return { value, label: '首尾帧', referenceRule: 'exactly-two' }
  }
  if (
    normalized.includes('text2video') ||
    normalized.includes('text_to_video') ||
    normalized === 'text'
  ) {
    return { value, label: '文生视频', referenceRule: 'none' }
  }
  if (
    normalized.includes('image2video') ||
    normalized.includes('image_to_video') ||
    normalized.includes('reference')
  ) {
    return { value, label: '全能参考', referenceRule: 'at-least-one' }
  }
  return null
}

export function supportedVideoModes(model: CatalogModel): ResolvedVideoMode[] {
  return model.modes
    .map(resolveVideoMode)
    .filter((mode): mode is ResolvedVideoMode => mode !== null)
    .filter(
      (mode, index, modes) =>
        modes.findIndex((candidate) => candidate.label === mode.label) === index,
    )
}

export function normalizeSettingsForModel(
  settings: MediaGenerationSettings,
  model: CatalogModel,
  catalogVersion: string,
  providerId = settings.providerId ?? '',
): MediaGenerationSettings {
  const qualityValue = firstOr(
    model.qualityOptions.map((option) => option.value),
    settings.kind === 'image' ? settings.quality : settings.resolution,
  )
  const aspectRatio = includesValue(model.aspectRatios, settings.aspectRatio)
    ? settings.aspectRatio
    : firstOr(model.aspectRatios, settings.aspectRatio || 'Auto')
  const count = includesValue(model.countOptions, settings.count)
    ? settings.count
    : firstOr(model.countOptions, 1)

  if (settings.kind === 'image' && model.mediaType === 'image') {
    const quality = model.qualityOptions.some(
      (option) => option.value === settings.quality,
    )
      ? settings.quality
      : qualityValue
    return {
      ...settings,
      providerId,
      catalogVersion,
      channel: model.channel,
      model: model.model,
      mode: includesValue(model.modes, settings.mode ?? '')
        ? settings.mode
        : model.modes[0],
      quality,
      resolution: quality,
      aspectRatio,
      count,
    }
  }

  if (settings.kind === 'video' && model.mediaType === 'video') {
    const modes = supportedVideoModes(model)
    const selectedMode = modes.some((mode) => mode.value === settings.mode)
      ? settings.mode
      : modes[0]?.value
    const durationSec = includesValue(
      model.durationOptions,
      settings.durationSec,
    )
      ? settings.durationSec
      : firstOr(model.durationOptions, settings.durationSec || 1)
    return {
      ...settings,
      providerId,
      catalogVersion,
      channel: model.channel,
      model: model.model,
      mode: selectedMode,
      resolution: model.qualityOptions.some(
        (option) => option.value === settings.resolution,
      )
        ? settings.resolution
        : qualityValue,
      aspectRatio,
      durationSec,
      count,
    }
  }

  return settings
}

export function findInvalidMentionAliases(
  prompt: string,
  connectedAliases: readonly number[],
): number[] {
  const connected = new Set(connectedAliases)
  const invalid = new Set<number>()
  for (const { alias } of parsePromptReferenceMentions(prompt)) {
    if (!connected.has(alias)) {
      invalid.add(alias)
    }
  }
  return [...invalid].sort((left, right) => left - right)
}

export function estimateGenerationCredits(
  model: CatalogModel,
  settings: MediaGenerationSettings,
  referenceMediaTypes: readonly ('image' | 'video' | 'audio')[] = [],
): number {
  const quality =
    settings.kind === 'image' ? settings.quality : settings.resolution
  return estimateModelCredits(model, {
    quality,
    count: settings.count,
    duration: settings.kind === 'video' ? settings.durationSec : undefined,
    inputVideos: referenceMediaTypes.filter((kind) => kind === 'video').length,
  }) ?? 0
}

export interface GenerationUiValidationInput {
  settings: MediaGenerationSettings
  model: CatalogModel
  referenceAliases: readonly number[]
  references?: ReadonlyArray<{
    alias: number
    mediaType: 'image' | 'video' | 'audio'
  }>
  invalidMentionAliases: readonly number[]
  unresolvedReferences?: boolean
}

export interface GenerationUiValidation {
  valid: boolean
  message?: string
}

function videoModeValidation(
  settings: VideoGenerationSettings,
  model: CatalogModel,
  counts: { image: number; total: number },
): GenerationUiValidation | null {
  const mode = supportedVideoModes(model).find(
    (candidate) => candidate.value === settings.mode,
  )
  if (!mode) return { valid: false, message: '当前视频模式已不可用，请刷新目录' }
  if (mode.referenceRule === 'none' && counts.total > 0) {
    return { valid: false, message: '文生视频不能添加参考素材' }
  }
  if (mode.referenceRule === 'at-least-one' && counts.image < 1) {
    return { valid: false, message: '全能参考至少需要 1 张图片' }
  }
  if (mode.referenceRule === 'exactly-two' && (counts.image !== 2 || counts.total !== 2)) {
    return { valid: false, message: '首尾帧需要恰好 2 张图片' }
  }
  return null
}

export function validateGenerationUi(
  input: GenerationUiValidationInput,
): GenerationUiValidation {
  const { invalidMentionAliases, model, referenceAliases, settings } = input
  const references = input.references ?? referenceAliases.map((alias) => ({
    alias,
    mediaType: 'image' as const,
  }))
  const counts = {
    image: references.filter((reference) => reference.mediaType === 'image').length,
    video: references.filter((reference) => reference.mediaType === 'video').length,
    audio: references.filter((reference) => reference.mediaType === 'audio').length,
  }
  if (model.mediaType !== settings.kind) {
    return { valid: false, message: '当前模型与节点类型不匹配' }
  }
  if (input.unresolvedReferences) {
    return { valid: false, message: '存在已丢失的参考素材' }
  }
  if (counts.image > model.inputLimits.images) {
    return {
      valid: false,
      message: `当前模型最多支持 ${model.inputLimits.images} 张图片参考`,
    }
  }
  if (counts.video > model.inputLimits.videos) {
    return {
      valid: false,
      message: model.inputLimits.videos === 0
        ? '当前模型不支持视频参考'
        : `当前模型最多支持 ${model.inputLimits.videos} 个视频参考`,
    }
  }
  if (counts.audio > model.inputLimits.audios) {
    return {
      valid: false,
      message: model.inputLimits.audios === 0
        ? '当前模型不支持音频参考'
        : `当前模型最多支持 ${model.inputLimits.audios} 个音频参考`,
    }
  }
  if (settings.kind === 'video') {
    const modeError = videoModeValidation(
      settings,
      model,
      { image: counts.image, total: references.length },
    )
    if (modeError) return modeError
  }
  if (invalidMentionAliases.length > 0) {
    return {
      valid: false,
      message: `提示词中的 ${invalidMentionAliases
        .map((alias) => `@${alias}`)
        .join('、')} 没有对应参考`,
    }
  }
  return { valid: true }
}
