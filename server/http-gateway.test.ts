import { request as nodeRequest } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerationRequest, ProviderCatalog } from '../src/contracts/generation.ts'
import { AssetStore } from './asset-store.ts'
import { DataDirectoryLock } from './data-directory-lock.ts'
import * as gatewayModule from './http-gateway.ts'
import { startGateway, type GatewayHandle } from './http-gateway.ts'
import { resolveMainOptions } from './main.ts'
import { generationRequestDigest } from './jobs.ts'
import type { ProviderAdapter } from './providers/provider-adapter.ts'

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
const handles: GatewayHandle[] = []
const localAdminCookies = new WeakMap<GatewayHandle, string>()
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080,
])

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'libtv-http-'))
}

const catalog: ProviderCatalog = {
  providerId: 'aistartlab',
  version: 'catalog-v1',
  fetchedAt: new Date().toISOString(),
  stale: false,
  models: [{
    mediaType: 'image',
    channel: 46,
    model: 'gpt-image-2',
    qualityOptions: [{ value: '1K', label: '1K', pricing: { type: 'fixed_total', credits: 5 } }],
    aspectRatios: ['16:9'],
    countOptions: [1],
    durationOptions: [],
    countRange: { min: 1, max: 1, options: [1] },
    modes: [],
    inputLimits: { images: 6, videos: 0, audios: 0 },
    raw: {},
  }],
}

function adapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    testConnection: async () => {},
    syncCatalog: async () => catalog,
    presignReference: async () => { throw new Error('not used') },
    uploadReference: async () => { throw new Error('not used') },
    completeReference: async () => { throw new Error('not used') },
    createGeneration: async () => 'task-1',
    getGenerationStatus: async () => [],
    getGenerationDetail: async () => { throw new Error('not used') },
    ...overrides,
  }
}

function generationRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    clientRequestId: 'client-1',
    projectId: 'project-alpha',
    canvasId: 'canvas-alpha',
    providerId: 'aistartlab',
    catalogVersion: 'catalog-v1',
    mediaType: 'image',
    channel: 46,
    model: 'gpt-image-2',
    prompt: 'A quiet courtyard at dusk',
    quality: '1K',
    aspectRatio: '16:9',
    n: 1,
    references: [],
    ...overrides,
  }
}

async function start(
  options: Parameters<typeof startGateway>[0] = {} as never,
  bootstrapAdmin = true,
) {
  const dataDir = options.dataDir ?? await tempDirectory()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const handle = await startGateway({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      envFile: join(dataDir, '.env.local'),
      env: { API_PROVIDER_AISTARTLAB_KEY: 'initial-secret-123456' },
      adapterFactory: () => adapter(),
      ...options,
    })
    if (!FETCH_BLOCKED_PORTS.has(Number(new URL(handle.origin).port))) {
      if (bootstrapAdmin && (!options.host || gatewayModule.isLoopbackHost?.(options.host))) {
        const session = await fetch(`${handle.origin}/api/local-admin/session`, { method: 'POST' })
        const cookie = session.headers.get('set-cookie')?.split(';', 1)[0]
        if (!cookie) throw new Error('Expected local administrator cookie')
        localAdminCookies.set(handle, cookie)
      }
      handles.push(handle)
      return handle
    }
    await handle.close()
  }
  throw new Error('Could not allocate a Fetch-compatible test port')
}

function adminHeaders(gateway: GatewayHandle, headers: Record<string, string> = {}): Record<string, string> {
  const cookie = localAdminCookies.get(gateway)
  if (!cookie) throw new Error('Local administrator test session is unavailable')
  return { ...headers, cookie }
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, any>>
}

async function seedCompletedOutput(
  gateway: GatewayHandle,
  overrides: Partial<GenerationRequest> & { clientRequestId: string },
) {
  const asset = await gateway.runtime.assets.save({
    filename: `${overrides.clientRequestId}.png`, contentType: 'image/png', bytes: PNG,
  })
  const { job } = await gateway.runtime.jobs.create(generationRequest(overrides))
  const completed = await gateway.runtime.jobs.update(job.id, {
    status: 'complete', progress: 100,
    outputs: [{ assetId: asset.id, url: asset.url, contentType: asset.contentType, size: asset.size }],
  })
  return { asset, job: completed }
}

function requestWithHost(
  origin: string,
  path: string,
  host: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  const url = new URL(path, origin)
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = options.body ?? ''
    const request = nodeRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: options.method,
      headers: {
        host,
        ...options.headers,
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    })
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

function startDeclaredOversizeRequest(origin: string, path: string, declaredSize: number, cookie: string) {
  const url = new URL(path, origin)
  return new Promise<{ status: number; socketClosed: boolean }>((resolve, reject) => {
    let status = 0
    let ended = false
    let socketClosed = false
    const request = nodeRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'content-length': String(declaredSize), 'content-type': 'application/octet-stream', cookie },
    }, (response) => {
      status = response.statusCode ?? 0
      response.resume()
      response.on('end', () => {
        ended = true
        if (socketClosed) resolve({ status, socketClosed })
      })
    })
    request.on('socket', (socket) => socket.on('close', () => {
      socketClosed = true
      if (ended) resolve({ status, socketClosed })
    }))
    request.on('error', (error) => {
      if (!socketClosed) reject(error)
    })
    request.flushHeaders()
    request.write('x')
    setTimeout(() => {
      if (!socketClosed) {
        request.destroy()
        reject(new Error('Server did not cancel the oversized request'))
      }
    }, 1_000).unref()
  })
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
})

describe('HTTP gateway', () => {
  it('reassigns only the requested canvas history and keeps the operation idempotent', async () => {
    const gateway = await start()
    for (const [clientRequestId, canvasId] of [
      ['client-canvas-a', 'canvas-a'],
      ['client-canvas-b', 'canvas-b'],
    ] as const) {
      const seeded = await seedCompletedOutput(gateway, { clientRequestId, canvasId })
      await gateway.runtime.history.recordOutput({ job: seeded.job, outputIndex: 0, asset: seeded.asset })
    }
    const body = {
      operationId: 'move-canvas-a', canvasId: 'canvas-a',
      fromProjectId: 'project-alpha', toProjectId: 'project-beta',
    }
    const post = () => fetch(`${gateway.origin}/api/generation-history/reassign-canvas`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })

    expect(await json(await post())).toEqual({ moved: 1, bound: 0 })
    expect(await json(await post())).toEqual({ moved: 1, bound: 0 })
    expect((await json(await fetch(`${gateway.origin}/api/generation-history?projectId=project-alpha`)))
      .entries.map((entry: { canvasId?: string }) => entry.canvasId)).toEqual(['canvas-b'])
    expect((await json(await fetch(`${gateway.origin}/api/generation-history?projectId=project-beta`)))
      .entries.map((entry: { canvasId?: string }) => entry.canvasId)).toEqual(['canvas-a'])
  })

  it('persists canvas references, reports redacted activity, and safely reclaims only orphaned assets', async () => {
    const gateway = await start()
    const orphan = await gateway.runtime.assets.save({ filename: 'orphan.png', contentType: 'image/png', bytes: PNG })
    const history = await seedCompletedOutput(gateway, {
      clientRequestId: 'client-history-protected', canvasId: 'canvas-cleanup',
    })
    await gateway.runtime.history.recordOutput({ job: history.job, outputIndex: 0, asset: history.asset })
    const taskAsset = await gateway.runtime.assets.save({ filename: 'task.png', contentType: 'image/png', bytes: PNG })
    await gateway.runtime.jobs.create(generationRequest({
      clientRequestId: 'client-active-protected', canvasId: 'canvas-cleanup',
      references: [{ alias: 1, assetId: taskAsset.id, mediaType: 'image' }],
    }))
    const sync = await fetch(`${gateway.origin}/api/canvas-asset-references/canvas-cleanup`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-alpha', assetIds: [orphan.id, history.asset.id, taskAsset.id] }),
    })
    expect(await json(sync)).toEqual({ canvasId: 'canvas-cleanup', assetCount: 3 })

    const activity = await json(await fetch(
      `${gateway.origin}/api/canvas-activity?projectId=project-alpha&canvasId=canvas-cleanup`,
    ))
    expect(activity).toEqual({ active: true, jobs: [expect.objectContaining({ status: 'queued' })] })
    expect(JSON.stringify(activity)).not.toContain('prompt')

    const blocked = await fetch(
      `${gateway.origin}/api/canvas-asset-references/canvas-cleanup?projectId=project-alpha`,
      { method: 'DELETE' },
    )
    expect(blocked.status).toBe(409)

    await gateway.runtime.jobs.update(activity.jobs[0].id, { status: 'failed' })
    const released = await json(await fetch(
      `${gateway.origin}/api/canvas-asset-references/canvas-cleanup?projectId=project-alpha`,
      { method: 'DELETE' },
    ))
    expect(released).toEqual({ canvasId: 'canvas-cleanup', deletedAssetIds: [orphan.id] })
    expect(gateway.runtime.assets.get(orphan.id)).toBeUndefined()
    expect(gateway.runtime.assets.get(history.asset.id)).toBeDefined()
    expect(gateway.runtime.assets.get(taskAsset.id)).toBeDefined()
  })

  it('accepts URL-encoded migrated canvas ids for asset reference sync', async () => {
    const gateway = await start()
    const canvasId = 'legacy-canvas:project-alpha:1'
    const response = await fetch(
      `${gateway.origin}/api/canvas-asset-references/${encodeURIComponent(canvasId)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'project-alpha', assetIds: [] }),
      },
    )

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ canvasId, assetCount: 0 })
  })

  it('requires projectId on new generation job submissions', async () => {
    const gateway = await start()
    await fetch(`${gateway.origin}/api/providers/aistartlab/sync`, { method: 'POST', headers: adminHeaders(gateway) })

    const response = await fetch(`${gateway.origin}/api/generation-jobs`, {
      method: 'POST',
      headers: adminHeaders(gateway, { 'content-type': 'application/json' }),
      body: JSON.stringify((({ projectId: _projectId, ...request }) => request)(generationRequest())),
    })

    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({
      error: { code: 'invalid_input', message: 'Request could not be accepted' },
    })
  })

  it('rejects generation when explicit local administrator authorization is omitted', async () => {
    const gateway = await start()
    const response = await fetch(`${gateway.origin}/api/generation-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(generationRequest()),
    })
    expect(response.status).toBe(403)
  })

  it('registers one local browser, rejects a second, and restores the cookie after restart', async () => {
    const dataDir = await tempDirectory()
    const firstGateway = await start({ dataDir }, false)
    const first = await fetch(`${firstGateway.origin}/api/local-admin/session`, { method: 'POST' })
    const adminCookie = first.headers.get('set-cookie')?.split(';', 1)[0]
    expect(first.status).toBe(200)
    expect(adminCookie).toBeTruthy()
    expect(first.headers.get('set-cookie')).toContain('HttpOnly')
    expect(first.headers.get('set-cookie')).toContain('SameSite=Strict')
    expect(first.headers.get('set-cookie')).toContain('Path=/')
    expect((await fetch(`${firstGateway.origin}/api/local-admin/session`, { method: 'POST' })).status).toBe(403)
    expect((await fetch(`${firstGateway.origin}/api/providers/aistartlab/test`, {
      method: 'POST', headers: { 'x-local-admin-mode': '1' },
    })).status).toBe(403)
    const metadata = await readFile(join(dataDir, 'local-admin.json'), 'utf8')
    expect(metadata).not.toContain(String(adminCookie).split('=', 2)[1])

    await firstGateway.close()
    handles.splice(handles.indexOf(firstGateway), 1)
    const restarted = await start({ dataDir }, false)
    const resumed = await fetch(`${restarted.origin}/api/local-admin/session`, {
      method: 'POST', headers: { cookie: adminCookie as string },
    })
    expect(resumed.status).toBe(200)
    expect(await json(resumed)).toEqual({ ok: true, created: false })
  })

  it('allows exactly one concurrent first local administrator registration', async () => {
    const gateway = await start({}, false)
    const responses = await Promise.all([
      fetch(`${gateway.origin}/api/local-admin/session`, { method: 'POST' }),
      fetch(`${gateway.origin}/api/local-admin/session`, { method: 'POST' }),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
  })

  it('accepts projectId on new generation job submissions', async () => {
    const gateway = await start()
    await fetch(`${gateway.origin}/api/providers/aistartlab/sync`, { method: 'POST', headers: adminHeaders(gateway) })

    const response = await fetch(`${gateway.origin}/api/generation-jobs`, {
      method: 'POST',
      headers: adminHeaders(gateway, { 'content-type': 'application/json' }),
      body: JSON.stringify(generationRequest()),
    })

    expect(response.status).toBe(202)
    expect((await json(response)).job.request.projectId).toBe('project-alpha')
  })

  it('returns an empty project-scoped generation history page', async () => {
    const gateway = await start()

    const response = await fetch(
      `${gateway.origin}/api/generation-history?projectId=project-alpha&limit=20`,
    )

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ entries: [] })
  })

  it('rejects overlong history project IDs at the HTTP boundary', async () => {
    const gateway = await start()
    const projectId = 'p'.repeat(257)

    expect((await fetch(`${gateway.origin}/api/generation-history?projectId=${projectId}`)).status).toBe(400)
    expect((await fetch(`${gateway.origin}/api/generation-history/${'a'.repeat(64)}?projectId=${projectId}`, {
      method: 'DELETE',
    })).status).toBe(400)
  })

  it('backfills completed outputs idempotently and deletes metadata without deleting the asset', async () => {
    const gateway = await start()
    const seeded = await seedCompletedOutput(gateway, { clientRequestId: 'client-history-1' })
    const body = {
      projectId: 'project-alpha',
      entries: [{ jobId: seeded.job.id, outputIndex: 0, assetId: seeded.asset.id }],
    }
    const backfill = () => fetch(`${gateway.origin}/api/generation-history/backfill`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })

    const first = await backfill()
    const second = await backfill()
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstEntry = (await json(first)).entries[0]
    expect((await json(second)).entries[0].id).toBe(firstEntry.id)
    expect((await json(await fetch(
      `${gateway.origin}/api/generation-history?projectId=project-alpha`,
    ))).entries).toHaveLength(1)

    const removed = await fetch(
      `${gateway.origin}/api/generation-history/${firstEntry.id}?projectId=project-alpha`,
      { method: 'DELETE' },
    )
    expect(removed.status).toBe(200)
    expect(await json(removed)).toEqual({ deleted: true })
    expect((await fetch(`${gateway.origin}${seeded.asset.url}`)).status).toBe(200)
    expect((await json(await fetch(
      `${gateway.origin}/api/generation-history?projectId=project-alpha`,
    ))).entries).toEqual([])
  })

  it('keeps the data lock until an in-flight history backfill write settles', async () => {
    const dataDir = await tempDirectory()
    const gateway = await start({ dataDir })
    const seeded = await seedCompletedOutput(gateway, { clientRequestId: 'client-history-close' })
    let releaseWrite!: () => void
    let markStarted!: () => void
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const original = gateway.runtime.history.recordOutputs.bind(gateway.runtime.history)
    vi.spyOn(gateway.runtime.history, 'recordOutputs').mockImplementation(async (entries) => {
      markStarted()
      await writeGate
      return original(entries)
    })
    const backfill = fetch(`${gateway.origin}/api/generation-history/backfill`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-alpha',
        entries: [{ jobId: seeded.job.id, outputIndex: 0, assetId: seeded.asset.id }],
      }),
    })
    await started

    handles.splice(handles.indexOf(gateway), 1)
    const closing = gateway.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(DataDirectoryLock.acquire({ dataDir, token: () => 'premature-owner' }))
      .rejects.toMatchObject({ code: 'data_directory_locked' })

    releaseWrite()
    expect((await backfill).status).toBe(200)
    await closing
    const nextOwner = await DataDirectoryLock.acquire({ dataDir, token: () => 'next-owner' })
    await nextOwner.release()
  })

  it('quarantines corrupt generation history without preventing gateway startup', async () => {
    const dataDir = await tempDirectory()
    await writeFile(join(dataDir, 'generation-history.json'), '{not-json')

    const gateway = await start({ dataDir })

    expect((await fetch(`${gateway.origin}/api/health`)).status).toBe(200)
    expect(gateway.runtime.history.list({ projectId: 'project-alpha', limit: 20 }).entries).toEqual([])
    expect((await readdir(dataDir)).some((name) => name.startsWith('generation-history.json.corrupt.'))).toBe(true)
  })

  it('strictly validates backfill jobs, project ownership, output indexes and local assets', async () => {
    const gateway = await start()
    const completed = await seedCompletedOutput(gateway, { clientRequestId: 'client-history-valid' })
    const { job: queued } = await gateway.runtime.jobs.create(generationRequest({
      clientRequestId: 'client-history-queued',
    }))
    const post = (body: unknown) => fetch(`${gateway.origin}/api/generation-history/backfill`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })

    expect((await post({
      projectId: 'project-alpha',
      entries: [{ jobId: queued.id, outputIndex: 0, assetId: completed.asset.id }],
    })).status).toBe(400)
    expect((await post({
      projectId: 'project-beta',
      entries: [{ jobId: completed.job.id, outputIndex: 0, assetId: completed.asset.id }],
    })).status).toBe(409)
    expect((await post({
      projectId: 'project-alpha',
      entries: [{ jobId: completed.job.id, outputIndex: 1, assetId: completed.asset.id }],
    })).status).toBe(400)
    expect((await post({
      projectId: 'project-alpha',
      entries: [{ jobId: completed.job.id, outputIndex: 0, assetId: '99999999-9999-4999-8999-999999999999' }],
    })).status).toBe(404)
    expect(gateway.runtime.history.list({ projectId: 'project-alpha', limit: 20 }).entries).toEqual([])
  })

  it('serves stable HTTP pagination, media filters and rejects invalid or cross-filter cursors', async () => {
    const gateway = await start()
    const first = await seedCompletedOutput(gateway, { clientRequestId: 'client-page-1' })
    const second = await seedCompletedOutput(gateway, {
      clientRequestId: 'client-page-2', mediaType: 'video', duration: 6, mode: 'image2video',
    })
    await gateway.runtime.history.recordOutput({
      job: first.job, outputIndex: 0, asset: first.asset, completedAt: '2026-07-17T02:00:00.000Z',
    })
    await gateway.runtime.history.recordOutput({
      job: second.job, outputIndex: 0, asset: second.asset, completedAt: '2026-07-17T01:00:00.000Z',
    })

    const firstPage = await json(await fetch(
      `${gateway.origin}/api/generation-history?projectId=project-alpha&limit=1`,
    ))
    expect(firstPage.entries.map((entry: { jobId: string }) => entry.jobId)).toEqual([first.job.id])
    expect(firstPage.nextCursor).toEqual(expect.any(String))
    const secondPage = await json(await fetch(
      `${gateway.origin}/api/generation-history?projectId=project-alpha&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    ))
    expect(secondPage.entries.map((entry: { jobId: string }) => entry.jobId)).toEqual([second.job.id])
    const videos = await json(await fetch(
      `${gateway.origin}/api/generation-history?projectId=project-alpha&mediaType=video`,
    ))
    expect(videos.entries.map((entry: { jobId: string }) => entry.jobId)).toEqual([second.job.id])
    expect((await fetch(
      `${gateway.origin}/api/generation-history?projectId=project-alpha&cursor=broken`,
    )).status).toBe(400)
    expect((await fetch(
      `${gateway.origin}/api/generation-history?projectId=project-alpha&mediaType=image&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    )).status).toBe(400)
  })

  it('registers a completed legacy job only through explicit project backfill', async () => {
    const dataDir = await tempDirectory()
    const assets = await AssetStore.open({ dataDir })
    const asset = await assets.save({ filename: 'legacy.png', contentType: 'image/png', bytes: PNG })
    const legacyRequest = generationRequest({ clientRequestId: 'client-legacy' }) as unknown as Record<string, unknown>
    delete legacyRequest.projectId
    delete legacyRequest.canvasId
    const timestamp = '2026-07-16T00:00:00.000Z'
    await writeFile(join(dataDir, 'jobs.json'), JSON.stringify([{
      id: '11111111-1111-4111-8111-111111111111',
      clientRequestId: legacyRequest.clientRequestId,
      requestDigest: generationRequestDigest(legacyRequest as never),
      request: legacyRequest,
      status: 'complete', progress: 100, createdAt: timestamp, updatedAt: timestamp,
      outputs: [{ assetId: asset.id, url: asset.url, contentType: asset.contentType, size: asset.size }],
      referenceUploads: [],
    }]))
    const gateway = await start({ dataDir })
    expect(gateway.runtime.history.list({ projectId: 'project-alpha', limit: 20 }).entries).toEqual([])

    const response = await fetch(`${gateway.origin}/api/generation-history/backfill`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-alpha',
        entries: [{
          jobId: '11111111-1111-4111-8111-111111111111', outputIndex: 0, assetId: asset.id,
        }],
      }),
    })

    expect(response.status).toBe(200)
    expect((await json(response)).entries[0]).toEqual(expect.objectContaining({
      projectId: 'project-alpha', jobId: '11111111-1111-4111-8111-111111111111',
    }))
  })

  it('serves health only to local Host values and does not emit permissive CORS', async () => {
    const gateway = await start()
    const response = await fetch(`${gateway.origin}/api/health`)
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await json(response)).toEqual(expect.objectContaining({ ok: true }))

    const rejected = await requestWithHost(gateway.origin, '/api/health', 'attacker.example')
    expect(rejected.status).toBe(400)
    expect(rejected.body).not.toContain('attacker.example')
  })

  it('allows absent or exact local origins and rejects hostile browser origins on mutations', async () => {
    const testConnection = vi.fn(async () => {})
    const gateway = await start({ adapterFactory: () => adapter({ testConnection }) })

    const hostile = await fetch(`${gateway.origin}/api/providers/aistartlab/test`, {
      method: 'POST', headers: { origin: 'https://attacker.example' },
    })
    expect(hostile.status).toBe(403)
    expect(testConnection).not.toHaveBeenCalled()

    const sameOrigin = await fetch(`${gateway.origin}/api/providers/aistartlab/test`, {
      method: 'POST', headers: adminHeaders(gateway, { origin: gateway.origin }),
    })
    expect(sameOrigin.status).toBe(200)
    const viteOrigin = await fetch(`${gateway.origin}/api/providers/aistartlab/test`, {
      method: 'POST', headers: adminHeaders(gateway, { origin: 'http://127.0.0.1:4173' }),
    })
    expect(viteOrigin.status).toBe(200)
    expect(testConnection).toHaveBeenCalledTimes(2)
    expect(sameOrigin.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('rejects bodies on no-body POST routes and cancels declared oversized bodies', async () => {
    const testConnection = vi.fn(async () => {})
    const syncCatalog = vi.fn(async () => catalog)
    const gateway = await start({ adapterFactory: () => adapter({ testConnection, syncCatalog }) })

    const testWithBody = await fetch(`${gateway.origin}/api/providers/aistartlab/test`, {
      method: 'POST', headers: adminHeaders(gateway, { 'content-type': 'application/json' }), body: '{}',
    })
    const syncWithBody = await fetch(`${gateway.origin}/api/providers/aistartlab/sync`, {
      method: 'POST', headers: adminHeaders(gateway, { 'content-type': 'application/json' }), body: '{}',
    })
    expect(testWithBody.status).toBe(400)
    expect(syncWithBody.status).toBe(400)
    expect(testConnection).not.toHaveBeenCalled()
    expect(syncCatalog).not.toHaveBeenCalled()

    await expect(startDeclaredOversizeRequest(
      gateway.origin, '/api/providers/aistartlab/test', 2 * 1024 * 1024,
      adminHeaders(gateway).cookie,
    )).resolves.toEqual({ status: 413, socketClosed: true })
  })

  it('strictly updates providers and replaces then clears secrets without disclosure', async () => {
    const gateway = await start()
    const initial = await json(await fetch(`${gateway.origin}/api/providers`))
    expect(JSON.stringify(initial)).not.toContain('initial-secret-123456')
    expect(initial.providers[0]).toEqual(expect.objectContaining({
      id: 'aistartlab', secretConfigured: true, maskedSecret: expect.any(String),
    }))

    const invalid = await fetch(`${gateway.origin}/api/providers/aistartlab`, {
      method: 'PUT', headers: adminHeaders(gateway, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'AIStartLab', adapterType: 'aistartlab-openapi', baseUrl: 'https://api.example', enabled: true, preferred: true, apiKey: 'leak' }),
    })
    expect(invalid.status).toBe(400)

    const replaced = await fetch(`${gateway.origin}/api/providers/aistartlab/secret`, {
      method: 'PUT', headers: adminHeaders(gateway, { 'content-type': 'application/json' }),
      body: JSON.stringify({ apiKey: 'replacement-secret-9876' }),
    })
    expect(replaced.status).toBe(200)
    expect(JSON.stringify(await json(replaced))).not.toContain('replacement-secret-9876')

    const revealed = await fetch(`${gateway.origin}/api/providers/aistartlab/secret`, {
      method: 'GET', headers: adminHeaders(gateway),
    })
    expect(revealed.status).toBe(200)
    expect(await json(revealed)).toEqual({ apiKey: 'replacement-secret-9876' })

    const cleared = await fetch(`${gateway.origin}/api/providers/aistartlab/secret`, { method: 'DELETE', headers: adminHeaders(gateway) })
    expect(cleared.status).toBe(200)
    expect(await json(cleared)).toEqual(expect.objectContaining({ secretConfigured: false }))
  })

  it('accepts a valid imageRequestMode on provider updates', async () => {
    const gateway = await start()
    const updated = await fetch(`${gateway.origin}/api/providers/openai`, {
      method: 'PUT', headers: adminHeaders(gateway, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        name: 'OpenAI 官方', adapterType: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1', enabled: true, preferred: false,
        imageRequestMode: 'openai-json',
      }),
    })
    expect(updated.status).toBe(200)
    expect(await json(updated)).toEqual({
      provider: expect.objectContaining({ imageRequestMode: 'openai-json' }),
    })
  })

  it('rejects an invalid imageRequestMode on provider updates', async () => {
    const gateway = await start()
    const invalid = await fetch(`${gateway.origin}/api/providers/openai`, {
      method: 'PUT', headers: adminHeaders(gateway, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        name: 'OpenAI 官方', adapterType: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1', enabled: true, preferred: false,
        imageRequestMode: 'bogus',
      }),
    })
    expect(invalid.status).toBe(400)
  })

  it('tests adapters, persists synced catalogs, and returns cached capability data', async () => {
    const testConnection = vi.fn(async () => {})
    const syncCatalog = vi.fn(async () => catalog)
    const gateway = await start({ adapterFactory: () => adapter({ testConnection, syncCatalog }) })

    expect((await fetch(`${gateway.origin}/api/providers/aistartlab/test`, { method: 'POST', headers: adminHeaders(gateway) })).status).toBe(200)
    const synced = await json(await fetch(`${gateway.origin}/api/providers/aistartlab/sync`, { method: 'POST', headers: adminHeaders(gateway) }))
    expect(synced.catalog).toEqual(expect.objectContaining({ version: 'catalog-v1', stale: false }))

    const cached = await json(await fetch(`${gateway.origin}/api/catalog?providerId=aistartlab`))
    expect(cached.catalog.models).toHaveLength(1)
    expect(testConnection).toHaveBeenCalledTimes(1)
    expect(syncCatalog).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(join(gateway.dataDir, 'catalog-cache.json'), 'utf8')).aistartlab.version).toBe('catalog-v1')
  })

  it('stores raw assets and serves GET, HEAD, 206 and 416 responses', async () => {
    const gateway = await start()
    const saveStream = vi.spyOn(gateway.runtime.assets, 'saveStream')
    const uploaded = await fetch(`${gateway.origin}/api/assets`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': 'reference.png' },
      body: PNG,
    })
    expect(uploaded.status).toBe(201)
    expect(saveStream).toHaveBeenCalledWith(expect.objectContaining({
      stream: expect.anything(), signal: expect.any(AbortSignal),
    }))
    const { asset } = await json(uploaded)
    expect(asset).toEqual(expect.objectContaining({ filename: 'reference.png', size: PNG.length }))

    const head = await fetch(`${gateway.origin}${asset.url}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('image/png')
    expect(head.headers.get('content-length')).toBe(String(PNG.length))
    expect(await head.text()).toBe('')

    const range = await fetch(`${gateway.origin}${asset.url}`, { headers: { range: 'bytes=2-5' } })
    expect(range.status).toBe(206)
    expect(range.headers.get('content-range')).toBe(`bytes 2-5/${PNG.length}`)
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(PNG.slice(2, 6))

    const unsatisfiable = await fetch(`${gateway.origin}${asset.url}`, { headers: { range: 'bytes=999-1000' } })
    expect(unsatisfiable.status).toBe(416)
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${PNG.length}`)
  })

  it('rejects private imports and revalidates every redirect before pinned fetching', async () => {
    const lookup = vi.fn(async (hostname: string) => [{
      address: hostname === 'first.public.test' ? '93.184.216.34' : '10.0.0.9', family: 4,
    }])
    const pinnedFetcher = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: 'https://private.test/asset.png' },
    }))
    const gateway = await start({ lookup, pinnedFetcher })

    const loopback = await fetch(`${gateway.origin}/api/assets/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/reference.png' }),
    })
    expect(loopback.status).toBe(400)

    const redirected = await fetch(`${gateway.origin}/api/assets/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://first.public.test/reference.png', filename: 'chosen.png' }),
    })
    expect(redirected.status).toBe(400)
    expect(pinnedFetcher).toHaveBeenCalledTimes(1)
    expect(pinnedFetcher.mock.calls[0][2]).toBe('93.184.216.34')
    expect(lookup).toHaveBeenCalledWith('private.test', expect.any(AbortSignal))
  })

  it('uses the optional public filename when a remote import succeeds', async () => {
    const gateway = await start({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
      }),
    })

    const response = await fetch(`${gateway.origin}/api/assets/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://media.public.test/source.png', filename: 'chosen-name.png' }),
    })

    expect(response.status).toBe(201)
    expect((await json(response)).asset.filename).toBe('chosen-name.png')
  })

  it('aborts a hanging standalone import before waiting for HTTP connections to close', async () => {
    let observedSignal: AbortSignal | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const pinnedFetcher = vi.fn((_url, init: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init.signal
      markStarted()
      const safety = setTimeout(() => reject(new Error('test safety timeout')), 1_500)
      init.signal?.addEventListener('abort', () => {
        clearTimeout(safety)
        reject(init.signal?.reason)
      }, { once: true })
    }))
    const dataDir = await tempDirectory()
    const gateway = await start({
      dataDir,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: pinnedFetcher as never,
    })
    const importing = fetch(`${gateway.origin}/api/assets/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://media.public.test/hanging.png' }),
    }).catch((error: unknown) => error)
    await started

    const closeStartedAt = Date.now()
    await gateway.close()
    const closeDuration = Date.now() - closeStartedAt
    handles.splice(handles.indexOf(gateway), 1)

    expect(closeDuration).toBeLessThan(800)
    expect(observedSignal?.aborted).toBe(true)
    await importing
    const lock = await DataDirectoryLock.acquire({ dataDir })
    await lock.release()
  })

  it('tracks an abort-ignoring asset import until it settles before releasing the data lock', async () => {
    let releaseImport!: () => void
    let markStarted!: () => void
    const importGate = new Promise<void>((resolve) => { releaseImport = resolve })
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const dataDir = await tempDirectory()
    const gateway = await start({
      dataDir,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => {
        markStarted()
        await importGate
        return new Response(PNG, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
        })
      },
    })
    const importing = fetch(`${gateway.origin}/api/assets/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://media.public.test/slow.png' }),
    }).catch((error: unknown) => error)
    await started

    const closing = gateway.close()
    handles.splice(handles.indexOf(gateway), 1)
    const closedBeforeImportSettled = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ])
    let lockWasHeld = false
    let prematureOwner: Awaited<ReturnType<typeof DataDirectoryLock.acquire>> | undefined
    try {
      prematureOwner = await DataDirectoryLock.acquire({ dataDir, token: () => 'premature-import-owner' })
    } catch (error) {
      lockWasHeld = (error as { code?: string }).code === 'data_directory_locked'
    } finally {
      await prematureOwner?.release()
    }

    releaseImport()
    await importing
    await closing

    expect(closedBeforeImportSettled).toBe(false)
    expect(lockWasHeld).toBe(true)
    const nextOwner = await DataDirectoryLock.acquire({ dataDir, token: () => 'after-import-owner' })
    await nextOwner.release()
  })

  it('destroys an asset read stream when the client aborts the response', async () => {
    const gateway = await start()
    const uploaded = await fetch(`${gateway.origin}/api/assets`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-filename': 'abort.png' },
      body: PNG,
    })
    const { asset } = await json(uploaded)
    let destroyedAfterClientAbort = false
    let sent = false
    const source = new Readable({
      read() {
        if (!sent) {
          sent = true
          this.push(Buffer.alloc(64, 1))
        }
      },
      destroy(error, callback) {
        destroyedAfterClientAbort = true
        callback(error)
      },
    })
    vi.spyOn(gateway.runtime.assets, 'openResponse').mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '1048576', 'accept-ranges': 'bytes' },
      stream: source,
    })
    const url = new URL(`${gateway.origin}${asset.url}`)

    await new Promise<void>((resolve, reject) => {
      const request = nodeRequest(url, (response) => {
        response.once('data', () => {
          response.destroy()
          resolve()
        })
        response.on('error', () => {})
      })
      request.once('error', reject)
      request.end()
    })

    await vi.waitFor(() => expect(destroyedAfterClientAbort).toBe(true))
  })

  it('maps a failed remote asset response to a sanitized 502', async () => {
    const gateway = await start({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => new Response('upstream details', { status: 503 }),
    })
    const response = await fetch(`${gateway.origin}/api/assets/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://media.public.test/source.png' }),
    })

    expect(response.status).toBe(502)
    expect(await json(response)).toEqual({
      error: { code: 'upstream_error', message: 'Upstream operation failed' },
    })
  })

  it('maps invalid remote media to a diagnostic response without exposing its URL', async () => {
    const sourceUrl = 'https://media.public.test/private-reference.png?token=source-secret'
    const gateway = await start({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => new Response('plain text, not image bytes', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    })
    const response = await fetch(`${gateway.origin}/api/assets/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: sourceUrl }),
    })
    const payload = await json(response)

    expect(response.status).toBe(400)
    expect(payload).toEqual({
      error: {
        code: 'invalid_remote_asset',
        message: 'Remote asset content does not match a supported media type',
      },
    })
    expect(JSON.stringify(payload)).not.toContain(sourceUrl)
    expect(JSON.stringify(payload)).not.toContain('source-secret')
  })

  it('maps a remote asset download timeout to a sanitized diagnostic 504', async () => {
    const sourceUrl = 'https://media.public.test/private-reference.png?token=source-secret'
    const reason = new DOMException(`Timed out downloading ${sourceUrl}`, 'TimeoutError')
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(reason))
    try {
      const gateway = await start({
        assetImportTimeoutMs: 45_000,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        pinnedFetcher: async () => { throw new Error('fetch should observe the aborted signal') },
      })
      const response = await fetch(`${gateway.origin}/api/assets/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: sourceUrl }),
      })
      const payload = await json(response)

      expect(timeout).toHaveBeenCalledWith(45_000)
      expect(response.status).toBe(504)
      expect(payload).toEqual({
        error: {
          code: 'asset_import_timeout',
          message: 'Remote asset import timed out',
        },
      })
      expect(JSON.stringify(payload)).not.toContain(sourceUrl)
      expect(JSON.stringify(payload)).not.toContain('source-secret')
    } finally {
      timeout.mockRestore()
    }
  })

  it('single-flights idempotent jobs and reports conflicting payloads as 409', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const createGeneration = vi.fn(async () => { await gate; return 'task-1' })
    const gateway = await start({ adapterFactory: () => adapter({ createGeneration }) })
    await fetch(`${gateway.origin}/api/providers/aistartlab/sync`, { method: 'POST', headers: adminHeaders(gateway) })

    const submit = (body: GenerationRequest) => fetch(`${gateway.origin}/api/generation-jobs`, {
      method: 'POST', headers: adminHeaders(gateway, { 'content-type': 'application/json' }), body: JSON.stringify(body),
    })
    const first = submit(generationRequest())
    const second = submit(generationRequest())
    await vi.waitFor(() => expect(createGeneration).toHaveBeenCalledTimes(1))
    release()
    const [firstResponse, secondResponse] = await Promise.all([first, second])
    expect(firstResponse.status).toBe(202)
    expect(secondResponse.status).toBe(202)
    const jobId = (await json(firstResponse)).job.id
    expect(jobId).toBe((await json(secondResponse)).job.id)
    const fetched = await json(await fetch(`${gateway.origin}/api/generation-jobs/${jobId}`))
    expect(fetched.job).toEqual(expect.objectContaining({ id: jobId, upstreamTaskId: 'task-1' }))

    const conflict = await submit(generationRequest({ prompt: 'Different prompt' }))
    expect(conflict.status).toBe(409)
    expect(await json(conflict)).toEqual({ error: { code: 'idempotency_conflict', message: expect.any(String) } })
  })

  it('maps invalid, upstream, timeout and oversized failures without raw error data', async () => {
    const raw = 'Bearer upstream-secret https://private.example/path'
    const gateway = await start({
      rawBodyLimit: 8,
      adapterFactory: () => adapter({ testConnection: async () => { throw new Error(raw) } }),
    })

    const invalid = await fetch(`${gateway.origin}/api/providers/aistartlab`, {
      method: 'PUT', headers: adminHeaders(gateway, { 'content-type': 'application/json' }), body: '{broken',
    })
    expect(invalid.status).toBe(400)

    const upstream = await fetch(`${gateway.origin}/api/providers/aistartlab/test`, { method: 'POST', headers: adminHeaders(gateway) })
    expect(upstream.status).toBe(502)
    expect(JSON.stringify(await json(upstream))).not.toContain(raw)

    const tooLarge = await fetch(`${gateway.origin}/api/assets`, {
      method: 'POST', headers: { 'content-type': 'image/png', 'x-filename': 'large.png' }, body: PNG,
    })
    expect(tooLarge.status).toBe(413)
  })

  it('maps an upstream timeout to a controlled 504 response', async () => {
    const gateway = await start({
      adapterFactory: () => adapter({ testConnection: async () => { throw new Error('Provider request timed out') } }),
    })
    const response = await fetch(`${gateway.origin}/api/providers/aistartlab/test`, { method: 'POST', headers: adminHeaders(gateway) })
    expect(response.status).toBe(504)
    expect(await json(response)).toEqual({
      error: { code: 'upstream_timeout', message: 'Provider operation timed out' },
    })
  })

  it('supports deleting a provider and its configured secret', async () => {
    const gateway = await start()
    const deleteRes = await fetch(`${gateway.origin}/api/providers/openai`, {
      method: 'DELETE',
      headers: adminHeaders(gateway),
    })
    expect(deleteRes.status).toBe(200)
    expect(await json(deleteRes)).toEqual({ ok: true })

    const listRes = await fetch(`${gateway.origin}/api/providers`)
    const { providers } = await json(listRes)
    expect(providers.some((p: { id: string }) => p.id === 'openai')).toBe(false)
  })

  it('releases the data lock on shutdown and serves SPA fallback only outside /api', async () => {
    const dataDir = await tempDirectory()
    const distDir = join(dataDir, 'dist')
    await mkdir(join(distDir, 'assets'), { recursive: true })
    await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Canvas shell</title>')
    await writeFile(join(distDir, 'assets', 'app.js'), 'console.log("app")')
    const gateway = await start({ dataDir, distDir })

    const spa = await fetch(`${gateway.origin}/canvas?spaceId=local`)
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('Canvas shell')
    expect((await fetch(`${gateway.origin}/api/missing`)).status).toBe(404)
    for (const path of ['/api', '/api/', '/api%2Fhealth', '/api%5Chealth', '/%61pi']) {
      const reserved = await fetch(`${gateway.origin}${path}`)
      expect([400, 404]).toContain(reserved.status)
      expect(reserved.headers.get('content-type')).toContain('application/json')
      expect(await reserved.text()).not.toContain('Canvas shell')
    }

    await gateway.close()
    handles.splice(handles.indexOf(gateway), 1)
    const lock = await DataDirectoryLock.acquire({ dataDir })
    await lock.release()
  })

  it.each([
    ['0.0.0.0', 'http://127.0.0.1:4174'],
    ['::', 'http://[::1]:4174'],
    ['127.42.0.9', 'http://127.42.0.9:4174'],
    ['LOCALHOST', 'http://localhost:4174'],
    ['2001:0DB8:0:0:0:0:0:5', 'http://[2001:db8::5]:4174'],
  ])('formats a gateway origin for bind host %s', (host, expected) => {
    expect(gatewayModule.formatGatewayOrigin?.(host, 4174)).toBe(expected)
  })

  it.each([
    ['0.0.0.0', '127.0.0.1'],
    ['127.0.0.2', '127.0.0.2'],
    ['localhost', 'localhost'],
    ['::', '[::1]'],
    ['::1', '[::1]'],
    ['0:0:0:0:0:0:0:1', '[::1]'],
  ])('reports an accessible handle origin for bind host %s', async (host, originHost) => {
    const gateway = await start({
      host,
      ...((host === '0.0.0.0' || host === '::') ? {
        publicOrigin: 'https://canvas.example',
        allowedOrigins: ['https://canvas.example'],
      } : {}),
    })
    const port = new URL(gateway.origin).port

    expect(gateway.origin).toBe(`http://${originHost}:${port}`)
  })

  it('does not accept local-admin mode when the gateway is publicly bound', async () => {
    const gateway = await start({
      host: '0.0.0.0',
      publicOrigin: 'https://canvas.example',
      allowedOrigins: ['https://canvas.example'],
    })
    const response = await fetch(`${gateway.origin}/api/providers/aistartlab/test`, {
      method: 'POST',
      headers: { origin: 'https://canvas.example', 'x-local-admin-mode': '1' },
    })
    expect(response.status).toBe(403)
    const registration = await fetch(`${gateway.origin}/api/local-admin/session`, {
      method: 'POST', headers: { origin: 'https://canvas.example' },
    })
    expect(registration.status).toBe(403)
  })

  it('allows a loopback browser origin to establish local administration on a LAN-bound gateway', async () => {
    const dataDir = await tempDirectory()
    const loopbackOrigin = 'http://127.0.0.1:4173'
    const localGateway = await start({ dataDir }, false)
    expect((await fetch(`${localGateway.origin}/api/local-admin/session`, {
      method: 'POST',
    })).status).toBe(200)
    await localGateway.close()
    handles.splice(handles.indexOf(localGateway), 1)

    const gateway = await start({
      dataDir,
      host: '0.0.0.0',
      publicOrigin: 'http://192.168.1.4:4173',
      allowedOrigins: ['http://192.168.1.4:4173', loopbackOrigin],
      allowInsecureLan: true,
    }, false)

    const registration = await fetch(`${gateway.origin}/api/local-admin/session`, {
      method: 'POST',
      headers: { origin: loopbackOrigin },
    })
    const adminCookie = registration.headers.get('set-cookie')?.split(';', 1)[0]

    expect(registration.status).toBe(200)
    expect(adminCookie).toBeTruthy()
    expect((await fetch(`${gateway.origin}/api/providers/aistartlab/test`, {
      method: 'POST',
      headers: {
        origin: loopbackOrigin,
        cookie: `${adminCookie}; canvas_collaboration_room_stale-room=stale-token`,
      },
    })).status).not.toBe(403)
  })

  it('does not derive a public mutation origin from an attacker-controlled Host header', async () => {
    const gateway = await start({
      host: '0.0.0.0',
      publicOrigin: 'https://canvas.example',
      allowedOrigins: ['https://canvas.example'],
    }, false)
    const response = await requestWithHost(
      gateway.origin,
      '/api/collaboration/sessions',
      'attacker.example',
      {
        method: 'POST',
        headers: { origin: 'http://attacker.example', 'content-type': 'application/json' },
        body: '{}',
      },
    )
    expect(response.status).toBe(403)
  })

  it.each([
    '127.0.0.1',
    '127.42.0.9',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.42.0.9',
    '0:0:0:0:0:ffff:127.42.0.9',
    '::ffff:7f2a:9',
  ])('recognizes loopback address %s', (address) => {
    expect(gatewayModule.isLoopbackRemoteAddress?.(address)).toBe(true)
  })

  it.each([
    '10.0.0.5',
    '126.255.255.255',
    '128.0.0.1',
    '2001:db8::5',
  ])('rejects non-loopback address %s', (address) => {
    expect(gatewayModule.isLoopbackRemoteAddress?.(address)).toBe(false)
  })

  it.each([
    'localhost',
    'LOCALHOST',
    '127.42.0.9',
    '::1',
    '0:0:0:0:0:0:0:1',
  ])('classifies local bind host %s case-insensitively', (host) => {
    expect(gatewayModule.isLoopbackHost?.(host)).toBe(true)
  })

  it('keeps normalized local Host-header protection enabled', async () => {
    const gateway = await start()
    const port = new URL(gateway.origin).port

    for (const host of [
      `LOCALHOST:${port}`,
      `127.42.0.9:${port}`,
      `[0:0:0:0:0:0:0:1]:${port}`,
    ]) {
      await expect(requestWithHost(gateway.origin, '/api/health', host))
        .resolves.toEqual(expect.objectContaining({ status: 200 }))
    }

    await expect(requestWithHost(gateway.origin, '/api/health', `example.test:${port}`))
      .resolves.toEqual(expect.objectContaining({ status: 400 }))
  })

  it('surfaces locked and corrupt startup states as controlled 409-class errors', async () => {
    const lockedDir = await tempDirectory()
    const lock = await DataDirectoryLock.acquire({ dataDir: lockedDir })
    await expect(startGateway({ dataDir: lockedDir, port: 0 })).rejects.toMatchObject({
      status: 409, code: 'locked',
    })
    await lock.release()

    const corruptDir = await tempDirectory()
    await writeFile(join(corruptDir, 'jobs.json'), '{broken')
    await expect(startGateway({ dataDir: corruptDir, port: 0 })).rejects.toMatchObject({
      status: 409, code: 'corruption_recovery',
    })
  })

  it('chooses 4174 for the gateway and 4173 with dist hosting for production', async () => {
    await expect(resolveMainOptions([], {}, 'D:/app')).resolves.toEqual(expect.objectContaining({
      host: '127.0.0.1', port: 4174, distDir: undefined,
    }))
    await expect(resolveMainOptions(['--production'], {}, 'D:/app')).resolves.toEqual(expect.objectContaining({
      host: '127.0.0.1', port: 4173, distDir: join('D:/app', 'dist'),
    }))
  })

  it('serves workspace manifest, commit, and canvas document endpoints', async () => {
    const gateway = await start()

    // 1. GET /api/workspace/manifest
    const manifestRes = await fetch(`${gateway.origin}/api/workspace/manifest`)
    expect(manifestRes.status).toBe(200)
    const { manifest } = await json(manifestRes)
    expect(manifest.version).toBe(1)
    expect(manifest.canvases).toHaveLength(1)

    // 2. PUT /api/canvases/:canvasId
    const canvasPayload = {
      version: 3,
      canvasId: 'default-project',
      projectId: 'default-project',
      name: '画布 1',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'test-node-1',
          type: 'text',
          name: '文本',
          position: { x: 50, y: 50 },
          size: { width: 200, height: 100 },
          data: { text: '服务端保存测试' },
        },
      ],
      edges: [],
    }

    const saveRes = await fetch(`${gateway.origin}/api/canvases/default-project`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(canvasPayload),
    })
    expect(saveRes.status).toBe(200)

    // 3. GET /api/canvases/:canvasId
    const getRes = await fetch(`${gateway.origin}/api/canvases/default-project`)
    expect(getRes.status).toBe(200)
    const { canvas } = await json(getRes)
    expect(canvas.nodes[0]?.data?.text).toBe('服务端保存测试')

    // 4. POST /api/workspace/commit
    manifest.canvases.push({
      canvasId: 'canvas-2',
      projectId: 'default-project',
      name: '第二块画布',
      position: { x: 0, y: 0 },
      nodeCount: 0,
      favorite: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const commitRes = await fetch(`${gateway.origin}/api/workspace/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
    })
    expect(commitRes.status).toBe(200)
    const commitData = await json(commitRes)
    expect(commitData.manifest.canvases).toHaveLength(2)
  })

  it('supports asset listing, protects referenced assets from deletion, and cleans unreferenced assets', async () => {
    const gateway = await start()

    // 1. Upload two assets
    const upload1 = await fetch(`${gateway.origin}/api/assets`, {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-filename': 'used.png',
      },
      body: PNG,
    })
    expect(upload1.status).toBe(201)
    const { asset: asset1 } = await json(upload1)

    const upload2 = await fetch(`${gateway.origin}/api/assets`, {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-filename': 'unused.png',
      },
      body: PNG,
    })
    expect(upload2.status).toBe(201)
    const { asset: asset2 } = await json(upload2)

    // 2. GET /api/assets lists them
    const listRes = await fetch(`${gateway.origin}/api/assets`)
    expect(listRes.status).toBe(200)
    const { assets } = await json(listRes)
    expect(assets.some((a: { id: string }) => a.id === asset1.id)).toBe(true)
    expect(assets.some((a: { id: string }) => a.id === asset2.id)).toBe(true)

    // 3. Put a canvas document referencing asset1
    const putRes = await fetch(`${gateway.origin}/api/canvases/default-project`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 3,
        canvasId: 'default-project',
        projectId: 'default-project',
        name: '测试画布',
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          {
            id: 'node-used',
            name: '图片节点',
            type: 'image',
            position: { x: 0, y: 0 },
            size: { width: 100, height: 100 },
            data: { url: asset1.url, assetId: asset1.id },
          },
        ],
        edges: [],
      }),
    })
    expect(putRes.status).toBe(200)

    // 4. Try DELETE /api/assets/:asset1 -> should fail with 409 Conflict
    const delUsedRes = await fetch(`${gateway.origin}/api/assets/${asset1.id}`, {
      method: 'DELETE',
      headers: adminHeaders(gateway),
    })
    expect(delUsedRes.status).toBe(409)
    const errData = await json(delUsedRes)
    expect(errData.error.message).toContain('无法删除')

    // 5. Try DELETE /api/assets/:asset2 (unreferenced) -> should succeed with 200
    const delUnusedRes = await fetch(`${gateway.origin}/api/assets/${asset2.id}`, {
      method: 'DELETE',
      headers: adminHeaders(gateway),
    })
    expect(delUnusedRes.status).toBe(200)

    // 6. POST /api/assets/clean-unreferenced
    const cleanRes = await fetch(`${gateway.origin}/api/assets/clean-unreferenced`, {
      method: 'POST',
      headers: adminHeaders(gateway),
    })
    expect(cleanRes.status).toBe(200)
    const cleanData = await json(cleanRes)
    expect(cleanData.ok).toBe(true)
  })
})
