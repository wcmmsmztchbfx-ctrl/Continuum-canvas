import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderCatalog } from '../src/contracts/generation.ts'
import { DataDirectoryLock } from './data-directory-lock.ts'
import { atomicWriteJson } from './atomic-json.ts'
import { CollaborationService } from './collaboration-service.ts'
import { defaultInitialCanvas } from './canvas-storage.ts'
import { GenerationRunner } from './jobs.ts'
import { startGateway } from './http-gateway.ts'
import { ProviderRequestRejectedError } from './providers/provider-adapter.ts'
import { createGatewayRuntime, ProviderUnavailableError, type GatewayRuntime } from './runtime.ts'
import { WorkspaceService } from './workspace-service.ts'

const catalog: ProviderCatalog = {
  providerId: 'aistartlab', version: 'catalog-v1', fetchedAt: new Date().toISOString(), stale: false,
  models: [],
}

const runtimes: GatewayRuntime[] = []

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'libtv-runtime-'))
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('gateway runtime provider adapters', () => {
  it('binds an existing active room to an identical migrated legacy canvas on startup', async () => {
    const dataDir = await tempDirectory()
    const canvas = defaultInitialCanvas('legacy-active', 'legacy-active', 'Shared')
    const seed = await CollaborationService.open({ dataDir })
    const owner = await seed.enableRoom({ canvasId: canvas.canvasId, projectId: canvas.projectId,
      snapshot: canvas, deviceId: 'device-owner', displayName: 'Owner' })
    await seed.close()
    await mkdir(join(dataDir, 'workspace', 'documents'), { recursive: true })
    await writeFile(join(dataDir, 'workspace', 'documents', `${canvas.canvasId}.json`), JSON.stringify(canvas), 'utf8')

    const runtime = await createGatewayRuntime({ dataDir, envFile: join(dataDir, '.env.local'), env: {} })
    runtimes.push(runtime)
    expect(await runtime.workspace.getCanvasRecord(canvas.canvasId)).toMatchObject({
      revision: 0, roomId: owner.room.roomId, epoch: expect.any(String),
    })
    expect(runtime.collaboration.getRoomStatus(owner.room.roomId, owner.sessionToken))
      .toMatchObject({ roomId: owner.room.roomId })
  })

  it('invalidates a divergent restored room without overwriting the canvas or blocking startup', async () => {
    const dataDir = await tempDirectory()
    const stale = defaultInitialCanvas('legacy-stale', 'legacy-stale', 'Old room')
    const authoritative = { ...stale, name: 'Current workspace' }
    const seed = await CollaborationService.open({ dataDir })
    const owner = await seed.enableRoom({ canvasId: stale.canvasId, projectId: stale.projectId,
      snapshot: stale, deviceId: 'device-owner', displayName: 'Owner' })
    await seed.close()
    await mkdir(join(dataDir, 'workspace', 'documents'), { recursive: true })
    await writeFile(join(dataDir, 'workspace', 'documents', `${stale.canvasId}.json`), JSON.stringify(authoritative), 'utf8')

    const runtime = await createGatewayRuntime({ dataDir, envFile: join(dataDir, '.env.local'), env: {} })
    runtimes.push(runtime)
    expect(JSON.parse((await runtime.workspace.getCanvasDocument(stale.canvasId))!).name).toBe('Current workspace')
    expect(() => runtime.collaboration.getRoomStatus(owner.room.roomId, owner.sessionToken)).toThrow()
    const roomDir = join(dataDir, 'collaboration', owner.room.roomId)
    expect(JSON.parse(await readFile(join(roomDir, 'metadata.json'), 'utf8'))).toMatchObject({ enabled: false })
    expect((await readFile(join(roomDir, 'snapshot.bin'))).byteLength).toBeGreaterThan(0)
  })

  it('invalidates an obsolete restored room even when its content matches another bound room', async () => {
    const dataDir = await tempDirectory()
    const canvas = defaultInitialCanvas('obsolete-room-canvas')
    const seed = await CollaborationService.open({ dataDir })
    const old = await seed.enableRoom({ canvasId: canvas.canvasId, projectId: canvas.projectId,
      snapshot: canvas, deviceId: 'device-owner', displayName: 'Owner' })
    await seed.close()
    const workspace = new WorkspaceService({ dataDir })
    await workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'obsolete-canvas-save',
      kind: 'save-canvas', expectedRevision: 0, canvas })
    expect(await workspace.applyCollaborationCheckpoint({ snapshot: canvas,
      roomId: 'current-room', epoch: 'current-epoch', sourceRevision: 'current', initial: true })).toBe(true)

    const runtime = await createGatewayRuntime({ dataDir, envFile: join(dataDir, '.env.local'), env: {} })
    runtimes.push(runtime)
    expect(() => runtime.collaboration.getRoomStatus(old.room.roomId, old.sessionToken)).toThrow()
    expect(await runtime.workspace.getCanvasRecord(canvas.canvasId)).toMatchObject({ roomId: 'current-room' })
  })

  it('refreshes the provider catalog before creating a new generation job', async () => {
    const dataDir = await tempDirectory()
    const oldCatalog: ProviderCatalog = {
      providerId: 'aistartlab', version: 'catalog-old', fetchedAt: new Date().toISOString(), stale: false,
      models: [{
        mediaType: 'image', channel: 37, channelTitle: 'Removed route',
        model: 'gpt-image-2', title: 'GPT Image 2',
        qualityOptions: [{ value: '1K', label: '1K', pricing: { type: 'fixed_total', credits: 5 } }],
        aspectRatios: ['1:1'], countOptions: [1], countRange: { min: 1, max: 1, options: [1] },
        durationOptions: [], durationRange: { min: null, max: null, options: [] },
        modes: ['text2image'], inputLimits: { images: 0, videos: 0, audios: 0 }, raw: {},
      }],
    }
    const freshCatalog: ProviderCatalog = {
      ...oldCatalog,
      version: 'catalog-fresh',
      models: oldCatalog.models.map((model) => ({ ...model, channel: 50 })),
    }
    const syncCatalog = vi.fn().mockResolvedValue(freshCatalog)
    const createGeneration = vi.fn().mockResolvedValue({ taskId: 'must-not-submit' })
    const runtime = await createGatewayRuntime({
      dataDir,
      envFile: join(dataDir, '.env.local'),
      env: { API_PROVIDER_AISTARTLAB_KEY: 'unit-secret' },
      adapterFactory: () => ({
        testConnection: async () => {}, syncCatalog,
        presignReference: async () => { throw new Error('not used') },
        uploadReference: async () => { throw new Error('not used') },
        completeReference: async () => { throw new Error('not used') },
        createGeneration,
        getGenerationStatus: async () => [],
        getGenerationDetail: async () => { throw new Error('not used') },
      }),
    })
    runtimes.push(runtime)
    await runtime.catalogs.sync('aistartlab', async () => oldCatalog)

    await expect(runtime.submit({
      clientRequestId: 'new-request-on-removed-route', projectId: 'project-one',
      providerId: 'aistartlab', catalogVersion: 'catalog-old', mediaType: 'image',
      channel: 37, model: 'gpt-image-2', prompt: 'portrait', quality: '1K',
      aspectRatio: '1:1', n: 1, references: [],
    })).rejects.toMatchObject({ code: 'catalog_changed', catalogVersion: 'catalog-fresh' })
    expect(syncCatalog).toHaveBeenCalledTimes(1)
    expect(createGeneration).not.toHaveBeenCalled()
    expect(runtime.jobs.list()).toHaveLength(0)
  })

  it('replays a persisted terminal collaborative job on restart without resubmitting it', async () => {
    const dataDir = await tempDirectory()
    const first = await createGatewayRuntime({
      dataDir, envFile: join(dataDir, '.env.local'), env: {},
    })
    const owner = await first.collaboration.enableRoom({
      canvasId: 'canvas-terminal', projectId: 'project-terminal',
      snapshot: {
        version: 2, canvasId: 'canvas-terminal', projectId: 'project-terminal', name: 'Shared',
        viewport: { x: 0, y: 0, zoom: 1 }, edges: [],
        nodes: [{
          id: 'image-target', type: 'image', name: 'Target',
          position: { x: 0, y: 0 }, size: { width: 480, height: 270 },
          data: {
            assetId: '11111111-1111-4111-8111-111111111111',
            url: '/api/assets/11111111-1111-4111-8111-111111111111',
            generation: { prompt: 'portrait', status: 'generating', phase: 'queued', clientRequestId: 'client-terminal' },
          },
        }],
      },
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const created = await first.jobs.create({
      clientRequestId: 'client-terminal', projectId: 'project-terminal', canvasId: 'canvas-terminal',
      targetNodeId: 'image-target', providerId: 'aistartlab', catalogVersion: 'catalog-v1',
      mediaType: 'image', channel: 46, model: 'gpt-image-2', prompt: 'portrait',
      quality: '1K', aspectRatio: '1:1', n: 1, references: [],
    }, { roomId: owner.room.roomId, targetNodeId: 'image-target' })
    await first.jobs.update(created.job.id, {
      status: 'failed', progress: 63, error: { code: 'PROVIDER_FAILED', message: 'safe failure' },
    })
    const generation = first.collaboration.documentForRoom(owner.room.roomId)
      .getMap<any>('nodes').get('image-target').get('data').get('generation')
    generation.set('status', 'generating')
    generation.set('phase', 'running')
    await first.collaboration.settlePersistence(owner.room.roomId)
    await first.close()

    const second = await createGatewayRuntime({
      dataDir, envFile: join(dataDir, '.env.local'), env: {},
    })
    runtimes.push(second)
    expect(second.collaboration.exportSnapshot(owner.room.roomId).nodes[0]?.data.generation)
      .toMatchObject({ jobId: created.job.id, status: 'failed', phase: 'failed', progress: 63 })
  })

  it('writes collaborative job changes after disconnect, replays active state on restart, and ignores closed rooms', async () => {
    const dataDir = await tempDirectory()
    const oldAssetId = '11111111-1111-4111-8111-111111111111'
    const first = await createGatewayRuntime({
      dataDir, envFile: join(dataDir, '.env.local'), env: {},
    })
    const owner = await first.collaboration.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha',
      snapshot: {
        version: 2, canvasId: 'canvas-alpha', projectId: 'project-alpha', name: 'Shared',
        viewport: { x: 0, y: 0, zoom: 1 }, edges: [],
        nodes: [{
          id: 'image-target', type: 'image', name: 'Target',
          position: { x: 0, y: 0 }, size: { width: 480, height: 270 },
          data: {
            assetId: oldAssetId, url: `/api/assets/${oldAssetId}`,
            generation: {
              prompt: 'portrait', status: 'generating', phase: 'queued',
              clientRequestId: 'client-collab',
            },
          },
        }],
      },
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const request = {
      clientRequestId: 'client-collab', projectId: 'project-alpha', canvasId: 'canvas-alpha',
      targetNodeId: 'image-target', providerId: 'aistartlab', catalogVersion: 'catalog-v1',
      mediaType: 'image' as const, channel: 46, model: 'gpt-image-2', prompt: 'portrait',
      quality: '1K', aspectRatio: '1:1', n: 1, references: [],
    }
    const created = await first.jobs.create(request, {
      roomId: owner.room.roomId, targetNodeId: 'image-target',
    })
    expect(first.collaboration.exportSnapshot(owner.room.roomId).nodes[0]?.data.generation)
      .toMatchObject({ jobId: created.job.id, phase: 'queued' })

    await first.collaboration.revokeSession(owner.sessionToken)
    await first.jobs.update(created.job.id, { status: 'running', progress: 44 })
    expect(first.collaboration.exportSnapshot(owner.room.roomId).nodes[0]?.data.generation)
      .toMatchObject({ phase: 'running', progress: 44 })
    first.collaboration.documentForRoom(owner.room.roomId)
      .getMap<any>('nodes').get('image-target').get('data').get('generation').set('phase', 'queued')
    await first.collaboration.settlePersistence(owner.room.roomId)
    await first.close()

    const second = await createGatewayRuntime({
      dataDir, envFile: join(dataDir, '.env.local'), env: {},
    })
    runtimes.push(second)
    expect(second.collaboration.exportSnapshot(owner.room.roomId).nodes[0]?.data.generation)
      .toMatchObject({ jobId: created.job.id, phase: 'running', progress: 44 })
    const recovered = await second.collaboration.exchangeSession({
      roomId: owner.room.roomId, secret: owner.recoverySecret,
      deviceId: 'device-owner-recovered', displayName: 'Owner recovered',
    })
    await second.collaboration.closeRoom({
      roomId: owner.room.roomId, sessionToken: recovered.sessionToken,
    })
    await expect(second.jobs.update(created.job.id, {
      status: 'failed', error: { code: 'PROVIDER_FAILED', message: 'safe failure' },
    })).resolves.toMatchObject({ status: 'failed' })
  })

  it('rejects a non-official AIStartLab endpoint before sending its key', async () => {
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    const dataDir = await tempDirectory()
    const runtime = await createGatewayRuntime({
      dataDir,
      envFile: join(dataDir, '.env.local'),
      env: { API_PROVIDER_AISTARTLAB_KEY: 'unit-secret' },
    })
    runtimes.push(runtime)
    await expect(runtime.updateProvider({
      id: 'aistartlab', name: 'AIStartLab', adapterType: 'aistartlab-openapi',
      baseUrl: 'https://gateway.example.test/openapi', enabled: true, preferred: true,
    })).rejects.toThrow('official AIStartLab endpoint')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('never sends an unsupported provider secret to the AIStartLab network path', async () => {
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    const dataDir = await tempDirectory()
    const runtime = await createGatewayRuntime({ dataDir, envFile: join(dataDir, '.env.local'), env: {} })
    runtimes.push(runtime)
    await runtime.updateProvider({
      id: 'other', name: 'Other', adapterType: 'not-installed',
      baseUrl: 'https://other.example.test/openapi', enabled: true, preferred: false,
    })
    await expect(runtime.setProviderSecret('other', 'other-provider-secret'))
      .rejects.toThrow('does not accept API keys')

    await expect(runtime.testProvider('other')).rejects.toBeInstanceOf(ProviderUnavailableError)
    expect(fetcher).not.toHaveBeenCalled()
    expect(runtime.providers.getPublic('other')).toEqual(expect.objectContaining({ available: false }))
  })

  it('shares the injected pinned transport with the default provider adapter', async () => {
    const dataDir = await tempDirectory()
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
    const pinnedFetcher = vi.fn(async () => new Response(null, { status: 200 }))
    const runtime = await createGatewayRuntime({
      dataDir,
      envFile: join(dataDir, '.env.local'),
      env: { API_PROVIDER_AISTARTLAB_KEY: 'unit-secret' },
      lookup,
      pinnedFetcher,
    })
    runtimes.push(runtime)

    await runtime.adapterFor('aistartlab').uploadReference({
      filename: 'reference.png',
      contentType: 'image/png',
      size: 8,
      openStream: () => Readable.from([new Uint8Array(8)]),
    }, {
      fileKey: 'materials/images/reference.png',
      uploadUrl: 'https://uploads.example.test/reference.png',
      method: 'PUT',
      headers: {},
      expiresAt: Date.now() + 60_000,
    })

    expect(lookup).toHaveBeenCalledWith('uploads.example.test', expect.any(AbortSignal))
    expect(pinnedFetcher).toHaveBeenCalledWith(
      'https://uploads.example.test/reference.png',
      expect.objectContaining({ method: 'PUT', redirect: 'error' }),
      '93.184.216.34',
    )
  })

  it('builds an OpenAI-compatible adapter for openai-compatible providers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetcher)
    try {
      const dataDir = await tempDirectory()
      const runtime = await createGatewayRuntime({
        dataDir,
        envFile: join(dataDir, '.env.local'),
        env: { API_PROVIDER_OPENAI_KEY: 'unit-secret' },
      })
      runtimes.push(runtime)

      await runtime.updateProvider({
        id: 'openai', name: 'OpenAI 官方', adapterType: 'openai-compatible',
        baseUrl: 'https://custom.openai.example/v1', enabled: true, preferred: false,
      })
      await expect(runtime.testProvider('openai')).resolves.toEqual(expect.objectContaining({
        id: 'openai',
        available: true,
      }))
      expect(fetcher).toHaveBeenCalledWith(
        'https://custom.openai.example/v1/models',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer unit-secret' }) }),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('normalizes non-Error provider rejections without throwing from error handling', async () => {
    const dataDir = await tempDirectory()
    const runtime = await createGatewayRuntime({
      dataDir,
      envFile: join(dataDir, '.env.local'),
      env: { API_PROVIDER_AISTARTLAB_KEY: 'unit-secret' },
      adapterFactory: () => ({
        testConnection: async () => { throw null },
        syncCatalog: async () => { throw undefined },
        presignReference: async () => { throw new Error('not used') },
        uploadReference: async () => { throw new Error('not used') },
        completeReference: async () => { throw new Error('not used') },
        createGeneration: async () => { throw new Error('not used') },
        getGenerationStatus: async () => [],
        getGenerationDetail: async () => { throw new Error('not used') },
      }),
    })
    runtimes.push(runtime)

    await expect(runtime.testProvider('aistartlab')).rejects.toMatchObject({
      code: 'upstream_error',
    })
    await expect(runtime.syncProvider('aistartlab')).rejects.toMatchObject({
      code: 'upstream_error',
    })
  })

  it('preserves a sanitized provider rejection for connection tests and catalog sync', async () => {
    const dataDir = await tempDirectory()
    const runtime = await createGatewayRuntime({
      dataDir,
      envFile: join(dataDir, '.env.local'),
      env: { API_PROVIDER_AISTARTLAB_KEY: 'unit-secret' },
      adapterFactory: () => ({
        testConnection: async () => {
          throw new ProviderRequestRejectedError(
            'Provider rejected the request: invalid Bearer secret-value at https://private.example/path',
            'forbidden',
          )
        },
        syncCatalog: async () => {
          throw new ProviderRequestRejectedError('Provider rejected the request: forbidden', 'forbidden')
        },
        presignReference: async () => { throw new Error('not used') },
        uploadReference: async () => { throw new Error('not used') },
        completeReference: async () => { throw new Error('not used') },
        createGeneration: async () => { throw new Error('not used') },
        getGenerationStatus: async () => [],
        getGenerationDetail: async () => { throw new Error('not used') },
      }),
    })
    runtimes.push(runtime)

    await expect(runtime.testProvider('aistartlab')).rejects.toMatchObject({
      code: 'provider_request_rejected',
      providerCode: 'forbidden',
      message: 'Provider rejected the request: invalid Bearer [redacted] at [redacted-url]',
    })
    await expect(runtime.syncProvider('aistartlab')).rejects.toMatchObject({
      code: 'provider_request_rejected',
      providerCode: 'forbidden',
    })
  })

  it('keeps the data lock until an abort-ignoring provider sync and its writes settle', async () => {
    const dataDir = await tempDirectory()
    let releaseSync!: () => void
    let markSyncStarted!: () => void
    const syncGate = new Promise<void>((resolve) => { releaseSync = resolve })
    const syncStarted = new Promise<void>((resolve) => { markSyncStarted = resolve })
    let providerSignal: AbortSignal | undefined
    const runtime = await createGatewayRuntime({
      dataDir,
      envFile: join(dataDir, '.env.local'),
      env: { API_PROVIDER_AISTARTLAB_KEY: 'unit-secret' },
      adapterFactory: () => ({
        testConnection: async () => {},
        syncCatalog: async (signal) => {
          providerSignal = signal
          markSyncStarted()
          await syncGate
          return catalog
        },
        presignReference: async () => { throw new Error('not used') },
        uploadReference: async () => { throw new Error('not used') },
        completeReference: async () => { throw new Error('not used') },
        createGeneration: async () => { throw new Error('not used') },
        getGenerationStatus: async () => [],
        getGenerationDetail: async () => { throw new Error('not used') },
      }),
    })
    runtimes.push(runtime)

    const syncing = runtime.syncProvider('aistartlab')
    await syncStarted
    const closing = runtime.close()
    runtimes.splice(runtimes.indexOf(runtime), 1)
    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true))
    const closedBeforeSyncSettled = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ])
    expect(closedBeforeSyncSettled).toBe(false)

    let prematureOwner: Awaited<ReturnType<typeof DataDirectoryLock.acquire>> | undefined
    try {
      prematureOwner = await DataDirectoryLock.acquire({ dataDir, token: () => 'premature-owner' })
      expect.fail('a second runtime acquired the lock while provider sync was still active')
    } catch (error) {
      expect(error).toMatchObject({ code: 'data_directory_locked' })
    } finally {
      await prematureOwner?.release()
    }

    releaseSync()
    await syncing
    await closing
    const nextOwner = await DataDirectoryLock.acquire({ dataDir, token: () => 'next-owner' })
    await nextOwner.release()
  })

  it('keeps the data lock until collaboration persistence finishes closing', async () => {
    const dataDir = await tempDirectory()
    let releaseAppend = () => {}
    const appendReleased = new Promise<void>((resolve) => { releaseAppend = resolve })
    let reportAppendStarted = () => {}
    const appendStarted = new Promise<void>((resolve) => { reportAppendStarted = resolve })
    let blockAppend = false
    const runtime = await createGatewayRuntime({
      dataDir,
      envFile: join(dataDir, '.env.local'),
      env: { API_PROVIDER_AISTARTLAB_KEY: 'unit-secret' },
      collaborationOptions: {
        persistence: {
          async append(path, bytes) {
            if (blockAppend) {
              blockAppend = false
              reportAppendStarted()
              await appendReleased
            }
            await appendFile(path, bytes)
          },
          writeBytes: (path, bytes) => writeFile(path, bytes).then(() => undefined),
          writeJson: atomicWriteJson,
        },
      },
    })
    runtimes.push(runtime)
    const owner = await runtime.collaboration.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha',
      snapshot: {
        version: 2, canvasId: 'canvas-alpha', projectId: 'project-alpha', name: 'Shared',
        viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
      },
      deviceId: 'device-owner', displayName: 'Owner',
    })
    blockAppend = true
    runtime.collaboration.documentForRoom(owner.room.roomId).getMap('meta').set('pending', true)
    await appendStarted

    const closing = runtime.close()
    runtimes.splice(runtimes.indexOf(runtime), 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(DataDirectoryLock.acquire({ dataDir, token: () => 'second-instance' }))
      .rejects.toMatchObject({ code: 'data_directory_locked' })

    releaseAppend()
    await closing
    const nextOwner = await DataDirectoryLock.acquire({ dataDir, token: () => 'next-instance' })
    await nextOwner.release()
  })

  it('does not acknowledge a current room checkpoint after another save takes ownership', async () => {
    const dataDir = await tempDirectory()
    const runtime = await createGatewayRuntime({ dataDir, envFile: join(dataDir, '.env.local'), env: {} })
    runtimes.push(runtime)
    const canvas = { version: 2 as const, canvasId: 'canvas-alpha', projectId: 'project-alpha',
      name: 'Shared', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }
    await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'before-room',
      kind: 'save-canvas', expectedRevision: 0, canvas })
    const owner = await runtime.collaboration.enableRoom({ canvasId: canvas.canvasId,
      projectId: canvas.projectId, snapshot: canvas, deviceId: 'device-owner', displayName: 'Owner' })
    await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'later-save',
      kind: 'save-canvas', expectedRevision: 1, canvas: { ...canvas, name: 'Other save' } })
    runtime.collaboration.documentForRoom(owner.room.roomId).getMap('meta').set('pending', true)
    await expect(runtime.collaboration.checkpointRoom(owner.room.roomId))
      .rejects.toMatchObject({ code: 'collaboration_persistence_failed' })
    await expect(runtime.collaboration.closeRoom({ roomId: owner.room.roomId, sessionToken: owner.sessionToken }))
      .rejects.toMatchObject({ code: 'collaboration_persistence_failed' })
    expect(JSON.parse((await runtime.workspace.getCanvasDocument(canvas.canvasId))!).name).toBe('Other save')
    await runtime.collaboration.closeCanvasRoom(canvas.projectId, canvas.canvasId)
  })

  it('awaits collaboration cleanup before releasing the lock when runner resume fails', async () => {
    const dataDir = await tempDirectory()
    let releaseCollaboration = () => {}
    const collaborationReleased = new Promise<void>((resolve) => { releaseCollaboration = resolve })
    let reportCloseStarted = () => {}
    const closeStarted = new Promise<void>((resolve) => { reportCloseStarted = resolve })
    const originalClose = CollaborationService.prototype.close
    vi.spyOn(CollaborationService.prototype, 'close').mockImplementation(function (
      this: CollaborationService,
    ) {
      reportCloseStarted()
      return collaborationReleased.then(() => originalClose.call(this))
    })
    vi.spyOn(GenerationRunner.prototype, 'resume').mockRejectedValueOnce(new Error('injected resume failure'))

    const starting = createGatewayRuntime({
      dataDir,
      envFile: join(dataDir, '.env.local'),
      env: { API_PROVIDER_AISTARTLAB_KEY: 'unit-secret' },
    })
    expect(await Promise.race([
      closeStarted.then(() => 'collaboration-close'),
      starting.then(() => 'startup-resolved', (error) => `startup-rejected:${String(error)}`),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 3_000)),
    ])).toBe('collaboration-close')
    await expect(DataDirectoryLock.acquire({ dataDir, token: () => 'startup-race' }))
      .rejects.toMatchObject({ code: 'data_directory_locked' })

    releaseCollaboration()
    await expect(starting).rejects.toThrow('injected resume failure')
    const nextOwner = await DataDirectoryLock.acquire({ dataDir, token: () => 'after-failure' })
    await nextOwner.release()
  })

  it('preserves an HTTP listen error while awaiting collaboration before runner cleanup', async () => {
    const occupied = createServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', () => resolve())
    })
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('Expected an occupied TCP port')
    const dataDir = await tempDirectory()
    let releaseCollaboration = () => {}
    const collaborationReleased = new Promise<void>((resolve) => { releaseCollaboration = resolve })
    let reportCloseStarted = () => {}
    const closeStarted = new Promise<void>((resolve) => { reportCloseStarted = resolve })
    const originalClose = CollaborationService.prototype.close
    vi.spyOn(CollaborationService.prototype, 'close').mockImplementation(function (
      this: CollaborationService,
    ) {
      reportCloseStarted()
      return collaborationReleased.then(() => originalClose.call(this))
    })
    const runnerClose = vi.spyOn(GenerationRunner.prototype, 'close')

    try {
      const starting = startGateway({
        dataDir,
        envFile: join(dataDir, '.env.local'),
        env: { API_PROVIDER_AISTARTLAB_KEY: 'unit-secret' },
        host: '127.0.0.1',
        port: address.port,
      })
      expect(await Promise.race([
        closeStarted.then(() => 'collaboration-close'),
        starting.then(() => 'startup-resolved', (error) => `startup-rejected:${String(error)}`),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 3_000)),
      ])).toBe('collaboration-close')
      expect(runnerClose).not.toHaveBeenCalled()
      let prematureOwner: Awaited<ReturnType<typeof DataDirectoryLock.acquire>> | undefined
      let lockError: unknown
      try {
        prematureOwner = await DataDirectoryLock.acquire({ dataDir, token: () => 'listen-race' })
      } catch (error) {
        lockError = error
      }
      await prematureOwner?.release()
      expect(lockError).toMatchObject({ code: 'data_directory_locked' })

      releaseCollaboration()
      await expect(starting).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(runnerClose).toHaveBeenCalledTimes(1)
      const nextOwner = await DataDirectoryLock.acquire({ dataDir, token: () => 'after-listen-failure' })
      await nextOwner.release()
    } finally {
      releaseCollaboration()
      await new Promise<void>((resolve) => occupied.close(() => resolve()))
    }
  })
})
