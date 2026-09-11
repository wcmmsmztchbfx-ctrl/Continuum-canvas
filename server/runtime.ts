import { join } from 'node:path'
import type { GenerationRequest, ProviderCatalog, ProviderMetadata } from '../src/contracts/generation.ts'
import { AssetStore } from './asset-store.ts'
import { CanvasAssetReferenceStore } from './canvas-asset-references.ts'
import { CatalogCache } from './catalog-cache.ts'
import {
  loadGatewayEnvironment,
  resolveAssetImportTimeoutMs,
  resolveGenerationMaxRunTimeMs,
  resolveProjectPath,
  type GatewayEnvironment,
} from './config.ts'
import { DataDirectoryLock } from './data-directory-lock.ts'
import {
  GenerationJobStore,
  GenerationRunner,
  type GenerationJobCollaborationContext,
} from './jobs.ts'
import { GenerationHistoryStore } from './generation-history.ts'
import {
  createPinnedRemoteFetcher,
  createRuntimeAddressLookup,
  type AddressLookup,
  type PinnedRemoteFetcher,
} from './pinned-http.ts'
import { ProviderRegistry, type ProviderRecord } from './provider-registry.ts'
import { AIStartLabAdapter } from './providers/aistartlab-adapter.ts'
import { OpenAICompatibleAdapter } from './providers/openai-compatible-adapter.ts'
import { MiniMaxAdapter } from './providers/minimax-adapter.ts'
import { RunningHubAdapter } from './providers/runninghub-adapter.ts'
import { VolcengineAdapter } from './providers/volcengine-adapter.ts'
import { ModelScopeAdapter } from './providers/modelscope-adapter.ts'
import { JimengAdapter } from './providers/jimeng-adapter.ts'
import { DashScopeAdapter } from './providers/dashscope-adapter.ts'
import { KlingAdapter } from './providers/kling-adapter.ts'
import { ComfyUIAdapter } from './providers/comfyui-adapter.ts'
import { XiaoYunqueAdapter } from './providers/xiaoyunque-adapter.ts'
import {
  ProviderRequestRejectedError,
  type ProviderAdapter,
} from './providers/provider-adapter.ts'
import {
  CollaborationService,
  type CollaborationServiceOptions,
} from './collaboration-service.ts'
import { WorkspaceService } from './workspace-service.ts'
import { TunnelService } from './tunnel-service.ts'
import { CanvasPersistenceService } from './canvas-storage.ts'
import { AgentConfigStore } from './agent-config-store.ts'
import { AgentAccessStore } from './agent-access-store.ts'
import { CanvasDocumentService } from './canvas-document-service.ts'
import { CanvasOperationService } from './canvas-operation-service.ts'
import { WorkflowService } from './workflow-service.ts'

export type AdapterFactory = (provider: ProviderMetadata, apiKey: string) => ProviderAdapter

export class RuntimeNotFoundError extends Error {
  readonly code = 'not_found'
}

export class ProviderUnavailableError extends Error {
  readonly code = 'provider_unavailable'
}

export class ProviderOperationError extends Error {
  readonly code: 'upstream_error' | 'upstream_timeout'

  constructor(timeout: boolean) {
    super(timeout ? 'Provider operation timed out' : 'Provider operation failed')
    this.code = timeout ? 'upstream_timeout' : 'upstream_error'
  }
}

function providerOperationTimedOut(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'TimeoutError') return true
  return error instanceof Error && /timed out|timeout/i.test(error.message)
}

function sanitizedProviderRejection(error: ProviderRequestRejectedError): ProviderRequestRejectedError {
  const message = error.message
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|secret)\s*[=:]\s*[^\s]+/gi, '$1=[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z]:\\[^\s]+/g, '[local path]')
    .slice(0, 320)
  return new ProviderRequestRejectedError(message, error.providerCode)
}

function providerRejection(error: unknown): ProviderRequestRejectedError | undefined {
  if (error instanceof ProviderRequestRejectedError) return error
  if (error instanceof Error && error.cause instanceof ProviderRequestRejectedError) return error.cause
  return undefined
}

function defaultAdapterFactory(
  provider: ProviderMetadata,
  apiKey: string,
  transport: {
    pinnedFetcher: PinnedRemoteFetcher
    lookup: AddressLookup
    stagingDir: string
  },
): ProviderAdapter {
  if (provider.adapterType === 'aistartlab-openapi') {
    return new AIStartLabAdapter({
      apiKey,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      pinnedFetcher: transport.pinnedFetcher,
      lookup: transport.lookup,
    })
  }
  if (provider.adapterType === 'openai-compatible') {
    return new OpenAICompatibleAdapter({
      apiKey,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      stagingDir: transport.stagingDir,
      imageRequestMode: provider.imageRequestMode ?? 'auto',
    })
  }
  if (provider.adapterType === 'minimax-video') {
    return new MiniMaxAdapter({
      apiKey,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      stagingDir: transport.stagingDir,
    })
  }
  if (provider.adapterType === 'runninghub-api') {
    return new RunningHubAdapter({
      apiKey,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      stagingDir: transport.stagingDir,
    })
  }
  if (provider.adapterType === 'volcengine-ark') {
    return new VolcengineAdapter({
      apiKey,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      stagingDir: transport.stagingDir,
    })
  }
  if (provider.adapterType === 'modelscope-api') {
    return new ModelScopeAdapter({
      apiKey,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      stagingDir: transport.stagingDir,
    })
  }
  if (provider.adapterType === 'jimeng-cli') {
    return new JimengAdapter({
      apiKey,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      stagingDir: transport.stagingDir,
    })
  }
  if (provider.adapterType === 'dashscope-api') {
    return new DashScopeAdapter({
      apiKey,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      stagingDir: transport.stagingDir,
    })
  }
  if (provider.adapterType === 'kling-api') {
    return new KlingAdapter({
      apiKey,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      stagingDir: transport.stagingDir,
    })
  }
  if (provider.adapterType === 'comfyui-direct') {
    return new ComfyUIAdapter({
      apiKey,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      stagingDir: transport.stagingDir,
    })
  }
  if (provider.adapterType === 'xiaoyunque-video') {
    return new XiaoYunqueAdapter({
      apiKey,
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      stagingDir: transport.stagingDir,
    })
  }
  throw new ProviderUnavailableError('Provider adapter is not installed')
}

function providerRecord(provider: ProviderMetadata, patch: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: provider.id,
    name: provider.name,
    adapterType: provider.adapterType,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    preferred: provider.preferred,
    ...(provider.lastSyncedAt ? { lastSyncedAt: provider.lastSyncedAt } : {}),
    imageRequestMode: provider.imageRequestMode ?? 'auto',
    ...patch,
  }
}

export interface GatewayRuntime {
  readonly dataDir: string
  readonly signal: AbortSignal
  readonly providers: ProviderRegistry
  readonly catalogs: CatalogCache
  readonly assets: AssetStore
  readonly canvasAssetReferences: CanvasAssetReferenceStore
  readonly jobs: GenerationJobStore
  readonly history: GenerationHistoryStore
  readonly runner: GenerationRunner
  readonly collaboration: CollaborationService
  readonly workspace: WorkspaceService
  readonly canvases: CanvasPersistenceService
  readonly tunnel: TunnelService
  readonly agentConfig: AgentConfigStore
  readonly agentAccess: AgentAccessStore
  readonly canvasDocuments: CanvasDocumentService
  readonly canvasOperations: CanvasOperationService
  readonly workflows: WorkflowService
  trackOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>
  adapterFor(providerId: string): ProviderAdapter
  updateProvider(record: ProviderRecord): Promise<ProviderMetadata>
  getProviderSecret(providerId: string): Promise<string | undefined>
  setProviderSecret(providerId: string, apiKey: string): Promise<ProviderMetadata>
  deleteProviderSecret(providerId: string): Promise<ProviderMetadata>
  deleteProvider(providerId: string): Promise<boolean>
  testProvider(providerId: string): Promise<ProviderMetadata>
  syncProvider(providerId: string): Promise<ProviderCatalog>
  submit(
    request: GenerationRequest,
    collaboration?: GenerationJobCollaborationContext,
  ): ReturnType<GenerationRunner['submit']>
  close(): Promise<void>
}

export async function createGatewayRuntime(options: {
  rootDir?: string
  dataDir?: string
  envFile?: string
  processEnv?: GatewayEnvironment
  env?: GatewayEnvironment
  assetImportTimeoutMs?: number
  generationMaxRunTimeMs?: number
  adapterFactory?: AdapterFactory
  pinnedFetcher?: PinnedRemoteFetcher
  lookup?: AddressLookup
  dohEndpoint?: string
  log?: (entry: { event: string; message: string }) => void
  collaborationOptions?: Omit<CollaborationServiceOptions, 'dataDir'>
} = {}): Promise<GatewayRuntime> {
  const loaded = await loadGatewayEnvironment(options)
  const rootDir = loaded.rootDir
  const dataDir = resolveProjectPath(rootDir, options.dataDir ?? loaded.env.CANVAS_DATA_DIR ?? 'data')
  const envFile = loaded.envFile
  const env = loaded.env
  const assetImportTimeoutMs = resolveAssetImportTimeoutMs(
    options.assetImportTimeoutMs ?? env.CANVAS_ASSET_IMPORT_TIMEOUT_MS,
  )
  const generationMaxRunTimeMs = resolveGenerationMaxRunTimeMs(
    options.generationMaxRunTimeMs ?? env.CANVAS_GENERATION_MAX_RUN_TIME_MS,
  )
  const lock = await DataDirectoryLock.acquire({ dataDir })
  const abortController = new AbortController()
  let runner: GenerationRunner | undefined
  let collaboration: CollaborationService | undefined
  try {
    const providers = await ProviderRegistry.open({ dataDir, env, envFile })
    const catalogs = await CatalogCache.open({ dataDir })
    const pinnedFetcher = options.pinnedFetcher ?? createPinnedRemoteFetcher()
    const lookup = options.lookup ?? createRuntimeAddressLookup({
      dohEndpoint: options.dohEndpoint ?? env.CANVAS_DOH_ENDPOINT,
    })
    const assets = await AssetStore.open({
      dataDir,
      assetImportTimeoutMs,
      pinnedFetcher,
      lookup,
    })
    const jobs = await GenerationJobStore.open({ dataDir })
    const history = await GenerationHistoryStore.open({ dataDir })
    const canvasAssetReferences = await CanvasAssetReferenceStore.open({ dataDir })
    const workspace = new WorkspaceService({ dataDir })
    const canvases = new CanvasPersistenceService({ dataDir })
    const activeCollaboration = await CollaborationService.open({
      ...options.collaborationOptions,
      dataDir,
      onSnapshotSaved: async (snapshot) => {
        try {
          await canvases.saveCanvas(snapshot)
        } catch {
          // ignore
        }
      },
    })
    collaboration = activeCollaboration
    const tunnel = await TunnelService.open({ dataDir })
    const agentConfig = await AgentConfigStore.open({ dataDir, env: options.env ?? process.env, envFile })
    const writeCollaborativeJob = (job: import('../src/contracts/generation.ts').GenerationJob) => {
      if (!job.roomId) return
      try {
        activeCollaboration.applyGenerationJobUpdate(job)
      } catch {
        options.log?.({
          event: 'collaboration.generation_write_skipped',
          message: 'Collaborative generation state could not be applied',
        })
      }
    }
    const unsubscribeJobChanges = jobs.onChange(writeCollaborativeJob)
    // Replaying persisted jobs only updates the Yjs document; it never submits an
    // upstream task. Terminal jobs are included so a crash between jobs.json and
    // collaboration persistence cannot leave a node permanently generating.
    for (const job of jobs.list()) {
      if (job.roomId) writeCollaborativeJob(job)
    }
    const adapterFactory = options.adapterFactory ??
      ((provider, apiKey) => defaultAdapterFactory(provider, apiKey, {
        pinnedFetcher,
        lookup,
        stagingDir: join(dataDir, 'provider-staging'),
      }))
    const activeOperations = new Set<Promise<unknown>>()
    let isClosing = false

    const trackOperation = <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      if (isClosing) return Promise.reject(new DOMException('Gateway runtime is closing', 'AbortError'))
      const active = Promise.resolve().then(() => operation(abortController.signal))
      activeOperations.add(active)
      void active.finally(() => activeOperations.delete(active)).catch(() => {})
      return active
    }

    const adapterFor = (providerId: string): ProviderAdapter => {
      const provider = providers.getPublic(providerId)
      if (!provider) throw new RuntimeNotFoundError('Provider not found')
      const secret = providers.getSecret(providerId)
      if (!provider.enabled || !secret) throw new ProviderUnavailableError('Provider is not configured')
      return adapterFactory(provider, secret)
    }

    const agentAccess = await AgentAccessStore.open(dataDir)
    const canvasDocuments = await CanvasDocumentService.open({
      dataDir,
      collaboration: activeCollaboration,
      canvases,
    })
    const canvasOperations = await CanvasOperationService.open(dataDir, canvasDocuments)
    const workflows = await WorkflowService.open({
      dataDir,
      documents: canvasDocuments,
      assets,
      adapterFor,
    })

    const syncProvider = (providerId: string) => trackOperation(async (signal) => {
      let catalog: ProviderCatalog
      try {
        catalog = await catalogs.sync(providerId, () => adapterFor(providerId).syncCatalog(signal))
      } catch (error) {
        if (error instanceof RuntimeNotFoundError || error instanceof ProviderUnavailableError) throw error
        const rejection = providerRejection(error)
        if (rejection) throw sanitizedProviderRejection(rejection)
        throw new ProviderOperationError(providerOperationTimedOut(error))
      }
      if (!catalog.stale) {
        const provider = providers.getPublic(providerId)
        if (!provider) throw new RuntimeNotFoundError('Provider not found')
        await providers.upsert(providerRecord(provider, { lastSyncedAt: catalog.fetchedAt }))
      }
      return catalog
    })

    runner = new GenerationRunner({
      jobs,
      history,
      assets,
      lock,
      adapterFor,
      catalogFor: (providerId) => {
        const catalog = catalogs.get(providerId)
        if (!catalog) throw new ProviderUnavailableError('Provider catalog has not been synchronized')
        return catalog
      },
      signal: abortController.signal,
      maxRunTimeMs: generationMaxRunTimeMs,
      log: options.log,
    })

    const runtime: GatewayRuntime = {
      dataDir,
      signal: abortController.signal,
      providers,
      catalogs,
      assets,
      canvasAssetReferences,
      jobs,
      history,
      runner,
      collaboration: activeCollaboration,
      workspace,
      canvases,
      tunnel,
      agentConfig,
      agentAccess,
      canvasDocuments,
      canvasOperations,
      workflows,
      trackOperation,
      adapterFor,
      async updateProvider(record) {
        return trackOperation(async () => {
          const previous = providers.getPublic(record.id)
          if (previous && previous.adapterType !== record.adapterType) {
            await catalogs.delete(record.id)
          }
          await providers.upsert(record)
          const updated = providers.getPublic(record.id)
          if (!updated) throw new RuntimeNotFoundError('Provider not found')
          return updated
        })
      },
      async getProviderSecret(providerId) {
        return trackOperation(async () => {
          const provider = providers.getPublic(providerId)
          if (!provider) throw new RuntimeNotFoundError('Provider not found')
          return providers.getSecret(providerId)
        })
      },
      async setProviderSecret(providerId, apiKey) {
        return trackOperation(async () => {
          await providers.setSecret(providerId, apiKey)
          const updated = providers.getPublic(providerId)
          if (!updated) throw new RuntimeNotFoundError('Provider not found')
          return updated
        })
      },
      async deleteProviderSecret(providerId) {
        return trackOperation(async () => {
          await providers.deleteSecret(providerId)
          const updated = providers.getPublic(providerId)
          if (!updated) throw new RuntimeNotFoundError('Provider not found')
          return updated
        })
      },
      async deleteProvider(providerId) {
        return trackOperation(async () => {
          return providers.delete(providerId)
        })
      },
      async testProvider(providerId) {
        return trackOperation(async (signal) => {
          try {
            await adapterFor(providerId).testConnection(signal)
          } catch (error) {
            if (error instanceof RuntimeNotFoundError || error instanceof ProviderUnavailableError) throw error
            if (error instanceof ProviderRequestRejectedError) throw sanitizedProviderRejection(error)
            throw new ProviderOperationError(providerOperationTimedOut(error))
          }
          const provider = providers.getPublic(providerId)
          if (!provider) throw new RuntimeNotFoundError('Provider not found')
          return provider
        })
      },
      syncProvider,
      submit: async (request, generationCollaboration) => {
        const existing = jobs.list().some(
          (job) => job.clientRequestId === request.clientRequestId,
        )
        if (!existing) await syncProvider(request.providerId)
        return runner?.submit(request, generationCollaboration) as ReturnType<GenerationRunner['submit']>
      },
      close: (() => {
        let closing: Promise<void> | undefined
        return () => {
          closing ??= (async () => {
            isClosing = true
            abortController.abort(new DOMException('Gateway runtime is closing', 'AbortError'))
            await Promise.allSettled([...activeOperations])
            unsubscribeJobChanges()
            workflows.close()
            let failure: unknown
            try {
              await activeCollaboration.close()
            } catch (error) {
              failure = error
            }
            try {
              await tunnel.stopTunnel()
            } catch (error) {
              failure ??= error
            }
            try {
              await canvases.flushAll()
            } catch (error) {
              failure ??= error
            }
            try {
              await runner?.close()
            } catch (error) {
              failure ??= error
            }
            if (failure) throw failure
          })()
          return closing
        }
      })(),
    }

    await runner.resume()
    return runtime
  } catch (error) {
    abortController.abort(new DOMException('Gateway runtime startup failed', 'AbortError'))
    await collaboration?.close().catch(() => {})
    if (runner) await runner.close().catch(() => {})
    else await lock.release().catch(() => {})
    throw error
  }
}
