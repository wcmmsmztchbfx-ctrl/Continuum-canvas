import { createCanvasContentIndex } from './canvasContentIndex.ts'

export const PROJECT_SNAPSHOT_VERSION = 1 as const
export const CANVAS_SNAPSHOT_VERSION = 3 as const
export const LEGACY_CANVAS_SNAPSHOT_VERSION = 2 as const

export type CanvasNodeType =
  | 'image'
  | 'video'
  | 'text'
  | 'group'
  | 'frame'
  | 'shape'
  | 'path'

export interface Point {
  x: number
  y: number
}

export interface NodeSize {
  width: number
  height: number
}

export type GenerationStatus = 'generating' | 'complete' | 'failed'
export type GenerationPhase =
  | 'queued'
  | 'uploading'
  | 'submitted'
  | 'running'
  | 'downloading'
  | 'complete'
  | 'failed'

export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '1:2',
  '2:1',
  '9:16',
  '16:9',
  '3:4',
  '4:3',
  '3:2',
  '2:3',
  '5:4',
  '4:5',
  '21:9',
  '9:21',
] as const
export const VIDEO_ASPECT_RATIOS = [
  'Auto',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
  '21:9',
] as const
export const IMAGE_QUALITIES = ['low', 'standard', 'high'] as const
export const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const
export const VIDEO_RESOLUTIONS = ['480P', '720P', '1080P', '4K'] as const
export const GENERATION_COUNTS = [1, 2, 4] as const

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number]
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number]
export type ImageQuality = (typeof IMAGE_QUALITIES)[number]
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number]
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number]
export type GenerationCount = (typeof GENERATION_COUNTS)[number]

export interface GenerationProviderSettings {
  providerId?: string
  catalogVersion?: string
  channel?: string | number
  model?: string
  mode?: string
}

export interface ImageGenerationSettings extends GenerationProviderSettings {
  kind: 'image'
  quality: string
  resolution: string
  aspectRatio: string
  count: number
}

export interface VideoGenerationSettings extends GenerationProviderSettings {
  kind: 'video'
  resolution: string
  aspectRatio: string
  durationSec: number
  generateAudio: boolean
  count: number
}

export type MediaGenerationSettings =
  | ImageGenerationSettings
  | VideoGenerationSettings

export const DEFAULT_IMAGE_GENERATION_SETTINGS: ImageGenerationSettings = {
  kind: 'image',
  providerId: '',
  channel: '',
  model: '',
  mode: 'text2image',
  quality: 'standard',
  resolution: '2K',
  aspectRatio: '16:9',
  count: 1,
}

export const DEFAULT_VIDEO_GENERATION_SETTINGS: VideoGenerationSettings = {
  kind: 'video',
  providerId: '',
  channel: '',
  model: '',
  mode: 'image2video',
  resolution: '720P',
  aspectRatio: '16:9',
  durationSec: 5,
  generateAudio: true,
  count: 1,
}

// Resolve the default generation provider from the live provider list:
// preferred first, then any available provider, then the first record, and
// finally the historical hard-coded fallback when the gateway is unreachable.
export function resolveDefaultProviderId(
  providers?: ReadonlyArray<{ id: string; preferred?: boolean; available?: boolean }>,
): string {
  return providers?.find((provider) => provider.preferred)?.id
    ?? providers?.find((provider) => provider.available)?.id
    ?? providers?.[0]?.id
    ?? 'aistartlab'
}

export interface MediaGeneration {
  prompt: string
  status: GenerationStatus
  sourceNodeId?: string
  phase?: GenerationPhase
  jobId?: string
  clientRequestId?: string
  outputIndex?: number
  progress?: number
  providerId?: string
  upstreamTaskId?: string
  createdAt?: string
  error?: { code: string; message: string }
  outputs?: GenerationOutputAsset[]
  actualSettings?: MediaGenerationSettings
  outputAspectRatio?: string
  pendingRequest?: PendingGenerationRequest
}

export interface PendingGenerationRequest {
  projectId: string
  sourceNodeId: string
  outputs: Array<{ nodeId: string; outputIndex: number }>
  request: {
    clientRequestId: string
    projectId?: string
    canvasId?: string
    targetNodeId?: string
    providerId: string
    catalogVersion: string
    mediaType: 'image' | 'video'
    channel: string | number
    model: string
    prompt: string
    quality?: string
    aspectRatio?: string
    n?: number
    duration?: number
    generateAudio?: boolean
    mode?: string
    references: Array<{
      alias: number
      assetId?: string
      url?: string
      mediaType: 'image' | 'video' | 'audio'
    }>
  }
}

export interface GenerationOutputAsset {
  assetId: string
  url: string
  contentType: string
  size: number
}

interface BaseNode<TType extends CanvasNodeType, TData> {
  id: string
  type: TType
  name: string
  position: Point
  size: NodeSize
  parentId?: string
  hidden?: boolean
  locked?: boolean
  data: TData
}

export interface ImageVersion {
  id: string
  url: string
  assetId?: string
  createdAt: string
  label?: string
  sourceVersionId?: string
}

export interface MediaSource {
  nodeId?: string
  kind?: string
  timeSec?: number
  capture?: 'first' | 'current' | 'last'
}

export interface CanvasNodeEffectShadow {
  color: string
  x: number
  y: number
  blur: number
}

export type CanvasEffectType =
  | 'inner-shadow'
  | 'drop-shadow'
  | 'layer-blur'
  | 'background-blur'
  | 'noise'
  | 'texture'
  | 'glass'
  | 'shader'

export interface CanvasEffectItem {
  id: string
  type: CanvasEffectType
  enabled: boolean
  x?: number
  y?: number
  blur?: number
  spread?: number
  color?: string
  radius?: number
  intensity?: number
  specular?: number
  tint?: string
  preset?: string
}

export interface CanvasFillItem {
  id: string
  color: string
  opacity?: number
  enabled: boolean
}

export type CanvasStrokePosition = 'outside' | 'center' | 'inside'

export interface CanvasStrokeItem {
  id: string
  color: string
  width: number
  style?: 'solid' | 'dashed'
  opacity?: number
  enabled: boolean
  position?: CanvasStrokePosition
}

export interface ImageNodeData {
  url: string
  thumbnailUrl?: string
  assetId?: string
  alt?: string
  promptDraft?: string
  referenceNodeIds?: string[]
  unresolvedReferenceNodeIds?: string[]
  generation?: MediaGeneration
  fills?: CanvasFillItem[]
  strokes?: CanvasStrokeItem[]
  effects?: CanvasEffectItem[]
  generationSettings?: ImageGenerationSettings
  versions?: ImageVersion[]
  activeVersionId?: string
  source?: MediaSource
  displayMode?: 'generation' | 'layer'
  opacity?: number
  radius?: number
  stroke?: string
  strokeWidth?: number
  strokeStyle?: 'solid' | 'dashed'
  strokePosition?: CanvasStrokePosition
  blur?: number
  shadow?: CanvasNodeEffectShadow
  objectFit?: 'cover' | 'contain' | 'fill'
  rotation?: number
}

export type ImageNode = BaseNode<'image', ImageNodeData>

export interface VideoNodeData {
  url: string
  assetId?: string
  poster?: string
  promptDraft?: string
  durationSec?: number
  hasAudio?: boolean
  referenceNodeIds?: string[]
  unresolvedReferenceNodeIds?: string[]
  generation?: MediaGeneration
  generationSettings?: VideoGenerationSettings
  displayMode?: 'generation' | 'layer'
  opacity?: number
  radius?: number
  stroke?: string
  strokeWidth?: number
  strokeStyle?: 'solid' | 'dashed'
  strokePosition?: CanvasStrokePosition
  blur?: number
  shadow?: CanvasNodeEffectShadow
  fills?: CanvasFillItem[]
  strokes?: CanvasStrokeItem[]
  effects?: CanvasEffectItem[]
  objectFit?: 'cover' | 'contain' | 'fill'
  rotation?: number
}

export type VideoNode = BaseNode<'video', VideoNodeData>

export interface TextNodeData {
  text: string
  nodeKind?: 'text' | 'audio' | 'script' | 'skill'
  presentation?: 'plain' | 'workflow-card'
  autoWidth?: boolean
  assetId?: string
  url?: string
  fontFamily?: string
  fontSize?: number
  fontWeight?: number
  color?: string
  textAlign?: 'left' | 'center' | 'right'
  lineHeight?: number
  letterSpacing?: number
  opacity?: number
  rotation?: number
  stroke?: string
  strokeWidth?: number
  strokeStyle?: 'solid' | 'dashed'
  strokePosition?: CanvasStrokePosition
  blur?: number
  shadow?: CanvasNodeEffectShadow
  fills?: CanvasFillItem[]
  strokes?: CanvasStrokeItem[]
  effects?: CanvasEffectItem[]
}

export type TextNode = BaseNode<'text', TextNodeData>

export interface GroupNodeData {
  childIds: string[]
  nodeKind?: 'group' | 'director' | 'video-clip'
}

export type GroupNode = BaseNode<'group', GroupNodeData>

export interface FrameNodeData {
  childIds: string[]
  fill?: string
  stroke?: string
  strokeWidth?: number
  strokeStyle?: 'solid' | 'dashed'
  strokePosition?: CanvasStrokePosition
  opacity?: number
  blur?: number
  shadow?: CanvasNodeEffectShadow
  fills?: CanvasFillItem[]
  strokes?: CanvasStrokeItem[]
  effects?: CanvasEffectItem[]
  rotation?: number
  locked?: boolean
  hidden?: boolean
}

export type FrameNode = BaseNode<'frame', FrameNodeData>

export interface ShapeNodeData {
  kind: 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'line' | 'arrow'
  fill?: string
  stroke?: string
  strokeWidth?: number
  strokeStyle?: 'solid' | 'dashed'
  strokePosition?: CanvasStrokePosition
  opacity?: number
  blur?: number
  shadow?: CanvasNodeEffectShadow
  fills?: CanvasFillItem[]
  strokes?: CanvasStrokeItem[]
  effects?: CanvasEffectItem[]
  radius?: number
  rotation?: number
  locked?: boolean
  hidden?: boolean
}

export type ShapeNode = BaseNode<'shape', ShapeNodeData>

export interface PathAnchor {
  x: number
  y: number
  in?: Point
  out?: Point
}

export interface PathNodeData {
  kind: 'pen' | 'brush'
  anchors: PathAnchor[]
  closed: boolean
  fill?: string
  stroke?: string
  strokeWidth?: number
  strokeStyle?: 'solid' | 'dashed'
  strokePosition?: CanvasStrokePosition
  opacity?: number
  blur?: number
  shadow?: CanvasNodeEffectShadow
  fills?: CanvasFillItem[]
  strokes?: CanvasStrokeItem[]
  effects?: CanvasEffectItem[]
  locked?: boolean
  hidden?: boolean
}

export type PathNode = BaseNode<'path', PathNodeData>

export type CanvasNode =
  | ImageNode
  | VideoNode
  | TextNode
  | GroupNode
  | FrameNode
  | ShapeNode
  | PathNode
export interface CanvasEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  type?: string
  relation?: 'reference' | 'output' | 'flow' | 'skill'
  referenceAlias?: number
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface ProjectSnapshotV1 {
  version: typeof PROJECT_SNAPSHOT_VERSION
  projectId: string
  name: string
  viewport: Viewport
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export type ProjectSnapshot = ProjectSnapshotV1

export interface CanvasSnapshotV2 {
  version: typeof CANVAS_SNAPSHOT_VERSION
  canvasId: string
  projectId: string
  name: string
  viewport: Viewport
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPoint(value: unknown): boolean {
  return (
    isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y)
  )
}

function isSize(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    value.width > 0 &&
    value.height > 0 &&
    value.width <= 100_000 &&
    value.height <= 100_000
  )
}

function hasOptionalString(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string'
}

function hasOptionalStringArray(record: UnknownRecord, key: string): boolean {
  return (
    record[key] === undefined ||
    (Array.isArray(record[key]) &&
      record[key].every((item) => typeof item === 'string'))
  )
}

function validColor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function isImageVersion(value: unknown): value is ImageVersion {
  return isRecord(value) &&
    typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.url === 'string' &&
    hasOptionalString(value, 'assetId') &&
    typeof value.createdAt === 'string' &&
    hasOptionalString(value, 'label') &&
    hasOptionalString(value, 'sourceVersionId')
}

function hasOptionalImageVersions(record: UnknownRecord): boolean {
  if (record.versions === undefined && record.activeVersionId === undefined) return true
  if (!Array.isArray(record.versions) || !record.versions.every(isImageVersion)) return false
  if (record.versions.length === 0 || typeof record.activeVersionId !== 'string') return false
  const ids = new Set(record.versions.map((item) => (item as ImageVersion).id))
  return ids.size === record.versions.length && ids.has(record.activeVersionId)
}

function isMediaSource(value: unknown): boolean {
  return isRecord(value) && typeof value.nodeId === 'string' &&
    (value.kind === 'video-frame' || value.kind === 'image-edit') &&
    (value.timeSec === undefined || isFiniteNumber(value.timeSec)) &&
    (value.capture === undefined || ['first', 'current', 'last'].includes(String(value.capture)))
}

function isPathAnchor(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) &&
    (value.in === undefined || isPoint(value.in)) &&
    (value.out === undefined || isPoint(value.out))
}

function hasOptionalGeneration(record: UnknownRecord): boolean {
  if (record.generation === undefined) return true
  if (!isRecord(record.generation)) return false

  const generation = record.generation
  const validError =
    generation.error === undefined ||
    (isRecord(generation.error) &&
      typeof generation.error.code === 'string' &&
      typeof generation.error.message === 'string')
  const validOutputs =
    generation.outputs === undefined ||
    (Array.isArray(generation.outputs) &&
      generation.outputs.every(
        (output) =>
          isRecord(output) &&
          typeof output.assetId === 'string' &&
          typeof output.url === 'string' &&
          typeof output.contentType === 'string' &&
          isFiniteNumber(output.size) &&
          output.size >= 0,
      ))
  const phases: readonly GenerationPhase[] = [
    'queued',
    'uploading',
    'submitted',
    'running',
    'downloading',
    'complete',
    'failed',
  ]
  const validPendingRequest =
    generation.pendingRequest === undefined ||
    (isPendingGenerationRequest(generation.pendingRequest) &&
      generation.pendingRequest.sourceNodeId === generation.sourceNodeId &&
      generation.pendingRequest.request.clientRequestId ===
        generation.clientRequestId)

  return (
    typeof generation.prompt === 'string' &&
    (generation.status === 'generating' ||
      generation.status === 'complete' ||
      generation.status === 'failed') &&
    (generation.phase === undefined || phases.includes(generation.phase as GenerationPhase)) &&
    hasOptionalString(generation, 'jobId') &&
    hasOptionalString(generation, 'clientRequestId') &&
    hasOptionalString(generation, 'sourceNodeId') &&
    hasOptionalString(generation, 'providerId') &&
    hasOptionalString(generation, 'upstreamTaskId') &&
    hasOptionalString(generation, 'createdAt') &&
    hasOptionalString(generation, 'outputAspectRatio') &&
    (generation.progress === undefined ||
      (isFiniteNumber(generation.progress) &&
        generation.progress >= 0 &&
        generation.progress <= 100)) &&
    (generation.outputIndex === undefined ||
      (isFiniteNumber(generation.outputIndex) &&
        Number.isInteger(generation.outputIndex) &&
        generation.outputIndex >= 0)) &&
    validError &&
    validOutputs &&
    validPendingRequest &&
    (generation.actualSettings === undefined ||
      isMediaGenerationSettings(generation.actualSettings))
  )
}

function isPendingGenerationRequest(value: unknown): value is PendingGenerationRequest {
  if (
    !isRecord(value) ||
    typeof value.projectId !== 'string' ||
    typeof value.sourceNodeId !== 'string' ||
    !Array.isArray(value.outputs) ||
    !isRecord(value.request)
  ) {
    return false
  }
  if (
    value.outputs.length === 0 ||
    value.outputs.some(
      (output) =>
        !isRecord(output) ||
        typeof output.nodeId !== 'string' ||
        !isFiniteNumber(output.outputIndex) ||
        !Number.isInteger(output.outputIndex) ||
        output.outputIndex < 0,
    )
  ) {
    return false
  }
  const request = value.request
  return (
    typeof request.clientRequestId === 'string' &&
    (request.projectId === undefined || typeof request.projectId === 'string') &&
    hasOptionalString(request, 'canvasId') &&
    hasOptionalString(request, 'targetNodeId') &&
    typeof request.providerId === 'string' &&
    typeof request.catalogVersion === 'string' &&
    (request.mediaType === 'image' || request.mediaType === 'video') &&
    (typeof request.channel === 'string' || isFiniteNumber(request.channel)) &&
    typeof request.model === 'string' &&
    typeof request.prompt === 'string' &&
    hasOptionalString(request, 'quality') &&
    hasOptionalString(request, 'aspectRatio') &&
    hasOptionalString(request, 'mode') &&
    (request.n === undefined || isPositiveCount(request.n)) &&
    (request.duration === undefined ||
      (isFiniteNumber(request.duration) && request.duration > 0)) &&
    (request.generateAudio === undefined || typeof request.generateAudio === 'boolean') &&
    Array.isArray(request.references) &&
    request.references.every(
      (reference) =>
        isRecord(reference) &&
        isFiniteNumber(reference.alias) &&
        Number.isInteger(reference.alias) &&
        reference.alias > 0 &&
        (typeof reference.assetId === 'string' ||
          typeof reference.url === 'string') &&
        (reference.mediaType === 'image' ||
          reference.mediaType === 'video' ||
          reference.mediaType === 'audio'),
    )
  )
}

function hasProjectConsistentPendingRequests(
  nodes: CanvasNode[],
  projectId: string,
): boolean {
  return nodes.every((node) => {
    if (node.type !== 'image' && node.type !== 'video') return true
    const pending = node.data.generation?.pendingRequest
    if (!pending) return true
    return (
      pending.projectId === projectId &&
      (pending.request.projectId === undefined || pending.request.projectId === projectId)
    )
  })
}

function hasProviderSettings(settings: UnknownRecord): boolean {
  return (
    hasOptionalString(settings, 'providerId') &&
    hasOptionalString(settings, 'catalogVersion') &&
    (settings.channel === undefined ||
      typeof settings.channel === 'string' ||
      isFiniteNumber(settings.channel)) &&
    hasOptionalString(settings, 'model') &&
    hasOptionalString(settings, 'mode')
  )
}

function isPositiveCount(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 1 && value <= 16
}

function isMediaGenerationSettings(value: unknown): value is MediaGenerationSettings {
  if (!isRecord(value) || !hasProviderSettings(value)) return false
  if (value.kind === 'image') {
    return (
      typeof value.quality === 'string' &&
      value.quality.length > 0 &&
      typeof value.resolution === 'string' &&
      value.resolution.length > 0 &&
      typeof value.aspectRatio === 'string' &&
      value.aspectRatio.length > 0 &&
      isPositiveCount(value.count)
    )
  }
  return (
    value.kind === 'video' &&
    typeof value.resolution === 'string' &&
    value.resolution.length > 0 &&
    typeof value.aspectRatio === 'string' &&
    value.aspectRatio.length > 0 &&
    isFiniteNumber(value.durationSec) &&
    value.durationSec > 0 &&
    value.durationSec <= 600 &&
    typeof value.generateAudio === 'boolean' &&
    isPositiveCount(value.count)
  )
}

function hasOptionalImageGenerationSettings(record: UnknownRecord) {
  if (record.generationSettings === undefined) return true
  const settings = record.generationSettings
  return isMediaGenerationSettings(settings) && settings.kind === 'image'
}

function hasOptionalVideoGenerationSettings(record: UnknownRecord) {
  if (record.generationSettings === undefined) return true
  const settings = record.generationSettings
  return isMediaGenerationSettings(settings) && settings.kind === 'video'
}

function hasOptionalStrokeStyle(record: UnknownRecord): boolean {
  return record.strokeStyle === undefined || ['solid', 'dashed'].includes(String(record.strokeStyle))
}

function hasOptionalStrokePosition(record: UnknownRecord): boolean {
  return record.strokePosition === undefined || ['outside', 'center', 'inside'].includes(String(record.strokePosition))
}

function isCanvasStrokeItem(value: unknown): value is CanvasStrokeItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.color === undefined || typeof value.color === 'string') &&
    (value.width === undefined || (isFiniteNumber(value.width) && value.width >= 0)) &&
    (value.enabled === undefined || typeof value.enabled === 'boolean') &&
    (value.style === undefined || ['solid', 'dashed'].includes(value.style as string)) &&
    (value.position === undefined || ['outside', 'center', 'inside'].includes(value.position as string)) &&
    (value.opacity === undefined || (isFiniteNumber(value.opacity) && value.opacity >= 0 && value.opacity <= 1))
  )
}

function hasOptionalStrokes(record: UnknownRecord): boolean {
  if (record.strokes === undefined) return true
  return Array.isArray(record.strokes) && record.strokes.every(isCanvasStrokeItem)
}

function isCanvasFillItem(value: unknown): value is CanvasFillItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.color === 'string' &&
    (value.enabled === undefined || typeof value.enabled === 'boolean') &&
    (value.opacity === undefined || (isFiniteNumber(value.opacity) && value.opacity >= 0 && value.opacity <= 1))
  )
}

function hasOptionalFills(record: UnknownRecord): boolean {
  if (record.fills === undefined) return true
  return Array.isArray(record.fills) && record.fills.every(isCanvasFillItem)
}

function isCanvasEffectItem(value: unknown): value is CanvasEffectItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    (value.enabled === undefined || typeof value.enabled === 'boolean')
  )
}

function hasOptionalEffects(record: UnknownRecord): boolean {
  if (record.effects === undefined) return true
  return Array.isArray(record.effects) && record.effects.every(isCanvasEffectItem)
}

function hasOptionalBlur(record: UnknownRecord): boolean {
  return record.blur === undefined || (isFiniteNumber(record.blur) && record.blur >= 0)
}

function hasOptionalShadow(record: UnknownRecord): boolean {
  if (record.shadow === undefined) return true
  if (!isRecord(record.shadow)) return false
  return (
    validColor(record.shadow.color) &&
    isFiniteNumber(record.shadow.x) &&
    isFiniteNumber(record.shadow.y) &&
    isFiniteNumber(record.shadow.blur) &&
    record.shadow.blur >= 0
  )
}

function isCanvasNode(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !isPoint(value.position) ||
    !isSize(value.size) ||
    !hasOptionalString(value, 'parentId') ||
    (value.hidden !== undefined && typeof value.hidden !== 'boolean') ||
    (value.locked !== undefined && typeof value.locked !== 'boolean') ||
    !isRecord(value.data)
  ) {
    return false
  }

  switch (value.type) {
    case 'image':
      return (
        typeof value.data.url === 'string' &&
        hasOptionalString(value.data, 'thumbnailUrl') &&
        hasOptionalString(value.data, 'assetId') &&
        hasOptionalString(value.data, 'alt') &&
        hasOptionalString(value.data, 'promptDraft') &&
        hasOptionalStringArray(value.data, 'referenceNodeIds') &&
        hasOptionalStringArray(value.data, 'unresolvedReferenceNodeIds') &&
        hasOptionalGeneration(value.data) &&
        hasOptionalImageGenerationSettings(value.data) &&
        hasOptionalImageVersions(value.data) &&
        (value.data.source === undefined || isMediaSource(value.data.source)) &&
        (value.data.displayMode === undefined || value.data.displayMode === 'generation' || value.data.displayMode === 'layer') &&
        (value.data.opacity === undefined || (isFiniteNumber(value.data.opacity) && value.data.opacity >= 0 && value.data.opacity <= 1)) &&
        (value.data.radius === undefined || (isFiniteNumber(value.data.radius) && value.data.radius >= 0)) &&
        (value.data.stroke === undefined || value.data.stroke === '' || validColor(value.data.stroke)) &&
        (value.data.strokeWidth === undefined || (isFiniteNumber(value.data.strokeWidth) && value.data.strokeWidth >= 0)) &&
        (value.data.objectFit === undefined || ['cover', 'contain', 'fill'].includes(String(value.data.objectFit))) &&
        (value.data.rotation === undefined || isFiniteNumber(value.data.rotation)) &&
        hasOptionalStrokeStyle(value.data) &&
        hasOptionalStrokePosition(value.data) &&
        hasOptionalStrokes(value.data) &&
        hasOptionalFills(value.data) &&
        hasOptionalEffects(value.data) &&
        hasOptionalBlur(value.data) &&
        hasOptionalShadow(value.data)
      )
    case 'video':
      return (
        typeof value.data.url === 'string' &&
        hasOptionalString(value.data, 'assetId') &&
        hasOptionalString(value.data, 'poster') &&
        hasOptionalString(value.data, 'promptDraft') &&
        (value.data.durationSec === undefined ||
          isFiniteNumber(value.data.durationSec)) &&
        (value.data.hasAudio === undefined ||
          typeof value.data.hasAudio === 'boolean') &&
        hasOptionalStringArray(value.data, 'referenceNodeIds') &&
        hasOptionalStringArray(value.data, 'unresolvedReferenceNodeIds') &&
        hasOptionalGeneration(value.data) &&
        hasOptionalVideoGenerationSettings(value.data) &&
        (value.data.displayMode === undefined || value.data.displayMode === 'generation' || value.data.displayMode === 'layer') &&
        (value.data.opacity === undefined || (isFiniteNumber(value.data.opacity) && value.data.opacity >= 0 && value.data.opacity <= 1)) &&
        (value.data.radius === undefined || (isFiniteNumber(value.data.radius) && value.data.radius >= 0)) &&
        (value.data.stroke === undefined || value.data.stroke === '' || validColor(value.data.stroke)) &&
        (value.data.strokeWidth === undefined || (isFiniteNumber(value.data.strokeWidth) && value.data.strokeWidth >= 0)) &&
        (value.data.objectFit === undefined || ['cover', 'contain', 'fill'].includes(String(value.data.objectFit))) &&
        (value.data.rotation === undefined || isFiniteNumber(value.data.rotation)) &&
        hasOptionalStrokeStyle(value.data) &&
        hasOptionalStrokePosition(value.data) &&
        hasOptionalStrokes(value.data) &&
        hasOptionalFills(value.data) &&
        hasOptionalEffects(value.data) &&
        hasOptionalBlur(value.data) &&
        hasOptionalShadow(value.data)
      )
    case 'text':
      return (
        typeof value.data.text === 'string' &&
        hasOptionalString(value.data, 'assetId') &&
        hasOptionalString(value.data, 'url') &&
        (value.data.nodeKind === undefined ||
          value.data.nodeKind === 'text' ||
          value.data.nodeKind === 'audio' ||
          value.data.nodeKind === 'script' ||
          value.data.nodeKind === 'skill') &&
        (value.data.presentation === undefined || value.data.presentation === 'plain' || value.data.presentation === 'workflow-card') &&
        (value.data.autoWidth === undefined || typeof value.data.autoWidth === 'boolean') &&
        hasOptionalString(value.data, 'fontFamily') &&
        (value.data.fontSize === undefined || (isFiniteNumber(value.data.fontSize) && value.data.fontSize > 0)) &&
        (value.data.fontWeight === undefined || (isFiniteNumber(value.data.fontWeight) && value.data.fontWeight > 0)) &&
        (value.data.color === undefined || validColor(value.data.color)) &&
        (value.data.textAlign === undefined || ['left', 'center', 'right'].includes(String(value.data.textAlign))) &&
        (value.data.lineHeight === undefined || (isFiniteNumber(value.data.lineHeight) && value.data.lineHeight > 0)) &&
        (value.data.opacity === undefined || (isFiniteNumber(value.data.opacity) && value.data.opacity >= 0 && value.data.opacity <= 1)) &&
        (value.data.rotation === undefined || isFiniteNumber(value.data.rotation)) &&
        (value.data.stroke === undefined || value.data.stroke === '' || validColor(value.data.stroke)) &&
        (value.data.strokeWidth === undefined || (isFiniteNumber(value.data.strokeWidth) && value.data.strokeWidth >= 0)) &&
        hasOptionalStrokeStyle(value.data) &&
        hasOptionalStrokePosition(value.data) &&
        hasOptionalStrokes(value.data) &&
        hasOptionalFills(value.data) &&
        hasOptionalEffects(value.data) &&
        hasOptionalBlur(value.data) &&
        hasOptionalShadow(value.data)
      )
    case 'group':
      return (
        Array.isArray(value.data.childIds) &&
        value.data.childIds.every((id) => typeof id === 'string') &&
        (value.data.nodeKind === undefined ||
          value.data.nodeKind === 'group' ||
          value.data.nodeKind === 'director' ||
          value.data.nodeKind === 'video-clip')
      )
    case 'frame':
      return (
        Array.isArray(value.data.childIds) &&
        value.data.childIds.every((id) => typeof id === 'string') &&
        (value.data.fill === undefined || validColor(value.data.fill)) &&
        (value.data.stroke === undefined || value.data.stroke === '' || validColor(value.data.stroke)) &&
        (value.data.strokeWidth === undefined || (isFiniteNumber(value.data.strokeWidth) && value.data.strokeWidth >= 0)) &&
        (value.data.rotation === undefined || isFiniteNumber(value.data.rotation)) &&
        (value.data.opacity === undefined || (isFiniteNumber(value.data.opacity) && value.data.opacity >= 0 && value.data.opacity <= 1)) &&
        hasOptionalStrokeStyle(value.data) &&
        hasOptionalStrokePosition(value.data) &&
        hasOptionalStrokes(value.data) &&
        hasOptionalFills(value.data) &&
        hasOptionalEffects(value.data) &&
        hasOptionalBlur(value.data) &&
        hasOptionalShadow(value.data) &&
        (value.data.locked === undefined || typeof value.data.locked === 'boolean') &&
        (value.data.hidden === undefined || typeof value.data.hidden === 'boolean')
      )
    case 'shape':
      return (
        ['rectangle', 'rounded-rectangle', 'ellipse', 'line', 'arrow'].includes(String(value.data.kind)) &&
        (value.data.fill === undefined || validColor(value.data.fill)) &&
        (value.data.stroke === undefined || value.data.stroke === '' || validColor(value.data.stroke)) &&
        (value.data.strokeWidth === undefined || (isFiniteNumber(value.data.strokeWidth) && value.data.strokeWidth >= 0)) &&
        (value.data.opacity === undefined || (isFiniteNumber(value.data.opacity) && value.data.opacity >= 0 && value.data.opacity <= 1)) &&
        hasOptionalStrokeStyle(value.data) &&
        hasOptionalStrokePosition(value.data) &&
        hasOptionalStrokes(value.data) &&
        hasOptionalFills(value.data) &&
        hasOptionalEffects(value.data) &&
        hasOptionalBlur(value.data) &&
        hasOptionalShadow(value.data) &&
        (value.data.radius === undefined || (isFiniteNumber(value.data.radius) && value.data.radius >= 0)) &&
        (value.data.rotation === undefined || isFiniteNumber(value.data.rotation)) &&
        (value.data.locked === undefined || typeof value.data.locked === 'boolean') &&
        (value.data.hidden === undefined || typeof value.data.hidden === 'boolean')
      )
    case 'path':
      return (
        (value.data.kind === 'pen' || value.data.kind === 'brush') &&
        Array.isArray(value.data.anchors) && value.data.anchors.length >= 2 &&
        value.data.anchors.every(isPathAnchor) && typeof value.data.closed === 'boolean' &&
        (value.data.fill === undefined || validColor(value.data.fill)) &&
        (value.data.stroke === undefined || value.data.stroke === '' || validColor(value.data.stroke)) &&
        (value.data.strokeWidth === undefined || (isFiniteNumber(value.data.strokeWidth) && value.data.strokeWidth >= 0)) &&
        (value.data.opacity === undefined || (isFiniteNumber(value.data.opacity) && value.data.opacity >= 0 && value.data.opacity <= 1)) &&
        hasOptionalStrokeStyle(value.data) &&
        hasOptionalStrokePosition(value.data) &&
        hasOptionalStrokes(value.data) &&
        hasOptionalFills(value.data) &&
        hasOptionalEffects(value.data) &&
        hasOptionalBlur(value.data) &&
        hasOptionalShadow(value.data) &&
        (value.data.locked === undefined || typeof value.data.locked === 'boolean') &&
        (value.data.hidden === undefined || typeof value.data.hidden === 'boolean')
      )
    default:
      return false
  }
}

function isCanvasEdge(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.source === 'string' &&
    typeof value.target === 'string' &&
    hasOptionalString(value, 'sourceHandle') &&
    hasOptionalString(value, 'targetHandle') &&
    hasOptionalString(value, 'type') &&
    (value.relation === undefined ||
      value.relation === 'reference' ||
      value.relation === 'output' ||
      value.relation === 'flow' ||
      value.relation === 'skill') &&
    (value.referenceAlias === undefined ||
      (isFiniteNumber(value.referenceAlias) &&
        Number.isInteger(value.referenceAlias) &&
        value.referenceAlias > 0))
  )
}

function nextReferenceAlias(used: Set<number>): number {
  let alias = 1
  while (used.has(alias)) alias += 1
  used.add(alias)
  return alias
}

function inferredNodeKind(node: CanvasNode): CanvasNode {
  if (node.type === 'text' && node.data.nodeKind === undefined) {
    const nodeKind =
      node.name === '音频节点'
        ? 'audio'
        : node.name === '脚本节点'
          ? 'script'
          : 'text'
    return { ...node, data: { ...node.data, nodeKind } }
  }
  if (node.type === 'group' && node.data.nodeKind === undefined) {
    const nodeKind =
      node.name === '导演台'
        ? 'director'
        : node.name === '视频合成'
          ? 'video-clip'
          : 'group'
    return { ...node, data: { ...node.data, nodeKind } }
  }
  return node
}

function withoutLegacyReferenceIds(
  node: CanvasNode,
  nodeIds: ReadonlySet<string>,
): CanvasNode {
  if (node.type !== 'image' && node.type !== 'video') return node
  const { referenceNodeIds: _legacy, ...data } = node.data
  const unresolvedReferenceNodeIds = [
    ...(node.data.unresolvedReferenceNodeIds ?? []),
    ...(node.data.referenceNodeIds ?? []).filter((id) => !nodeIds.has(id)),
  ].filter((id, index, values) => values.indexOf(id) === index)
  return {
    ...node,
    data: {
      ...data,
      ...(unresolvedReferenceNodeIds.length > 0
        ? { unresolvedReferenceNodeIds }
        : {}),
    },
  } as CanvasNode
}

type NormalizableSnapshot = ProjectSnapshotV1 | CanvasSnapshotV2

export function normalizeCanvasHierarchy(nodes: readonly CanvasNode[]): CanvasNode[] {
  const sourceById = new Map(nodes.map(node => [node.id, node]))
  const ids = new Set(nodes.map((node) => node.id))
  const containers = new Set(nodes.flatMap((node) =>
    node.type === 'frame' || node.type === 'group' ? [node.id] : [],
  ))
  const parentById = new Map<string, string | undefined>()

  for (const node of nodes) {
    const candidate = node.parentId
    if (!candidate || candidate === node.id || !ids.has(candidate) || !containers.has(candidate)) {
      parentById.set(node.id, undefined)
      continue
    }
    const visited = new Set([node.id])
    let cursor: string | undefined = candidate
    let cyclic = false
    while (cursor) {
      if (visited.has(cursor)) {
        cyclic = true
        break
      }
      visited.add(cursor)
      cursor = parentById.get(cursor) ?? sourceById.get(cursor)?.parentId
    }
    parentById.set(node.id, cyclic ? undefined : candidate)
  }

  const childrenByParent = new Map<string | undefined, string[]>()
  for (const node of nodes) {
    const parentId = parentById.get(node.id)
    const siblings = childrenByParent.get(parentId) ?? []
    siblings.push(node.id)
    childrenByParent.set(parentId, siblings)
  }

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const normalized = new Map<string, CanvasNode>()
  for (const node of nodes) {
    const parentId = parentById.get(node.id)
    const legacyHidden = Boolean(node.data && 'hidden' in node.data && node.data.hidden === true)
    const legacyLocked = Boolean(node.data && 'locked' in node.data && node.data.locked === true)
    const childIds = childrenByParent.get(node.id) ?? []
    const childrenUnchanged = (node.type !== 'frame' && node.type !== 'group') ||
      (Array.isArray(node.data.childIds) && node.data.childIds.length === childIds.length && node.data.childIds.every((id, i) => id === childIds[i]))
    if (node.parentId === parentId && node.hidden === ((node.hidden ?? legacyHidden) || undefined) &&
      node.locked === ((node.locked ?? legacyLocked) || undefined) && childrenUnchanged) {
      normalized.set(node.id, node)
      continue
    }
    const { parentId: _legacyParentId, ...nodeWithoutParent } = node
    const base = {
      ...nodeWithoutParent,
      ...(parentId ? { parentId } : {}),
      ...((node.hidden ?? legacyHidden) ? { hidden: true } : { hidden: undefined }),
      ...((node.locked ?? legacyLocked) ? { locked: true } : { locked: undefined }),
    } as CanvasNode
    normalized.set(node.id, node.type === 'frame' || node.type === 'group'
      ? { ...base, data: { ...base.data, childIds: childrenByParent.get(node.id) ?? [] } } as CanvasNode
      : base)
  }

  const ordered: CanvasNode[] = []
  const visitedSet = new Set<string>()
  const visit = (id: string) => {
    if (visitedSet.has(id)) return
    const node = normalized.get(id)
    if (!node) return
    visitedSet.add(id)
    ordered.push(node)
    if (node.type === 'frame' || node.type === 'group') {
      for (const childId of (node.data.childIds ?? [])) visit(childId)
    }
  }
  for (const id of childrenByParent.get(undefined) ?? []) visit(id)
  for (const id of byId.keys()) visit(id)
  return ordered
}

function normalizeProjectSnapshot<TSnapshot extends NormalizableSnapshot>(
  snapshot: TSnapshot,
): TSnapshot {
  const originalNodeById = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const legacyReferences = new Map<string, string[]>()
  for (const node of snapshot.nodes) {
    if (node.type === 'image' || node.type === 'video') {
      legacyReferences.set(node.id, [...(node.data.referenceNodeIds ?? [])])
    }
  }

  const edges = snapshot.edges.map((edge) => {
    if (edge.relation !== undefined) return { ...edge }
    const target = originalNodeById.get(edge.target)
    const legacyIds = legacyReferences.get(edge.target) ?? []
    const isLegacyReference = legacyIds.includes(edge.source)
    const isLegacyOutput =
      (target?.type === 'image' || target?.type === 'video') &&
      target.data.generation?.sourceNodeId === edge.source
    return {
      ...edge,
      relation: isLegacyReference
        ? 'reference' as const
        : isLegacyOutput
          ? 'output' as const
          : 'flow' as const,
    }
  })

  const usedAliasesByTarget = new Map<string, Set<number>>()
  for (const edge of edges) {
    if (edge.relation !== 'reference' || edge.referenceAlias === undefined) continue
    const used = usedAliasesByTarget.get(edge.target) ?? new Set<number>()
    if (used.has(edge.referenceAlias)) {
      delete edge.referenceAlias
    } else {
      used.add(edge.referenceAlias)
    }
    usedAliasesByTarget.set(edge.target, used)
  }

  const existingIds = new Set(edges.map((edge) => edge.id))
  for (const [targetId, sourceIds] of legacyReferences) {
    const used = usedAliasesByTarget.get(targetId) ?? new Set<number>()
    usedAliasesByTarget.set(targetId, used)
    for (const sourceId of sourceIds) {
      if (!originalNodeById.has(sourceId)) continue
      const matches = edges.filter(
        (edge) => edge.source === sourceId && edge.target === targetId,
      )
      if (matches.some((edge) => edge.relation === 'output')) continue
      let reference = matches.find((edge) => edge.relation === 'reference')
      if (!reference) {
        reference = matches.find((edge) => edge.relation === 'flow')
        if (reference) reference.relation = 'reference'
      }
      if (!reference) {
        const baseId = `migration-reference-${targetId}-${sourceId}`
        let id = baseId
        let suffix = 2
        while (existingIds.has(id)) {
          id = `${baseId}-${suffix}`
          suffix += 1
        }
        existingIds.add(id)
        reference = { id, source: sourceId, target: targetId, relation: 'reference' }
        edges.push(reference)
      }
      reference.referenceAlias ??= nextReferenceAlias(used)
    }
  }

  for (const edge of edges) {
    if (edge.relation !== 'reference' || edge.referenceAlias !== undefined) continue
    const used = usedAliasesByTarget.get(edge.target) ?? new Set<number>()
    usedAliasesByTarget.set(edge.target, used)
    edge.referenceAlias = nextReferenceAlias(used)
  }

  const outputSourcesByTarget = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (edge.relation !== 'output') continue
    const sources = outputSourcesByTarget.get(edge.target) ?? new Set<string>()
    sources.add(edge.source)
    outputSourcesByTarget.set(edge.target, sources)
  }
  const nodeIds = new Set(originalNodeById.keys())
  const nodes = normalizeCanvasHierarchy(snapshot.nodes.map((node) => {
    const normalized = withoutLegacyReferenceIds(inferredNodeKind(node), nodeIds)
    if (
      normalized.type !== 'image' &&
      normalized.type !== 'video'
    ) {
      return normalized
    }
    const generation = normalized.data.generation
    const outputSources = outputSourcesByTarget.get(normalized.id)
    if (
      !generation ||
      generation.sourceNodeId !== undefined ||
      outputSources?.size !== 1
    ) {
      return normalized
    }
    return {
      ...normalized,
      data: {
        ...normalized.data,
        generation: {
          ...generation,
          sourceNodeId: [...outputSources][0],
        },
      },
    } as CanvasNode
  }))

  return {
    ...snapshot,
    nodes,
    edges,
  } as TSnapshot
}

function hasSaneViewport(viewport: UnknownRecord): boolean {
  return (
    isFiniteNumber(viewport.x) &&
    isFiniteNumber(viewport.y) &&
    isFiniteNumber(viewport.zoom) &&
    Math.abs(viewport.x) <= 10_000_000 &&
    Math.abs(viewport.y) <= 10_000_000 &&
    viewport.zoom >= 0.01 &&
    viewport.zoom <= 8
  )
}


function legacyVersionId(nodeId: string): string {
  return `original:${nodeId}`
}

function migrateImageVersions(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((node) => {
    if (node.type !== 'image' || node.data.versions?.length) return node
    const id = legacyVersionId(node.id)
    return {
      ...node,
      data: {
        ...node.data,
        versions: [{
          id,
          url: node.data.url,
          ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
          createdAt: '1970-01-01T00:00:00.000Z',
          label: '原始版本',
        }],
        activeVersionId: id,
      },
    }
  })
}

function hasValidGraph(nodes: CanvasNode[], edges: CanvasEdge[]): boolean {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edgeIds = new Set(edges.map((edge) => edge.id))
  if (nodeIds.size !== nodes.length || edgeIds.size !== edges.length) return false
  if (nodes.some((node) => !node.id || !node.name)) return false

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    if (node.parentId) {
      const parent = nodeById.get(node.parentId)
      if (!parent || (parent.type !== 'group' && parent.type !== 'frame') || parent.id === node.id) return false
    }
    if (
      (node.type === 'group' || node.type === 'frame') &&
      (new Set(node.data.childIds).size !== node.data.childIds.length ||
        node.data.childIds.some((childId) => !nodeIds.has(childId) || childId === node.id))
    ) {
      return false
    }
    const seen = new Set([node.id])
    let cursor = node.parentId
    while (cursor) {
      if (seen.has(cursor)) return false
      seen.add(cursor)
      cursor = nodeById.get(cursor)?.parentId
    }
    if (node.parentId) {
      const parent = nodeById.get(node.parentId)
      if (!parent || (parent.type !== 'frame' && parent.type !== 'group') || !parent.data.childIds.includes(node.id)) return false
    }
  }

  return edges.every(
    (edge) =>
      edge.id.length > 0 &&
      nodeIds.has(edge.source) &&
      nodeIds.has(edge.target),
  )
}

export interface OrderedReference {
  edge: CanvasEdge & { relation: 'reference'; referenceAlias: number }
  node: CanvasNode
}

export function getOrderedReferences(
  snapshot: ProjectSnapshot,
  targetNodeId: string,
): OrderedReference[] {
  return [...createCanvasContentIndex(snapshot.nodes, snapshot.edges).orderedReferences(targetNodeId)]
}

export interface PromptReferenceValidation {
  mentionedAliases: number[]
  resolvedAliases: number[]
  unresolvedAliases: number[]
  valid: boolean
}

export interface PromptReferenceMention {
  alias: number
  index: number
  token: string
}

export function parsePromptReferenceMentions(
  prompt: string,
): PromptReferenceMention[] {
  const mentions: PromptReferenceMention[] = []
  for (const match of prompt.matchAll(/(^|[^\w])@(\d+)\b/g)) {
    const prefix = match[1] ?? ''
    const token = `@${match[2]}`
    mentions.push({
      alias: Number(match[2]),
      index: (match.index ?? 0) + prefix.length,
      token,
    })
  }
  return mentions
}

export function validatePromptReferences(
  prompt: string,
  availableAliases: Iterable<number>,
): PromptReferenceValidation {
  const mentionedAliases: number[] = []
  const seen = new Set<number>()
  for (const { alias } of parsePromptReferenceMentions(prompt)) {
    if (!seen.has(alias)) {
      seen.add(alias)
      mentionedAliases.push(alias)
    }
  }
  const available = new Set(availableAliases)
  const resolvedAliases = mentionedAliases.filter((alias) => available.has(alias))
  const unresolvedAliases = mentionedAliases.filter((alias) => !available.has(alias))
  return {
    mentionedAliases,
    resolvedAliases,
    unresolvedAliases,
    valid: unresolvedAliases.length === 0,
  }
}

export function compactPromptReferences(
  prompt: string,
  removedAlias: number,
): string {
  if (!prompt || typeof prompt !== 'string') return ''
  const transformed = prompt.replace(/(^|[^\w])@(\d+)\b/g, (match, prefix, numStr) => {
    const num = Number(numStr)
    if (num === removedAlias) {
      return prefix === ' ' ? '' : prefix
    }
    if (num > removedAlias) {
      return `${prefix}@${num - 1}`
    }
    return match
  })
  return transformed
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^ +| +$/g, '')
    .trim()
}

export function parseProjectSnapshot(serialized: string): ProjectSnapshot {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('Invalid project snapshot JSON')
  }

  if (isRecord(value) && value.version !== PROJECT_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported project snapshot version: ${String(value.version)}`)
  }

  if (isRecord(value) && Array.isArray(value.nodes) && value.nodes.every(isCanvasNode)) {
    const ids = (value.nodes as CanvasNode[]).map((node) => node.id)
    if (new Set(ids).size === ids.length) value = { ...value, nodes: normalizeCanvasHierarchy(value.nodes as CanvasNode[]) }
  }

  if (
    !isRecord(value) ||
    value.version !== PROJECT_SNAPSHOT_VERSION ||
    typeof value.projectId !== 'string' ||
    typeof value.name !== 'string' ||
    !isRecord(value.viewport) ||
    !hasSaneViewport(value.viewport) ||
    !Array.isArray(value.nodes) ||
    !value.nodes.every(isCanvasNode) ||
    !hasProjectConsistentPendingRequests(
      value.nodes as CanvasNode[],
      value.projectId,
    ) ||
    !Array.isArray(value.edges) ||
    !value.edges.every(isCanvasEdge) ||
    !hasValidGraph(
      value.nodes as CanvasNode[],
      value.edges as CanvasEdge[],
    )
  ) {
    throw new Error('Invalid project snapshot')
  }

  return normalizeProjectSnapshot(value as unknown as ProjectSnapshot)
}

export function deterministicLegacyCanvasId(projectId: string): string {
  return `legacy-canvas:${projectId}:1`
}

export function upgradeProjectSnapshot(
  snapshot: ProjectSnapshotV1,
  canvasId = deterministicLegacyCanvasId(snapshot.projectId),
): CanvasSnapshotV2 {
  return {
    ...snapshot,
    version: CANVAS_SNAPSHOT_VERSION,
    canvasId,
    name: '画布 1',
    nodes: migrateImageVersions(snapshot.nodes),
  }
}

export function parseCanvasSnapshot(serialized: string): CanvasSnapshotV2 {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('Invalid canvas snapshot JSON')
  }

  if (isRecord(value) && value.version === PROJECT_SNAPSHOT_VERSION) {
    return upgradeProjectSnapshot(parseProjectSnapshot(serialized))
  }

  if (isRecord(value) && value.version === LEGACY_CANVAS_SNAPSHOT_VERSION) {
    const legacy = value as unknown as Omit<CanvasSnapshotV2, 'version'> & { version: 2 }
    value = {
      ...legacy,
      version: CANVAS_SNAPSHOT_VERSION,
      nodes: Array.isArray(legacy.nodes) ? migrateImageVersions(legacy.nodes) : legacy.nodes,
    }
  }

  if (isRecord(value) && value.version !== CANVAS_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported canvas snapshot version: ${String(value.version)}`)
  }

  if (isRecord(value) && Array.isArray(value.nodes) && value.nodes.every(isCanvasNode)) {
    const ids = (value.nodes as CanvasNode[]).map((node) => node.id)
    if (new Set(ids).size === ids.length) value = { ...value, nodes: normalizeCanvasHierarchy(value.nodes as CanvasNode[]) }
  }

  if (
    !isRecord(value) ||
    value.version !== CANVAS_SNAPSHOT_VERSION ||
    typeof value.canvasId !== 'string' ||
    value.canvasId.length === 0 ||
    typeof value.projectId !== 'string' ||
    value.projectId.length === 0 ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    !isRecord(value.viewport) ||
    !hasSaneViewport(value.viewport) ||
    !Array.isArray(value.nodes) ||
    !value.nodes.every(isCanvasNode) ||
    !hasProjectConsistentPendingRequests(
      value.nodes as CanvasNode[],
      value.projectId,
    ) ||
    !Array.isArray(value.edges) ||
    !value.edges.every(isCanvasEdge) ||
    !hasValidGraph(
      value.nodes as CanvasNode[],
      value.edges as CanvasEdge[],
    )
  ) {
    throw new Error('Invalid canvas snapshot')
  }

  return normalizeProjectSnapshot(value as unknown as CanvasSnapshotV2)
}
