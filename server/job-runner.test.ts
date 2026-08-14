import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenerationRequest, ProviderCatalog } from '../src/contracts/generation.ts'
import { AssetStore } from './asset-store.ts'
import { atomicWriteJson } from './atomic-json.ts'
import { CatalogChangedError } from './generation-validation.ts'
import { GenerationHistoryStore } from './generation-history.ts'
import { generationRequestDigest, GenerationJobStore, GenerationRunner } from './jobs.ts'
import type {
  PresignedUpload,
  ProviderAdapter,
  StagedReference,
  UpstreamTaskStatus,
} from './providers/provider-adapter.ts'
import { ProviderRequestRejectedError } from './providers/provider-adapter.ts'

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
const catalog: ProviderCatalog = {
  providerId: 'aistartlab', version: 'catalog-v1', fetchedAt: new Date().toISOString(), stale: false,
  models: [{
    mediaType: 'image', channel: 46, model: 'gpt-image-2', title: 'GPT', label: 'GPT',
    qualityOptions: [{ value: '1K', label: '1K', pricing: { type: 'fixed_total', credits: 5 } }],
    aspectRatios: ['1:1'], countOptions: [1],
    durationOptions: [], countRange: { min: 1, max: 1, options: [1] }, modes: [],
    inputLimits: { images: 6, videos: 0, audios: 0 },
    raw: {},
  }],
}

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'libtv-jobs-'))
}

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    clientRequestId: 'client-1', projectId: 'project-alpha', canvasId: 'canvas-alpha',
    providerId: 'aistartlab', catalogVersion: 'catalog-v1',
    mediaType: 'image', channel: 46, model: 'gpt-image-2', prompt: 'portrait', quality: '1K',
    aspectRatio: '1:1', n: 1, references: [], ...overrides,
  }
}

function grant(fileKey: string): PresignedUpload {
  return {
    fileKey, uploadUrl: `https://storage.example/${fileKey}`, method: 'PUT',
    headers: { 'x-upload-token': fileKey }, expiresAt: Date.now() + 60_000,
  }
}

function adapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    testConnection: async () => {},
    syncCatalog: async () => catalog,
    presignReference: async (reference) => grant(`file-${reference.filename}`),
    uploadReference: async () => {},
    completeReference: async (fileKey) => ({ url: `https://cdn.example/${fileKey}` }),
    createGeneration: async () => 'upstream-1',
    getGenerationStatus: async () => [],
    getGenerationDetail: async (taskId) => ({ taskId, status: 2, progress: 50 }),
    ...overrides,
  }
}

function runner(options: {
  jobs: GenerationJobStore
  assets: AssetStore
  provider?: ProviderAdapter
  schedule?: (run: () => void | Promise<void>, delay: number) => unknown
  cancelSchedule?: (handle: unknown) => void
  currentCatalog?: ProviderCatalog
  sleep?: (delay: number) => Promise<void>
  log?: (entry: { event: string; message: string }) => void
  history?: GenerationHistoryStore
  maxRunTimeMs?: number
  now?: () => number
}) {
  const lock = { assertHeld: () => {}, release: async () => {} }
  return new GenerationRunner({
    jobs: options.jobs,
    history: options.history,
    assets: options.assets,
    lock,
    adapterFor: () => options.provider ?? adapter(),
    catalogFor: () => options.currentCatalog ?? catalog,
    schedule: options.schedule,
    cancelSchedule: options.cancelSchedule,
    pollDelayMs: () => 12_000,
    sleep: options.sleep,
    log: options.log,
    maxRunTimeMs: options.maxRunTimeMs,
    now: options.now,
  } as never)
}

describe('generation jobs', () => {
  it('persists server-owned collaboration identity while accepting legacy jobs without it', async () => {
    const dataDir = await tempDirectory()
    const store = await GenerationJobStore.open({ dataDir, id: () => 'job-collaborative' })
    const created = await store.create(request({ targetNodeId: 'image-target' }), {
      roomId: 'room-alpha', targetNodeId: 'image-target',
    })

    expect(created.job).toMatchObject({
      id: 'job-collaborative', roomId: 'room-alpha', targetNodeId: 'image-target',
    })
    const persisted = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'))
    expect(persisted[0]).toMatchObject({ roomId: 'room-alpha', targetNodeId: 'image-target' })

    delete persisted[0].roomId
    delete persisted[0].targetNodeId
    await writeFile(join(dataDir, 'jobs.json'), JSON.stringify(persisted))
    const reopened = await GenerationJobStore.open({ dataDir })
    expect(reopened.get('job-collaborative')).not.toHaveProperty('roomId')
    expect(reopened.get('job-collaborative')).not.toHaveProperty('targetNodeId')
  })

  it('notifies subscribers after durable create and every durable state update', async () => {
    const store = await GenerationJobStore.open({ dataDir: await tempDirectory(), id: () => 'job-events' })
    const observed: Array<[string, string, number]> = []
    const unsubscribe = store.onChange((job) => observed.push([job.id, job.status, job.progress]))
    const created = await store.create(request())
    await store.update(created.job.id, { status: 'running', progress: 51 })
    unsubscribe()
    await store.update(created.job.id, { status: 'complete', progress: 100 })

    expect(observed).toEqual([
      ['job-events', 'queued', 0],
      ['job-events', 'running', 51],
    ])
  })

  it('reports active jobs for one canvas without exposing generation inputs', async () => {
    const dataDir = await tempDirectory()
    let nextId = 0
    const store = await GenerationJobStore.open({ dataDir, id: () => `job-${++nextId}` })
    await store.create(request({ clientRequestId: 'active-a', canvasId: 'canvas-a' }))
    const { job: running } = await store.create(request({ clientRequestId: 'active-b', canvasId: 'canvas-a' }))
    await store.update(running.id, { status: 'running' })
    const { job: complete } = await store.create(request({ clientRequestId: 'complete', canvasId: 'canvas-a' }))
    await store.update(complete.id, { status: 'complete', progress: 100 })
    await store.create(request({ clientRequestId: 'other', canvasId: 'canvas-b' }))

    const activity = store.activityForCanvas({ projectId: 'project-alpha', canvasId: 'canvas-a' })

    expect(activity.active).toBe(true)
    expect(activity.jobs.map((job) => job.status)).toEqual(['queued', 'running'])
    expect(activity.jobs.every((job) => Object.keys(job).sort().join(',') === 'id,status,updatedAt')).toBe(true)
    expect(JSON.stringify(activity)).not.toContain('portrait')
  })

  it('protects every local asset referenced by requests and outputs', async () => {
    const dataDir = await tempDirectory()
    const store = await GenerationJobStore.open({ dataDir, id: () => 'job-assets' })
    const referenceId = '51111111-1111-4111-8111-111111111111'
    const outputId = '61111111-1111-4111-8111-111111111111'
    const { job } = await store.create(request({
      references: [{ alias: 1, assetId: referenceId, mediaType: 'image' }],
    }))
    await store.update(job.id, {
      status: 'complete', progress: 100,
      outputs: [{ assetId: outputId, url: `/api/assets/${outputId}`, contentType: 'image/png', size: 12 }],
    })

    expect(store.referencedAssetIds()).toEqual(new Set([referenceId, outputId]))
  })

  it('loads persisted legacy jobs without projectId', async () => {
    const dataDir = await tempDirectory()
    const legacyRequest = request() as unknown as Record<string, unknown>
    delete legacyRequest.projectId
    delete legacyRequest.canvasId
    const timestamp = '2026-07-16T00:00:00.000Z'
    await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([{
      id: 'job-legacy',
      clientRequestId: legacyRequest.clientRequestId,
      requestDigest: generationRequestDigest(legacyRequest as never),
      request: legacyRequest,
      status: 'complete',
      progress: 100,
      createdAt: timestamp,
      updatedAt: timestamp,
      outputs: [],
      referenceUploads: [],
    }]))

    const store = await GenerationJobStore.open({ dataDir })

    expect(store.get('job-legacy')).toEqual(expect.objectContaining({
      status: 'complete',
      request: expect.not.objectContaining({ projectId: expect.anything() }),
    }))
  })

  it('scrubs safely recoverable legacy source and provider URLs during load', async () => {
    const dataDir = await tempDirectory()
    const assets = await AssetStore.open({ dataDir })
    const local = await assets.save({ filename: 'legacy-ref.png', contentType: 'image/png', bytes: PNG })
    const legacyRequest = request({ references: [{
      alias: 1, url: 'https://source.example/ref.png?token=secret', mediaType: 'image',
    }] })
    const timestamp = '2026-07-16T00:00:00.000Z'
    await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([{
      id: 'job-legacy-url', clientRequestId: legacyRequest.clientRequestId,
      requestDigest: generationRequestDigest(legacyRequest), request: legacyRequest,
      status: 'submitted', progress: 10, createdAt: timestamp, updatedAt: timestamp,
      upstreamTaskId: 'existing-upstream', outputs: [], referenceUploads: [{
        alias: 1, assetId: local.id, sourceUrl: legacyRequest.references[0].url,
        mediaType: 'image', status: 'complete', fileKey: 'provider-file-key',
        completedAt: timestamp, url: 'https://provider.example/ref.png?signature=secret',
      }],
    }]))

    const jobs = await GenerationJobStore.open({ dataDir })
    const persisted = await readFile(join(dataDir, 'jobs.json'), 'utf8')

    expect(jobs.get('job-legacy-url')?.request.references).toEqual([
      { alias: 1, assetId: local.id, mediaType: 'image' },
    ])
    expect(persisted).not.toContain('source.example')
    expect(persisted).not.toContain('provider.example')
    expect(persisted).not.toContain('provider-file-key')
  })

  it('associates an identical nonterminal legacy job with a project without another upstream create', async () => {
    const dataDir = await tempDirectory()
    const legacyRequest = request() as unknown as Record<string, unknown>
    delete legacyRequest.projectId
    delete legacyRequest.canvasId
    const timestamp = '2026-07-16T00:00:00.000Z'
    await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([{
      id: 'job-legacy-running', clientRequestId: legacyRequest.clientRequestId,
      requestDigest: generationRequestDigest(legacyRequest as never), request: legacyRequest,
      status: 'submitted', progress: 20, createdAt: timestamp, updatedAt: timestamp,
      upstreamTaskId: 'existing-upstream', outputs: [], referenceUploads: [],
    }]))
    const jobs = await GenerationJobStore.open({ dataDir })
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>()
    const generation = runner({
      jobs, assets: await AssetStore.open({ dataDir }),
      provider: adapter({ createGeneration }), schedule: () => {},
    })

    const resumed = await generation.submit(request())

    expect(resumed).toEqual(expect.objectContaining({
      id: 'job-legacy-running', upstreamTaskId: 'existing-upstream',
      request: expect.objectContaining({ projectId: 'project-alpha' }),
    }))
    expect(createGeneration).not.toHaveBeenCalled()
    await expect(generation.submit(request({ prompt: 'different' })))
      .rejects.toMatchObject({ code: 'idempotency_conflict' })
    const persisted = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'))
    expect(persisted[0].request.projectId).toBe('project-alpha')
    expect(persisted[0].requestDigest).toBe(generationRequestDigest(request()))
  })

  it('migrates a legacy URL reference to its matching local asset without creating a second job', async () => {
    const dataDir = await tempDirectory()
    const assets = await AssetStore.open({ dataDir })
    const local = await assets.save({ filename: 'legacy-ref.png', contentType: 'image/png', bytes: PNG })
    const legacyRequest = request({ references: [{
      alias: 1, url: 'https://source.example/ref.png?token=secret', mediaType: 'image',
    }] }) as unknown as Record<string, unknown>
    delete legacyRequest.projectId
    delete legacyRequest.canvasId
    const timestamp = '2026-07-16T00:00:00.000Z'
    await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([{
      id: 'job-legacy-uploading', clientRequestId: legacyRequest.clientRequestId,
      requestDigest: generationRequestDigest(legacyRequest as never), request: legacyRequest,
      status: 'uploading', progress: 10, createdAt: timestamp, updatedAt: timestamp,
      outputs: [], referenceUploads: [{
        alias: 1, assetId: local.id, sourceUrl: 'https://source.example/ref.png?token=secret',
        mediaType: 'image', status: 'complete', fileKey: 'legacy-provider-key',
        completedAt: timestamp, url: 'https://provider.example/ref.png?signature=secret',
      }],
    }]))
    const jobs = await GenerationJobStore.open({ dataDir })
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>(async () => 'existing-flow-upstream')
    const generation = runner({
      jobs, assets, provider: adapter({ createGeneration }), schedule: () => {},
    })

    const resumed = await generation.submit(request({ references: [{
      alias: 1, assetId: local.id, mediaType: 'image',
    }] }))

    expect(resumed).toEqual(expect.objectContaining({
      id: 'job-legacy-uploading', upstreamTaskId: 'existing-flow-upstream', status: 'submitted',
    }))
    expect(createGeneration).toHaveBeenCalledTimes(1)
    const persisted = await readFile(join(dataDir, 'jobs.json'), 'utf8')
    expect(persisted).not.toContain('source.example')
    expect(persisted).not.toContain('provider.example')
    expect(persisted).not.toContain('legacy-provider-key')
    expect(JSON.parse(persisted)).toHaveLength(1)
  })

  it('rejects a legacy URL migration when the requested local asset does not match persisted upload state', async () => {
    const dataDir = await tempDirectory()
    const assets = await AssetStore.open({ dataDir })
    const local = await assets.save({ filename: 'legacy-ref.png', contentType: 'image/png', bytes: PNG })
    const different = await assets.save({ filename: 'different-ref.png', contentType: 'image/png', bytes: PNG })
    const legacyRequest = request({ references: [{
      alias: 1, url: 'https://source.example/ref.png', mediaType: 'image',
    }] }) as unknown as Record<string, unknown>
    delete legacyRequest.projectId
    delete legacyRequest.canvasId
    const timestamp = '2026-07-16T00:00:00.000Z'
    await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([{
      id: 'job-legacy-conflict', clientRequestId: legacyRequest.clientRequestId,
      requestDigest: generationRequestDigest(legacyRequest as never), request: legacyRequest,
      status: 'uploading', progress: 10, createdAt: timestamp, updatedAt: timestamp,
      outputs: [], referenceUploads: [{
        alias: 1, assetId: local.id, sourceUrl: 'https://source.example/ref.png',
        mediaType: 'image', status: 'pending',
      }],
    }]))
    const jobs = await GenerationJobStore.open({ dataDir })

    await expect(runner({ jobs, assets, schedule: () => {} }).submit(request({ references: [{
      alias: 1, assetId: different.id, mediaType: 'image',
    }] }))).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('deduplicates clientRequestId across persistence restarts', async () => {
    const dataDir = await tempDirectory()
    const store = await GenerationJobStore.open({ dataDir, id: () => 'job-1', now: () => new Date('2026-07-16T00:00:00Z') })
    const firstResult = await store.create(request())
    const secondResult = await store.create(request())
    const first = firstResult.job
    const second = secondResult.job
    const reopened = await GenerationJobStore.open({ dataDir })
    expect(second.id).toBe(first.id)
    expect(firstResult.created).toBe(true)
    expect(secondResult.created).toBe(false)
    expect(second.request.prompt).toBe('portrait')
    expect(first.requestDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(reopened.get('job-1')).toEqual(first)
  })

  it('rolls back in-memory job updates when the transactional persistence write fails', async () => {
    const dataDir = await tempDirectory()
    let failNextWrite = false
    const writeJobs = vi.fn(async (filePath: string, value: unknown) => {
      if (failNextWrite) {
        failNextWrite = false
        throw new Error('injected jobs persistence failure')
      }
      await atomicWriteJson(filePath, value)
    })
    const store = await GenerationJobStore.open({ dataDir, id: () => 'job-1', writeJobs })
    const { job } = await store.create(request())
    failNextWrite = true

    await expect(store.update(job.id, { status: 'running', progress: 42 })).rejects.toThrow('injected')

    expect(store.get(job.id)).toEqual(job)
    expect((await GenerationJobStore.open({ dataDir })).get(job.id)).toEqual(job)
  })

  it('serializes concurrent read-modify-persist-commit mutations without losing either job', async () => {
    const dataDir = await tempDirectory()
    let nextId = 0
    let releaseFirstWrite!: () => void
    let markFirstWriteStarted!: () => void
    let markFirstWriteFinished!: () => void
    const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve })
    const firstWriteStarted = new Promise<void>((resolve) => { markFirstWriteStarted = resolve })
    const firstWriteFinished = new Promise<void>((resolve) => { markFirstWriteFinished = resolve })
    const writeJobs = vi.fn(async (filePath: string, value: unknown) => {
      const jobs = value as Array<{ id: string; status: string }>
      const first = jobs.find((job) => job.id === 'job-1')
      const second = jobs.find((job) => job.id === 'job-2')
      if (first?.status === 'running' && second?.status === 'queued') {
        markFirstWriteStarted()
        await firstWriteGate
        await atomicWriteJson(filePath, value)
        markFirstWriteFinished()
        return
      }
      if (first?.status === 'queued' && second?.status === 'running') {
        await firstWriteFinished
        await atomicWriteJson(filePath, value)
        return
      }
      await atomicWriteJson(filePath, value)
    })
    const store = await GenerationJobStore.open({
      dataDir,
      id: () => `job-${++nextId}`,
      writeJobs,
    })
    await store.create(request({ clientRequestId: 'client-1' }))
    await store.create(request({ clientRequestId: 'client-2' }))

    const firstUpdate = store.update('job-1', { status: 'running', progress: 20 })
    await firstWriteStarted
    const secondUpdate = store.update('job-2', { status: 'running', progress: 30 })
    releaseFirstWrite()
    await Promise.all([firstUpdate, secondUpdate])

    expect(store.get('job-1')).toEqual(expect.objectContaining({ status: 'running', progress: 20 }))
    expect(store.get('job-2')).toEqual(expect.objectContaining({ status: 'running', progress: 30 }))
    const reopened = await GenerationJobStore.open({ dataDir })
    expect(reopened.get('job-1')).toEqual(expect.objectContaining({ status: 'running', progress: 20 }))
    expect(reopened.get('job-2')).toEqual(expect.objectContaining({ status: 'running', progress: 30 }))
  })

  it('durably hands off a paid upstream task across a failed primary persist and restart', async () => {
    const dataDir = await tempDirectory()
    let failNextWrite = false
    const writeJobs = vi.fn(async (filePath: string, value: unknown) => {
      if (failNextWrite) {
        failNextWrite = false
        throw new Error('injected first post-create persistence failure')
      }
      await atomicWriteJson(filePath, value)
    })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1', writeJobs })
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>(async () => {
      failNextWrite = true
      return 'paid-upstream-task'
    })
    const firstPolls: Array<() => void | Promise<void>> = []
    const firstRunner = runner({
      jobs,
      assets: await AssetStore.open({ dataDir }),
      provider: adapter({ createGeneration }),
      schedule: (run) => { firstPolls.push(run); return firstPolls.length },
    })

    const submitted = await firstRunner.submit(request())

    expect(submitted).toEqual(expect.objectContaining({
      status: 'submitted', upstreamTaskId: 'paid-upstream-task',
    }))
    expect(createGeneration).toHaveBeenCalledTimes(1)
    expect(firstPolls).toHaveLength(1)
    expect(JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'))[0]).not.toHaveProperty('upstreamTaskId')
    expect(await readdir(join(dataDir, 'generation-handoffs'))).toEqual(['job-1.json'])

    const restartedJobs = await GenerationJobStore.open({ dataDir })
    const createAfterRestart = vi.fn<ProviderAdapter['createGeneration']>()
    const getGenerationStatus = vi.fn<ProviderAdapter['getGenerationStatus']>(async () => [{
      taskId: 'paid-upstream-task', status: 2, progress: 35,
    }])
    const restartedPolls: Array<() => void | Promise<void>> = []
    const restartedRunner = runner({
      jobs: restartedJobs,
      assets: await AssetStore.open({ dataDir }),
      provider: adapter({ createGeneration: createAfterRestart, getGenerationStatus }),
      schedule: (run) => { restartedPolls.push(run); return restartedPolls.length },
    })

    await restartedRunner.resume()
    expect(restartedJobs.get('job-1')).toEqual(expect.objectContaining({
      status: 'submitted', upstreamTaskId: 'paid-upstream-task',
    }))
    expect(restartedPolls).toHaveLength(1)
    await restartedPolls[0]()
    expect(getGenerationStatus).toHaveBeenCalledWith(['paid-upstream-task'], expect.any(AbortSignal))
    expect(createAfterRestart).not.toHaveBeenCalled()
    expect(createGeneration).toHaveBeenCalledTimes(1)
  })

  it('removes a stale matching handoff without reviving a failed terminal job', async () => {
    const dataDir = await tempDirectory()
    const store = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const { job } = await store.create(request())
    await store.update(job.id, {
      status: 'failed',
      error: { code: 'provider_failed', message: 'Generation failed safely' },
    })
    const handoffRoot = join(dataDir, 'generation-handoffs')
    await mkdir(handoffRoot, { recursive: true })
    await writeFile(join(handoffRoot, 'job-1.json'), JSON.stringify({
      version: 1,
      jobId: 'job-1',
      upstreamTaskId: 'old-upstream-task',
      recordedAt: '2026-07-16T00:00:00.000Z',
    }))

    const reopened = await GenerationJobStore.open({ dataDir })

    expect(reopened.get('job-1')).toEqual(expect.objectContaining({
      status: 'failed',
      error: { code: 'provider_failed', message: 'Generation failed safely' },
    }))
    expect(reopened.get('job-1')).not.toHaveProperty('upstreamTaskId')
    expect(await readdir(handoffRoot)).toEqual([])
  })

  it('normalizes a request before digesting and persists a strict roundtrip across restart', async () => {
    const dataDir = await tempDirectory()
    const store = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const input = {
      ...request({ references: [
        { alias: 2, assetId: 'asset-two', mediaType: 'image' },
        { alias: 1, assetId: 'asset-one', mediaType: 'image' },
      ] }),
      mode: undefined,
    } as GenerationRequest

    const { job } = await store.create(input)
    const reopened = await GenerationJobStore.open({ dataDir })

    expect(job.request).not.toHaveProperty('mode')
    expect(reopened.get('job-1')).toEqual(job)
    expect(JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'))[0].request).toEqual(job.request)
  })

  it('rejects extra request fields before GenerationJobStore persists or digests them', async () => {
    const dataDir = await tempDirectory()
    const store = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const invalid = { ...request(), unexpected: 'not allowed' } as GenerationRequest

    await expect(store.create(invalid)).rejects.toMatchObject({ code: 'invalid_generation_request' })
    expect(store.list()).toEqual([])
    await expect(readFile(join(dataDir, 'jobs.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects extra request fields in submit before catalog or provider operations', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const assets = await AssetStore.open({ dataDir })
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>()
    const invalid = { ...request(), unexpected: 'not allowed' } as GenerationRequest

    await expect(runner({
      jobs, assets, provider: adapter({ createGeneration }),
    }).submit(invalid)).rejects.toMatchObject({ code: 'invalid_generation_request' })
    expect(createGeneration).not.toHaveBeenCalled()
    expect(jobs.list()).toEqual([])
  })

  it('throws typed idempotency_conflict when a clientRequestId is reused with a different digest', async () => {
    const dataDir = await tempDirectory()
    const store = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    await store.create(request())

    await expect(store.create(request({ prompt: 'different request body' }))).rejects.toMatchObject({
      code: 'idempotency_conflict',
    })
    expect(store.list()).toHaveLength(1)
  })

  it('single-flights concurrent submit calls by clientRequestId and creates upstream exactly once', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const assets = await AssetStore.open({ dataDir })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>(async () => {
      await gate
      return 'upstream-1'
    })
    const generation = runner({
      jobs, assets, provider: adapter({ createGeneration }), schedule: () => 1,
    })

    const first = generation.submit(request())
    const second = generation.submit(request())
    await vi.waitFor(() => expect(createGeneration).toHaveBeenCalledTimes(1))
    release()
    const results = await Promise.all([first, second])

    expect(createGeneration).toHaveBeenCalledTimes(1)
    expect(results.map((job) => job.id)).toEqual(['job-1', 'job-1'])
    expect(results.every((job) => job.status === 'submitted')).toBe(true)
  })

  it('rejects a conflicting request while the original clientRequestId is in flight', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const assets = await AssetStore.open({ dataDir })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>(async () => {
      await gate
      return 'upstream-1'
    })
    const generation = runner({
      jobs, assets, provider: adapter({ createGeneration }), schedule: () => 1,
    })

    const first = generation.submit(request())
    await vi.waitFor(() => expect(createGeneration).toHaveBeenCalledTimes(1))
    const conflict = generation.submit(request({ prompt: 'conflicting in-flight request' }))
    release()
    await expect(conflict).rejects.toMatchObject({
      code: 'idempotency_conflict',
    })
    await first
    expect(createGeneration).toHaveBeenCalledTimes(1)
  })

  it('stages local references in alias order and clears provider URLs after submission', async () => {
    const dataDir = await tempDirectory()
    const assets = await AssetStore.open({ dataDir })
    const alias2 = await assets.save({ filename: 'alias-2.png', contentType: 'image/png', bytes: PNG })
    const alias1 = await assets.save({ filename: 'alias-1.png', contentType: 'image/png', bytes: PNG })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const presignReference = vi.fn<ProviderAdapter['presignReference']>(async (item) => grant(`key-${item.filename}`))
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>(async () => 'upstream-1')

    const job = await runner({
      jobs, assets, provider: adapter({ presignReference, createGeneration }), schedule: () => {},
    }).submit(request({ references: [
      { alias: 2, assetId: alias2.id, mediaType: 'image' },
      { alias: 1, assetId: alias1.id, mediaType: 'image' },
    ] }))

    expect(presignReference.mock.calls.map((call) => call[0].filename)).toEqual(['alias-1.png', 'alias-2.png'])
    const staged = createGeneration.mock.calls[0][1] as StagedReference[]
    expect(staged.map((item) => [item.alias, item.url])).toEqual([
      [1, 'https://cdn.example/key-alias-1.png'], [2, 'https://cdn.example/key-alias-2.png'],
    ])
    expect(job.status).toBe('submitted')
    const persisted = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'))
    expect(persisted[0].referenceUploads.map((item: { alias: number; status: string; assetId: string }) =>
      [item.alias, item.status, item.assetId])).toEqual([
      [1, 'released', alias1.id], [2, 'released', alias2.id],
    ])
    expect(JSON.stringify(persisted)).not.toContain('https://cdn.example')
    expect(JSON.stringify(persisted)).not.toContain('key-alias')
  })

  it('retries raw upload with the same persisted presign grant', async () => {
    const dataDir = await tempDirectory()
    const assets = await AssetStore.open({ dataDir })
    const asset = await assets.save({ filename: 'ref.png', contentType: 'image/png', bytes: PNG })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const fixedGrant = grant('one-file-key')
    const presignReference = vi.fn<ProviderAdapter['presignReference']>(async () => fixedGrant)
    const uploadReference = vi.fn<ProviderAdapter['uploadReference']>()
      .mockRejectedValueOnce(new TypeError('reset'))
      .mockRejectedValueOnce(new TypeError('reset'))
      .mockResolvedValue(undefined)

    const job = await runner({
      jobs, assets, provider: adapter({ presignReference, uploadReference }),
      schedule: () => {}, sleep: async () => {},
    }).submit(request({ references: [{ alias: 1, assetId: asset.id, mediaType: 'image' }] }))

    expect(job.status).toBe('submitted')
    expect(presignReference).toHaveBeenCalledTimes(1)
    expect(uploadReference).toHaveBeenCalledTimes(3)
    expect(uploadReference.mock.calls.map((call) => call[1])).toEqual([fixedGrant, fixedGrant, fixedGrant])
  })

  it('keeps presigned upload URLs and headers only in process memory', async () => {
    const dataDir = await tempDirectory()
    const assets = await AssetStore.open({ dataDir })
    const asset = await assets.save({ filename: 'ref.png', contentType: 'image/png', bytes: PNG })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const fixedGrant = grant('memory-only-key')
    const uploadReference = vi.fn<ProviderAdapter['uploadReference']>(async () => {
      const persisted = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'))
      const state = persisted[0].referenceUploads[0]
      expect(state).toEqual(expect.objectContaining({ status: 'presigned', fileKey: 'memory-only-key' }))
      expect(state).not.toHaveProperty('grant')
      expect(JSON.stringify(state)).not.toContain(fixedGrant.uploadUrl)
      expect(JSON.stringify(state)).not.toContain('x-upload-token')
    })

    const job = await runner({
      jobs,
      assets,
      provider: adapter({ presignReference: async () => fixedGrant, uploadReference }),
      schedule: () => 1,
    }).submit(request({ references: [{ alias: 1, assetId: asset.id, mediaType: 'image' }] }))

    expect(job.status).toBe('submitted')
    expect(uploadReference).toHaveBeenCalledWith(expect.anything(), fixedGrant, expect.any(AbortSignal))
  })

  it('strips legacy persisted grants before the next jobs write', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const { job } = await jobs.create(request({
      references: [{ alias: 1, assetId: 'asset-1', mediaType: 'image' }],
    }))
    const file = join(dataDir, 'jobs.json')
    const legacy = JSON.parse(await readFile(file, 'utf8'))
    legacy[0].referenceUploads[0] = {
      ...legacy[0].referenceUploads[0],
      status: 'presigned',
      fileKey: 'legacy-key',
      grant: {
        fileKey: 'legacy-key', uploadUrl: 'https://storage.example/private-signature',
        headers: { Authorization: 'secret-storage-header' }, method: 'PUT', expiresAt: Date.now() + 60_000,
      },
    }
    await writeFile(file, JSON.stringify(legacy))

    const reopened = await GenerationJobStore.open({ dataDir })
    await reopened.update(job.id, { progress: 1 })

    const persisted = await readFile(file, 'utf8')
    expect(persisted).not.toContain('private-signature')
    expect(persisted).not.toContain('secret-storage-header')
    expect(persisted).not.toContain('"grant"')
  })

  it('keeps completed references and stops for manual recovery after ambiguous complete', async () => {
    const dataDir = await tempDirectory()
    const assets = await AssetStore.open({ dataDir })
    const first = await assets.save({ filename: 'first.png', contentType: 'image/png', bytes: PNG })
    const second = await assets.save({ filename: 'second.png', contentType: 'image/png', bytes: PNG })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const completeReference = vi.fn<ProviderAdapter['completeReference']>(async (fileKey) => {
      const persisted = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'))
      const state = persisted[0].referenceUploads.find((item: { fileKey: string }) => item.fileKey === fileKey)
      expect(state).toEqual(expect.objectContaining({
        status: 'manual_recovery', fileKey, completeAttemptedAt: expect.any(String),
      }))
      if (fileKey.includes('second')) throw new TypeError('connection reset after submit')
      return { url: `https://cdn.example/${fileKey}` }
    })
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>()
    const provider = adapter({ completeReference, createGeneration })
    const generation = runner({ jobs, assets, provider, schedule: () => {}, sleep: async () => {} })

    const job = await generation.submit(request({ references: [
      { alias: 1, assetId: first.id, mediaType: 'image' },
      { alias: 2, assetId: second.id, mediaType: 'image' },
    ] }))
    await generation.resume()

    expect(job.status).toBe('failed')
    expect(job.error?.code).toBe('COMPLETE_AMBIGUOUS')
    expect(createGeneration).not.toHaveBeenCalled()
    expect(completeReference).toHaveBeenCalledTimes(2)
    expect(completeReference.mock.calls.map((call) => call[0])).toEqual([
      'file-first.png', 'file-second.png',
    ])
    const persisted = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'))
    expect(persisted[0].referenceUploads.map((item: { status: string }) => item.status)).toEqual(['released', 'manual_recovery'])
    expect(JSON.stringify(persisted[0].referenceUploads[0])).not.toContain('cdn.example')
    expect(JSON.stringify(persisted[0].referenceUploads[0])).not.toContain('file-first.png')
  })

  it('does not retry an ambiguous complete and preserves its fileKey for manual recovery', async () => {
    const dataDir = await tempDirectory()
    const assets = await AssetStore.open({ dataDir })
    const asset = await assets.save({ filename: 'ref.png', contentType: 'image/png', bytes: PNG })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const presignReference = vi.fn<ProviderAdapter['presignReference']>(async () => grant('stable-file-key'))
    const completeReference = vi.fn<ProviderAdapter['completeReference']>()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValue({ url: 'https://cdn.example/stable-file-key' })

    const job = await runner({
      jobs,
      assets,
      provider: adapter({ presignReference, completeReference }),
      schedule: () => {},
      sleep: async () => {},
    }).submit(request({ references: [{ alias: 1, assetId: asset.id, mediaType: 'image' }] }))

    expect(job.status).toBe('failed')
    expect(job.error?.code).toBe('COMPLETE_AMBIGUOUS')
    expect(presignReference).toHaveBeenCalledTimes(1)
    expect(completeReference).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'))
    expect(persisted[0].referenceUploads[0]).toEqual(expect.objectContaining({
      status: 'manual_recovery', fileKey: 'stable-file-key', completeAttemptedAt: expect.any(String),
    }))
  })

  it('waits for explicit resubmission before obtaining a fresh presign after restart', async () => {
    const dataDir = await tempDirectory()
    const assets = await AssetStore.open({ dataDir })
    const asset = await assets.save({ filename: 'ref.png', contentType: 'image/png', bytes: PNG })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const { job: created } = await jobs.create(request({
      references: [{ alias: 1, assetId: asset.id, mediaType: 'image' }],
    }))
    await jobs.update(created.id, { status: 'uploading' })
    await jobs.updateReferenceUpload(created.id, 1, {
      status: 'presigned', fileKey: 'expired-process-key', presignedAt: '2026-07-16T00:00:00Z',
    } as never)

    const reopened = await GenerationJobStore.open({ dataDir })
    const freshGrant = grant('fresh-process-key')
    const presignReference = vi.fn<ProviderAdapter['presignReference']>(async () => freshGrant)
    const uploadReference = vi.fn<ProviderAdapter['uploadReference']>(async () => {})
    const generation = runner({
      jobs: reopened,
      assets,
      provider: adapter({ presignReference, uploadReference }),
      schedule: () => 1,
    })
    await generation.resume()

    expect(presignReference).not.toHaveBeenCalled()
    expect(uploadReference).not.toHaveBeenCalled()
    expect(reopened.get('job-1')?.status).toBe('uploading')

    const resumed = await generation.submit(request({
      references: [{ alias: 1, assetId: asset.id, mediaType: 'image' }],
    }))

    expect(presignReference).toHaveBeenCalledTimes(1)
    expect(uploadReference).toHaveBeenCalledWith(expect.anything(), freshGrant, expect.any(AbortSignal))
    expect(resumed.status).toBe('submitted')
  })

  it('rejects URL references on new submissions before persistence', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>()
    const generation = runner({
      jobs,
      assets: await AssetStore.open({ dataDir }),
      provider: adapter({ createGeneration }),
      schedule: () => {},
    })

    await expect(generation.submit(request({
      references: [{ alias: 1, url: 'https://public.example/reference.png', mediaType: 'image' }],
    }))).rejects.toMatchObject({ code: 'invalid_generation_request' })
    expect(jobs.list()).toEqual([])
    expect(createGeneration).not.toHaveBeenCalled()
  })

  it('rejects URL references even when a pinned importer is configured', async () => {
    const dataDir = await tempDirectory()
    const pinnedFetcher = vi.fn(async () => new Response(PNG, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
    }))
    const assets = await AssetStore.open({
      dataDir,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher,
    })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const presignReference = vi.fn<ProviderAdapter['presignReference']>(async () => grant('imported-key'))
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>(async () => 'upstream-1')
    const sourceUrl = 'https://public.example/reference.png'

    await expect(runner({
      jobs,
      assets,
      provider: adapter({ presignReference, createGeneration }),
      schedule: () => {},
    }).submit(request({ references: [{ alias: 1, url: sourceUrl, mediaType: 'image' }] })))
      .rejects.toMatchObject({ code: 'invalid_generation_request' })

    expect(pinnedFetcher).not.toHaveBeenCalled()
    expect(presignReference).not.toHaveBeenCalled()
    expect(createGeneration).not.toHaveBeenCalled()
  })

  it('waits for explicit resubmission before completing an uploaded reference', async () => {
    const dataDir = await tempDirectory()
    const assets = await AssetStore.open({ dataDir })
    const asset = await assets.save({ filename: 'ref.png', contentType: 'image/png', bytes: PNG })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const { job: created } = await jobs.create(request({ references: [{ alias: 1, assetId: asset.id, mediaType: 'image' }] }))
    await jobs.update(created.id, { status: 'uploading' })
    await jobs.updateReferenceUpload(created.id, 1, {
      status: 'uploaded', fileKey: 'existing-key', uploadedAt: '2026-07-16T00:00:00Z',
    } as never)
    const reopened = await GenerationJobStore.open({ dataDir })
    const presignReference = vi.fn<ProviderAdapter['presignReference']>()
    const uploadReference = vi.fn<ProviderAdapter['uploadReference']>()
    const completeReference = vi.fn<ProviderAdapter['completeReference']>(async () => ({ url: 'https://cdn.example/existing.png' }))

    const generation = runner({
      jobs: reopened, assets,
      provider: adapter({ presignReference, uploadReference, completeReference }), schedule: () => {},
    })
    await generation.resume()

    expect(presignReference).not.toHaveBeenCalled()
    expect(uploadReference).not.toHaveBeenCalled()
    expect(completeReference).not.toHaveBeenCalled()
    expect(reopened.get('job-1')?.status).toBe('uploading')

    const resumed = await generation.submit(request({
      references: [{ alias: 1, assetId: asset.id, mediaType: 'image' }],
    }))

    expect(completeReference).toHaveBeenCalledWith('existing-key', expect.any(AbortSignal))
    expect(resumed.status).toBe('submitted')
  })

  it('performs zero paid create calls during startup recovery', async () => {
    const dataDir = await tempDirectory()
    const assets = await AssetStore.open({ dataDir })
    const asset = await assets.save({ filename: 'ref.png', contentType: 'image/png', bytes: PNG })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => `job-${jobs.list().length + 1}` })
    await jobs.create(request({ clientRequestId: 'queued' }))
    const { job: uploading } = await jobs.create(request({
      clientRequestId: 'uploading', references: [{ alias: 1, assetId: asset.id, mediaType: 'image' }],
    }))
    await jobs.update(uploading.id, { status: 'uploading' })
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>()
    const presignReference = vi.fn<ProviderAdapter['presignReference']>()
    const generation = runner({
      jobs: await GenerationJobStore.open({ dataDir }),
      assets,
      provider: adapter({ createGeneration, presignReference }),
      schedule: () => {},
    })

    await generation.resume()

    expect(createGeneration, 'createGenerationCallsDuringStartup').not.toHaveBeenCalled()
    expect(presignReference).not.toHaveBeenCalled()
  })

  it('aborts an avoidable reference upload during shutdown and keeps the job resumable', async () => {
    const dataDir = await tempDirectory()
    const assets = await AssetStore.open({ dataDir })
    const asset = await assets.save({ filename: 'ref.png', contentType: 'image/png', bytes: PNG })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    let receivedSignal: AbortSignal | undefined
    let markUploadStarted!: () => void
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve
    })
    const uploadReference = vi.fn<ProviderAdapter['uploadReference']>(async (_reference, _grant, signal) => {
      receivedSignal = signal
      markUploadStarted()
      if (!signal) throw new Error('missing shutdown signal')
      await new Promise((_done, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const generation = runner({
      jobs, assets, provider: adapter({ uploadReference }), schedule: () => {}, sleep: async () => {},
    })
    const submitted = generation.submit(request({
      references: [{ alias: 1, assetId: asset.id, mediaType: 'image' }],
    }))

    await uploadStarted
    await generation.close()
    await submitted
    await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true))
    expect(jobs.get('job-1')).toEqual(expect.objectContaining({
      status: 'uploading', error: expect.objectContaining({ code: 'REFERENCE_STAGING_FAILED' }),
    }))
  })

  it('never retries an ambiguous create failure', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const assets = await AssetStore.open({ dataDir })
    const asset = await assets.save({ filename: 'ref.png', contentType: 'image/png', bytes: PNG })
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>().mockRejectedValue(new TypeError('network timeout'))
    const generation = runner({ jobs, assets, provider: adapter({ createGeneration }), schedule: () => {} })
    const job = await generation.submit(request({ references: [{
      alias: 1, assetId: asset.id, mediaType: 'image',
    }] }))
    await generation.resume()
    expect(createGeneration).toHaveBeenCalledTimes(1)
    expect(job.status).toBe('failed')
    expect(job.error).toEqual(expect.objectContaining({ code: 'CREATE_AMBIGUOUS' }))
    const persisted = await readFile(join(dataDir, 'jobs.json'), 'utf8')
    expect(persisted).not.toContain('https://cdn.example/file-ref.png')
    expect(persisted).not.toContain('file-ref.png')
  })

  it('records an explicit provider rejection separately from an ambiguous create failure', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-rejected' })
    const generation = runner({
      jobs,
      assets: await AssetStore.open({ dataDir }),
      provider: adapter({
        createGeneration: async () => {
          throw new ProviderRequestRejectedError('Provider rejected the request: Prompt is too long', '40017')
        },
      }),
      schedule: () => {},
    })

    const job = await generation.submit(request())

    expect(job).toMatchObject({
      status: 'failed',
      error: {
        code: 'PROVIDER_REJECTED',
        message: 'Provider rejected the request: Prompt is too long',
      },
    })
  })

  it('rejects stale catalogs before persisting or creating a paid task', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>()
    const generation = runner({
      jobs, assets: await AssetStore.open({ dataDir }), provider: adapter({ createGeneration }),
      currentCatalog: { ...catalog, stale: true }, schedule: () => {},
    })
    await expect(generation.submit(request())).rejects.toBeInstanceOf(CatalogChangedError)
    expect(jobs.list()).toEqual([])
    expect(createGeneration).not.toHaveBeenCalled()
  })

  it('uses detail fallback and keeps polling when success has no output', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const getGenerationStatus = vi.fn<ProviderAdapter['getGenerationStatus']>(async () => [{
      taskId: 'upstream-1', status: 3, progress: 100, outputs: [],
    }])
    const getGenerationDetail = vi.fn<ProviderAdapter['getGenerationDetail']>(async () => ({
      taskId: 'upstream-1', status: 3, progress: 100, outputs: [],
    }))
    const scheduled: number[] = []
    const generation = runner({
      jobs, assets: await AssetStore.open({ dataDir }),
      provider: adapter({ getGenerationStatus, getGenerationDetail }),
      schedule: (_run, delay) => { scheduled.push(delay) },
    })
    await generation.submit(request())

    const pending = await generation.poll('job-1')

    expect(getGenerationDetail).toHaveBeenCalledWith('upstream-1', expect.any(AbortSignal))
    expect(pending.status).toBe('running')
    expect(pending.outputs).toEqual([])
    expect(scheduled.at(-1)).toBe(12_000)
  })

  it('downloads a terminal output to a durable local asset', async () => {
    const dataDir = await tempDirectory()
    const pinnedFetcher = vi.fn().mockResolvedValue(new Response(PNG, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
    }))
    const assets = await AssetStore.open({
      dataDir,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher,
    })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const statuses: UpstreamTaskStatus[][] = [
      [{ taskId: 'upstream-1', status: 2, progress: 47 }],
      [{ taskId: 'upstream-1', status: 3, progress: 100, outputs: ['https://cdn.example/result.png'] }],
    ]
    const getGenerationStatus = vi.fn<ProviderAdapter['getGenerationStatus']>(async () => statuses.shift() ?? [])
    const generation = runner({ jobs, assets, provider: adapter({ getGenerationStatus }), schedule: () => {} })
    await generation.submit(request())
    expect((await generation.poll('job-1')).status).toBe('running')
    const completed = await generation.poll('job-1')
    expect(completed.status).toBe('complete')
    expect(await assets.readBytes(completed.outputs[0].assetId)).toEqual(PNG)
    const persisted = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'))
    expect(JSON.stringify(persisted)).not.toContain('https://cdn.example/result.png')
  })

  it('records every downloaded output in project history', async () => {
    const dataDir = await tempDirectory()
    const pinnedFetcher = vi.fn(async () => new Response(PNG, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
    }))
    const assets = await AssetStore.open({
      dataDir,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher,
    })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const history = await GenerationHistoryStore.open({ dataDir })
    const getGenerationStatus = vi.fn<ProviderAdapter['getGenerationStatus']>(async () => [{
      taskId: 'upstream-1', status: 3, progress: 100,
      outputs: ['https://cdn.example/result-1.png', 'https://cdn.example/result-2.png'],
    }])
    const generation = runner({
      jobs, assets, history, provider: adapter({ getGenerationStatus }), schedule: () => {},
    })

    await generation.submit(request({
      prompt: 'portrait with stable identity', aspectRatio: '1:1', quality: '1K', n: 1,
      references: [],
    }))
    const completed = await generation.poll('job-1')

    expect(completed.status).toBe('complete')
    expect(history.list({ projectId: 'project-alpha', limit: 20 }).entries).toEqual([
      expect.objectContaining({
        jobId: 'job-1', outputIndex: 1, prompt: 'portrait with stable identity',
        providerId: 'aistartlab', channel: 46, model: 'gpt-image-2',
        settings: { quality: '1K', aspectRatio: '1:1', count: 1 },
      }),
      expect.objectContaining({
        jobId: 'job-1', outputIndex: 0, prompt: 'portrait with stable identity',
        providerId: 'aistartlab', channel: 46, model: 'gpt-image-2',
        settings: { quality: '1K', aspectRatio: '1:1', count: 1 },
      }),
    ])
    await generation.poll('job-1')
    expect(history.list({ projectId: 'project-alpha', limit: 20 }).entries).toHaveLength(2)
  })

  it('repairs a failed history write without downloading the output twice', async () => {
    const dataDir = await tempDirectory()
    const pinnedFetcher = vi.fn().mockResolvedValue(new Response(PNG, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
    }))
    const assets = await AssetStore.open({
      dataDir,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher,
    })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    let historyWrites = 0
    const history = await GenerationHistoryStore.open({
      dataDir,
      writeHistory: async (filePath, value) => {
        historyWrites += 1
        if (historyWrites === 1) throw new Error('injected history persistence failure')
        await atomicWriteJson(filePath, value)
      },
    })
    const getGenerationStatus = vi.fn<ProviderAdapter['getGenerationStatus']>(async () => [{
      taskId: 'upstream-1', status: 3, progress: 100,
      outputs: ['https://cdn.example/result.png'],
    }])
    const generation = runner({
      jobs, assets, history, provider: adapter({ getGenerationStatus }), schedule: () => 1, sleep: async () => {},
    })
    await generation.submit(request())

    expect((await generation.poll('job-1')).status).toBe('downloading')
    expect(history.list({ projectId: 'project-alpha', limit: 20 }).entries).toEqual([])
    const completed = await generation.poll('job-1')

    expect(completed.status).toBe('complete')
    expect(pinnedFetcher).toHaveBeenCalledTimes(1)
    expect(history.list({ projectId: 'project-alpha', limit: 20 }).entries).toHaveLength(1)
  })

  it('persists each downloaded output and skips it when a later output is retried', async () => {
    const dataDir = await tempDirectory()
    let secondAttempts = 0
    const fetchedUrls: string[] = []
    const pinnedFetcher = vi.fn(async (url: string) => {
      fetchedUrls.push(url)
      if (url.endsWith('/result-2.png') && ++secondAttempts <= 3) throw new TypeError('temporary download failure')
      return new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
      })
    })
    const assets = await AssetStore.open({
      dataDir,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher,
    })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const outputs = ['https://cdn.example/result-1.png', 'https://cdn.example/result-2.png']
    const getGenerationStatus = vi.fn<ProviderAdapter['getGenerationStatus']>(async () => [{
      taskId: 'upstream-1', status: 3, progress: 100, outputs,
    }])
    const generation = runner({
      jobs, assets, provider: adapter({ getGenerationStatus }), schedule: () => 1, sleep: async () => {},
    })
    await generation.submit(request())

    const partial = await generation.poll('job-1')
    expect(partial.status).toBe('downloading')
    expect(partial.outputs).toHaveLength(1)
    const persistedPartial = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'))
    expect(persistedPartial[0].outputs).toHaveLength(1)

    const completed = await generation.poll('job-1')
    expect(completed.status).toBe('complete')
    expect(completed.outputs).toHaveLength(2)
    expect(fetchedUrls.filter((url) => url.endsWith('/result-1.png'))).toHaveLength(1)
    expect(JSON.stringify(JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8')))).not.toContain('cdn.example')
  })

  it('single-flights concurrent polls so terminal output is downloaded once', async () => {
    const dataDir = await tempDirectory()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pinnedFetcher = vi.fn(async () => {
      await gate
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const assets = await AssetStore.open({
      dataDir,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher,
    })
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const getGenerationStatus = vi.fn<ProviderAdapter['getGenerationStatus']>(async () => [{
      taskId: 'upstream-1', status: 3, outputs: ['https://cdn.example/result.png'],
    }])
    const generation = runner({ jobs, assets, provider: adapter({ getGenerationStatus }), schedule: () => 1 })
    await generation.submit(request())

    const first = generation.poll('job-1')
    const second = generation.poll('job-1')
    await vi.waitFor(() => expect(pinnedFetcher).toHaveBeenCalledTimes(1))
    release()
    const results = await Promise.all([first, second])

    expect(getGenerationStatus).toHaveBeenCalledTimes(1)
    expect(pinnedFetcher).toHaveBeenCalledTimes(1)
    expect(results.every((job) => job.status === 'complete')).toBe(true)
  })

  it('replaces raw upstream failures with a controlled public error', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const rawSecret = 'Bearer upstream-secret'
    const rawUrl = 'https://private.example/task?id=secret'
    const getGenerationStatus = vi.fn<ProviderAdapter['getGenerationStatus']>(async () => [{
      taskId: 'upstream-1', status: 4, errorCode: rawSecret, errorMessage: rawUrl,
    }])
    const generation = runner({
      jobs, assets: await AssetStore.open({ dataDir }),
      provider: adapter({ getGenerationStatus }), schedule: () => 1,
    })
    await generation.submit(request())

    const failed = await generation.poll('job-1')
    expect(failed.error).toEqual({ code: 'PROVIDER_FAILED', message: 'Generation failed at the provider' })
    expect(JSON.stringify(failed)).not.toContain(rawSecret)
    expect(JSON.stringify(failed)).not.toContain(rawUrl)
  })

  it('redacts secrets and URLs from bounded diagnostic logs', async () => {
    const dataDir = await tempDirectory()
    const entries: Array<{ event: string; message: string }> = []
    const rawSecret = 'Bearer super-secret-token'
    const rawUrl = 'https://private.example/path?apiKey=hidden'
    const createGeneration = vi.fn<ProviderAdapter['createGeneration']>(async () => {
      throw new Error(`${rawSecret} failed at ${rawUrl} ${'x'.repeat(1_000)}`)
    })
    const generation = runner({
      jobs: await GenerationJobStore.open({ dataDir, id: () => 'job-1' }),
      assets: await AssetStore.open({ dataDir }),
      provider: adapter({ createGeneration }),
      schedule: () => 1,
      log: (entry) => entries.push(entry),
    })

    await generation.submit(request())

    expect(entries).toHaveLength(1)
    expect(entries[0].event).toBe('generation.create_failed')
    expect(entries[0].message.length).toBeLessThanOrEqual(300)
    expect(entries[0].message).not.toContain('super-secret-token')
    expect(entries[0].message).not.toContain('private.example')
  })

  it('resumes non-terminal upstream tasks with an official polling delay', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const { job: created } = await jobs.create(request())
    await jobs.update(created.id, { status: 'running', upstreamTaskId: 'upstream-1' })
    const scheduled: number[] = []
    await runner({
      jobs, assets: await AssetStore.open({ dataDir }), schedule: (_run, delay) => { scheduled.push(delay) },
    }).resume()
    expect(scheduled).toEqual([12_000])
  })

  it('fails an expired upstream task without another status request or poll', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-timeout' })
    const { job: created } = await jobs.create(request())
    const startedAt = Date.parse('2026-07-18T00:00:00.000Z')
    await jobs.update(created.id, {
      status: 'running',
      upstreamTaskId: 'upstream-timeout',
      createAttemptedAt: new Date(startedAt).toISOString(),
    })
    const getGenerationStatus = vi.fn<ProviderAdapter['getGenerationStatus']>()
    const schedule = vi.fn()
    const generation = runner({
      jobs,
      assets: await AssetStore.open({ dataDir }),
      provider: adapter({ getGenerationStatus }),
      schedule,
      maxRunTimeMs: 30 * 60_000,
      now: () => startedAt + 30 * 60_000 + 1,
    })

    const expired = await generation.poll(created.id)

    expect(expired).toMatchObject({
      status: 'failed',
      error: {
        code: 'GENERATION_TIMEOUT',
        message: 'Generation exceeded the local time limit',
      },
    })
    expect(getGenerationStatus).not.toHaveBeenCalled()
    expect(schedule).not.toHaveBeenCalled()
  })

  it('marks an expired persisted task failed during restart recovery', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-resume-timeout' })
    const { job: created } = await jobs.create(request())
    const startedAt = Date.parse('2026-07-18T00:00:00.000Z')
    await jobs.update(created.id, {
      status: 'submitted',
      upstreamTaskId: 'upstream-resume-timeout',
      createAttemptedAt: new Date(startedAt).toISOString(),
    })
    const schedule = vi.fn()
    const generation = runner({
      jobs,
      assets: await AssetStore.open({ dataDir }),
      schedule,
      maxRunTimeMs: 30 * 60_000,
      now: () => startedAt + 30 * 60_000 + 1,
    })

    await generation.resume()

    expect(jobs.get(created.id)).toMatchObject({
      status: 'failed',
      error: { code: 'GENERATION_TIMEOUT' },
    })
    expect(schedule).not.toHaveBeenCalled()
  })

  it('keeps one poll timer per job and clears it during close', async () => {
    const dataDir = await tempDirectory()
    const jobs = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    const handles: number[] = []
    const schedule = vi.fn((_run: () => void | Promise<void>, _delay: number) => {
      const handle = handles.length + 1
      handles.push(handle)
      return handle
    })
    const cancelSchedule = vi.fn()
    const generation = runner({
      jobs,
      assets: await AssetStore.open({ dataDir }),
      schedule,
      cancelSchedule,
    })

    await generation.submit(request())
    await generation.poll('job-1')
    expect(schedule).toHaveBeenCalledTimes(1)

    await generation.close()
    expect(cancelSchedule).toHaveBeenCalledTimes(1)
    expect(cancelSchedule).toHaveBeenCalledWith(1)
  })

  it.each([
    ['request', (record: Record<string, unknown>) => { (record.request as Record<string, unknown>).model = 42 }],
    ['status', (record: Record<string, unknown>) => { record.status = 'teleporting' }],
    ['outputs', (record: Record<string, unknown>) => { record.outputs = [{ assetId: '../bad' }] }],
    ['id', (record: Record<string, unknown>) => { record.id = '../bad' }],
    ['timestamp', (record: Record<string, unknown>) => { record.createdAt = 'not-a-date' }],
    ['attempt flag', (record: Record<string, unknown>) => { record.createAttemptedAt = 123 }],
    ['reference checkpoint', (record: Record<string, unknown>) => { record.referenceUploads = [{ alias: 0 }] }],
  ])('quarantines jobs.json and refuses startup when %s is corrupt', async (_field, corrupt) => {
    const dataDir = await tempDirectory()
    const now = () => new Date('2026-07-16T00:00:00.000Z')
    const store = await GenerationJobStore.open({ dataDir, id: () => 'job-1', now })
    await store.create(request())
    const file = join(dataDir, 'jobs.json')
    const persisted = JSON.parse(await readFile(file, 'utf8')) as Array<Record<string, unknown>>
    corrupt(persisted[0])
    await writeFile(file, JSON.stringify(persisted))

    await expect(GenerationJobStore.open({ dataDir, now })).rejects.toMatchObject({
      code: 'corrupt_jobs_file',
    })
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(dataDir)).some((name) => name.startsWith('jobs.json.corrupt.2026-07-16T00-00-00'))).toBe(true)
  })

  it('creates a durable recovery marker on the first corrupt restart', async () => {
    const dataDir = await tempDirectory()
    const now = () => new Date('2026-07-16T00:00:00.000Z')
    const store = await GenerationJobStore.open({ dataDir, id: () => 'job-1', now })
    await store.create(request())
    const file = join(dataDir, 'jobs.json')
    const persisted = JSON.parse(await readFile(file, 'utf8')) as Array<Record<string, unknown>>
    persisted[0].status = 'invalid'
    await writeFile(file, JSON.stringify(persisted))

    let corruptPath = ''
    try {
      await GenerationJobStore.open({ dataDir, now })
    } catch (error) {
      expect(error).toMatchObject({ code: 'corrupt_jobs_file' })
      corruptPath = (error as { corruptPath: string }).corruptPath
    }

    const marker = JSON.parse(await readFile(join(dataDir, '.jobs-recovery-required.json'), 'utf8'))
    expect(marker).toEqual({
      version: 1,
      corruptFile: basename(corruptPath),
      detectedAt: '2026-07-16T00:00:00.000Z',
    })
  })

  it('keeps subsequent restarts blocked until the quarantined file is explicitly acknowledged', async () => {
    const dataDir = await tempDirectory()
    const now = () => new Date('2026-07-16T00:00:00.000Z')
    const store = await GenerationJobStore.open({ dataDir, id: () => 'job-1', now })
    await store.create(request())
    const file = join(dataDir, 'jobs.json')
    await writeFile(file, '{broken json')

    let corruptPath = ''
    try {
      await GenerationJobStore.open({ dataDir, now })
    } catch (error) {
      corruptPath = (error as { corruptPath: string }).corruptPath
    }
    await expect(GenerationJobStore.open({ dataDir, now })).rejects.toMatchObject({
      code: 'corrupt_jobs_file', corruptPath,
    })
    expect((await readdir(dataDir)).filter((name) => name.startsWith('jobs.json.corrupt.'))).toHaveLength(1)

    await GenerationJobStore.acknowledgeCorruptJobs({ dataDir, corruptPath })
    expect((await GenerationJobStore.open({ dataDir, now })).list()).toEqual([])
  })
})
