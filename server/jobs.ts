import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type {
  GenerationJob,
  GenerationJobStatus,
  GenerationReference,
  GenerationRequest,
  PersistedGenerationRequest,
  ProviderCatalog,
} from '../src/contracts/generation.ts'
import type { AssetStore } from './asset-store.ts'
import { atomicWriteJson } from './atomic-json.ts'
import { DEFAULT_GENERATION_MAX_RUN_TIME_MS } from './config.ts'
import type { DataDirectoryLockHandle } from './data-directory-lock.ts'
import type { GenerationHistoryStore } from './generation-history.ts'
import { validateGenerationRequest } from './generation-validation.ts'
import type {
  LocalReference,
  PresignedUpload,
  ProviderAdapter,
  StagedReference,
  UpstreamTaskStatus,
} from './providers/provider-adapter.ts'
import { ProviderRequestRejectedError } from './providers/provider-adapter.ts'

type ScheduleHandle = unknown
type Schedule = (run: () => void | Promise<void>, delay: number) => ScheduleHandle
type LogEntry = { event: string; message: string }
type UploadStatus = 'pending' | 'presigned' | 'uploaded' | 'complete' | 'manual_recovery' | 'released'

interface ReferenceUploadState {
  alias: number
  assetId?: string
  sourceUrl?: string
  mediaType: GenerationReference['mediaType']
  status: UploadStatus
  fileKey?: string
  presignedAt?: string
  uploadedAt?: string
  completeAttemptedAt?: string
  completedAt?: string
  url?: string
}

interface StoredGenerationJob extends GenerationJob {
  referenceUploads: ReferenceUploadState[]
}

interface RecoveryRequiredMarker {
  version: 1
  corruptFile: string
  detectedAt: string
}

interface UpstreamTaskHandoff {
  version: 1
  jobId: string
  upstreamTaskId: string
  recordedAt: string
}

type WriteJobs = (filePath: string, value: unknown) => Promise<void>
type GenerationJobListener = (job: GenerationJob) => void

export interface GenerationJobCollaborationContext {
  roomId: string
  targetNodeId: string
}

export interface GenerationJobCreateResult {
  job: GenerationJob
  created: boolean
}

class CompleteAmbiguousError extends Error {}

const UPLOAD_STATUSES = new Set<UploadStatus>(['pending', 'presigned', 'uploaded', 'complete', 'manual_recovery', 'released'])
const JOB_STATUSES = new Set<GenerationJobStatus>([
  'queued', 'uploading', 'submitted', 'running', 'downloading', 'complete', 'failed',
])
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DIGEST = /^[a-f0-9]{64}$/
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(record).every((key) => keys.has(key))
}

function isString(value: unknown, maximum = 100_000): value is string {
  return typeof value === 'string' && value.length <= maximum
}

function isNonEmptyString(value: unknown, maximum = 512): value is string {
  return isString(value, maximum) && value.length > 0
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value, 4096)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

export function generationRequestDigest(request: PersistedGenerationRequest): string {
  const canonicalRequest = {
    ...request,
    references: [...request.references].sort((left, right) => left.alias - right.alias),
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(canonicalRequest))).digest('hex')
}

export class IdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict'

  constructor() {
    super('The clientRequestId is already associated with a different generation request')
  }
}

export class InvalidGenerationRequestError extends Error {
  readonly code = 'invalid_generation_request'

  constructor() {
    super('The generation request contains invalid or unsupported fields')
  }
}

export class CorruptJobsFileError extends Error {
  readonly code = 'corrupt_jobs_file'
  readonly corruptPath: string

  constructor(corruptPath: string) {
    super('The persisted generation jobs file is corrupt and was quarantined')
    this.corruptPath = corruptPath
  }
}

function parseGenerationReference(value: unknown): GenerationReference | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['alias', 'assetId', 'url', 'mediaType'])) return undefined
  if (!Number.isInteger(value.alias) || (value.alias as number) <= 0) return undefined
  if (value.mediaType !== 'image' && value.mediaType !== 'video' && value.mediaType !== 'audio') return undefined
  const assetId = value.assetId
  const url = value.url
  if ((assetId === undefined) === (url === undefined)) return undefined
  if (assetId !== undefined && (!isNonEmptyString(assetId, 128) || !SAFE_ID.test(assetId))) return undefined
  if (url !== undefined && !isHttpUrl(url)) return undefined
  return {
    alias: value.alias as number,
    mediaType: value.mediaType,
    ...(typeof assetId === 'string' ? { assetId } : {}),
    ...(typeof url === 'string' ? { url } : {}),
  }
}

function parseGenerationRequest(
  value: unknown,
  options: { allowLegacyProject?: boolean } = {},
): PersistedGenerationRequest | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'clientRequestId', 'projectId', 'canvasId', 'targetNodeId', 'providerId', 'catalogVersion', 'mediaType', 'channel', 'model', 'prompt',
    'quality', 'aspectRatio', 'n', 'duration', 'generateAudio', 'mode', 'references',
  ])) return undefined
  if (!isNonEmptyString(value.clientRequestId, 256)) return undefined
  if (value.projectId === undefined) {
    if (!options.allowLegacyProject) return undefined
  } else if (!isNonEmptyString(value.projectId, 256)) return undefined
  if (value.canvasId !== undefined && !isNonEmptyString(value.canvasId, 256)) return undefined
  if (value.targetNodeId !== undefined && !isNonEmptyString(value.targetNodeId, 256)) return undefined
  if (!isNonEmptyString(value.providerId, 64) || !/^[a-z0-9][a-z0-9-]*$/.test(value.providerId)) return undefined
  if (!isNonEmptyString(value.catalogVersion, 256)) return undefined
  if (value.mediaType !== 'image' && value.mediaType !== 'video') return undefined
  if (!((typeof value.channel === 'string' && value.channel.length > 0 && value.channel.length <= 256) ||
    (typeof value.channel === 'number' && Number.isFinite(value.channel)))) return undefined
  if (!isNonEmptyString(value.model, 512) || !isString(value.prompt)) return undefined
  for (const key of ['quality', 'aspectRatio', 'mode'] as const) {
    if (value[key] !== undefined && !isNonEmptyString(value[key], 256)) return undefined
  }
  if (value.n !== undefined && (!Number.isInteger(value.n) || (value.n as number) <= 0)) return undefined
  if (value.duration !== undefined && (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration <= 0)) return undefined
  if (value.generateAudio !== undefined && typeof value.generateAudio !== 'boolean') return undefined
  if (!Array.isArray(value.references)) return undefined
  const references = value.references.map(parseGenerationReference)
  if (references.some((reference) => reference === undefined)) return undefined
  const aliases = references.map((reference) => (reference as GenerationReference).alias)
  if (new Set(aliases).size !== aliases.length) return undefined
  return {
    clientRequestId: value.clientRequestId,
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    ...(typeof value.canvasId === 'string' ? { canvasId: value.canvasId } : {}),
    ...(typeof value.targetNodeId === 'string' ? { targetNodeId: value.targetNodeId } : {}),
    providerId: value.providerId,
    catalogVersion: value.catalogVersion,
    mediaType: value.mediaType,
    channel: value.channel as string | number,
    model: value.model,
    prompt: value.prompt,
    ...(typeof value.quality === 'string' ? { quality: value.quality } : {}),
    ...(typeof value.aspectRatio === 'string' ? { aspectRatio: value.aspectRatio } : {}),
    ...(typeof value.n === 'number' ? { n: value.n } : {}),
    ...(typeof value.duration === 'number' ? { duration: value.duration } : {}),
    ...(typeof value.generateAudio === 'boolean' ? { generateAudio: value.generateAudio } : {}),
    ...(typeof value.mode === 'string' ? { mode: value.mode } : {}),
    references: references as GenerationReference[],
  }
}

function normalizeGenerationRequest(value: unknown): GenerationRequest {
  const request = parseGenerationRequest(value)
  if (!request || request.references.some((reference) => !reference.assetId || reference.url !== undefined)) {
    throw new InvalidGenerationRequestError()
  }
  return request as GenerationRequest
}

function parseRecoveryRequiredMarker(value: unknown): RecoveryRequiredMarker | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'corruptFile', 'detectedAt'])) return undefined
  if (value.version !== 1 || !isNonEmptyString(value.corruptFile, 512) || !isTimestamp(value.detectedAt)) return undefined
  if (basename(value.corruptFile) !== value.corruptFile || !value.corruptFile.startsWith('jobs.json.corrupt.')) return undefined
  return { version: 1, corruptFile: value.corruptFile, detectedAt: value.detectedAt }
}

async function readRecoveryRequiredMarker(markerPath: string): Promise<RecoveryRequiredMarker | undefined> {
  let serialized: string
  try {
    serialized = await readFile(markerPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const marker = parseRecoveryRequiredMarker(JSON.parse(serialized))
    if (!marker) throw new Error('Invalid recovery marker')
    return marker
  } catch {
    throw new CorruptJobsFileError(markerPath)
  }
}

function parseReferenceUpload(value: unknown): ReferenceUploadState | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'alias', 'assetId', 'sourceUrl', 'mediaType', 'status', 'fileKey', 'presignedAt', 'uploadedAt',
    'completeAttemptedAt', 'completedAt', 'url', 'grant',
  ])) return undefined
  const record = value
  if (!Number.isInteger(record.alias) || (record.alias as number) <= 0) return undefined
  if (record.mediaType !== 'image' && record.mediaType !== 'video' && record.mediaType !== 'audio') return undefined
  if (typeof record.status !== 'string' || !UPLOAD_STATUSES.has(record.status as UploadStatus)) return undefined
  if (record.assetId !== undefined && (!isNonEmptyString(record.assetId, 128) || !SAFE_ID.test(record.assetId))) return undefined
  if (record.sourceUrl !== undefined && !isHttpUrl(record.sourceUrl)) return undefined
  if (record.fileKey !== undefined && !isNonEmptyString(record.fileKey, 2048)) return undefined
  if (record.url !== undefined && !isHttpUrl(record.url)) return undefined
  for (const key of ['presignedAt', 'uploadedAt', 'completeAttemptedAt', 'completedAt'] as const) {
    if (record[key] !== undefined && !isTimestamp(record[key])) return undefined
  }
  if (record.status !== 'pending' && record.status !== 'released' && !isNonEmptyString(record.fileKey, 2048)) return undefined
  if (record.status === 'released') {
    if (!isNonEmptyString(record.assetId, 128) || !SAFE_ID.test(record.assetId)) return undefined
    if (record.sourceUrl !== undefined || record.fileKey !== undefined || record.url !== undefined) return undefined
  }
  if (record.status === 'manual_recovery' && !isTimestamp(record.completeAttemptedAt)) return undefined
  if (record.status === 'complete' && (!isHttpUrl(record.url) || !isTimestamp(record.completedAt))) return undefined
  return {
    alias: record.alias as number,
    mediaType: record.mediaType,
    status: record.status as UploadStatus,
    ...(typeof record.assetId === 'string' ? { assetId: record.assetId } : {}),
    ...(typeof record.sourceUrl === 'string' ? { sourceUrl: record.sourceUrl } : {}),
    ...(typeof record.fileKey === 'string' ? { fileKey: record.fileKey } : {}),
    ...(typeof record.presignedAt === 'string' ? { presignedAt: record.presignedAt } : {}),
    ...(typeof record.uploadedAt === 'string' ? { uploadedAt: record.uploadedAt } : {}),
    ...(typeof record.completeAttemptedAt === 'string' ? { completeAttemptedAt: record.completeAttemptedAt } : {}),
    ...(typeof record.completedAt === 'string' ? { completedAt: record.completedAt } : {}),
    ...(typeof record.url === 'string' ? { url: record.url } : {}),
  }
}

function parseOutput(value: unknown): GenerationJob['outputs'][number] | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['assetId', 'url', 'contentType', 'size'])) return undefined
  if (!isNonEmptyString(value.assetId, 128) || !SAFE_ID.test(value.assetId)) return undefined
  if (value.url !== `/api/assets/${value.assetId}`) return undefined
  if (!isNonEmptyString(value.contentType, 256)) return undefined
  if (!Number.isInteger(value.size) || (value.size as number) <= 0) return undefined
  return {
    assetId: value.assetId,
    url: value.url,
    contentType: value.contentType,
    size: value.size as number,
  }
}

function parseJobError(value: unknown): GenerationJob['error'] | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['code', 'message'])) return undefined
  if (!isNonEmptyString(value.code, 128) || !isNonEmptyString(value.message, 1024)) return undefined
  return { code: value.code, message: value.message }
}

function parseStoredJob(value: unknown): StoredGenerationJob | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'roomId', 'targetNodeId', 'clientRequestId', 'requestDigest', 'request', 'status', 'progress', 'createdAt', 'updatedAt',
    'createAttemptedAt', 'upstreamTaskId', 'outputs', 'error', 'referenceUploads',
  ])) return undefined
  if (!isNonEmptyString(value.id, 128) || !SAFE_ID.test(value.id)) return undefined
  if (value.roomId !== undefined && (!isNonEmptyString(value.roomId, 128) || !SAFE_ID.test(value.roomId))) return undefined
  if (value.targetNodeId !== undefined && !isNonEmptyString(value.targetNodeId, 256)) return undefined
  if ((value.roomId === undefined) !== (value.targetNodeId === undefined)) return undefined
  if (!isNonEmptyString(value.clientRequestId, 256)) return undefined
  if (!isNonEmptyString(value.requestDigest, 64) || !DIGEST.test(value.requestDigest)) return undefined
  const request = parseGenerationRequest(value.request, { allowLegacyProject: true })
  if (!request) return undefined
  if (request.clientRequestId !== value.clientRequestId) return undefined
  if (value.targetNodeId !== undefined && request.targetNodeId !== value.targetNodeId) return undefined
  if (generationRequestDigest(request) !== value.requestDigest) return undefined
  if (typeof value.status !== 'string' || !JOB_STATUSES.has(value.status as GenerationJobStatus)) return undefined
  if (typeof value.progress !== 'number' || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 100) return undefined
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return undefined
  if (value.createAttemptedAt !== undefined && !isTimestamp(value.createAttemptedAt)) return undefined
  if (value.upstreamTaskId !== undefined && !isNonEmptyString(value.upstreamTaskId, 1024)) return undefined
  if (!Array.isArray(value.outputs) || !Array.isArray(value.referenceUploads)) return undefined
  const outputs = value.outputs.map(parseOutput)
  const uploads = value.referenceUploads.map(parseReferenceUpload)
  if (outputs.some((output) => output === undefined) || uploads.some((upload) => upload === undefined)) return undefined
  if (value.error !== undefined && !parseJobError(value.error)) return undefined
  const referenceUploads = uploads as ReferenceUploadState[]
  if (referenceUploads.length !== request.references.length) return undefined
  const referencesByAlias = new Map(request.references.map((reference) => [reference.alias, reference]))
  if (new Set(referenceUploads.map((upload) => upload.alias)).size !== referenceUploads.length) return undefined
  if (referenceUploads.some((upload) => referencesByAlias.get(upload.alias)?.mediaType !== upload.mediaType)) return undefined
  return {
    id: value.id,
    ...(typeof value.roomId === 'string' ? { roomId: value.roomId } : {}),
    ...(typeof value.targetNodeId === 'string' ? { targetNodeId: value.targetNodeId } : {}),
    clientRequestId: value.clientRequestId,
    requestDigest: value.requestDigest,
    request,
    status: value.status as GenerationJobStatus,
    progress: value.progress,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.createAttemptedAt === 'string' ? { createAttemptedAt: value.createAttemptedAt } : {}),
    ...(typeof value.upstreamTaskId === 'string' ? { upstreamTaskId: value.upstreamTaskId } : {}),
    outputs: outputs as GenerationJob['outputs'],
    ...(value.error !== undefined ? { error: parseJobError(value.error) as NonNullable<GenerationJob['error']> } : {}),
    referenceUploads,
  }
}

function parseStoredJobs(value: unknown): StoredGenerationJob[] | undefined {
  if (!Array.isArray(value)) return undefined
  const jobs = value.map(parseStoredJob)
  if (jobs.some((job) => job === undefined)) return undefined
  const parsed = jobs as StoredGenerationJob[]
  if (new Set(parsed.map((job) => job.id)).size !== parsed.length) return undefined
  if (new Set(parsed.map((job) => job.clientRequestId)).size !== parsed.length) return undefined
  return parsed
}

function parseUpstreamTaskHandoff(value: unknown): UpstreamTaskHandoff | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'jobId', 'upstreamTaskId', 'recordedAt'])) return undefined
  if (value.version !== 1 || !isNonEmptyString(value.jobId, 128) || !SAFE_ID.test(value.jobId)) return undefined
  if (!isNonEmptyString(value.upstreamTaskId, 2048) || !isTimestamp(value.recordedAt)) return undefined
  return {
    version: 1,
    jobId: value.jobId,
    upstreamTaskId: value.upstreamTaskId,
    recordedAt: value.recordedAt,
  }
}

export class RemoteReferenceImportError extends Error {
  readonly code = 'remote_reference_import_unavailable'

  constructor() {
    super('Remote references require a secure pinned import implementation')
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function initialUploads(request: GenerationRequest): ReferenceUploadState[] {
  return [...request.references]
    .sort((left, right) => left.alias - right.alias)
    .map((reference) => ({
      alias: reference.alias,
      assetId: reference.assetId,
      sourceUrl: reference.url,
      mediaType: reference.mediaType,
      status: 'pending',
    }))
}

function hasProjectId(request: PersistedGenerationRequest): request is GenerationRequest {
  return 'projectId' in request
}

function withoutProjectScope(
  request: GenerationRequest,
): Omit<GenerationRequest, 'projectId' | 'canvasId'> {
  const { projectId: _projectId, canvasId: _canvasId, ...legacy } = request
  return legacy
}

function releaseStagedReferences(job: StoredGenerationJob): StoredGenerationJob {
  const terminal = job.status === 'complete' || job.status === 'failed'
  const uploadsByAlias = new Map(job.referenceUploads.map((state) => [state.alias, state]))
  const request = {
    ...job.request,
    references: job.request.references.map((reference) => {
      const assetId = reference.assetId ?? uploadsByAlias.get(reference.alias)?.assetId
      return assetId
        ? { alias: reference.alias, assetId, mediaType: reference.mediaType }
        : reference
    }),
  } as PersistedGenerationRequest
  const referenceUploads = job.referenceUploads.map((state): ReferenceUploadState => {
    const withoutSource = state.assetId
      ? Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'sourceUrl')) as unknown as ReferenceUploadState
      : state
    if (!state.assetId || (!job.upstreamTaskId && !terminal)) return withoutSource
    if (state.status === 'manual_recovery') {
      return Object.fromEntries(Object.entries(withoutSource).filter(([key]) => key !== 'url')) as unknown as ReferenceUploadState
    }
    return {
      alias: state.alias,
      assetId: state.assetId,
      mediaType: state.mediaType,
      status: 'released',
    }
  })
  return {
    ...job,
    request,
    requestDigest: generationRequestDigest(request),
    referenceUploads,
  }
}

function sanitizedError(code: string, message: string): GenerationJob['error'] {
  return { code, message }
}

function sanitizedLogMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|secret)\s*[=:]\s*[^\s]+/gi, '$1=[redacted]')
    .slice(0, 300)
}

export class GenerationJobStore {
  private readonly filePath: string
  private readonly handoffRoot: string
  private jobs: StoredGenerationJob[]
  private readonly id: () => string
  private readonly now: () => Date
  private readonly writeJobs: WriteJobs
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<GenerationJobListener>()

  private constructor(
    filePath: string,
    handoffRoot: string,
    jobs: StoredGenerationJob[],
    id: () => string,
    now: () => Date,
    writeJobs: WriteJobs,
  ) {
    this.filePath = filePath
    this.handoffRoot = handoffRoot
    this.jobs = jobs
    this.id = id
    this.now = now
    this.writeJobs = writeJobs
  }

  static async open(options: {
    dataDir: string
    id?: () => string
    now?: () => Date
    writeJobs?: WriteJobs
  }) {
    await mkdir(options.dataDir, { recursive: true })
    const filePath = join(options.dataDir, 'jobs.json')
    const handoffRoot = join(options.dataDir, 'generation-handoffs')
    const markerPath = join(options.dataDir, '.jobs-recovery-required.json')
    const now = options.now ?? (() => new Date())
    const recoveryMarker = await readRecoveryRequiredMarker(markerPath)
    if (recoveryMarker) {
      throw new CorruptJobsFileError(join(options.dataDir, recoveryMarker.corruptFile))
    }
    let jobs: StoredGenerationJob[] = []
    let serialized: string
    try {
      serialized = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') serialized = '[]'
      else throw error
    }
    try {
      const parsed = parseStoredJobs(JSON.parse(serialized))
      if (!parsed) throw new Error('Invalid persisted generation jobs')
      jobs = parsed
    } catch {
      const detectedAt = now().toISOString()
      const stamp = detectedAt.replace(/[:.]/g, '-')
      const corruptPath = `${filePath}.corrupt.${stamp}.${randomUUID()}`
      await atomicWriteJson(markerPath, {
        version: 1,
        corruptFile: basename(corruptPath),
        detectedAt,
      } satisfies RecoveryRequiredMarker)
      await rename(filePath, corruptPath).catch(() => {})
      throw new CorruptJobsFileError(corruptPath)
    }
    const writeJobs = options.writeJobs ?? atomicWriteJson
    const sanitizedJobs = jobs.map(releaseStagedReferences)
    if (JSON.stringify(sanitizedJobs) !== JSON.stringify(jobs)) {
      await writeJobs(filePath, sanitizedJobs)
      jobs = sanitizedJobs
    }
    const store = new GenerationJobStore(
      filePath,
      handoffRoot,
      jobs,
      options.id ?? randomUUID,
      now,
      writeJobs,
    )
    await store.recoverUpstreamTaskHandoffs()
    return store
  }

  static async acknowledgeCorruptJobs(options: { dataDir: string; corruptPath: string }): Promise<void> {
    const markerPath = join(options.dataDir, '.jobs-recovery-required.json')
    const marker = await readRecoveryRequiredMarker(markerPath)
    if (!marker) throw new Error('No corrupt jobs recovery is pending')
    const expectedPath = resolve(options.dataDir, marker.corruptFile)
    if (resolve(options.corruptPath) !== expectedPath) {
      throw new Error('The acknowledged corrupt jobs file does not match the recovery marker')
    }
    await rm(markerPath)
  }

  async create(
    request: GenerationRequest,
    collaboration?: GenerationJobCollaborationContext,
  ): Promise<GenerationJobCreateResult> {
    return this.runMutation(async () => {
      const normalizedRequest = normalizeGenerationRequest(request)
      if (collaboration) {
        if (!SAFE_ID.test(collaboration.roomId)) throw new InvalidGenerationRequestError()
        if (
          !isNonEmptyString(collaboration.targetNodeId, 256) ||
          normalizedRequest.targetNodeId !== collaboration.targetNodeId ||
          !normalizedRequest.canvasId
        ) throw new InvalidGenerationRequestError()
      }
      const requestDigest = generationRequestDigest(normalizedRequest)
      const existing = this.jobs.find((job) => job.clientRequestId === normalizedRequest.clientRequestId)
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          const isRecoverableLegacy = !hasProjectId(existing.request) &&
            existing.status !== 'complete' && existing.status !== 'failed' &&
            existing.requestDigest === generationRequestDigest(withoutProjectScope(normalizedRequest))
          if (!isRecoverableLegacy) throw new IdempotencyConflictError()
          const index = this.jobs.indexOf(existing)
          const migrated: StoredGenerationJob = {
            ...existing,
            request: clone(normalizedRequest),
            requestDigest,
            updatedAt: this.now().toISOString(),
          }
          const candidate = [...this.jobs]
          candidate[index] = migrated
          this.jobs = await this.persistCandidate(candidate)
          return { job: this.toPublic(this.jobs[index]), created: false }
        }
        return { job: this.toPublic(existing), created: false }
      }
      const timestamp = this.now().toISOString()
      const job: StoredGenerationJob = {
        id: this.id(),
        ...(collaboration ? {
          roomId: collaboration.roomId,
          targetNodeId: collaboration.targetNodeId,
        } : {}),
        clientRequestId: normalizedRequest.clientRequestId,
        requestDigest,
        request: clone(normalizedRequest),
        status: 'queued',
        progress: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        outputs: [],
        referenceUploads: initialUploads(normalizedRequest),
      }
      this.jobs = await this.persistCandidate([...this.jobs, job])
      const publicJob = this.toPublic(job)
      this.emit(publicJob)
      return { job: publicJob, created: true }
    })
  }

  get(id: string): GenerationJob | undefined {
    const job = this.jobs.find((candidate) => candidate.id === id)
    return job ? this.toPublic(job) : undefined
  }

  getStored(id: string): StoredGenerationJob | undefined {
    const job = this.jobs.find((candidate) => candidate.id === id)
    return job ? clone(job) : undefined
  }

  list(): GenerationJob[] {
    return this.jobs.map((job) => this.toPublic(job))
  }

  clear(): void {
    this.jobs = []
  }

  onChange(listener: GenerationJobListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  activityForCanvas(input: { projectId: string; canvasId: string }): {
    active: boolean
    jobs: Array<Pick<GenerationJob, 'id' | 'status' | 'updatedAt'>>
  } {
    const jobs = this.jobs
      .filter((job) => (
        'projectId' in job.request && job.request.projectId === input.projectId &&
        'canvasId' in job.request && job.request.canvasId === input.canvasId &&
        job.status !== 'complete' && job.status !== 'failed'
      ))
      .map(({ id, status, updatedAt }) => ({ id, status, updatedAt }))
    return { active: jobs.length > 0, jobs }
  }

  referencedAssetIds(): Set<string> {
    const ids = new Set<string>()
    for (const job of this.jobs) {
      for (const reference of job.request.references) {
        if (reference.assetId) ids.add(reference.assetId)
      }
      for (const upload of job.referenceUploads) {
        if (upload.assetId) ids.add(upload.assetId)
      }
      for (const output of job.outputs) ids.add(output.assetId)
    }
    return ids
  }

  async update(id: string, patch: Partial<GenerationJob>): Promise<GenerationJob> {
    return this.runMutation(async () => {
      const index = this.jobs.findIndex((candidate) => candidate.id === id)
      if (index === -1) throw new Error('Generation job not found')
      const current = this.jobs[index]
      const next: StoredGenerationJob = {
        ...current,
        ...clone(patch),
        id: current.id,
        clientRequestId: current.clientRequestId,
        requestDigest: current.requestDigest,
        request: current.request,
        referenceUploads: current.referenceUploads,
        updatedAt: this.now().toISOString(),
      }
      const candidate = [...this.jobs]
      candidate[index] = next
      this.jobs = await this.persistCandidate(candidate)
      const publicJob = this.toPublic(this.jobs[index])
      this.emit(publicJob)
      return publicJob
    })
  }

  async recordUpstreamTask(id: string, upstreamTaskId: string): Promise<GenerationJob> {
    return this.runMutation(async () => {
      if (!isNonEmptyString(upstreamTaskId, 2048)) throw new Error('Upstream task id is invalid')
      const index = this.jobs.findIndex((candidate) => candidate.id === id)
      if (index === -1) throw new Error('Generation job not found')
      const current = this.jobs[index]
      if (current.upstreamTaskId && current.upstreamTaskId !== upstreamTaskId) {
        throw new Error('Generation job already has a different upstream task id')
      }
      const handoff: UpstreamTaskHandoff = {
        version: 1,
        jobId: id,
        upstreamTaskId,
        recordedAt: this.now().toISOString(),
      }
      await mkdir(this.handoffRoot, { recursive: true })
      const handoffPath = this.handoffPath(id)
      await atomicWriteJson(handoffPath, handoff)
      const next = releaseStagedReferences({
        ...current,
        status: 'submitted',
        upstreamTaskId,
        progress: 0,
        error: undefined,
        updatedAt: this.now().toISOString(),
      })
      const candidate = [...this.jobs]
      candidate[index] = next
      try {
        this.jobs = await this.persistCandidate(candidate)
        await rm(handoffPath, { force: true }).catch(() => {})
      } catch {
        // The handoff file is the durable source of truth until jobs.json catches up.
        this.jobs = this.sanitizeCandidate(candidate)
      }
      const publicJob = this.toPublic(this.jobs[index])
      this.emit(publicJob)
      return publicJob
    })
  }

  async updateReferenceUpload(
    id: string,
    alias: number,
    patch: Partial<Omit<ReferenceUploadState, 'alias' | 'mediaType'>>,
  ): Promise<void> {
    return this.runMutation(async () => {
      const jobIndex = this.jobs.findIndex((candidate) => candidate.id === id)
      if (jobIndex === -1) throw new Error('Generation job not found')
      const candidate = clone(this.jobs)
      const job = candidate[jobIndex]
      const index = job.referenceUploads.findIndex((candidate) => candidate.alias === alias)
      if (index === -1) throw new Error('Reference upload state not found')
      const current = job.referenceUploads[index]
      const next = parseReferenceUpload({
        ...current,
        ...clone(patch),
        alias: current.alias,
        mediaType: current.mediaType,
      })
      if (!next) throw new Error('Reference upload state is invalid')
      job.referenceUploads[index] = next
      job.updatedAt = this.now().toISOString()
      this.jobs = await this.persistCandidate(candidate)
    })
  }

  private toPublic(job: StoredGenerationJob): GenerationJob {
    const { referenceUploads: _referenceUploads, ...publicJob } = clone(job)
    return publicJob
  }

  private emit(job: GenerationJob): void {
    for (const listener of this.listeners) {
      try { listener(clone(job)) } catch { /* Job observers cannot roll back durable state. */ }
    }
  }

  private sanitizeCandidate(candidate: StoredGenerationJob[]): StoredGenerationJob[] {
    return candidate.map((job) => releaseStagedReferences({
      ...job,
      referenceUploads: job.referenceUploads.map((state) => {
        const parsed = parseReferenceUpload(state)
        if (!parsed) throw new Error('Reference upload state is invalid')
        return parsed
      }),
    }))
  }

  private async persistCandidate(candidate: StoredGenerationJob[]): Promise<StoredGenerationJob[]> {
    const sanitized = this.sanitizeCandidate(candidate)
    await this.writeJobs(this.filePath, sanitized)
    return sanitized
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private handoffPath(jobId: string): string {
    if (!SAFE_ID.test(jobId)) throw new Error('Generation job id is invalid')
    return join(this.handoffRoot, `${jobId}.json`)
  }

  private async recoverUpstreamTaskHandoffs(): Promise<void> {
    return this.runMutation(() => this.recoverUpstreamTaskHandoffsUnlocked())
  }

  private async recoverUpstreamTaskHandoffsUnlocked(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.handoffRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const handoffs: Array<{ path: string; value: UpstreamTaskHandoff }> = []
    for (const name of names) {
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/.exec(name)
      if (!match) continue
      const path = this.handoffPath(match[1])
      const parsed = parseUpstreamTaskHandoff(JSON.parse(await readFile(path, 'utf8')))
      if (!parsed || parsed.jobId !== match[1]) throw new Error('Persisted upstream task handoff is invalid')
      handoffs.push({ path, value: parsed })
    }
    if (handoffs.length === 0) return
    const candidate = clone(this.jobs)
    for (const { value } of handoffs) {
      const index = candidate.findIndex((job) => job.id === value.jobId)
      if (index === -1) throw new Error('Upstream task handoff references a missing job')
      const current = candidate[index]
      if (current.upstreamTaskId && current.upstreamTaskId !== value.upstreamTaskId) {
        throw new Error('Upstream task handoff conflicts with the persisted job')
      }
      if (current.status !== 'complete' && current.status !== 'failed') {
        candidate[index] = {
          ...current,
          status: 'submitted',
          upstreamTaskId: value.upstreamTaskId,
          error: undefined,
          updatedAt: value.recordedAt,
        }
      }
    }
    this.jobs = await this.persistCandidate(candidate)
    await Promise.all(handoffs.map(({ path }) => rm(path, { force: true }).catch(() => {})))
  }
}

export class GenerationRunner {
  private readonly schedule: Schedule
  private readonly cancelSchedule: (handle: ScheduleHandle) => void
  private readonly pollDelayMs: () => number
  private readonly maxRunTimeMs: number
  private readonly now: () => number
  private readonly sleep: (delay: number) => Promise<void>
  private readonly inFlight = new Map<string, Promise<GenerationJob>>()
  private readonly submitFlights = new Map<string, { digest: string; operation: Promise<GenerationJob> }>()
  private readonly pollTimers = new Map<string, ScheduleHandle>()
  private readonly uploadGrants = new Map<string, PresignedUpload>()
  private readonly lock: DataDirectoryLockHandle
  private readonly abortController = new AbortController()
  private readonly signal: AbortSignal
  private closed = false
  private readonly options: {
    jobs: GenerationJobStore
    history?: GenerationHistoryStore
    assets: AssetStore
    lock: DataDirectoryLockHandle
    adapterFor: (providerId: string) => ProviderAdapter
    catalogFor: (providerId: string) => ProviderCatalog | Promise<ProviderCatalog>
    schedule?: Schedule
    cancelSchedule?: (handle: ScheduleHandle) => void
    pollDelayMs?: () => number
    maxRunTimeMs?: number
    now?: () => number
    sleep?: (delay: number) => Promise<void>
    signal?: AbortSignal
    log?: (entry: LogEntry) => void
  }

  constructor(options: {
    jobs: GenerationJobStore
    history?: GenerationHistoryStore
    assets: AssetStore
    lock: DataDirectoryLockHandle
    adapterFor: (providerId: string) => ProviderAdapter
    catalogFor: (providerId: string) => ProviderCatalog | Promise<ProviderCatalog>
    schedule?: Schedule
    cancelSchedule?: (handle: ScheduleHandle) => void
    pollDelayMs?: () => number
    maxRunTimeMs?: number
    now?: () => number
    sleep?: (delay: number) => Promise<void>
    signal?: AbortSignal
    log?: (entry: LogEntry) => void
  }) {
    options.lock.assertHeld()
    this.options = options
    this.lock = options.lock
    this.schedule = options.schedule ?? ((run, delay) => {
      const timer = setTimeout(() => { void Promise.resolve(run()).catch(() => {}) }, delay)
      timer.unref()
      return timer
    })
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.pollDelayMs = options.pollDelayMs ?? (() => 10_000 + Math.floor(Math.random() * 5_001))
    this.maxRunTimeMs = options.maxRunTimeMs ?? DEFAULT_GENERATION_MAX_RUN_TIME_MS
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)))
    this.signal = options.signal
      ? AbortSignal.any([this.abortController.signal, options.signal])
      : this.abortController.signal
  }

  async submit(
    request: GenerationRequest,
    collaboration?: GenerationJobCollaborationContext,
  ): Promise<GenerationJob> {
    const normalizedRequest = normalizeGenerationRequest(request)
    const digest = generationRequestDigest(normalizedRequest)
    const existing = this.submitFlights.get(normalizedRequest.clientRequestId)
    if (existing) {
      if (existing.digest !== digest) throw new IdempotencyConflictError()
      return existing.operation
    }
    const operation = this.submitOnce(normalizedRequest, collaboration)
    this.submitFlights.set(normalizedRequest.clientRequestId, { digest, operation })
    try {
      return await operation
    } finally {
      if (this.submitFlights.get(normalizedRequest.clientRequestId)?.operation === operation) {
        this.submitFlights.delete(normalizedRequest.clientRequestId)
      }
    }
  }

  private async submitOnce(
    request: GenerationRequest,
    collaboration?: GenerationJobCollaborationContext,
  ): Promise<GenerationJob> {
    if (this.closed) throw new Error('Generation runner is closed')
    validateGenerationRequest(request, await this.options.catalogFor(request.providerId))
    if (request.references.some((reference) => reference.url) && !this.options.assets.canImportRemote()) {
      throw new RemoteReferenceImportError()
    }
    const { job, created } = await this.options.jobs.create(request, collaboration)
    if (!created) {
      const canResumeBeforeCreate =
        !job.upstreamTaskId && !job.createAttemptedAt &&
        (job.status === 'queued' || job.status === 'uploading')
      return canResumeBeforeCreate ? this.runForJob(job.id, () => this.stageAndCreate(job)) : job
    }
    if (job.status !== 'queued') return job
    return this.runForJob(job.id, () => this.stageAndCreate(job))
  }

  async poll(id: string): Promise<GenerationJob> {
    return this.runForJob(id, () => this.pollOnce(id))
  }

  private async pollOnce(id: string): Promise<GenerationJob> {
    const job = this.requireJob(id)
    if (!job.upstreamTaskId || this.isTerminal(job.status)) {
      if (this.isTerminal(job.status)) this.clearPoll(id)
      return job
    }
    if (this.hasExceededRunTime(job)) return this.failTimedOut(id)
    const adapter = this.options.adapterFor(job.request.providerId)
    let upstream: UpstreamTaskStatus | undefined
    try {
      const statuses = await this.retry(() => adapter.getGenerationStatus([job.upstreamTaskId as string], this.signal))
      upstream = statuses.find((candidate) => candidate.taskId === job.upstreamTaskId)
    } catch (error) {
      this.report('generation.status_failed', error)
      this.schedulePoll(id)
      return this.options.jobs.update(id, {
        error: sanitizedError('STATUS_UNAVAILABLE', 'Generation status is temporarily unavailable'),
      })
    }
    if (!upstream) {
      this.schedulePoll(id)
      return job
    }
    if (upstream.status === 4) return this.failFromUpstream(id, job, upstream)
    if (upstream.status === 3) {
      if ((upstream.outputs?.length ?? 0) > 0) return this.downloadOutputs(job, upstream.outputs as string[])
      try {
        const detail = await this.retry(() => adapter.getGenerationDetail(job.upstreamTaskId as string, this.signal))
        if (detail.status === 4) return this.failFromUpstream(id, job, detail)
        if ((detail.outputs?.length ?? 0) > 0) return this.downloadOutputs(job, detail.outputs as string[])
      } catch (error) {
        this.report('generation.detail_failed', error)
        // A missing detail is non-terminal; status polling remains authoritative.
      }
      const waiting = await this.options.jobs.update(id, {
        status: 'running', progress: Math.min(99, upstream.progress ?? 99), error: undefined,
      })
      this.schedulePoll(id)
      return waiting
    }
    const status: GenerationJobStatus = upstream.status === 2 ? 'running' : 'submitted'
    const updated = await this.options.jobs.update(id, {
      status,
      progress: Math.max(0, Math.min(100, upstream.progress ?? job.progress)),
      error: undefined,
    })
    this.schedulePoll(id)
    return updated
  }

  async resume(): Promise<void> {
    for (const job of this.options.jobs.list()) {
      if (this.isTerminal(job.status)) continue
      if (job.upstreamTaskId) {
        if (this.hasExceededRunTime(job)) await this.failTimedOut(job.id)
        else this.schedulePoll(job.id)
        continue
      }
      if (job.createAttemptedAt) {
        await this.options.jobs.update(job.id, {
          status: 'failed',
          error: sanitizedError('CREATE_STATE_UNKNOWN', 'Generation create state could not be recovered safely'),
        })
        continue
      }
      // A restart never performs provider-side staging or creation. The user must
      // explicitly resubmit the same idempotent request to continue safely.
    }
  }

  private async stageAndCreate(job: GenerationJob): Promise<GenerationJob> {
    const adapter = this.options.adapterFor(job.request.providerId)
    await this.options.jobs.update(job.id, { status: 'uploading', error: undefined })
    let references: StagedReference[]
    try {
      references = await this.stageReferences(job.id, adapter, job.request.references)
    } catch (error) {
      this.report('generation.reference_staging_failed', error)
      if (error instanceof CompleteAmbiguousError) {
        return this.options.jobs.update(job.id, {
          status: 'failed',
          error: sanitizedError('COMPLETE_AMBIGUOUS', 'Reference completion is uncertain and requires manual recovery'),
        })
      }
      return this.options.jobs.update(job.id, {
        status: 'uploading',
        error: sanitizedError('REFERENCE_STAGING_FAILED', 'Reference staging can be resumed safely'),
      })
    }
    await this.options.jobs.update(job.id, { createAttemptedAt: new Date().toISOString() })
    let upstreamTaskId: string
    try {
      upstreamTaskId = await adapter.createGeneration(job.request as GenerationRequest, references, this.signal)
    } catch (error) {
      this.report('generation.create_failed', error)
      if (error instanceof ProviderRequestRejectedError) {
        return this.options.jobs.update(job.id, {
          status: 'failed',
          error: sanitizedError('PROVIDER_REJECTED', sanitizedLogMessage(error)),
        })
      }
      return this.options.jobs.update(job.id, {
        status: 'failed',
        error: sanitizedError('CREATE_AMBIGUOUS', 'Provider create response was not confirmed; the request was not retried'),
      })
    }
    const submitted = await this.options.jobs.recordUpstreamTask(job.id, upstreamTaskId)
    this.schedulePoll(job.id)
    return submitted
  }

  private async stageReferences(
    jobId: string,
    adapter: ProviderAdapter,
    references: GenerationReference[],
  ): Promise<StagedReference[]> {
    const staged: StagedReference[] = []
    for (const reference of [...references].sort((left, right) => left.alias - right.alias)) {
      let state = this.requireUploadState(jobId, reference.alias)
      if (!state.assetId) {
        const sourceUrl = state.sourceUrl ?? reference.url
        if (!sourceUrl) throw new Error('Reference source is unavailable')
        const imported = await this.options.assets.importRemote(sourceUrl, undefined, this.signal)
        await this.options.jobs.updateReferenceUpload(jobId, reference.alias, { assetId: imported.id })
        state = this.requireUploadState(jobId, reference.alias)
      }
      const asset = state.assetId ? this.options.assets.get(state.assetId) : undefined
      if (!asset) throw new Error('Reference asset not found')
      const input: LocalReference = {
        filename: asset.filename,
        contentType: asset.contentType,
        size: asset.size,
        openStream: (signal) => this.options.assets.openReadStream(asset.id, signal),
      }
      if (state.status === 'manual_recovery') throw new CompleteAmbiguousError()
      if (state.status === 'complete') {
        if (!state.url) throw new Error('Completed reference URL is unavailable')
        staged.push({ alias: reference.alias, mediaType: reference.mediaType, url: state.url })
        continue
      }
      const grantKey = this.uploadGrantKey(jobId, reference.alias)
      if (state.status === 'pending') {
        const nextGrant = await this.retry(() => adapter.presignReference(input, this.signal))
        await this.options.jobs.updateReferenceUpload(jobId, reference.alias, {
          status: 'presigned', fileKey: nextGrant.fileKey, presignedAt: new Date().toISOString(),
        })
        this.uploadGrants.set(grantKey, nextGrant)
        state = this.requireUploadState(jobId, reference.alias)
      }
      if (state.status === 'presigned') {
        let activeGrant = this.uploadGrants.get(grantKey)
        if (!activeGrant || activeGrant.expiresAt <= Date.now()) {
          activeGrant = await this.retry(() => adapter.presignReference(input, this.signal))
          await this.options.jobs.updateReferenceUpload(jobId, reference.alias, {
            fileKey: activeGrant.fileKey, presignedAt: new Date().toISOString(),
          })
          this.uploadGrants.set(grantKey, activeGrant)
        }
        await this.retry(() => adapter.uploadReference(input, activeGrant as PresignedUpload, this.signal))
        await this.options.jobs.updateReferenceUpload(jobId, reference.alias, {
          status: 'uploaded', uploadedAt: new Date().toISOString(),
        })
        this.uploadGrants.delete(grantKey)
        state = this.requireUploadState(jobId, reference.alias)
      }
      if (state.status === 'uploaded') {
        if (!state.fileKey) throw new Error('Persisted upload file key is missing')
        const completeAttemptedAt = new Date().toISOString()
        await this.options.jobs.updateReferenceUpload(jobId, reference.alias, {
          status: 'manual_recovery', completeAttemptedAt,
        })
        let completed: StagedReference
        try {
          completed = await adapter.completeReference(state.fileKey, this.signal)
        } catch {
          throw new CompleteAmbiguousError()
        }
        await this.options.jobs.updateReferenceUpload(jobId, reference.alias, {
          status: 'complete', url: completed.url, completedAt: new Date().toISOString(),
        })
        state = this.requireUploadState(jobId, reference.alias)
      }
      if (!state.url) throw new Error('Completed reference URL is unavailable')
      staged.push({ alias: reference.alias, mediaType: reference.mediaType, url: state.url })
    }
    return staged
  }

  private async downloadOutputs(job: GenerationJob, urls: string[]): Promise<GenerationJob> {
    if (urls.length === 0) throw new Error('Cannot complete a generation without outputs')
    await this.options.jobs.update(job.id, { status: 'downloading', progress: 100, error: undefined })
    try {
      let current = this.requireJob(job.id)
      for (let index = current.outputs.length; index < urls.length; index += 1) {
        const url = urls[index]
        const asset = await this.retry(() => this.options.assets.importRemote(url, undefined, this.signal))
        const output = { assetId: asset.id, url: asset.url, contentType: asset.contentType, size: asset.size }
        current = await this.options.jobs.update(job.id, { outputs: [...current.outputs, output] })
        await this.recordHistoryOutput(current, index)
      }
      for (let index = 0; index < current.outputs.length; index += 1) {
        await this.recordHistoryOutput(current, index)
      }
      const completed = await this.options.jobs.update(job.id, {
        status: 'complete', outputs: current.outputs, progress: 100, error: undefined,
      })
      this.clearPoll(job.id)
      return completed
    } catch (error) {
      this.report('generation.output_download_failed', error)
      this.schedulePoll(job.id)
      return this.options.jobs.update(job.id, {
        status: 'downloading',
        error: sanitizedError('OUTPUT_DOWNLOAD_FAILED', 'Generated output could not be saved locally yet'),
      })
    }
  }

  private async recordHistoryOutput(job: GenerationJob, outputIndex: number): Promise<void> {
    if (!this.options.history) return
    const output = job.outputs[outputIndex]
    const asset = output ? this.options.assets.get(output.assetId) : undefined
    if (!asset) throw new Error('Downloaded generation output asset is unavailable')
    await this.options.history.recordOutput({ job, outputIndex, asset })
  }

  private async failFromUpstream(id: string, job: GenerationJob, upstream: UpstreamTaskStatus): Promise<GenerationJob> {
    if (upstream.errorCode || upstream.errorMessage) {
      this.report('generation.provider_failed', `${upstream.errorCode ?? ''} ${upstream.errorMessage ?? ''}`)
    }
    const failed = await this.options.jobs.update(id, {
      status: 'failed',
      progress: upstream.progress ?? job.progress,
      error: sanitizedError('PROVIDER_FAILED', 'Generation failed at the provider'),
    })
    this.clearPoll(id)
    return failed
  }

  private hasExceededRunTime(job: GenerationJob): boolean {
    const startedAt = Date.parse(job.createAttemptedAt ?? job.updatedAt ?? job.createdAt)
    return Number.isFinite(startedAt) && this.now() - startedAt > this.maxRunTimeMs
  }

  private async failTimedOut(id: string): Promise<GenerationJob> {
    const failed = await this.options.jobs.update(id, {
      status: 'failed',
      error: sanitizedError(
        'GENERATION_TIMEOUT',
        'Generation exceeded the local time limit',
      ),
    })
    this.clearPoll(id)
    return failed
  }

  private requireUploadState(jobId: string, alias: number): ReferenceUploadState {
    const job = this.options.jobs.getStored(jobId)
    const state = job?.referenceUploads.find((candidate) => candidate.alias === alias)
    if (!state) throw new Error('Reference upload state not found')
    return state
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.signal.throwIfAborted()
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (this.signal.aborted) throw this.signal.reason
        if (attempt < 3) await this.sleepUntilRetry(attempt * 250)
      }
    }
    throw lastError
  }

  private async sleepUntilRetry(delay: number): Promise<void> {
    this.signal.throwIfAborted()
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.signal.reason)
      this.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([this.sleep(delay), aborted])
    } finally {
      if (onAbort) this.signal.removeEventListener('abort', onAbort)
    }
  }

  private schedulePoll(id: string): void {
    if (this.closed || this.pollTimers.has(id)) return
    const job = this.options.jobs.get(id)
    if (!job || this.isTerminal(job.status)) return
    const delay = Math.max(10_000, Math.min(15_000, this.pollDelayMs()))
    const handle = this.schedule(async () => {
      this.pollTimers.delete(id)
      await this.poll(id)
    }, delay)
    this.pollTimers.set(id, handle)
  }

  private clearPoll(id: string): void {
    if (!this.pollTimers.has(id)) return
    const handle = this.pollTimers.get(id)
    this.pollTimers.delete(id)
    this.cancelSchedule(handle)
  }

  private runForJob(id: string, operation: () => Promise<GenerationJob>): Promise<GenerationJob> {
    const existing = this.inFlight.get(id)
    if (existing) return existing
    const current = operation()
    this.inFlight.set(id, current)
    void current.finally(() => {
      if (this.inFlight.get(id) === current) this.inFlight.delete(id)
    }).catch(() => {})
    return current
  }

  private uploadGrantKey(jobId: string, alias: number): string {
    return `${jobId}:${alias}`
  }

  private report(event: string, error: unknown): void {
    this.options.log?.({ event, message: sanitizedLogMessage(error) })
  }

  async close(): Promise<void> {
    this.closed = true
    this.abortController.abort(new DOMException('Generation runner is closing', 'AbortError'))
    for (const id of [...this.pollTimers.keys()]) this.clearPoll(id)
    await Promise.allSettled([
      ...[...this.submitFlights.values()].map((flight) => flight.operation),
      ...this.inFlight.values(),
    ])
    this.uploadGrants.clear()
    await this.lock.release()
  }

  private requireJob(id: string): GenerationJob {
    const job = this.options.jobs.get(id)
    if (!job) throw new Error('Generation job not found')
    return job
  }

  private isTerminal(status: GenerationJobStatus): boolean {
    return status === 'complete' || status === 'failed'
  }
}
