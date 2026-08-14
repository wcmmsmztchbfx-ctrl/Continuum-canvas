import { describe, expect, it, vi } from 'vitest'

import type { GenerationRequest } from '../contracts/generation'
import {
  CatalogChangedGatewayError,
  GatewayClient,
  GatewayClientError,
  IdempotencyConflictGatewayError,
  isMissingCatalogError,
} from './gatewayClient'

const generationRequest: GenerationRequest = {
  clientRequestId: 'request-1',
  projectId: 'gateway-project',
  canvasId: 'gateway-canvas',
  providerId: 'aistartlab',
  catalogVersion: 'catalog-v1',
  mediaType: 'image',
  channel: 46,
  model: 'gpt-image-2',
  prompt: 'cinematic portrait',
  quality: '1K',
  aspectRatio: '16:9',
  n: 1,
  references: [],
}

const historyEntry = {
  id: 'a'.repeat(64),
  projectId: 'gateway-project',
  canvasId: 'gateway-canvas',
  jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
  outputIndex: 0,
  mediaType: 'image' as const,
  asset: {
    id: '33333333-3333-4333-8333-333333333333',
    filename: 'portrait.png',
    contentType: 'image/png',
    size: 1024,
    url: '/api/assets/33333333-3333-4333-8333-333333333333',
    createdAt: '2026-07-17T08:00:00.000Z',
  },
  prompt: 'cinematic portrait',
  providerId: 'aistartlab',
  channel: 46,
  model: 'gpt-image-2',
  settings: { quality: '2K', aspectRatio: '9:16', count: 1 },
  references: [{
    alias: 1,
    assetId: '44444444-4444-4444-8444-444444444444',
    mediaType: 'image' as const,
  }],
  completedAt: '2026-07-17T08:01:00.000Z',
}

describe('GatewayClient', () => {
  it('adds the current collaboration room header without persisting a secret', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ providers: [] }))
    const client = new GatewayClient({ fetchImpl })
    client.setCollaborationRoomId('room-a')

    await client.listProviders()

    expect(fetchImpl).toHaveBeenCalledWith('/api/providers', expect.anything())
    const headers = new Headers(fetchImpl.mock.calls[0]![1]?.headers)
    expect(headers.get('x-collaboration-room')).toBe('room-a')
    expect(headers.has('x-local-admin-mode')).toBe(false)
  })

  it('single-flights local administrator session setup for sensitive local operations', async () => {
    const provider = {
      id: 'aistartlab', name: 'AIStartLab', adapterType: 'aistartlab-openapi',
      baseUrl: 'https://api.example', enabled: true, preferred: true,
      secretEnvName: 'API_PROVIDER_AISTARTLAB_KEY', secretConfigured: true,
      available: true, maskedSecret: '****',
    }
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === '/api/local-admin/session') return Response.json({ ok: true, created: true })
      return Response.json({ ok: true, provider })
    })
    const client = new GatewayClient({ fetchImpl })

    await Promise.all([client.testProvider('aistartlab'), client.testProvider('aistartlab')])

    expect(fetchImpl.mock.calls.filter(([input]) => String(input) === '/api/local-admin/session')).toHaveLength(1)
    for (const [, init] of fetchImpl.mock.calls) {
      const headers = new Headers(init?.headers)
      expect(headers.has('x-local-admin-mode')).toBe(false)
      expect(init?.credentials).toBe('same-origin')
    }
  })
  it('reassigns one canvas history with a stable operation id', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        operationId: 'move-1',
        canvasId: 'canvas-a',
        fromProjectId: 'project-a',
        toProjectId: 'project-b',
      })
      return Response.json({ moved: 3, bound: 0 })
    })
    const client = new GatewayClient({ fetchImpl })

    await expect(client.reassignGenerationHistory({
      operationId: 'move-1', canvasId: 'canvas-a',
      fromProjectId: 'project-a', toProjectId: 'project-b',
    })).resolves.toEqual({ moved: 3, bound: 0 })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/generation-history/reassign-canvas',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('syncs canvas asset references and validates the redacted activity response', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ canvasId: 'canvas-a', assetCount: 2 }))
      .mockResolvedValueOnce(Response.json({
        active: true,
        jobs: [{ id: 'job-1', status: 'running', updatedAt: '2026-07-18T00:00:00.000Z' }],
      }))
      .mockResolvedValueOnce(Response.json({
        canvasId: 'canvas-a',
        deletedAssetIds: ['11111111-1111-4111-8111-111111111111'],
      }))
    const client = new GatewayClient({ fetchImpl })

    await expect(client.syncCanvasAssetReferences({
      projectId: 'project-a', canvasId: 'canvas-a',
      assetIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
    })).resolves.toEqual({ canvasId: 'canvas-a', assetCount: 2 })
    await expect(client.getCanvasActivity('project-a', 'canvas-a')).resolves.toEqual({
      active: true,
      jobs: [{ id: 'job-1', status: 'running', updatedAt: '2026-07-18T00:00:00.000Z' }],
    })
    await expect(
      client.releaseCanvasAssetReferences('project-a', 'canvas-a'),
    ).resolves.toEqual({
      canvasId: 'canvas-a',
      deletedAssetIds: ['11111111-1111-4111-8111-111111111111'],
    })
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain('prompt')
  })
  it('lists a validated project history page with encoded filters', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      entries: [{ ...historyEntry, projectId: 'project with spaces' }],
      nextCursor: 'cursor/next+',
    }))
    const client = new GatewayClient({ fetchImpl })

    await expect(client.listGenerationHistory({
      projectId: 'project with spaces',
      mediaType: 'image',
      cursor: 'cursor/previous+',
      limit: 24,
    })).resolves.toEqual({
      entries: [{ ...historyEntry, projectId: 'project with spaces' }],
      nextCursor: 'cursor/next+',
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/generation-history?projectId=project+with+spaces&mediaType=image&cursor=cursor%2Fprevious%2B&limit=24',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('rejects malformed or non-local history entries', async () => {
    const client = new GatewayClient({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({
          entries: [{
            ...historyEntry,
            asset: { ...historyEntry.asset, url: 'https://unsafe.example/output.png' },
          }],
        }))
        .mockResolvedValueOnce(Response.json({
          entries: [{ ...historyEntry, completedAt: 'not-a-date' }],
        })),
    })

    await expect(client.listGenerationHistory({
      projectId: 'gateway-project',
    })).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(client.listGenerationHistory({
      projectId: 'gateway-project',
    })).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('deletes only project-scoped history metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ deleted: true }),
    )
    const client = new GatewayClient({ fetchImpl })

    await expect(client.deleteGenerationHistoryEntry(
      'project/one',
      'b'.repeat(64),
    )).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/generation-history/${'b'.repeat(64)}?projectId=project%2Fone`,
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('posts project-scoped completed outputs to the history backfill endpoint', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        projectId: 'gateway-project',
        entries: [{
          jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
          outputIndex: 0,
          assetId: '33333333-3333-4333-8333-333333333333',
        }],
      })
      return Response.json({ entries: [historyEntry] })
    })
    const client = new GatewayClient({ fetchImpl })

    await expect(client.backfillGenerationHistory({
      projectId: 'gateway-project',
      entries: [{
        jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
        outputIndex: 0,
        assetId: '33333333-3333-4333-8333-333333333333',
      }],
    })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/generation-history/backfill',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('rejects incomplete or mismatched history backfill confirmations', async () => {
    const client = new GatewayClient({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ entries: [] }))
        .mockResolvedValueOnce(Response.json({
          entries: [{ ...historyEntry, outputIndex: 2 }],
        })),
    })
    const input = {
      projectId: 'gateway-project',
      entries: [{
        jobId: historyEntry.jobId,
        outputIndex: 0,
        assetId: historyEntry.asset.id,
      }],
    }

    await expect(client.backfillGenerationHistory(input)).rejects.toMatchObject({
      code: 'invalid_response',
    })
    await expect(client.backfillGenerationHistory(input)).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('classifies only catalog 404 responses as an expected missing catalog', async () => {
    const client = new GatewayClient({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json(
            { error: { code: 'not_found', message: 'Resource not found' } },
            { status: 404 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json(
            { error: { code: 'server_error', message: 'Catalog exploded' } },
            { status: 500 },
          ),
        ),
    })

    const missing = await client
      .getCatalog('aistartlab')
      .catch((error: unknown) => error)
    const failure = await client
      .getCatalog('aistartlab')
      .catch((error: unknown) => error)

    expect(missing).toMatchObject({ status: 404, code: 'not_found' })
    expect(isMissingCatalogError(missing)).toBe(true)
    expect(failure).toMatchObject({ status: 500, code: 'server_error' })
    expect(isMissingCatalogError(failure)).toBe(false)
  })

  it('uploads raw binary assets with metadata headers', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeInstanceOf(Blob)
      expect(new Headers(init?.headers).get('content-type')).toBe('image/png')
      expect(new Headers(init?.headers).get('x-filename')).toBe('portrait.png')
      return Response.json(
        {
          asset: {
            id: '0f2f92f5-b754-46aa-8da7-5f863310a940',
            filename: 'portrait.png',
            contentType: 'image/png',
            size: 8,
            url: '/api/assets/0f2f92f5-b754-46aa-8da7-5f863310a940',
            createdAt: '2026-07-16T00:00:00.000Z',
          },
        },
        { status: 201 },
      )
    })
    const client = new GatewayClient({ fetchImpl })

    const result = await client.uploadAsset(
      new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
        type: 'image/png',
      }),
      'portrait.png',
    )

    expect(result.url).toBe(
      '/api/assets/0f2f92f5-b754-46aa-8da7-5f863310a940',
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/assets',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('maps catalog changes and idempotency conflicts without leaking raw responses', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, created: true }))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'catalog_changed', message: 'Refresh catalog' } },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: 'idempotency_conflict',
              message: 'clientRequestId was reused',
              secret: 'must-not-surface',
            },
          },
          { status: 409 },
        ),
      )
    const client = new GatewayClient({ fetchImpl })

    const catalogError = await client
      .createGenerationJob(generationRequest)
      .catch((error: unknown) => error)
    const idempotencyError = await client
      .createGenerationJob(generationRequest)
      .catch((error: unknown) => error)

    expect(catalogError).toBeInstanceOf(CatalogChangedGatewayError)
    expect(idempotencyError).toMatchObject({
      constructor: IdempotencyConflictGatewayError,
      code: 'idempotency_conflict',
      message: 'clientRequestId was reused',
    })
    expect(JSON.stringify(idempotencyError)).not.toContain('must-not-surface')
  })

  it('returns typed provider, catalog, import, and job envelopes', async () => {
    const provider = {
      id: 'aistartlab',
      name: 'AIStartLab',
      adapterType: 'aistartlab-openapi',
      baseUrl: 'https://api.video.aistarslab.com/openapi',
      enabled: true,
      preferred: true,
      secretEnvName: 'API_PROVIDER_AISTARTLAB_KEY',
      secretConfigured: false,
      available: true,
    }
    const catalog = {
      providerId: 'aistartlab',
      version: 'v1',
      fetchedAt: '2026-07-16T00:00:00.000Z',
      stale: false,
      models: [],
    }
    const asset = {
      id: '0f2f92f5-b754-46aa-8da7-5f863310a940',
      filename: 'remote.png',
      contentType: 'image/png',
      size: 8,
      url: '/api/assets/0f2f92f5-b754-46aa-8da7-5f863310a940',
      createdAt: '2026-07-16T00:00:00.000Z',
    }
    const job = {
      id: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: 'request-1',
      requestDigest: 'digest',
      request: generationRequest,
      status: 'queued' as const,
      progress: 0,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      outputs: [],
    }
    const responses = [
      Response.json({ providers: [provider] }),
      Response.json({ catalog }),
      Response.json({ asset }, { status: 201 }),
      Response.json({ ok: true, created: true }),
      Response.json({ job }, { status: 202 }),
      Response.json({ job }),
    ]
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!)
    const client = new GatewayClient({ fetchImpl })

    await expect(client.listProviders()).resolves.toEqual([provider])
    await expect(client.getCatalog('aistartlab')).resolves.toEqual(catalog)
    await expect(
      client.importAsset('https://assets.example.test/remote.png'),
    ).resolves.toEqual(asset)
    await expect(client.createGenerationJob(generationRequest)).resolves.toEqual(job)
    await expect(client.getGenerationJob(job.id)).resolves.toEqual(job)
  })

  it('accepts an optional imageRequestMode on provider metadata and updates', async () => {
    const metadata = {
      id: 'openai',
      name: 'OpenAI 官方',
      adapterType: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
      preferred: false,
      secretEnvName: 'API_PROVIDER_OPENAI_KEY',
      secretConfigured: true,
      maskedSecret: 'sk-****abcd',
      available: true,
      imageRequestMode: 'openai-json',
    }
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      providers: [metadata],
    }))
    const client = new GatewayClient({ fetchImpl })
    await expect(client.listProviders()).resolves.toEqual([
      expect.objectContaining({ imageRequestMode: 'openai-json' }),
    ])

    const updateImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === '/api/local-admin/session') return Response.json({ ok: true, created: true })
      return Response.json({ provider: metadata })
    })
    const updater = new GatewayClient({ fetchImpl: updateImpl })
    await updater.updateProvider('openai', {
      name: 'OpenAI',
      adapterType: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
      preferred: false,
      imageRequestMode: 'openai-responses',
    })
    expect(updateImpl).toHaveBeenCalledWith(
      '/api/providers/openai',
      expect.objectContaining({ body: expect.stringContaining('openai-responses') }),
    )
  })

  it('rejects malformed success envelopes and non-local asset or output URLs', async () => {
    const invalidJob = {
      id: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: 'request-1',
      requestDigest: 'digest',
      request: generationRequest,
      status: 'surprise',
      progress: 0,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      outputs: [],
    }
    const remoteOutputJob = {
      ...invalidJob,
      status: 'complete',
      progress: 100,
      outputs: [
        {
          assetId: '0f2f92f5-b754-46aa-8da7-5f863310a940',
          url: 'https://unsafe.example/result.png',
          contentType: 'image/png',
          size: 8,
        },
      ],
    }
    const responses = [
      Response.json({ providers: [{ id: 'missing-fields' }] }),
      Response.json({ catalog: { providerId: 'aistartlab', models: 'bad' } }),
      Response.json({
        asset: {
          id: '0f2f92f5-b754-46aa-8da7-5f863310a940',
          filename: 'unsafe.png',
          contentType: 'image/png',
          size: 8,
          url: 'https://unsafe.example/asset.png',
          createdAt: '2026-07-16T00:00:00.000Z',
        },
      }),
      Response.json({ ok: true, created: true }),
      Response.json({ job: invalidJob }),
      Response.json({ job: remoteOutputJob }),
    ]
    const client = new GatewayClient({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockImplementation(async () => responses.shift()!),
    })

    await expect(client.listProviders()).rejects.toMatchObject({
      code: 'invalid_response',
    })
    await expect(client.getCatalog('aistartlab')).rejects.toMatchObject({
      code: 'invalid_response',
    })
    await expect(
      client.importAsset('https://assets.example.test/input.png'),
    ).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(client.createGenerationJob(generationRequest)).rejects.toMatchObject({
      code: 'invalid_response',
    })
    await expect(client.getGenerationJob(invalidJob.id)).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it.each([
    ['expired date', { providerId: 'aistartlab', version: 'v1', fetchedAt: 'bad', stale: false, models: [] }],
    ['pricing enum', {
      providerId: 'aistartlab', version: 'v1', fetchedAt: '2026-07-17T00:00:00.000Z', stale: false,
      models: [{
        mediaType: 'image', channel: 46, model: 'image-model',
        qualityOptions: [{ value: '1K', label: '1K', pricing: { type: 'fixed', credits: 5 } }],
        aspectRatios: ['1:1'], countOptions: [1], durationOptions: [], modes: [],
        inputLimits: { images: 1, videos: 0, audios: 0 }, raw: {},
      }],
    }],
  ])('rejects a catalog with invalid %s', async (_label, catalog) => {
    const client = new GatewayClient({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ catalog })),
    })
    await expect(client.getCatalog('aistartlab')).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('propagates caller aborts and times out stalled requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
          )
        }),
    )
    const client = new GatewayClient({ fetchImpl, timeoutMs: 5 })
    const caller = new AbortController()
    caller.abort(new DOMException('Caller stopped', 'AbortError'))

    await expect(client.listProviders({ signal: caller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    await expect(client.listProviders()).rejects.toBeInstanceOf(GatewayClientError)
    await expect(client.listProviders()).rejects.toMatchObject({ code: 'timeout' })
  })
})
