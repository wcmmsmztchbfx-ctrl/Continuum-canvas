import type { StoreApi } from 'zustand/vanilla'

import type {
  GenerationJob,
  GenerationReference,
  GenerationRequest,
  PersistedGenerationRequest,
  GenerationQuoteReference,
} from '../contracts/generation'
import {
  getOrderedReferences,
  validatePromptReferences,
  type CanvasEdge,
  type CanvasNode,
  type MediaGeneration,
  type MediaGenerationSettings,
  type PendingGenerationRequest,
  type ProjectSnapshot,
} from '../model/project'
import { defaultProjectPersistenceQueue } from '../persistence'
import type { CanvasStoreState } from '../store/canvas-store'
import {
  GatewayClientError,
  gatewayClient,
  type AssetRecord,
  type GatewayRequestOptions,
} from './gatewayClient'

export interface GenerationGateway {
  uploadAsset(
    body: Blob,
    filename: string,
    options?: GatewayRequestOptions,
  ): Promise<AssetRecord>
  importAsset(
    url: string,
    filename?: string,
    options?: GatewayRequestOptions,
  ): Promise<AssetRecord>
  createGenerationJob(
    request: GenerationRequest,
    options?: GatewayRequestOptions,
  ): Promise<GenerationJob>
  getGenerationJob(
    jobId: string,
    options?: GatewayRequestOptions,
  ): Promise<GenerationJob>
  backfillGenerationHistory?(
    input: {
      projectId: string
      canvasId?: string
      entries: Array<{ jobId: string; outputIndex: number; assetId: string }>
    },
    options?: GatewayRequestOptions,
  ): Promise<void>
}

export interface GenerationStartInput {
  canvasId?: string
  projectId?: string
  sourceNodeId: string
  targetNodeIds: string[]
  targetNodes?: CanvasNode[]
  outputEdges?: CanvasEdge[]
  prompt: string
  clientRequestId?: string
  settings?: MediaGenerationSettings
  references?: GenerationQuoteReference[]
}

export interface GenerationControllerOptions {
  gateway?: GenerationGateway
  store: StoreApi<CanvasStoreState>
  createId?: () => string
  pollIntervalMs?: number
  pollTimeoutMs?: number
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readBlob?: (url: string, signal: AbortSignal) => Promise<Blob>
  now?: () => Date
  persistProject?: (project: ProjectSnapshot) => Promise<void>
}

export class GenerationControllerError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'GenerationControllerError'
    this.code = code
  }
}

interface BatchContext {
  canvasId?: string
  projectId: string
  sourceNodeId: string
  targetNodeIds: string[]
  clientRequestId: string
}

type MediaNode = Extract<CanvasNode, { type: 'image' | 'video' }>
type StagedReference = GenerationReference & { assetId: string }

const LOCAL_ASSET = /^\/api\/assets\/([0-9a-f-]{36})$/i
const MAX_POLL_INTERVAL_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 10_000
const DEFAULT_POLL_TIMEOUT_MS = 30 * 60_000

function sanitizeExternalMessage(message: string, fallback: string): string {
  let sanitized = message.trim() || fallback
  sanitized = sanitized.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
    try {
      const url = new URL(value)
      return `${url.origin}${url.pathname}`
    } catch {
      return value.replace(/[?#].*$/, '')
    }
  })
  sanitized = sanitized.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
  sanitized = sanitized.replace(
    /\b(api[_-]?key|token|access[_-]?token|secret)\b(\s*[:=]\s*)[^\s,;]+/gi,
    '$1$2[redacted]',
  )
  sanitized = sanitized.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[redacted]')
  sanitized = sanitized.replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, '[local path]')
  sanitized = sanitized.replace(
    /\/(?:Users|home|root|var|tmp|etc|opt|srv|mnt|private)\/[^\s"'<>]*/g,
    '[local path]',
  )
  return sanitized.slice(0, 512)
}

function externalErrorMessage(error: unknown, fallback: string): string {
  return sanitizeExternalMessage(
    error instanceof Error && error.message ? error.message : fallback,
    fallback,
  )
}

function sanitizedPublicError(error: unknown): unknown {
  if (isAbort(error)) return error
  if (error instanceof GatewayClientError) {
    return new GatewayClientError(
      error.status,
      error.code,
      externalErrorMessage(error, 'Gateway request failed'),
    )
  }
  if (error instanceof GenerationControllerError) {
    return new GenerationControllerError(
      error.code,
      externalErrorMessage(error, 'Generation failed'),
    )
  }
  if (error instanceof Error) {
    const sanitized = new Error(externalErrorMessage(error, 'Generation failed'))
    sanitized.name = error.name
    return sanitized
  }
  return error
}

function mediaNode(node: CanvasNode | undefined): MediaNode | undefined {
  return node?.type === 'image' || node?.type === 'video' ? node : undefined
}

function activeGeneration(generation: MediaGeneration | undefined): boolean {
  return Boolean(
    generation &&
    (generation.status === 'generating' ||
      generation.pendingRequest !== undefined ||
      generation.error?.code === 'manual_recovery_required' ||
      (generation.jobId &&
        (generation.error?.code === 'poll_unavailable' ||
          generation.error?.code === 'network_error' ||
          generation.error?.code === 'local_persistence_failed'))),
  )
}

function requiresExplicitResubmission(generation: MediaGeneration | undefined): boolean {
  return Boolean(
    generation?.pendingRequest &&
    (generation.error?.code === 'REFERENCE_STAGING_FAILED' ||
      generation.error?.code === 'manual_recovery_required'),
  )
}

function batchNodes(snapshot: ProjectSnapshot, sourceNodeId: string): MediaNode[] {
  return snapshot.nodes
    .map(mediaNode)
    .filter((node): node is MediaNode => {
      const generation = node?.data.generation
      return (
        generation?.sourceNodeId === sourceNodeId && activeGeneration(generation)
      )
    })
    .sort(
      (left, right) =>
        (left.data.generation?.outputIndex ?? 0) -
        (right.data.generation?.outputIndex ?? 0),
    )
}

function extensionForMime(contentType: string): string {
  if (contentType === 'image/png') return 'png'
  if (contentType === 'image/jpeg') return 'jpg'
  if (contentType === 'image/webp') return 'webp'
  if (contentType === 'image/gif') return 'gif'
  if (contentType === 'video/mp4') return 'mp4'
  if (contentType === 'video/webm') return 'webm'
  return 'bin'
}

function filenameFromUrl(url: string, fallback: string): string {
  try {
    const filename = new URL(url).pathname.split('/').filter(Boolean).at(-1)
    return filename ? decodeURIComponent(filename).slice(0, 180) : fallback
  } catch {
    return fallback
  }
}

function dataUrlBlob(url: string): Blob {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url)
  if (!match) {
    throw new GenerationControllerError('invalid_asset', 'Reference data URL is invalid')
  }
  const contentType = match[1]
  const encoded = match[3]
  try {
    if (match[2]) {
      const decoded = globalThis.atob(encoded)
      const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0))
      return new Blob([bytes], { type: contentType })
    }
    return new Blob([decodeURIComponent(encoded)], { type: contentType })
  } catch {
    throw new GenerationControllerError('invalid_asset', 'Reference data URL is invalid')
  }
}

export function waitForPollDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const cleanup = () => signal.removeEventListener('abort', abort)
    const timer = globalThis.setTimeout(() => {
      cleanup()
      resolve()
    }, milliseconds)
    const abort = () => {
      globalThis.clearTimeout(timer)
      cleanup()
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function defaultReadBlob(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new GenerationControllerError('asset_read_failed', 'Unable to read local reference')
  }
  return response.blob()
}

function defaultId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

function generationSettings(node: MediaNode): MediaGenerationSettings {
  const settings = node.data.generationSettings
  if (!settings || settings.kind !== node.type) {
    throw new GenerationControllerError(
      'generation_not_configured',
      'Generation settings are not configured',
    )
  }
  if (
    !settings.providerId ||
    !settings.catalogVersion ||
    settings.channel === undefined ||
    settings.channel === '' ||
    !settings.model
  ) {
    throw new GenerationControllerError(
      'generation_not_configured',
      'Provider, catalog, channel, and model are required',
    )
  }
  return settings
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function isAmbiguousCreate(error: unknown): boolean {
  return (
    error instanceof GatewayClientError &&
    (error.status >= 500 ||
      (error.status === 0 &&
        (error.code === 'network_error' || error.code === 'timeout')))
  )
}

function isRecoverablePollError(error: unknown): boolean {
  return (
    error instanceof GatewayClientError &&
    (error.status >= 500 ||
      (error.status === 0 &&
        (error.code === 'network_error' || error.code === 'timeout')))
  )
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`)
  }
}

export class GenerationController {
  private readonly gateway: GenerationGateway
  private readonly store: StoreApi<CanvasStoreState>
  private readonly createId: () => string
  private readonly pollIntervalMs: number
  private readonly pollTimeoutMs: number
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly readBlob: (url: string, signal: AbortSignal) => Promise<Blob>
  private readonly now: () => Date
  private readonly persistProject: (project: ProjectSnapshot) => Promise<void>
  private readonly lifecycle = new AbortController()
  private readonly activeSources = new Map<string, Promise<GenerationJob>>()
  private readonly activeJobs = new Map<string, Promise<GenerationJob>>()

  constructor(options: GenerationControllerOptions) {
    this.gateway = options.gateway ?? gatewayClient
    this.store = options.store
    this.createId = options.createId ?? defaultId
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    assertPositiveFinite(this.pollIntervalMs, 'pollIntervalMs')
    assertPositiveFinite(this.pollTimeoutMs, 'pollTimeoutMs')
    this.wait = options.wait ?? waitForPollDelay
    this.readBlob = options.readBlob ?? defaultReadBlob
    this.now = options.now ?? (() => new Date())
    this.persistProject =
      options.persistProject ??
      ((project) => defaultProjectPersistenceQueue.persistBarrier(project))
  }

  start(input: GenerationStartInput): Promise<GenerationJob> {
    return this.run(input, false)
  }

  startSubmitted(input: GenerationStartInput): Promise<GenerationJob> {
    return this.runUntilSubmitted(input, false)
  }

  retry(input: GenerationStartInput): Promise<GenerationJob> {
    return this.run(input, true)
  }

  retrySubmitted(input: GenerationStartInput): Promise<GenerationJob> {
    return this.runUntilSubmitted(input, true)
  }

  private runUntilSubmitted(
    input: GenerationStartInput,
    retry: boolean,
  ): Promise<GenerationJob> {
    return new Promise((resolve, reject) => {
      let submitted = false
      void this.run(input, retry, (job) => {
        submitted = true
        resolve(job)
      }).catch((error: unknown) => {
        if (!submitted) reject(error)
      })
    })
  }

  isSourcePending(sourceNodeId: string): boolean {
    const snapshot = this.store.getState().snapshot
    return batchNodes(snapshot, sourceNodeId).length > 0
  }

  async resolveCatalogChanged(sourceNodeId: string): Promise<boolean> {
    const snapshot = this.store.getState().snapshot
    const rejected = snapshot.nodes
      .map(mediaNode)
      .filter((node): node is MediaNode => {
        const generation = node?.data.generation
        return Boolean(
          generation?.sourceNodeId === sourceNodeId &&
          generation.error?.code === 'catalog_changed' &&
          !generation.jobId,
        )
      })
    if (rejected.length === 0) return false

    let cleared = false
    for (const node of rejected) {
      const generation = node.data.generation!
      const written = this.store.getState().setMediaGenerationGuarded({
        projectId: snapshot.projectId,
        nodeId: node.id,
        clientRequestId: generation.clientRequestId ?? null,
        expectedJobId: null,
        generation: {
          ...generation,
          pendingRequest: undefined,
          error: undefined,
        },
      })
      cleared = written || cleared
    }
    if (!cleared) return false

    try {
      await this.persistProject(this.store.getState().snapshot)
    } catch (error) {
      throw sanitizedPublicError(error)
    }
    return true
  }

  private run(
    input: GenerationStartInput,
    retry: boolean,
    onSubmitted?: (job: GenerationJob) => void,
  ): Promise<GenerationJob> {
    const projectId = this.store.getState().snapshot.projectId
    if (input.projectId && input.projectId !== projectId) {
      return Promise.reject(new GenerationControllerError(
        'project_inactive',
        'The approved generation belongs to another project',
      ))
    }
    const key = `${projectId}:${input.sourceNodeId}`
    const existing = this.activeSources.get(key)
    if (existing) {
      if (retry) {
        return existing.then(
          (job) => {
            onSubmitted?.(job)
            return job
          },
          () => this.run(input, true, onSubmitted),
        )
      }
      return onSubmitted
        ? Promise.reject(new GenerationControllerError(
            'generation_locked',
            'A generation is already active for this source',
          ))
        : existing
    }
    const operation = this.execute(projectId, input, retry, onSubmitted)
      .catch((error: unknown) => {
        throw sanitizedPublicError(error)
      })
      .finally(() => {
        if (this.activeSources.get(key) === operation) this.activeSources.delete(key)
      })
    this.activeSources.set(key, operation)
    return operation
  }

  private async execute(
    projectId: string,
    input: GenerationStartInput,
    retry: boolean,
    onSubmitted?: (job: GenerationJob) => void,
  ): Promise<GenerationJob> {
    this.assertProject(projectId)
    const snapshot = this.store.getState().snapshot
    const source = mediaNode(snapshot.nodes.find((node) => node.id === input.sourceNodeId))
    if (!source) {
      throw new GenerationControllerError('source_not_found', 'Generation source was not found')
    }

    const persisted = batchNodes(snapshot, source.id)
    if (persisted.length > 0) {
      const context = this.contextFromBatch(projectId, source.id, persisted)
      if (retry) return this.recover(context, persisted, onSubmitted)
      const jobId = persisted[0]?.data.generation?.jobId
      if (jobId) return this.pollJob(context, jobId)
      throw new GenerationControllerError(
        'manual_recovery_required',
        'The pending paid request requires manual recovery',
      )
    }

    let settings: MediaGenerationSettings
    try {
      settings = input.settings ? structuredClone(input.settings) : generationSettings(source)
      if (settings.kind !== source.type) {
        throw new GenerationControllerError(
          'generation_not_configured',
          'Frozen generation settings do not match the source node',
        )
      }
    } catch (error) {
      this.recordPreflightFailure(projectId, input, error)
      throw error
    }
    if (source.data.unresolvedReferenceNodeIds?.length) {
      throw new GenerationControllerError(
        'unresolved_legacy_references',
        `Missing legacy references: ${source.data.unresolvedReferenceNodeIds.join(', ')}`,
      )
    }
    const references = this.referencesFor(snapshot, source, input.references)
    const promptValidation = validatePromptReferences(
      input.prompt,
      references.map(({ edge }) => edge.referenceAlias),
    )
    if (!promptValidation.valid) {
      throw new GenerationControllerError(
        'unresolved_references',
        `Prompt contains unresolved references: ${promptValidation.unresolvedAliases
          .map((alias) => `@${alias}`)
          .join(', ')}`,
      )
    }

    const clientRequestId = input.clientRequestId ?? this.createId()
    await this.backfillCurrentResult(projectId, source)
    const targetNodes = input.targetNodes ?? []
    const draftIds = new Set(targetNodes.map((node) => node.id))
    const existingTargetNodeIds = input.targetNodeIds.filter((id) => !draftIds.has(id))
    const targetNodeIds = this.store.getState().createGenerationBatch({
      projectId,
      sourceNodeId: source.id,
      clientRequestId,
      prompt: input.prompt,
      createdAt: this.now().toISOString(),
      existingTargetNodeIds,
      targetNodes,
      outputEdges: input.outputEdges ?? [],
      settings,
    })
    if (!targetNodeIds?.length) {
      throw new GenerationControllerError(
        'generation_locked',
        'A generation is already active for this source',
      )
    }
    const context: BatchContext = {
      canvasId: input.canvasId,
      projectId,
      sourceNodeId: source.id,
      targetNodeIds,
      clientRequestId,
    }

    try {
      const staged: StagedReference[] = []
      for (const reference of references) {
        staged.push(
          await this.stageReference(
            projectId,
            reference.edge.referenceAlias,
            reference.node,
            this.lifecycle.signal,
          ),
        )
      }
      const request = this.buildRequest(
        projectId,
        input.canvasId,
        targetNodeIds[0],
        source,
        settings,
        input.prompt,
        clientRequestId,
        staged,
      )
      const pendingRequest: PendingGenerationRequest = {
        projectId,
        sourceNodeId: source.id,
        outputs: targetNodeIds.map((nodeId, outputIndex) => ({ nodeId, outputIndex })),
        request,
      }
      this.updatePendingRequest(context, pendingRequest)
      await this.persistPendingRequest(context)
      return await this.submitPending(context, pendingRequest, null, onSubmitted)
    } catch (error) {
      if (
        !isAbort(error) &&
        !(error instanceof GenerationControllerError &&
          (error.code === 'manual_recovery_required' ||
            error.code === 'poll_timeout' ||
            error.code === 'poll_unavailable' ||
            error.code === 'local_persistence_failed' ||
            error.code === 'project_inactive'))
      ) {
        this.markFailed(context, error)
      }
      throw error
    }
  }

  private referencesFor(
    snapshot: ProjectSnapshot,
    source: MediaNode,
    frozen?: GenerationQuoteReference[],
  ) {
    const ordered = getOrderedReferences(snapshot, source.id)
    if (frozen) {
      return [...frozen]
        .sort((left, right) => left.alias - right.alias)
        .map((item) => {
          const match = ordered.find(({ edge, node }) =>
            edge.referenceAlias === item.alias &&
            node.id === item.nodeId &&
            node.type === item.mediaType,
          )
          if (!match) {
            throw new GenerationControllerError(
              'generation_stale',
              `Reference @${item.alias} changed before submission`,
            )
          }
          return match
        })
    }
    return ordered.length > 0
      ? ordered
      : source.data.url
        ? [{ edge: { referenceAlias: 1 }, node: source }]
        : []
  }

  private contextFromBatch(
    projectId: string,
    sourceNodeId: string,
    nodes: MediaNode[],
  ): BatchContext {
    const clientRequestId = nodes[0]?.data.generation?.clientRequestId
    if (
      !clientRequestId ||
      nodes.some((node) => node.data.generation?.clientRequestId !== clientRequestId)
    ) {
      throw new GenerationControllerError(
        'invalid_pending_batch',
        'Pending generation batch metadata is inconsistent',
      )
    }
    return {
      canvasId: nodes[0]?.data.generation?.pendingRequest?.request.canvasId,
      projectId,
      sourceNodeId,
      targetNodeIds: nodes.map((node) => node.id),
      clientRequestId,
    }
  }

  private async recover(
    context: BatchContext,
    targets: MediaNode[],
    onSubmitted?: (job: GenerationJob) => void,
  ): Promise<GenerationJob> {
    const generation = targets[0]?.data.generation
    if (generation?.jobId) {
      if (requiresExplicitResubmission(generation)) {
        await this.persistBarrier(context)
        return this.submitPending(
          context,
          generation.pendingRequest!,
          generation.jobId,
          onSubmitted,
        )
      }
      if (onSubmitted) {
        const current = await this.gateway.getGenerationJob(generation.jobId, {
          signal: this.lifecycle.signal,
        })
        onSubmitted(current)
      }
      return this.pollJob(context, generation.jobId)
    }
    if (generation?.pendingRequest) {
      await this.persistPendingRequest(context)
      return this.submitPending(context, generation.pendingRequest, null, onSubmitted)
    }
    const message =
      'Original generation request is unavailable; start a new generation instead'
    this.markRecoverable(
      context,
      null,
      'original_request_unavailable',
      message,
      true,
    )
    throw new GenerationControllerError('original_request_unavailable', message)
  }

  private buildRequest(
    projectId: string,
    canvasId: string | undefined,
    targetNodeId: string,
    source: MediaNode,
    settings: MediaGenerationSettings,
    prompt: string,
    clientRequestId: string,
    references: StagedReference[],
  ): PendingGenerationRequest['request'] {
    const base: PendingGenerationRequest['request'] = {
      clientRequestId,
      projectId,
      ...(canvasId ? { canvasId } : {}),
      targetNodeId,
      providerId: settings.providerId!,
      catalogVersion: settings.catalogVersion!,
      mediaType: source.type,
      channel: settings.channel!,
      model: settings.model!,
      prompt,
      aspectRatio: settings.aspectRatio,
      n: settings.count,
      ...(settings.mode ? { mode: settings.mode } : {}),
      references: [...references]
        .sort((left, right) => left.alias - right.alias)
        .map(({ alias, assetId, mediaType }) => ({ alias, assetId, mediaType })),
    }
    if (settings.kind === 'image') base.quality = settings.quality || settings.resolution
    else {
      base.quality = settings.resolution
      base.duration = settings.durationSec
      base.generateAudio = settings.generateAudio
    }
    return base
  }

  private async backfillCurrentResult(
    projectId: string,
    source: MediaNode,
  ): Promise<void> {
    const generation = source.data.generation
    const outputIndex = generation?.outputIndex ?? 0
    const assetId = source.data.assetId
    const output = generation?.outputs?.[outputIndex]
    if (
      generation?.status !== 'complete' ||
      !generation.jobId ||
      !assetId ||
      source.data.url !== `/api/assets/${assetId}`
    ) {
      return
    }
    if (!this.gateway.backfillGenerationHistory) {
      throw new GenerationControllerError(
        'history_unavailable',
        'Generation history is unavailable; the existing result was not replaced',
      )
    }
    if (output && output.assetId !== assetId) {
      throw new GenerationControllerError(
        'history_conflict',
        'Existing generation metadata does not match its local asset',
      )
    }
    await this.gateway.backfillGenerationHistory(
      {
        projectId,
        ...(generation.pendingRequest?.request.canvasId
          ? { canvasId: generation.pendingRequest.request.canvasId }
          : {}),
        entries: [{ jobId: generation.jobId, outputIndex, assetId }],
      },
      { signal: this.lifecycle.signal },
    )
    this.assertProject(projectId)
  }

  private async stageReference(
    projectId: string,
    alias: number,
    node: CanvasNode,
    signal: AbortSignal,
  ): Promise<StagedReference> {
    this.assertProject(projectId)
    const reference = mediaNode(node)
    if (!reference?.data.url) {
      throw new GenerationControllerError(
        'reference_missing_asset',
        `Reference @${alias} has no media`,
      )
    }
    const originalUrl = reference.data.url
    const localMatch = LOCAL_ASSET.exec(originalUrl)
    if (localMatch) {
      return { alias, assetId: localMatch[1], mediaType: reference.type }
    }

    const staged = /^https?:\/\//i.test(originalUrl)
      ? await this.gateway.importAsset(
          originalUrl,
          filenameFromUrl(
            originalUrl,
            `reference-${alias}.${reference.type === 'image' ? 'png' : 'mp4'}`,
          ),
          { signal },
        )
      : await this.gateway.uploadAsset(
          originalUrl.startsWith('data:')
            ? dataUrlBlob(originalUrl)
            : await this.readBlob(originalUrl, signal),
          `reference-${alias}.${extensionForMime(
            originalUrl.startsWith('data:')
              ? dataUrlBlob(originalUrl).type
              : reference.type === 'image'
                ? 'image/png'
                : 'video/mp4',
          )}`,
          { signal },
        )
    this.assertProject(projectId)
    const written = this.store.getState().setMediaAssetGuarded({
      projectId,
      nodeId: reference.id,
      expectedUrl: originalUrl,
      asset: { assetId: staged.id, url: staged.url },
    })
    if (!written) {
      throw new GenerationControllerError(
        'generation_stale',
        'Reference changed while it was being staged',
      )
    }
    return { alias, assetId: staged.id, mediaType: reference.type }
  }

  private updatePendingRequest(
    context: BatchContext,
    pendingRequest: PendingGenerationRequest,
  ): void {
    for (const nodeId of context.targetNodeIds) {
      const node = this.currentTarget(context, nodeId)
      const generation = node.data.generation!
      const written = this.store.getState().setMediaGenerationGuarded({
        projectId: context.projectId,
        nodeId,
        clientRequestId: context.clientRequestId,
        expectedJobId: null,
        generation: {
          ...generation,
          status: 'generating',
          phase: 'submitted',
          pendingRequest,
          error: undefined,
        },
      })
      if (!written) this.throwStale(context)
    }
  }

  private async persistPendingRequest(context: BatchContext): Promise<void> {
    try {
      await this.persistBarrier(context)
    } catch (error) {
      if (error instanceof GenerationControllerError) throw error
      const detail = externalErrorMessage(error, '')
      const message =
        `Local persistence failed before task submission; ` +
        `the frozen request remains recoverable${detail ? `: ${detail}` : ''}`
      this.markRecoverable(
        context,
        null,
        'local_persistence_failed',
        message,
        false,
      )
      throw new GenerationControllerError('local_persistence_failed', message)
    }
  }

  private async submitPending(
    context: BatchContext,
    pendingRequest: PendingGenerationRequest,
    expectedJobId: string | null = null,
    onSubmitted?: (job: GenerationJob) => void,
  ): Promise<GenerationJob> {
    this.assertProject(context.projectId)
    if (
      pendingRequest.projectId !== context.projectId ||
      (pendingRequest.request.projectId !== undefined &&
        pendingRequest.request.projectId !== context.projectId)
    ) {
      throw new GenerationControllerError(
        'invalid_pending_batch',
        'Persisted generation request belongs to another project',
      )
    }
    let submitted: GenerationJob
    try {
      submitted = await this.gateway.createGenerationJob({
        ...pendingRequest.request,
        projectId: context.projectId,
        ...(context.canvasId
          ? { canvasId: context.canvasId, targetNodeId: context.targetNodeIds[0] }
          : {}),
      }, {
        signal: this.lifecycle.signal,
      })
    } catch (error) {
      if (isAmbiguousCreate(error)) {
        const message =
          'Task creation result is unknown; retry manually with the same request'
        this.markRecoverable(
          context,
          expectedJobId,
          'manual_recovery_required',
          message,
          true,
        )
        await this.persistRecoverableAndThrow(
          context,
          'manual_recovery_required',
          message,
        )
      }
      throw error
    }
    this.assertProject(context.projectId)
    this.applyJob(context, submitted, expectedJobId)
    await this.persistAppliedJob(context, submitted)
    onSubmitted?.(submitted)
    // Collaborative jobs are written back by the gateway through the shared
    // Yjs document. A second browser-side poller races that authoritative
    // stream and can incorrectly mark an otherwise valid target as stale.
    if (submitted.roomId) return submitted
    if (
      submitted.status === 'uploading' &&
      submitted.error?.code === 'REFERENCE_STAGING_FAILED'
    ) {
      return submitted
    }
    if (submitted.status === 'complete' || submitted.status === 'failed') {
      return submitted
    }
    return this.pollJob(context, submitted.id)
  }

  private async persistAppliedJob(
    context: BatchContext,
    job: GenerationJob,
  ): Promise<void> {
    try {
      await this.persistBarrier(context)
    } catch (error) {
      if (error instanceof GenerationControllerError) throw error
      if (job.error?.code === 'REFERENCE_STAGING_FAILED') {
        throw new GenerationControllerError(
          'REFERENCE_STAGING_FAILED',
          sanitizeExternalMessage(job.error.message, 'Reference staging failed'),
        )
      }
      if (job.status === 'failed') throw error
      const detail = externalErrorMessage(error, '')
      const message =
        `Local persistence failed after the upstream task was accepted; ` +
        `the task remains resumable${detail ? `: ${detail}` : ''}`
      if (job.status === 'complete') {
        this.markLocalPersistenceFailure(context, job.id, message)
      } else {
        this.markRecoverable(
          context,
          job.id,
          'local_persistence_failed',
          message,
          false,
        )
      }
      throw new GenerationControllerError('local_persistence_failed', message)
    }
  }

  private pollJob(context: BatchContext, jobId: string): Promise<GenerationJob> {
    const key = `${context.projectId}:${jobId}`
    const existing = this.activeJobs.get(key)
    if (existing) return existing
    const operation = this.pollJobUntilTerminal(context, jobId).finally(() => {
      if (this.activeJobs.get(key) === operation) this.activeJobs.delete(key)
    })
    this.activeJobs.set(key, operation)
    return operation
  }

  private async pollJobUntilTerminal(
    context: BatchContext,
    jobId: string,
  ): Promise<GenerationJob> {
    const startedAt = this.now().getTime()
    let delay = Math.min(this.pollIntervalMs, MAX_POLL_INTERVAL_MS)
    for (;;) {
      this.assertProject(context.projectId)
      const remainingBeforeGet = this.remainingPollBudget(startedAt)
      if (remainingBeforeGet <= 0) {
        return this.handlePollTimeout(context, jobId)
      }
      let current: GenerationJob
      try {
        current = await this.getGenerationJobWithinBudget(jobId, remainingBeforeGet)
      } catch (error) {
        if (isAbort(error)) throw error
        if (
          error instanceof GenerationControllerError &&
          error.code === 'poll_timeout'
        ) {
          return this.handlePollTimeout(context, jobId)
        }
        if (!isRecoverablePollError(error)) {
          this.markFailed(context, error)
          await this.persistCurrentIfActive(context).catch(() => undefined)
          throw error
        }
        const message = externalErrorMessage(
          error,
          'Polling is temporarily unavailable',
        )
        this.markRecoverable(context, jobId, 'poll_unavailable', message, false)
        return this.persistRecoverableAndThrow(
          context,
          'poll_unavailable',
          message,
        )
      }
      this.assertProject(context.projectId)
      this.applyJob(context, current, jobId)
      await this.persistAppliedJob(context, current)
      if (
        current.status === 'uploading' &&
        current.error?.code === 'REFERENCE_STAGING_FAILED'
      ) {
        return current
      }
      if (current.status === 'complete' || current.status === 'failed') return current

      const remaining = this.remainingPollBudget(startedAt)
      if (remaining <= 0) {
        return this.handlePollTimeout(context, jobId)
      }
      const waitMs = Math.min(delay, remaining)
      await this.wait(waitMs, this.lifecycle.signal)
      delay = Math.min(MAX_POLL_INTERVAL_MS, Math.ceil(delay * 1.5))
    }
  }

  private async handlePollTimeout(
    context: BatchContext,
    jobId: string,
  ): Promise<never> {
    this.markRecoverable(
      context,
      jobId,
      'poll_timeout',
      'Polling timed out; the task can be resumed safely',
      false,
    )
    return this.persistRecoverableAndThrow(
      context,
      'poll_timeout',
      'Polling timed out; the task remains resumable',
    )
  }

  private remainingPollBudget(startedAt: number): number {
    const elapsed = Math.max(0, this.now().getTime() - startedAt)
    return this.pollTimeoutMs - elapsed
  }

  private getGenerationJobWithinBudget(
    jobId: string,
    remainingMs: number,
  ): Promise<GenerationJob> {
    const requestController = new AbortController()
    return new Promise((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined
      const cleanup = () => {
        if (timer !== undefined) globalThis.clearTimeout(timer)
        this.lifecycle.signal.removeEventListener('abort', abortFromLifecycle)
      }
      const resolveOnce = (job: GenerationJob) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(job)
      }
      const rejectOnce = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const abortFromLifecycle = () => {
        const reason =
          this.lifecycle.signal.reason ??
          new DOMException('Generation controller disposed', 'AbortError')
        requestController.abort(reason)
        rejectOnce(reason)
      }
      if (this.lifecycle.signal.aborted) {
        abortFromLifecycle()
        return
      }
      this.lifecycle.signal.addEventListener('abort', abortFromLifecycle, {
        once: true,
      })
      timer = globalThis.setTimeout(() => {
        const error = new GenerationControllerError(
          'poll_timeout',
          'Polling timed out; the task remains resumable',
        )
        requestController.abort(error)
        rejectOnce(error)
      }, remainingMs)
      try {
        void this.gateway
          .getGenerationJob(jobId, { signal: requestController.signal })
          .then(resolveOnce, rejectOnce)
      } catch (error) {
        rejectOnce(error)
      }
    })
  }

  private async persistRecoverableAndThrow(
    context: BatchContext,
    code: string,
    message: string,
  ): Promise<never> {
    await this.persistCurrentIfActive(context).catch(() => undefined)
    throw new GenerationControllerError(code, message)
  }

  private applyJob(
    context: BatchContext,
    job: GenerationJob,
    expectedJobId: string | null,
  ): void {
    if (job.clientRequestId !== context.clientRequestId) {
      throw new GenerationControllerError(
        'job_identity_mismatch',
        'Gateway job does not match the persisted request',
      )
    }
    if ('projectId' in job.request && job.request.projectId !== context.projectId) {
      throw new GenerationControllerError(
        'job_identity_mismatch',
        'Gateway job belongs to another project',
      )
    }
    const rebuiltPendingRequest: PendingGenerationRequest | undefined =
      job.status === 'complete' || job.status === 'failed'
        ? undefined
        : {
            projectId: context.projectId,
            sourceNodeId: context.sourceNodeId,
            outputs: context.targetNodeIds.map((nodeId, fallbackIndex) => ({
              nodeId,
              outputIndex:
                this.currentTarget(context, nodeId).data.generation?.outputIndex ?? fallbackIndex,
            })),
            request: this.freezeJobRequest(job.request, context.projectId),
          }
    for (const [fallbackIndex, nodeId] of context.targetNodeIds.entries()) {
      const node = this.currentTarget(context, nodeId)
      const existing = node.data.generation!
      const guardedJobId = existing.jobId === job.id ? job.id : expectedJobId
      const outputIndex = existing.outputIndex ?? fallbackIndex
      const output = job.outputs[outputIndex]
      const outputMissing = job.status === 'complete' && output === undefined
      const failed = job.status === 'failed' || outputMissing
      const complete = job.status === 'complete' && output !== undefined
      const generation: MediaGeneration = {
        ...existing,
        status: complete ? 'complete' : failed ? 'failed' : 'generating',
        phase: complete ? 'complete' : failed ? 'failed' : job.status,
        progress: job.progress,
        jobId: job.id,
        clientRequestId: job.clientRequestId,
        providerId: job.request.providerId,
        upstreamTaskId: job.upstreamTaskId,
        createdAt: existing.createdAt ?? job.createdAt,
        outputs: [...job.outputs],
        pendingRequest:
          job.status === 'complete' || job.status === 'failed'
            ? undefined
            : existing.pendingRequest ?? rebuiltPendingRequest,
        error: outputMissing
          ? { code: 'output_missing', message: `Output ${outputIndex + 1} was not returned` }
          : job.error
            ? {
                ...job.error,
                message: sanitizeExternalMessage(
                  job.error.message,
                  'Generation failed',
                ),
              }
            : undefined,
      }
      const written = this.store.getState().setMediaGenerationGuarded({
        projectId: context.projectId,
        nodeId,
        clientRequestId: context.clientRequestId,
        expectedJobId: guardedJobId,
        generation,
        ...(complete && output
          ? {
              asset: {
                assetId: output.assetId,
                url: output.url,
              },
            }
          : {}),
      })
      if (!written) this.throwStale(context)
    }
  }

  private freezeJobRequest(
    request: PersistedGenerationRequest,
    projectId: string,
  ): PendingGenerationRequest['request'] {
    const cloned = structuredClone(request)
    const references = cloned.references.map((reference) => {
      if (!reference.assetId && !reference.url) {
        throw new GenerationControllerError(
          'invalid_response',
          'Gateway job request contains an unusable reference',
        )
      }
      return {
        alias: reference.alias,
        ...(reference.assetId ? { assetId: reference.assetId } : {}),
        ...(reference.url ? { url: reference.url } : {}),
        mediaType: reference.mediaType,
      }
    })
    return {
      ...cloned,
      projectId: 'projectId' in cloned ? cloned.projectId : projectId,
      references,
    }
  }

  private markRecoverable(
    context: BatchContext,
    expectedJobId: string | null,
    code: string,
    message: string,
    failedStatus: boolean,
  ): void {
    if (this.store.getState().snapshot.projectId !== context.projectId) return
    const sanitizedMessage = sanitizeExternalMessage(message, 'Generation is recoverable')
    for (const nodeId of context.targetNodeIds) {
      const node = mediaNode(
        this.store.getState().snapshot.nodes.find((candidate) => candidate.id === nodeId),
      )
      if (!node?.data.generation) continue
      this.store.getState().setMediaGenerationGuarded({
        projectId: context.projectId,
        nodeId,
        clientRequestId: context.clientRequestId,
        expectedJobId,
        generation: {
          ...node.data.generation,
          status: failedStatus ? 'failed' : 'generating',
          error: { code, message: sanitizedMessage },
        },
      })
    }
  }

  private markLocalPersistenceFailure(
    context: BatchContext,
    expectedJobId: string,
    message: string,
  ): void {
    if (this.store.getState().snapshot.projectId !== context.projectId) return
    const sanitizedMessage = sanitizeExternalMessage(
      message,
      'Local persistence failed; the task remains recoverable',
    )
    for (const nodeId of context.targetNodeIds) {
      const node = mediaNode(
        this.store.getState().snapshot.nodes.find((candidate) => candidate.id === nodeId),
      )
      if (!node?.data.generation) continue
      this.store.getState().setMediaGenerationGuarded({
        projectId: context.projectId,
        nodeId,
        clientRequestId: context.clientRequestId,
        expectedJobId,
        generation: {
          ...node.data.generation,
          error: { code: 'local_persistence_failed', message: sanitizedMessage },
        },
      })
    }
  }

  private markFailed(context: BatchContext, error: unknown): void {
    if (this.store.getState().snapshot.projectId !== context.projectId) return
    const code =
      error instanceof GatewayClientError || error instanceof GenerationControllerError
        ? error.code
        : 'generation_failed'
    const message = externalErrorMessage(error, 'Generation failed')
    for (const nodeId of context.targetNodeIds) {
      const node = mediaNode(
        this.store.getState().snapshot.nodes.find((candidate) => candidate.id === nodeId),
      )
      if (!node?.data.generation) continue
      if (
        node.data.generation.error?.code === 'poll_unavailable' ||
        node.data.generation.error?.code === 'REFERENCE_STAGING_FAILED' ||
        node.data.generation.error?.code === 'local_persistence_failed' ||
        node.data.generation.error?.code === 'manual_recovery_required' ||
        node.data.generation.error?.code === 'poll_timeout'
      ) {
        continue
      }
      const expectedJobId = node.data.generation.jobId ?? null
      this.store.getState().setMediaGenerationGuarded({
        projectId: context.projectId,
        nodeId,
        clientRequestId: context.clientRequestId,
        expectedJobId,
        generation: {
          ...node.data.generation,
          status: 'failed',
          phase: 'failed',
          pendingRequest: undefined,
          error: { code, message },
        },
      })
    }
  }

  private recordPreflightFailure(
    projectId: string,
    input: GenerationStartInput,
    error: unknown,
  ): void {
    if (this.store.getState().snapshot.projectId !== projectId) return
    const code =
      error instanceof GatewayClientError || error instanceof GenerationControllerError
        ? error.code
        : 'generation_failed'
    const message = externalErrorMessage(error, 'Generation failed')
    const existingTargetIds = input.targetNodeIds.filter((nodeId) =>
      this.store.getState().snapshot.nodes.some((node) => node.id === nodeId),
    )
    const nodeIds = existingTargetIds.length > 0
      ? existingTargetIds
      : [input.sourceNodeId]
    for (const nodeId of nodeIds) {
      const node = mediaNode(
        this.store.getState().snapshot.nodes.find((candidate) => candidate.id === nodeId),
      )
      if (!node) continue
      this.store.getState().setMediaGenerationGuarded({
        projectId,
        nodeId,
        clientRequestId: null,
        expectedJobId: null,
        generation: {
          ...(node.data.generation ?? { prompt: input.prompt, status: 'failed' }),
          status: 'failed',
          phase: 'failed',
          error: { code, message },
        },
      })
    }
  }

  private currentTarget(context: BatchContext, nodeId: string): MediaNode {
    this.assertProject(context.projectId)
    const node = mediaNode(
      this.store.getState().snapshot.nodes.find((candidate) => candidate.id === nodeId),
    )
    if (
      !node ||
      node.data.generation?.clientRequestId !== context.clientRequestId ||
      node.data.generation.sourceNodeId !== context.sourceNodeId
    ) {
      this.throwStale(context)
    }
    return node
  }

  private assertProject(projectId: string): void {
    if (this.store.getState().snapshot.projectId !== projectId) {
      throw new GenerationControllerError(
        'project_inactive',
        'The active project changed while generation was running',
      )
    }
  }

  private throwStale(context: BatchContext): never {
    this.assertProject(context.projectId)
    throw new GenerationControllerError(
      'generation_stale',
      'Generation targets changed while the task was running',
    )
  }

  private async persistBarrier(context: BatchContext): Promise<void> {
    this.assertProject(context.projectId)
    const snapshot = this.store.getState().snapshot
    if (
      context.targetNodeIds.some((nodeId) => {
        const node = mediaNode(snapshot.nodes.find((candidate) => candidate.id === nodeId))
        return node?.data.generation?.clientRequestId !== context.clientRequestId
      })
    ) {
      this.throwStale(context)
    }
    await this.persistProject(snapshot)
    this.assertProject(context.projectId)
  }

  private async persistCurrentIfActive(context: BatchContext): Promise<void> {
    if (this.store.getState().snapshot.projectId !== context.projectId) return
    await this.persistProject(this.store.getState().snapshot)
  }

  async resumePersisted(): Promise<void> {
    const snapshot = this.store.getState().snapshot
    const projectId = snapshot.projectId
    const sourceIds = new Set<string>()
    for (const node of snapshot.nodes) {
      const sourceNodeId = mediaNode(node)?.data.generation?.sourceNodeId
      if (sourceNodeId) sourceIds.add(sourceNodeId)
    }
    await Promise.all(
      [...sourceIds].map(async (sourceNodeId) => {
        if (this.activeSources.has(`${projectId}:${sourceNodeId}`)) return
        const targets = batchNodes(this.store.getState().snapshot, sourceNodeId)
        if (targets.length === 0) return
        const context = this.contextFromBatch(projectId, sourceNodeId, targets)
        if (requiresExplicitResubmission(targets[0]?.data.generation)) return
        const jobId = targets[0]?.data.generation?.jobId
        if (!jobId) {
          this.markRecoverable(
            context,
            null,
            'manual_recovery_required',
            'Pending creation must be recovered manually',
            true,
          )
          return
        }
        try {
          await this.pollJob(context, jobId)
        } catch (error) {
          if (
            !isAbort(error) &&
            !(error instanceof GenerationControllerError &&
              (error.code === 'poll_timeout' ||
                error.code === 'poll_unavailable' ||
                error.code === 'local_persistence_failed' ||
                error.code === 'project_inactive'))
          ) {
            this.markFailed(context, error)
          }
        }
      }),
    )
  }

  dispose(): void {
    this.lifecycle.abort(new DOMException('Generation controller disposed', 'AbortError'))
  }
}
