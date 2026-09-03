import type { ImageRequestMode } from './catalog.ts'

export type GenerationJobStatus =
  | 'queued'
  | 'uploading'
  | 'submitted'
  | 'running'
  | 'downloading'
  | 'complete'
  | 'failed'

export type MediaType = 'image' | 'video'

export interface ProviderMetadata {
  id: string
  name: string
  adapterType: string
  baseUrl: string
  enabled: boolean
  preferred: boolean
  secretEnvName: string
  secretConfigured: boolean
  maskedSecret?: string
  available: boolean
  lastSyncedAt?: string
  imageRequestMode?: ImageRequestMode
}

export interface CatalogQualityOption {
  value: string
  label: string
  pricing: CatalogPricing
}

export interface CatalogRange {
  min: number | null
  max: number | null
  options: number[] | null
}

export interface CatalogPricing {
  type: 'per_second' | 'per_item' | 'fixed_total'
  credits: number
  inputVideoMultiplier?: number
}

export interface CatalogModel {
  mediaType: MediaType
  channel: string | number
  channelTitle?: string
  channelLabel?: string
  channelDescription?: string
  channelDefaultOption?: unknown
  model: string
  title?: string
  label?: string
  qualityOptions: CatalogQualityOption[]
  aspectRatios: string[]
  countOptions: number[]
  durationOptions: number[]
  countRange?: CatalogRange
  durationRange?: CatalogRange
  modes: string[]
  inputLimits: { images: number; videos: number; audios: number }
  raw: Record<string, unknown>
}

export interface ProviderCatalog {
  providerId: string
  version: string
  fetchedAt: string
  stale: boolean
  models: CatalogModel[]
}

export interface GenerationReference {
  alias: number
  assetId?: string
  url?: string
  mediaType: 'image' | 'video' | 'audio'
}

export interface GenerationRequest {
  clientRequestId: string
  projectId: string
  /** Optional while legacy canvas documents are being migrated. */
  canvasId?: string
  /** Server-selected workspace namespace for isolated workstation runs. */
  workspaceNamespace?: string
  /** Required for collaborative generation so one node cannot be charged twice concurrently. */
  targetNodeId?: string
  providerId: string
  catalogVersion: string
  mediaType: MediaType
  channel: string | number
  model: string
  prompt: string
  quality?: string
  aspectRatio?: string
  n?: number
  duration?: number
  generateAudio?: boolean
  mode?: string
  references: GenerationReference[]
}

export type PersistedGenerationRequest =
  | GenerationRequest
  | Omit<GenerationRequest, 'projectId'>

export interface GenerationQuoteReference {
  alias: number
  mediaType: 'image' | 'video' | 'audio'
  nodeId: string
}

export interface GenerationQuoteRequest
  extends Omit<GenerationRequest, 'references'> {
  references: GenerationQuoteReference[]
  generateAudio?: boolean
}

export interface GenerationQuote {
  exactCredits: number
  requestDigest: string
  request: GenerationQuoteRequest
}

export interface GenerationOutput {
  assetId: string
  url: string
  contentType: string
  size: number
}

export interface GenerationJob {
  id: string
  /** Server-owned collaboration scope. Absent on local and legacy jobs. */
  roomId?: string
  /** Stable output target copied out of the request for recovery and stale-job checks. */
  targetNodeId?: string
  clientRequestId: string
  requestDigest: string
  request: PersistedGenerationRequest
  status: GenerationJobStatus
  progress: number
  createdAt: string
  updatedAt: string
  createAttemptedAt?: string
  upstreamTaskId?: string
  outputs: GenerationOutput[]
  error?: { code: string; message: string }
}

export type GenerationHistoryMediaType = GenerationReference['mediaType']

export interface GenerationHistoryAsset {
  id: string
  filename: string
  contentType: string
  size: number
  url: string
  createdAt: string
}

export interface GenerationHistoryEntry {
  id: string
  projectId: string
  canvasId?: string
  jobId: string
  outputIndex: number
  mediaType: GenerationHistoryMediaType
  asset: GenerationHistoryAsset
  prompt: string
  providerId: string
  channel: string | number
  model: string
  settings: {
    quality?: string
    aspectRatio?: string
    count?: number
    duration?: number
    mode?: string
  }
  references: Array<Pick<GenerationReference, 'alias' | 'assetId' | 'mediaType'>>
  completedAt: string
}

export interface GenerationHistoryPage {
  entries: GenerationHistoryEntry[]
  nextCursor?: string
}

export interface GenerationHistoryBackfillRequest {
  projectId: string
  entries: Array<{
    jobId: string
    outputIndex: number
    assetId: string
  }>
}
