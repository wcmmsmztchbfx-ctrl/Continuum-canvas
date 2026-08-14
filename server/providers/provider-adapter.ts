import type { GenerationRequest, ProviderCatalog } from '../../src/contracts/generation.ts'
import type { Readable } from 'node:stream'

export interface LocalReference {
  filename: string
  contentType: string
  size: number
  openStream(signal?: AbortSignal): Readable
}

export interface StagedReference {
  alias?: number
  mediaType?: 'image' | 'video' | 'audio'
  url: string
}

export interface PresignedUpload {
  fileKey: string
  uploadUrl: string
  method: string
  headers: Record<string, string>
  expiresAt: number
}

export interface UpstreamTaskStatus {
  taskId: string
  status: number
  progress?: number
  outputs?: string[]
  errorCode?: string
  errorMessage?: string
}

export class ProviderRequestRejectedError extends Error {
  readonly code = 'provider_request_rejected'
  readonly providerCode?: string

  constructor(
    message = 'Provider rejected the request',
    providerCode?: string,
  ) {
    super(message)
    this.name = 'ProviderRequestRejectedError'
    this.providerCode = providerCode
  }
}

export interface ProviderAdapter {
  testConnection(signal?: AbortSignal): Promise<void>
  syncCatalog(signal?: AbortSignal): Promise<ProviderCatalog>
  presignReference(reference: LocalReference, signal?: AbortSignal): Promise<PresignedUpload>
  uploadReference(reference: LocalReference, grant: PresignedUpload, signal?: AbortSignal): Promise<void>
  completeReference(fileKey: string, signal?: AbortSignal): Promise<StagedReference>
  createGeneration(request: GenerationRequest, references: StagedReference[], signal?: AbortSignal): Promise<string>
  getGenerationStatus(taskIds: string[], signal?: AbortSignal): Promise<UpstreamTaskStatus[]>
  getGenerationDetail(taskId: string, signal?: AbortSignal): Promise<UpstreamTaskStatus>
}
