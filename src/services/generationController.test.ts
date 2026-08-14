import { describe, expect, it, vi } from 'vitest'

import type {
  GenerationJob,
  GenerationRequest,
} from '../contracts/generation'
import type { ProjectSnapshot } from '../model/project'
import { createCanvasStore } from '../store/canvas-store'
import {
  CatalogChangedGatewayError,
  GatewayClientError,
  IdempotencyConflictGatewayError,
  type AssetRecord,
} from './gatewayClient'
import {
  GenerationController,
  GenerationControllerError,
  waitForPollDelay,
  type GenerationGateway,
} from './generationController'

const asset = (
  id: string,
  contentType = 'image/png',
): AssetRecord => ({
  id,
  filename: `${id}.png`,
  contentType,
  size: 8,
  url: `/api/assets/${id}`,
  createdAt: '2026-07-16T00:00:00.000Z',
})

const job = (
  request: GenerationRequest,
  status: GenerationJob['status'],
  overrides: Partial<GenerationJob> = {},
): GenerationJob => ({
  id: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
  clientRequestId: request.clientRequestId,
  requestDigest: 'digest',
  request,
  status,
  progress: status === 'complete' ? 100 : 20,
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:01.000Z',
  outputs: [],
  ...overrides,
})

const snapshot = (): ProjectSnapshot => ({
  version: 1,
  projectId: 'generation-controller',
  name: 'Generation controller',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    {
      id: 'reference-data',
      type: 'image',
      name: 'Data reference',
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      data: {
        url: 'data:image/png;base64,iVBORw0KGgo=',
      },
    },
    {
      id: 'reference-remote',
      type: 'image',
      name: 'Remote reference',
      position: { x: 120, y: 0 },
      size: { width: 100, height: 100 },
      data: { url: 'https://assets.example.test/courtyard.png' },
    },
    {
      id: 'target',
      type: 'video',
      name: 'Target',
      position: { x: 240, y: 0 },
      size: { width: 160, height: 90 },
      data: {
        url: '',
        generationSettings: {
          kind: 'video',
          providerId: 'aistartlab',
          catalogVersion: 'catalog-v1',
          channel: 27,
          model: 'grok-1.0',
          mode: 'image2video',
          resolution: '720p',
          aspectRatio: '16:9',
          durationSec: 6,
          generateAudio: false,
          count: 1,
        },
      },
    },
  ],
  edges: [
    {
      id: 'reference-2',
      source: 'reference-remote',
      target: 'target',
      relation: 'reference',
      referenceAlias: 2,
    },
    {
      id: 'reference-1',
      source: 'reference-data',
      target: 'target',
      relation: 'reference',
      referenceAlias: 1,
    },
  ],
})

const persistNoop = async (_project: ProjectSnapshot) => {}

function gateway(overrides: Partial<GenerationGateway> = {}): GenerationGateway {
  return {
    uploadAsset: vi.fn(async () =>
      asset('11111111-1111-4111-8111-111111111111'),
    ),
    importAsset: vi.fn(async () =>
      asset('22222222-2222-4222-8222-222222222222'),
    ),
    createGenerationJob: vi.fn(async (request) => job(request, 'queued')),
    getGenerationJob: vi.fn(async () => {
      throw new Error('No job response configured')
    }),
    ...overrides,
  }
}

function persistedJobSnapshot(): ProjectSnapshot {
  const persisted = snapshot()
  persisted.edges = []
  const target = persisted.nodes.find((node) => node.id === 'target')!
  if (target.type !== 'video') throw new Error('Expected video')
  target.data.generation = {
    prompt: generationRequestForResume.prompt,
    status: 'generating',
    phase: 'running',
    sourceNodeId: target.id,
    jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
    clientRequestId: generationRequestForResume.clientRequestId,
    pendingRequest: {
      projectId: persisted.projectId,
      sourceNodeId: target.id,
      outputs: [{ nodeId: target.id, outputIndex: 0 }],
      request: structuredClone(generationRequestForResume),
    },
  }
  return persisted
}

const sensitiveExternalMessage =
  'failed at https://cdn.example.test/output.png?X-Amz-Signature=signed-secret&token=url-token ' +
  'apiKey=plain-api-key Bearer bearer-token C:\\Users\\Admin\\secret.txt /home/user/secret.json'

function expectSanitizedMessage(message: string | undefined): void {
  expect(message).toContain('https://cdn.example.test/output.png')
  expect(message).not.toContain('X-Amz-Signature')
  expect(message).not.toContain('signed-secret')
  expect(message).not.toContain('url-token')
  expect(message).not.toContain('plain-api-key')
  expect(message).not.toContain('bearer-token')
  expect(message).not.toContain('C:\\Users\\Admin')
  expect(message).not.toContain('/home/user')
}

describe('GenerationController', () => {
  it('freezes project, 9:16, and 2K settings into the paid request and completed node', async () => {
    const simple = snapshot()
    simple.edges = []
    const store = createCanvasStore(simple)
    let submitted: GenerationRequest | undefined
    const output = asset('33333333-3333-4333-8333-333333333333', 'video/mp4')
    const api = gateway({
      createGenerationJob: vi.fn(async (request) => {
        submitted = request
        store.getState().updateGenerationSettings('target', {
          kind: 'video',
          providerId: 'changed-provider',
          catalogVersion: 'changed-catalog',
          channel: 999,
          model: 'changed-model',
          mode: 'changed-mode',
          resolution: '4K',
          aspectRatio: '16:9',
          durationSec: 10,
          generateAudio: true,
          count: 4,
        })
        return job(request, 'complete', { outputs: [output] })
      }),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      persistProject: persistNoop,
    })
    const frozen = {
      kind: 'video' as const,
      providerId: 'aistartlab',
      catalogVersion: 'catalog-v1',
      channel: 27,
      model: 'grok-1.0',
      mode: 'image2video',
      resolution: '2K',
      aspectRatio: '9:16',
      durationSec: 6,
      generateAudio: true,
      count: 1,
    }

    await controller.start({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'vertical video',
      settings: frozen,
    })

    expect(submitted).toMatchObject({
      projectId: simple.projectId,
      quality: '2K',
      aspectRatio: '9:16',
      duration: 6,
      generateAudio: true,
      n: 1,
    })
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'target')).toMatchObject({
      data: {
        url: output.url,
        generation: { actualSettings: frozen },
      },
    })
  })

  it('includes the canvas scope and first output target in collaborative generation requests', async () => {
    const simple = snapshot()
    simple.edges = []
    const store = createCanvasStore(simple)
    let submitted: GenerationRequest | undefined
    const api = gateway({
      createGenerationJob: vi.fn(async (request) => {
        submitted = request
        return job(request, 'complete')
      }),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'collaborative-request',
      persistProject: persistNoop,
    })

    await controller.start({
      canvasId: 'canvas-collaborative',
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'collaborative video',
    })

    expect(submitted).toMatchObject({
      canvasId: 'canvas-collaborative',
      targetNodeId: 'target',
    })
  })

  it('leaves collaborative job progress to the server-owned shared document', async () => {
    const simple = snapshot()
    simple.edges = []
    const store = createCanvasStore(simple)
    const getGenerationJob = vi.fn<GenerationGateway['getGenerationJob']>()
    const api = gateway({
      createGenerationJob: vi.fn(async (request) => job(request, 'queued', {
        roomId: 'room-collaborative',
        targetNodeId: request.targetNodeId,
      })),
      getGenerationJob,
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      persistProject: persistNoop,
    })

    await expect(controller.start({
      canvasId: 'canvas-collaborative',
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'server owned progress',
    })).resolves.toMatchObject({
      roomId: 'room-collaborative',
      status: 'queued',
    })

    expect(getGenerationJob).not.toHaveBeenCalled()
  })

  it('accepts an identical collaborative server writeback that wins the submit race', async () => {
    const simple = snapshot()
    simple.edges = []
    const store = createCanvasStore(simple)
    const api = gateway({
      createGenerationJob: vi.fn(async (request) => {
        const accepted = job(request, 'failed', {
          error: { code: 'upstream_failed', message: 'failed after acceptance' },
        })
        const target = store.getState().snapshot.nodes.find((node) => node.id === 'target')
        if (target?.type !== 'video' || !target.data.generation) {
          throw new Error('Expected a pending video target')
        }
        store.getState().setMediaGenerationGuarded({
          projectId: simple.projectId,
          nodeId: target.id,
          clientRequestId: request.clientRequestId,
          expectedJobId: null,
          generation: {
            ...target.data.generation,
            jobId: accepted.id,
            status: 'failed',
            phase: 'failed',
            error: accepted.error,
          },
        })
        return accepted
      }),
    })
    const controller = new GenerationController({ gateway: api, store, persistProject: persistNoop })

    await expect(controller.start({
      canvasId: 'canvas-collaborative',
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'server wins the write race',
    })).resolves.toMatchObject({ status: 'failed' })

    expect(store.getState().snapshot.nodes.find((node) => node.id === 'target')).toMatchObject({
      data: {
        generation: {
          jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
          error: { code: 'upstream_failed' },
        },
      },
    })
  })

  it('backfills an existing completed generated asset before any paid replacement', async () => {
    const existing = snapshot()
    existing.edges = []
    const target = existing.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    const old = asset('44444444-4444-4444-8444-444444444444', 'video/mp4')
    target.data.url = old.url
    target.data.assetId = old.id
    target.data.generation = {
      prompt: 'old result',
      status: 'complete',
      sourceNodeId: target.id,
      jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      outputIndex: 0,
    }
    const order: string[] = []
    const api = {
      ...gateway({
        createGenerationJob: vi.fn(async (request) => {
          order.push('create')
          return job(request, 'failed', {
            error: { code: 'upstream_failed', message: 'failed' },
          })
        }),
      }),
      backfillGenerationHistory: vi.fn(async () => {
        order.push('backfill')
      }),
    }
    const store = createCanvasStore(existing)
    const controller = new GenerationController({ gateway: api, store, persistProject: persistNoop })

    await controller.start({
      sourceNodeId: target.id,
      targetNodeIds: [target.id],
      prompt: 'replacement',
    })

    expect(api.backfillGenerationHistory).toHaveBeenCalledWith({
      projectId: existing.projectId,
      entries: [{
        jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        outputIndex: 0,
        assetId: old.id,
      }],
    }, expect.any(Object))
    expect(order).toEqual(['backfill', 'create'])
    expect(store.getState().snapshot.nodes.find((node) => node.id === target.id)).toMatchObject({
      data: { url: old.url },
    })
  })

  it('preserves existing media when a failed job unexpectedly includes outputs', async () => {
    const existing = snapshot()
    existing.edges = []
    const target = existing.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    const old = asset('45454545-4545-4545-8545-454545454545', 'video/mp4')
    const unexpected = asset('46464646-4646-4646-8646-464646464646', 'video/mp4')
    target.data.url = old.url
    target.data.assetId = old.id
    const api = gateway({
      createGenerationJob: vi.fn(async (request) =>
        job(request, 'failed', {
          outputs: [unexpected],
          error: { code: 'upstream_failed', message: 'failed' },
        }),
      ),
    })
    const store = createCanvasStore(existing)
    const controller = new GenerationController({
      gateway: api,
      store,
      persistProject: persistNoop,
    })

    await controller.start({
      sourceNodeId: target.id,
      targetNodeIds: [target.id],
      prompt: 'replacement',
    })

    expect(store.getState().snapshot.nodes.find((node) => node.id === target.id)).toMatchObject({
      data: {
        url: old.url,
        assetId: old.id,
        generation: { status: 'failed' },
      },
    })
  })

  it('blocks paid replacement and preserves old media when history backfill fails', async () => {
    const existing = snapshot()
    existing.edges = []
    const target = existing.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    const old = asset('55555555-5555-4555-8555-555555555555', 'video/mp4')
    target.data.url = old.url
    target.data.assetId = old.id
    target.data.generation = {
      prompt: 'old result',
      status: 'complete',
      sourceNodeId: target.id,
      jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      outputIndex: 0,
      outputs: [{ assetId: old.id, url: old.url, contentType: old.contentType, size: old.size }],
    }
    const api = {
      ...gateway(),
      backfillGenerationHistory: vi.fn(async () => {
        throw new GatewayClientError(500, 'history_write_failed', 'History write failed')
      }),
    }
    const store = createCanvasStore(existing)
    const controller = new GenerationController({ gateway: api, store, persistProject: persistNoop })

    await expect(controller.start({
      sourceNodeId: target.id,
      targetNodeIds: [target.id],
      prompt: 'replacement',
    })).rejects.toMatchObject({ code: 'history_write_failed' })

    expect(api.createGenerationJob).not.toHaveBeenCalled()
    expect(store.getState().snapshot.nodes.find((node) => node.id === target.id)).toMatchObject({
      data: {
        url: old.url,
        assetId: old.id,
        generation: { status: 'complete', jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      },
    })
  })

  it('stages references in alias order and persists completed local outputs', async () => {
    const store = createCanvasStore(snapshot())
    let submittedRequest: GenerationRequest | undefined
    const output = asset(
      '33333333-3333-4333-8333-333333333333',
      'video/mp4',
    )
    const api = gateway({
      createGenerationJob: vi.fn(async (request) => {
        submittedRequest = request
        return job(request, 'queued')
      }),
      getGenerationJob: vi
        .fn<GenerationGateway['getGenerationJob']>()
        .mockImplementationOnce(async () => job(submittedRequest!, 'running'))
        .mockImplementationOnce(async () =>
          job(submittedRequest!, 'complete', { outputs: [output] }),
        ),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'client-request-1',
      wait: async () => {},
      persistProject: persistNoop,
    })

    await controller.start({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: '从 @1 推进到 @2',
    })

    expect(submittedRequest).toMatchObject({
      clientRequestId: 'client-request-1',
      providerId: 'aistartlab',
      catalogVersion: 'catalog-v1',
      mediaType: 'video',
      channel: 27,
      model: 'grok-1.0',
      quality: '720p',
      duration: 6,
      mode: 'image2video',
      references: [
        {
          alias: 1,
          assetId: '11111111-1111-4111-8111-111111111111',
          mediaType: 'image',
        },
        {
          alias: 2,
          assetId: '22222222-2222-4222-8222-222222222222',
          mediaType: 'image',
        },
      ],
    })
    expect(api.uploadAsset).toHaveBeenCalledTimes(1)
    expect(api.importAsset).toHaveBeenCalledWith(
      'https://assets.example.test/courtyard.png',
      'courtyard.png',
      expect.any(Object),
    )
    expect(
      store
        .getState()
        .snapshot.nodes.filter((node) => node.id.startsWith('reference-'))
        .map((node) => (node.data as { url?: string }).url),
    ).toEqual([
      '/api/assets/11111111-1111-4111-8111-111111111111',
      '/api/assets/22222222-2222-4222-8222-222222222222',
    ])
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'target')).toMatchObject({
      type: 'video',
      data: {
        url: output.url,
        generation: {
          status: 'complete',
          phase: 'complete',
          jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
          clientRequestId: 'client-request-1',
          outputs: [output],
        },
      },
    })
  })

  it('rejects unresolved @ aliases before uploading or creating a paid job', async () => {
    const store = createCanvasStore(snapshot())
    store.getState().detachReference('target', 'reference-remote')
    const api = gateway()
    const controller = new GenerationController({
      gateway: api,
      store,
      persistProject: persistNoop,
    })

    await expect(
      controller.start({
        sourceNodeId: 'target',
        targetNodeIds: ['target'],
        prompt: '从 @1 推进到 @2',
      }),
    ).rejects.toMatchObject({
      constructor: GenerationControllerError,
      code: 'unresolved_references',
    })
    expect(api.uploadAsset).not.toHaveBeenCalled()
    expect(api.createGenerationJob).not.toHaveBeenCalled()
  })

  it('turns preflight configuration failures into a terminal node error', async () => {
    const unconfigured = snapshot()
    const target = unconfigured.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    delete target.data.generationSettings
    target.data.generation = { prompt: 'pending', status: 'generating' }
    const store = createCanvasStore(unconfigured)
    const api = gateway()
    const controller = new GenerationController({
      gateway: api,
      store,
      persistProject: persistNoop,
    })

    await expect(
      controller.start({
        sourceNodeId: 'target',
        targetNodeIds: ['target'],
        prompt: 'pending',
      }),
    ).rejects.toMatchObject({ code: 'generation_not_configured' })
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'target')).toMatchObject({
      data: {
        generation: {
          status: 'failed',
          phase: 'failed',
          error: { code: 'generation_not_configured' },
        },
      },
    })
    expect(api.createGenerationJob).not.toHaveBeenCalled()
  })

  it('coalesces duplicate starts and never repeats the paid POST', async () => {
    const simple = snapshot()
    simple.edges = []
    const store = createCanvasStore(simple)
    let release!: (value: GenerationJob) => void
    const createPromise = new Promise<GenerationJob>((resolve) => {
      release = resolve
    })
    let request: GenerationRequest | undefined
    const api = gateway({
      createGenerationJob: vi.fn(async (input) => {
        request = input
        return createPromise
      }),
      getGenerationJob: vi.fn(async () =>
        job(request!, 'failed', {
          error: { code: 'upstream_failed', message: 'failed' },
        }),
      ),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      persistProject: persistNoop,
    })
    const input = {
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: '文本生成视频',
    }

    const first = controller.start(input)
    const second = controller.start(input)
    await vi.waitFor(() =>
      expect(api.createGenerationJob).toHaveBeenCalledTimes(1),
    )
    release(job(request!, 'queued'))
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(api.createGenerationJob).toHaveBeenCalledTimes(1)
  })

  it('ignores persisted recovery while the same controller is staging the source', async () => {
    const simple = snapshot()
    simple.edges = simple.edges.filter((edge) => edge.source === 'reference-remote')
    const store = createCanvasStore(simple)
    let releaseStage!: (value: AssetRecord) => void
    const stagedAsset = new Promise<AssetRecord>((resolve) => {
      releaseStage = resolve
    })
    const api = gateway({
      importAsset: vi.fn(async () => stagedAsset),
      createGenerationJob: vi.fn(async (request) =>
        job(request, 'failed', {
          error: { code: 'upstream_failed', message: 'failed' },
        }),
      ),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'active-client-request',
      persistProject: persistNoop,
    })

    const started = controller.start({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'use @2',
    })
    await vi.waitFor(() => expect(api.importAsset).toHaveBeenCalledTimes(1))

    await controller.resumePersisted()

    expect(store.getState().snapshot.nodes.find((node) => node.id === 'target')).toMatchObject({
      data: {
        generation: {
          status: 'generating',
        },
      },
    })
    expect(
      store.getState().snapshot.nodes.find((node) => node.id === 'target')?.data.generation
        ?.error,
    ).toBeUndefined()
    expect(api.createGenerationJob).not.toHaveBeenCalled()

    releaseStage(asset('66666666-6666-4666-8666-666666666666'))
    await started

    expect(api.createGenerationJob).toHaveBeenCalledTimes(1)
  })

  it('resumes persisted jobs by polling only and maps all outputs by output index', async () => {
    const persisted = snapshot()
    const target = persisted.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    target.data.generation = {
      prompt: 'resume',
      status: 'generating',
      phase: 'running',
      sourceNodeId: 'target',
      jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: 'persisted-client-request',
      outputIndex: 0,
    }
    const store = createCanvasStore(persisted)
    const request = {
      ...generationRequestForResume,
      clientRequestId: 'persisted-client-request',
    }
    const output = asset('44444444-4444-4444-8444-444444444444', 'video/mp4')
    const api = gateway({
      getGenerationJob: vi.fn(async () =>
        job(request, 'complete', { outputs: [output] }),
      ),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      persistProject: persistNoop,
    })

    await controller.resumePersisted()

    expect(api.createGenerationJob).not.toHaveBeenCalled()
    expect(api.getGenerationJob).toHaveBeenCalledTimes(1)
    const resumedTarget = store
      .getState()
      .snapshot.nodes.find((node) => node.id === 'target')
    expect((resumedTarget?.data as { url?: string } | undefined)?.url).toBe(
      output.url,
    )
  })

  it.each(['REFERENCE_STAGING_FAILED', 'manual_recovery_required'])(
    'leaves %s pending for explicit resubmission during startup recovery',
    async (errorCode) => {
      const persisted = snapshot()
      persisted.edges = []
      const target = persisted.nodes.find((node) => node.id === 'target')!
      if (target.type !== 'video') throw new Error('Expected video')
      target.data.generation = {
        prompt: generationRequestForResume.prompt,
        status: errorCode === 'manual_recovery_required' ? 'failed' : 'generating',
        phase: 'uploading',
        sourceNodeId: target.id,
        jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
        clientRequestId: generationRequestForResume.clientRequestId,
        error: { code: errorCode, message: 'explicit recovery required' },
        pendingRequest: {
          projectId: persisted.projectId,
          sourceNodeId: target.id,
          outputs: [{ nodeId: target.id, outputIndex: 0 }],
          request: structuredClone(generationRequestForResume),
        },
      }
      const store = createCanvasStore(persisted)
      const api = gateway()
      const controller = new GenerationController({ gateway: api, store, persistProject: persistNoop })

      await controller.resumePersisted()

      expect(api.getGenerationJob).not.toHaveBeenCalled()
      expect(api.createGenerationJob).not.toHaveBeenCalled()
      expect(store.getState().snapshot.nodes.find((node) => node.id === target.id)).toMatchObject({
        data: {
          generation: {
            jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
            error: { code: errorCode },
            pendingRequest: { request: generationRequestForResume },
          },
        },
      })
    },
  )

  it('rebuilds a missing pending request from the existing gateway job', async () => {
    const persisted = snapshot()
    persisted.edges = []
    const target = persisted.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    target.data.generation = {
      prompt: generationRequestForResume.prompt,
      status: 'failed',
      phase: 'failed',
      sourceNodeId: target.id,
      jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: generationRequestForResume.clientRequestId,
      error: { code: 'network_error', message: 'Unable to reach local gateway' },
    }
    const store = createCanvasStore(persisted)
    const api = gateway({
      getGenerationJob: vi.fn(async (jobId) => job(
        generationRequestForResume,
        'uploading',
        {
          id: jobId,
          error: { code: 'REFERENCE_STAGING_FAILED', message: 'retry staging' },
        },
      )),
    })
    const controller = new GenerationController({ gateway: api, store, persistProject: persistNoop })

    await controller.resumePersisted()

    expect(api.getGenerationJob).toHaveBeenCalledTimes(1)
    expect(api.createGenerationJob).not.toHaveBeenCalled()
    expect(store.getState().snapshot.nodes.find((node) => node.id === target.id)).toMatchObject({
      data: {
        generation: {
          status: 'generating',
          error: { code: 'REFERENCE_STAGING_FAILED' },
          pendingRequest: {
            projectId: persisted.projectId,
            sourceNodeId: target.id,
            outputs: [{ nodeId: target.id, outputIndex: 0 }],
            request: generationRequestForResume,
          },
        },
      },
    })
  })

  it('keeps a created job resumable when polling cannot reach the gateway', async () => {
    const persisted = snapshot()
    persisted.edges = []
    const target = persisted.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    target.data.generation = {
      prompt: generationRequestForResume.prompt,
      status: 'generating',
      phase: 'running',
      sourceNodeId: target.id,
      jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: generationRequestForResume.clientRequestId,
      pendingRequest: {
        projectId: persisted.projectId,
        sourceNodeId: target.id,
        outputs: [{ nodeId: target.id, outputIndex: 0 }],
        request: structuredClone(generationRequestForResume),
      },
    }
    const store = createCanvasStore(persisted)
    const api = gateway({
      getGenerationJob: vi.fn(async () => {
        throw new GatewayClientError(0, 'network_error', 'Unable to reach local gateway')
      }),
    })
    const controller = new GenerationController({ gateway: api, store, persistProject: persistNoop })

    await controller.resumePersisted()

    expect(store.getState().snapshot.nodes.find((node) => node.id === target.id)).toMatchObject({
      data: {
        generation: {
          status: 'generating',
          jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
          error: { code: 'poll_unavailable' },
          pendingRequest: { request: generationRequestForResume },
        },
      },
    })
  })

  it('keeps poll_unavailable recoverable when persisting the poll failure fails', async () => {
    const persisted = snapshot()
    persisted.edges = []
    const target = persisted.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    target.data.generation = {
      prompt: generationRequestForResume.prompt,
      status: 'generating',
      phase: 'running',
      sourceNodeId: target.id,
      jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: generationRequestForResume.clientRequestId,
      pendingRequest: {
        projectId: persisted.projectId,
        sourceNodeId: target.id,
        outputs: [{ nodeId: target.id, outputIndex: 0 }],
        request: structuredClone(generationRequestForResume),
      },
    }
    const store = createCanvasStore(persisted)
    const api = gateway({
      getGenerationJob: vi.fn(async () => {
        throw new GatewayClientError(0, 'network_error', 'Unable to reach local gateway')
      }),
    })
    const persistProject = vi.fn(async () => {
      throw new Error('local persistence unavailable')
    })
    const controller = new GenerationController({ gateway: api, store, persistProject })

    await controller.resumePersisted()

    expect(persistProject).toHaveBeenCalledTimes(1)
    expect(store.getState().snapshot.nodes.find((node) => node.id === target.id)).toMatchObject({
      data: {
        generation: {
          status: 'generating',
          jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
          error: { code: 'poll_unavailable' },
          pendingRequest: { request: generationRequestForResume },
        },
      },
    })
  })

  it('keeps staged multi-target recovery pending when persistence fails after applyJob', async () => {
    const persisted = snapshot()
    persisted.edges = []
    const target = persisted.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    const secondTarget = structuredClone(target)
    secondTarget.id = 'target-2'
    secondTarget.name = 'Target 2'
    const generation = {
      prompt: generationRequestForResume.prompt,
      status: 'failed' as const,
      phase: 'failed',
      sourceNodeId: target.id,
      jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: generationRequestForResume.clientRequestId,
      error: { code: 'network_error', message: 'Unable to reach local gateway' },
    }
    target.data.generation = { ...generation, outputIndex: 0 }
    secondTarget.data.generation = { ...generation, outputIndex: 1 }
    persisted.nodes.push(secondTarget)
    const store = createCanvasStore(persisted)
    const api = gateway({
      getGenerationJob: vi.fn(async (jobId) => job(
        generationRequestForResume,
        'uploading',
        {
          id: jobId,
          error: { code: 'REFERENCE_STAGING_FAILED', message: 'retry staging' },
        },
      )),
    })
    const persistProject = vi.fn(async () => {
      throw new Error('local persistence unavailable')
    })
    const controller = new GenerationController({ gateway: api, store, persistProject })

    await controller.resumePersisted()

    expect(api.getGenerationJob).toHaveBeenCalledTimes(1)
    expect(api.createGenerationJob).not.toHaveBeenCalled()
    for (const nodeId of [target.id, secondTarget.id]) {
      expect(store.getState().snapshot.nodes.find((node) => node.id === nodeId)).toMatchObject({
        data: {
          generation: {
            status: 'generating',
            error: { code: 'REFERENCE_STAGING_FAILED' },
            pendingRequest: {
              projectId: persisted.projectId,
              sourceNodeId: target.id,
              outputs: [
                { nodeId: target.id, outputIndex: 0 },
                { nodeId: secondTarget.id, outputIndex: 1 },
              ],
              request: generationRequestForResume,
            },
          },
        },
      })
    }
  })

  it('keeps a submitted nonterminal job recoverable in the live store when persistence fails', async () => {
    const persisted = snapshot()
    persisted.edges = []
    const store = createCanvasStore(persisted)
    const api = gateway({
      createGenerationJob: vi.fn(async (request) => job(request, 'running')),
    })
    const persistProject = vi
      .fn<(project: ProjectSnapshot) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('local persistence unavailable'))
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'post-apply-client-request',
      persistProject,
    })

    const failure = await controller.start({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'persist after apply',
    }).then(() => undefined, (error: unknown) => error)

    expect(api.createGenerationJob).toHaveBeenCalledTimes(1)
    expect(api.getGenerationJob).not.toHaveBeenCalled()
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'target')).toMatchObject({
      data: {
        generation: {
          status: 'generating',
          jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
          clientRequestId: 'post-apply-client-request',
          error: { code: 'local_persistence_failed' },
          pendingRequest: {
            request: { clientRequestId: 'post-apply-client-request' },
          },
        },
      },
    })
    expect(failure).toMatchObject({ code: 'local_persistence_failed' })
  })

  it('keeps a polled nonterminal job recoverable in the live store when persistence fails', async () => {
    const persisted = snapshot()
    persisted.edges = []
    const target = persisted.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    target.data.generation = {
      prompt: generationRequestForResume.prompt,
      status: 'generating',
      phase: 'queued',
      sourceNodeId: target.id,
      jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: generationRequestForResume.clientRequestId,
      pendingRequest: {
        projectId: persisted.projectId,
        sourceNodeId: target.id,
        outputs: [{ nodeId: target.id, outputIndex: 0 }],
        request: structuredClone(generationRequestForResume),
      },
    }
    const store = createCanvasStore(persisted)
    const api = gateway({
      getGenerationJob: vi.fn(async (jobId) => job(
        generationRequestForResume,
        'running',
        { id: jobId, progress: 35 },
      )),
    })
    const persistProject = vi.fn(async () => {
      throw new Error('local persistence unavailable')
    })
    const controller = new GenerationController({ gateway: api, store, persistProject })

    await controller.resumePersisted()

    expect(api.getGenerationJob).toHaveBeenCalledTimes(1)
    expect(api.createGenerationJob).not.toHaveBeenCalled()
    expect(store.getState().snapshot.nodes.find((node) => node.id === target.id)).toMatchObject({
      data: {
        generation: {
          status: 'generating',
          phase: 'running',
          progress: 35,
          jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
          error: { code: 'local_persistence_failed' },
          pendingRequest: { request: generationRequestForResume },
        },
      },
    })
  })

  it.each(['poll_unavailable', 'network_error', 'local_persistence_failed'] as const)(
    'retries %s with the existing job GET and never creates another job',
    async (errorCode) => {
      const persisted = snapshot()
      persisted.edges = []
      const target = persisted.nodes.find((node) => node.id === 'target')!
      if (target.type !== 'video') throw new Error('Expected video')
      target.data.generation = {
        prompt: generationRequestForResume.prompt,
        status: errorCode === 'poll_unavailable' ? 'generating' : 'failed',
        phase: errorCode === 'poll_unavailable' ? 'running' : 'failed',
        sourceNodeId: target.id,
        jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
        clientRequestId: generationRequestForResume.clientRequestId,
        error: { code: errorCode, message: 'recoverable polling error' },
      }
      const store = createCanvasStore(persisted)
      const output = asset('99999999-9999-4999-8999-999999999999', 'video/mp4')
      const api = gateway({
        getGenerationJob: vi.fn(async (jobId) => job(
          generationRequestForResume,
          'complete',
          { id: jobId, outputs: [output] },
        )),
      })
      const controller = new GenerationController({
        gateway: api,
        store,
        createId: () => generationRequestForResume.clientRequestId,
        persistProject: persistNoop,
      })

      await expect(controller.retry({
        sourceNodeId: target.id,
        targetNodeIds: [target.id],
        prompt: generationRequestForResume.prompt,
      })).resolves.toMatchObject({ status: 'complete' })

      expect(api.getGenerationJob).toHaveBeenCalledTimes(1)
      expect(api.createGenerationJob).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['manual_recovery_required', 'failed', 'failed'],
    ['generating without a persisted request', 'generating', 'running'],
  ] as const)(
    'exits an orphaned %s generation without POST and permits a later explicit start',
    async (label, status, phase) => {
      const persisted = snapshot()
      persisted.edges = []
      const target = persisted.nodes.find((node) => node.id === 'target')!
      if (target.type !== 'video') throw new Error('Expected video')
      target.data.generation = {
        prompt: generationRequestForResume.prompt,
        status,
        phase,
        sourceNodeId: target.id,
        clientRequestId: 'orphaned-client-request',
        ...(label === 'manual_recovery_required'
          ? { error: { code: label, message: 'Original request is unavailable' } }
          : {}),
      }
      const store = createCanvasStore(persisted)
      const output = asset('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'video/mp4')
      const api = gateway({
        createGenerationJob: vi.fn(async (request) => job(
          request,
          'complete',
          { outputs: [output] },
        )),
      })
      const controller = new GenerationController({
        gateway: api,
        store,
        createId: () => 'explicit-new-client-request',
        persistProject: persistNoop,
      })

      const failure = await controller.retry({
        sourceNodeId: target.id,
        targetNodeIds: [target.id],
        prompt: generationRequestForResume.prompt,
      }).then(() => undefined, (error: unknown) => error)

      expect(api.getGenerationJob).not.toHaveBeenCalled()
      expect(api.createGenerationJob).not.toHaveBeenCalled()
      expect(failure).toMatchObject({ code: 'original_request_unavailable' })
      const orphanedGeneration = store
        .getState()
        .snapshot.nodes.find((node) => node.id === target.id)?.data.generation
      expect(orphanedGeneration).toMatchObject({
        status: 'failed',
        clientRequestId: 'orphaned-client-request',
        error: {
          code: 'original_request_unavailable',
          message: expect.stringContaining('request'),
        },
      })
      expect(orphanedGeneration).not.toHaveProperty('jobId')
      expect(orphanedGeneration).not.toHaveProperty('pendingRequest')

      await expect(controller.start({
        sourceNodeId: target.id,
        targetNodeIds: [target.id],
        prompt: 'explicit new generation',
      })).resolves.toMatchObject({ status: 'complete' })

      expect(api.createGenerationJob).toHaveBeenCalledTimes(1)
      expect(api.createGenerationJob).toHaveBeenCalledWith(
        expect.objectContaining({
          clientRequestId: 'explicit-new-client-request',
          prompt: 'explicit new generation',
        }),
        expect.any(Object),
      )
    },
  )

  it('explicitly resumes a failed reference stage with the identical persisted request', async () => {
    const persisted = snapshot()
    persisted.edges = []
    const target = persisted.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    target.data.generation = {
      prompt: generationRequestForResume.prompt,
      status: 'generating',
      phase: 'uploading',
      sourceNodeId: target.id,
      jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: generationRequestForResume.clientRequestId,
      error: {
        code: 'REFERENCE_STAGING_FAILED',
        message: 'Reference staging can be resumed safely',
      },
      pendingRequest: {
        projectId: persisted.projectId,
        sourceNodeId: target.id,
        outputs: [{ nodeId: target.id, outputIndex: 0 }],
        request: structuredClone(generationRequestForResume),
      },
    }
    const store = createCanvasStore(persisted)
    const output = asset('77777777-7777-4777-8777-777777777777', 'video/mp4')
    const api = gateway({
      createGenerationJob: vi.fn(async (request) =>
        job(request, 'complete', { outputs: [output] }),
      ),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      persistProject: persistNoop,
    })

    await expect(controller.retry({
      sourceNodeId: target.id,
      targetNodeIds: [target.id],
      prompt: generationRequestForResume.prompt,
    })).resolves.toMatchObject({ status: 'complete' })

    expect(api.createGenerationJob).toHaveBeenCalledWith(
      generationRequestForResume,
      expect.any(Object),
    )
    expect(api.getGenerationJob).not.toHaveBeenCalled()
    expect(store.getState().snapshot.nodes.find((node) => node.id === target.id)).toMatchObject({
      data: {
        url: output.url,
        generation: {
          status: 'complete',
          jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
          clientRequestId: generationRequestForResume.clientRequestId,
        },
      },
    })
  })

  it('keeps a repeated reference staging failure recoverable without polling', async () => {
    const persisted = snapshot()
    persisted.edges = []
    const target = persisted.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    target.data.generation = {
      prompt: generationRequestForResume.prompt,
      status: 'generating',
      phase: 'uploading',
      sourceNodeId: target.id,
      jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: generationRequestForResume.clientRequestId,
      error: { code: 'REFERENCE_STAGING_FAILED', message: 'retry staging' },
      pendingRequest: {
        projectId: persisted.projectId,
        sourceNodeId: target.id,
        outputs: [{ nodeId: target.id, outputIndex: 0 }],
        request: structuredClone(generationRequestForResume),
      },
    }
    const store = createCanvasStore(persisted)
    const output = asset('88888888-8888-4888-8888-888888888888', 'video/mp4')
    const api = gateway({
      createGenerationJob: vi
        .fn<GenerationGateway['createGenerationJob']>()
        .mockImplementationOnce(async (request) => job(request, 'uploading', {
          error: { code: 'REFERENCE_STAGING_FAILED', message: 'retry staging' },
        }))
        .mockImplementationOnce(async (request) => job(request, 'complete', {
          outputs: [output],
        })),
    })
    const controller = new GenerationController({ gateway: api, store, persistProject: persistNoop })
    const input = {
      sourceNodeId: target.id,
      targetNodeIds: [target.id],
      prompt: generationRequestForResume.prompt,
    }

    await expect(controller.retry(input)).resolves.toMatchObject({
      status: 'uploading',
      error: { code: 'REFERENCE_STAGING_FAILED' },
    })
    expect(api.getGenerationJob).not.toHaveBeenCalled()
    expect(store.getState().snapshot.nodes.find((node) => node.id === target.id)).toMatchObject({
      data: { generation: { error: { code: 'REFERENCE_STAGING_FAILED' } } },
    })

    await expect(controller.retry(input)).resolves.toMatchObject({ status: 'complete' })
    expect(api.createGenerationJob).toHaveBeenCalledTimes(2)
    expect(api.createGenerationJob).toHaveBeenNthCalledWith(
      2,
      generationRequestForResume,
      expect.any(Object),
    )
  })

  it('records ambiguous recovery against the existing job id', async () => {
    const persisted = snapshot()
    persisted.edges = []
    const target = persisted.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    target.data.generation = {
      prompt: generationRequestForResume.prompt,
      status: 'generating',
      phase: 'uploading',
      sourceNodeId: target.id,
      jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: generationRequestForResume.clientRequestId,
      error: { code: 'REFERENCE_STAGING_FAILED', message: 'retry staging' },
      pendingRequest: {
        projectId: persisted.projectId,
        sourceNodeId: target.id,
        outputs: [{ nodeId: target.id, outputIndex: 0 }],
        request: structuredClone(generationRequestForResume),
      },
    }
    const store = createCanvasStore(persisted)
    const api = gateway({
      createGenerationJob: vi.fn(async () => {
        throw new GatewayClientError(0, 'network_error', 'connection lost')
      }),
    })
    const controller = new GenerationController({ gateway: api, store, persistProject: persistNoop })

    await expect(controller.retry({
      sourceNodeId: target.id,
      targetNodeIds: [target.id],
      prompt: generationRequestForResume.prompt,
    })).rejects.toMatchObject({ code: 'manual_recovery_required' })

    expect(store.getState().snapshot.nodes.find((node) => node.id === target.id)).toMatchObject({
      data: {
        generation: {
          jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
          status: 'failed',
          error: { code: 'manual_recovery_required' },
        },
      },
    })
  })

  it('coalesces concurrent polling for the same persisted job', async () => {
    const persisted = snapshot()
    const target = persisted.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    target.data.generation = {
      prompt: 'resume',
      status: 'generating',
      phase: 'running',
      sourceNodeId: 'target',
      jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: 'persisted-client-request',
    }
    const store = createCanvasStore(persisted)
    let release!: (value: GenerationJob) => void
    const response = new Promise<GenerationJob>((resolve) => {
      release = resolve
    })
    const api = gateway({
      getGenerationJob: vi.fn(async () => response),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      persistProject: persistNoop,
    })

    const first = controller.resumePersisted()
    const second = controller.resumePersisted()
    await Promise.resolve()

    expect(api.getGenerationJob).toHaveBeenCalledTimes(1)
    release(job(generationRequestForResume, 'complete'))
    await Promise.all([first, second])
  })

  it('keeps the pre-POST pending request recoverable in the live store when persistence fails', async () => {
    const simple = snapshot()
    simple.edges = []
    const store = createCanvasStore(simple)
    const output = asset('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'video/mp4')
    const api = gateway({
      createGenerationJob: vi.fn(async (request) =>
        job(request, 'complete', { outputs: [output] }),
      ),
    })
    const persisted: ProjectSnapshot[] = []
    let persistAttempts = 0
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'client-durable',
      persistProject: async (project) => {
        persisted.push(structuredClone(project))
        persistAttempts += 1
        if (persistAttempts === 1) throw new Error(sensitiveExternalMessage)
      },
    })

    const failure = await controller.start({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'durable request',
    }).then(() => undefined, (error: unknown) => error)

    expect(api.createGenerationJob).not.toHaveBeenCalled()
    expect(persisted).toHaveLength(1)
    expect(
      (persisted[0]!.nodes.find((node) => node.id === 'target')!.data as {
        generation?: { pendingRequest?: unknown }
      }).generation?.pendingRequest,
    ).toMatchObject({
      projectId: simple.projectId,
      sourceNodeId: 'target',
      outputs: [{ nodeId: 'target', outputIndex: 0 }],
      request: { clientRequestId: 'client-durable', references: [] },
    })
    const liveGeneration = store
      .getState()
      .snapshot.nodes.find((node) => node.id === 'target')?.data.generation
    expect(liveGeneration).toMatchObject({
      status: 'generating',
      clientRequestId: 'client-durable',
      error: { code: 'local_persistence_failed' },
      pendingRequest: {
        projectId: simple.projectId,
        sourceNodeId: 'target',
        outputs: [{ nodeId: 'target', outputIndex: 0 }],
        request: {
          clientRequestId: 'client-durable',
          prompt: 'durable request',
          references: [],
        },
      },
    })
    expect(liveGeneration).not.toHaveProperty('jobId')
    expect(failure).toMatchObject({ code: 'local_persistence_failed' })
    expectSanitizedMessage(liveGeneration?.error?.message)

    const frozenRequest = structuredClone(liveGeneration?.pendingRequest?.request)
    await expect(controller.retry({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'changed UI prompt must not be submitted',
    })).resolves.toMatchObject({ status: 'complete' })

    expect(api.createGenerationJob).toHaveBeenCalledTimes(1)
    expect(api.createGenerationJob).toHaveBeenCalledWith(frozenRequest, expect.any(Object))
    expect(api.getGenerationJob).not.toHaveBeenCalled()
  })

  it('manually recovers an ambiguous create with the identical request and client id', async () => {
    const simple = snapshot()
    simple.edges = []
    const store = createCanvasStore(simple)
    const submitted: GenerationRequest[] = []
    const output = asset('55555555-5555-4555-8555-555555555555', 'video/mp4')
    const api = gateway({
      createGenerationJob: vi
        .fn<GenerationGateway['createGenerationJob']>()
        .mockImplementationOnce(async (request) => {
          submitted.push(structuredClone(request))
          throw new GatewayClientError(0, 'network_error', 'connection lost')
        })
        .mockImplementationOnce(async (request) => {
          submitted.push(structuredClone(request))
          return job(request, 'complete', { outputs: [output] })
        }),
    })
    const createId = vi.fn(() => 'client-ambiguous')
    const controller = new GenerationController({
      gateway: api,
      store,
      createId,
      persistProject: async () => {},
    })
    const input = {
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'recover me',
    }

    await expect(controller.start(input)).rejects.toMatchObject({
      code: 'manual_recovery_required',
    })
    await expect(controller.retry(input)).resolves.toMatchObject({
      status: 'complete',
    })

    expect(createId).toHaveBeenCalledTimes(1)
    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toEqual(submitted[0])
    expect(submitted[1]!.clientRequestId).toBe('client-ambiguous')
  })

  it('queues an explicit retry while the ambiguous request is still being persisted', async () => {
    const simple = snapshot()
    simple.edges = []
    const store = createCanvasStore(simple)
    const submitted: GenerationRequest[] = []
    let releaseRecovery!: () => void
    const recoveryPersisted = new Promise<void>((resolve) => { releaseRecovery = resolve })
    let persistenceCalls = 0
    const api = gateway({
      createGenerationJob: vi
        .fn<GenerationGateway['createGenerationJob']>()
        .mockImplementationOnce(async (request) => {
          submitted.push(structuredClone(request))
          throw new GatewayClientError(0, 'network_error', 'connection lost')
        })
        .mockImplementationOnce(async (request) => {
          submitted.push(structuredClone(request))
          return job(request, 'complete')
        }),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'client-queued-recovery',
      persistProject: async () => {
        persistenceCalls += 1
        if (persistenceCalls === 2) await recoveryPersisted
      },
    })
    const input = {
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'recover immediately',
    }

    const first = controller.startSubmitted(input)
    await vi.waitFor(() => expect(
      store.getState().snapshot.nodes.find((node) => node.id === 'target')?.data.generation?.error?.code,
    ).toBe('manual_recovery_required'))
    const retry = controller.retrySubmitted(input)
    await Promise.resolve()
    expect(api.createGenerationJob).toHaveBeenCalledTimes(1)

    releaseRecovery()
    await expect(first).rejects.toMatchObject({ code: 'manual_recovery_required' })
    await expect(retry).resolves.toMatchObject({ status: 'complete' })
    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toEqual(submitted[0])
  })

  it.each([500, 502, 503, 504])(
    'treats create HTTP %i as ambiguous and preserves the frozen request',
    async (status) => {
      const simple = snapshot()
      simple.edges = []
      const store = createCanvasStore(simple)
      const api = gateway({
        createGenerationJob: vi.fn(async () => {
          throw new GatewayClientError(status, 'upstream_error', 'Provider result is unknown')
        }),
      })
      const controller = new GenerationController({
        gateway: api,
        store,
        createId: () => `ambiguous-${status}`,
        persistProject: persistNoop,
      })

      await expect(controller.start({
        sourceNodeId: 'target',
        targetNodeIds: ['target'],
        prompt: `ambiguous ${status}`,
      })).rejects.toMatchObject({ code: 'manual_recovery_required' })

      expect(store.getState().snapshot.nodes.find((node) => node.id === 'target')).toMatchObject({
        data: {
          generation: {
            status: 'failed',
            error: { code: 'manual_recovery_required' },
            pendingRequest: {
              request: {
                clientRequestId: `ambiguous-${status}`,
                prompt: `ambiguous ${status}`,
              },
            },
          },
        },
      })
    },
  )

  it('keeps an ambiguous frozen request when persisting recovery state also fails', async () => {
    const simple = snapshot()
    simple.edges = []
    const store = createCanvasStore(simple)
    const submitted: GenerationRequest[] = []
    const output = asset('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'video/mp4')
    const api = gateway({
      createGenerationJob: vi
        .fn<GenerationGateway['createGenerationJob']>()
        .mockImplementationOnce(async (request) => {
          submitted.push(structuredClone(request))
          throw new GatewayClientError(503, 'upstream_error', 'Provider result is unknown')
        })
        .mockImplementationOnce(async (request) => {
          submitted.push(structuredClone(request))
          return job(request, 'complete', { outputs: [output] })
        }),
    })
    const persistProject = vi
      .fn<(project: ProjectSnapshot) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('recovery persistence failed'))
      .mockResolvedValue(undefined)
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'ambiguous-persist-failure',
      persistProject,
    })

    const failure = await controller.start({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'frozen ambiguous request',
    }).then(() => undefined, (error: unknown) => error)

    const recovery = store
      .getState()
      .snapshot.nodes.find((node) => node.id === 'target')?.data.generation
    expect(failure).toMatchObject({ code: 'manual_recovery_required' })
    expect(recovery).toMatchObject({
      status: 'failed',
      error: { code: 'manual_recovery_required' },
      pendingRequest: {
        request: {
          clientRequestId: 'ambiguous-persist-failure',
          prompt: 'frozen ambiguous request',
        },
      },
    })
    const frozenRequest = structuredClone(recovery?.pendingRequest?.request)

    await expect(controller.retry({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'changed UI prompt',
    })).resolves.toMatchObject({ status: 'complete' })

    expect(submitted).toEqual([frozenRequest, frozenRequest])
    expect(api.getGenerationJob).not.toHaveBeenCalled()
  })

  it('treats an explicit create HTTP 400 as a terminal request failure', async () => {
    const simple = snapshot()
    simple.edges = []
    const store = createCanvasStore(simple)
    const api = gateway({
      createGenerationJob: vi.fn(async () => {
        throw new GatewayClientError(400, 'validation_error', 'Prompt is invalid')
      }),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'explicit-400',
      persistProject: persistNoop,
    })

    await expect(controller.start({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'invalid request',
    })).rejects.toMatchObject({ code: 'validation_error' })

    const generation = store
      .getState()
      .snapshot.nodes.find((node) => node.id === 'target')?.data.generation
    expect(generation).toMatchObject({
      status: 'failed',
      error: { code: 'validation_error' },
    })
    expect(generation?.pendingRequest).toBeUndefined()
  })

  it('repairs the missing target when retrying a pre-fix collaborative request', async () => {
    const persisted = snapshot()
    persisted.edges = []
    const target = persisted.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    const request = {
      ...generationRequestForResume,
      canvasId: 'canvas-collaborative',
      targetNodeId: undefined,
    }
    target.data.generation = {
      prompt: request.prompt,
      status: 'failed',
      phase: 'submitted',
      sourceNodeId: target.id,
      clientRequestId: request.clientRequestId,
      error: {
        code: 'manual_recovery_required',
        message: 'Pending creation must be recovered manually',
      },
      pendingRequest: {
        projectId: persisted.projectId,
        sourceNodeId: target.id,
        outputs: [{ nodeId: target.id, outputIndex: 0 }],
        request,
      },
    }
    const store = createCanvasStore(persisted)
    let submitted: GenerationRequest | undefined
    const api = gateway({
      createGenerationJob: vi.fn(async (nextRequest) => {
        submitted = nextRequest
        return job(nextRequest, 'complete')
      }),
    })
    const controller = new GenerationController({ gateway: api, store, persistProject: persistNoop })

    await controller.retry({
      canvasId: 'canvas-collaborative',
      sourceNodeId: target.id,
      targetNodeIds: [target.id],
      prompt: 'ignored in favor of the frozen request',
    })

    expect(submitted).toMatchObject({
      clientRequestId: generationRequestForResume.clientRequestId,
      canvasId: 'canvas-collaborative',
      targetNodeId: target.id,
    })
  })

  it('sanitizes an explicit create 4xx rejection at the public promise boundary', async () => {
    const simple = snapshot()
    simple.edges = []
    const store = createCanvasStore(simple)
    const api = gateway({
      createGenerationJob: vi.fn(async () => {
        throw new GatewayClientError(422, 'validation_error', sensitiveExternalMessage)
      }),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'explicit-sensitive-422',
      persistProject: persistNoop,
    })

    let rejection: unknown
    try {
      await controller.start({
        sourceNodeId: 'target',
        targetNodeIds: ['target'],
        prompt: 'invalid request',
      })
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(GatewayClientError)
    if (!(rejection instanceof GatewayClientError)) {
      throw new Error('Expected a GatewayClientError')
    }
    expect(rejection).toMatchObject({ status: 422, code: 'validation_error' })
    expectSanitizedMessage(rejection.message)
  })

  it('clears a definite catalog rejection after settings refresh without resubmitting', async () => {
    const simple = snapshot()
    simple.edges = []
    const store = createCanvasStore(simple)
    const api = gateway({
      createGenerationJob: vi.fn(async () => {
        throw new CatalogChangedGatewayError('Refresh the catalog')
      }),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'catalog-rejected-v1',
      persistProject: persistNoop,
    })

    await expect(controller.start({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'use refreshed catalog',
    })).rejects.toMatchObject({ code: 'catalog_changed' })
    const target = store.getState().snapshot.nodes.find((node) => node.id === 'target')
    if (target?.type !== 'video' || target.data.generationSettings?.kind !== 'video') {
      throw new Error('Expected configured video target')
    }
    store.getState().updateGenerationSettings('target', {
      ...target.data.generationSettings,
      catalogVersion: 'catalog-v2',
    })

    await expect(controller.resolveCatalogChanged('target')).resolves.toBe(true)

    const refreshed = store.getState().snapshot.nodes.find((node) => node.id === 'target')
    expect(refreshed).toMatchObject({
      data: {
        generationSettings: { catalogVersion: 'catalog-v2' },
        generation: {
          status: 'failed',
          pendingRequest: undefined,
          error: undefined,
        },
      },
    })
    expect(api.createGenerationJob).toHaveBeenCalledTimes(1)
    expect(api.getGenerationJob).not.toHaveBeenCalled()
  })

  it('keeps a complete result recoverable when terminal persistence fails', async () => {
    const simple = snapshot()
    simple.edges = []
    const store = createCanvasStore(simple)
    const output = asset('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'video/mp4')
    let acceptedRequest: GenerationRequest | undefined
    const api = gateway({
      createGenerationJob: vi.fn(async (request) => {
        acceptedRequest = structuredClone(request)
        return job(request, 'complete', { outputs: [output] })
      }),
      getGenerationJob: vi.fn(async (jobId) => job(
        acceptedRequest!,
        'complete',
        { id: jobId, outputs: [output] },
      )),
    })
    const persistProject = vi
      .fn<(project: ProjectSnapshot) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('terminal persistence failed'))
      .mockResolvedValue(undefined)
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'complete-persist-failure',
      persistProject,
    })

    const failure = await controller.start({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'complete once',
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toMatchObject({ code: 'local_persistence_failed' })
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'target')).toMatchObject({
      data: {
        url: output.url,
        generation: {
          status: 'complete',
          jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
          error: { code: 'local_persistence_failed' },
        },
      },
    })

    await expect(controller.retry({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'must not create again',
    })).resolves.toMatchObject({ status: 'complete' })

    expect(api.createGenerationJob).toHaveBeenCalledTimes(1)
    expect(api.getGenerationJob).toHaveBeenCalledTimes(1)
  })

  it('locks by project and source before creating targets for consecutive clicks', async () => {
    const simple = snapshot()
    simple.edges = []
    const source = simple.nodes.find((node) => node.id === 'target')!
    const store = createCanvasStore(simple)
    let release!: (value: GenerationJob) => void
    const response = new Promise<GenerationJob>((resolve) => {
      release = resolve
    })
    let request: GenerationRequest | undefined
    const api = gateway({
      createGenerationJob: vi.fn(async (input) => {
        request = input
        return response
      }),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'client-double-click',
      persistProject: async () => {},
    })
    const makeInput = (suffix: string) => ({
      sourceNodeId: source.id,
      targetNodeIds: [source.id, `result-${suffix}`],
      targetNodes: [
        {
          ...source,
          id: `result-${suffix}`,
          data: { ...source.data, url: '' },
        },
      ],
      outputEdges: [
        {
          id: `output-${suffix}`,
          source: source.id,
          target: `result-${suffix}`,
          relation: 'output' as const,
        },
      ],
      prompt: 'one operation',
    })

    const first = controller.start(makeInput('one'))
    const second = controller.start(makeInput('two'))
    await vi.waitFor(() => expect(api.createGenerationJob).toHaveBeenCalledTimes(1))
    expect(store.getState().snapshot.nodes.map((node) => node.id)).toContain('result-one')
    expect(store.getState().snapshot.nodes.map((node) => node.id)).not.toContain('result-two')
    release(job(request!, 'failed', { error: { code: 'failed', message: 'failed' } }))
    await Promise.allSettled([first, second])
  })

  it('does not write an old job into another project and resumes after switching back', async () => {
    const projectA = snapshot()
    projectA.edges = []
    const store = createCanvasStore(projectA)
    const durable = new Map<string, ProjectSnapshot>()
    let releasePoll!: (value: GenerationJob) => void
    let pollStarted!: () => void
    const started = new Promise<void>((resolve) => {
      pollStarted = resolve
    })
    let submitted: GenerationRequest | undefined
    const api = gateway({
      createGenerationJob: vi.fn(async (request) => {
        submitted = request
        return job(request, 'queued')
      }),
      getGenerationJob: vi.fn(
        async () =>
          new Promise<GenerationJob>((resolve) => {
            releasePoll = resolve
            pollStarted()
          }),
      ),
    })
    const persistProject = async (project: ProjectSnapshot) => {
      durable.set(project.projectId, structuredClone(project))
    }
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'client-project-a',
      persistProject,
    })
    const operation = controller.start({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'project A',
    })
    await started

    const projectB: ProjectSnapshot = {
      version: 1,
      projectId: 'project-b',
      name: 'Project B',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    }
    store.getState().restore(JSON.stringify(projectB))
    releasePoll(
      job(submitted!, 'complete', {
        outputs: [asset('66666666-6666-4666-8666-666666666666', 'video/mp4')],
      }),
    )
    await expect(operation).rejects.toMatchObject({ code: 'project_inactive' })
    expect(store.getState().snapshot).toEqual(projectB)

    store.getState().restore(JSON.stringify(durable.get(projectA.projectId)!))
    const resumeApi = gateway({
      getGenerationJob: vi.fn(async () =>
        job(submitted!, 'complete', {
          outputs: [asset('66666666-6666-4666-8666-666666666666', 'video/mp4')],
        }),
      ),
    })
    const resumed = new GenerationController({
      gateway: resumeApi,
      store,
      persistProject,
    })
    await resumed.resumePersisted()
    expect(
      (store.getState().snapshot.nodes.find((node) => node.id === 'target')!.data as {
        url?: string
      }).url,
    ).toBe('/api/assets/66666666-6666-4666-8666-666666666666')
  })

  it('rejects a gateway job explicitly bound to another project', async () => {
    const simple = snapshot()
    simple.edges = []
    const source = simple.nodes.find((node) => node.id === 'target')!
    if (source.type !== 'video') throw new Error('Expected video')
    source.data.url = '/api/assets/33333333-3333-4333-8333-333333333333'
    const store = createCanvasStore(simple)
    const api = gateway({
      createGenerationJob: vi.fn(async (request) => job(
        { ...request, projectId: 'another-project' },
        'complete',
        { outputs: [asset('66666666-6666-4666-8666-666666666666', 'video/mp4')] },
      )),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      createId: () => 'cross-project-job',
      persistProject: persistNoop,
    })

    await expect(controller.start({
      sourceNodeId: source.id,
      targetNodeIds: [source.id],
      prompt: 'must stay local',
    })).rejects.toMatchObject({ code: 'job_identity_mismatch' })
    expect(store.getState().snapshot.nodes.find((node) => node.id === source.id)).toMatchObject({
      data: { url: '/api/assets/33333333-3333-4333-8333-333333333333' },
    })
  })

  it('fails only unmatched targets when a complete job returns too few outputs', async () => {
    const simple = snapshot()
    simple.edges = []
    const source = simple.nodes.find((node) => node.id === 'target')!
    const second = { ...source, id: 'target-2', data: { ...source.data, url: '' } }
    simple.nodes.push(second)
    const store = createCanvasStore(simple)
    const output = asset('77777777-7777-4777-8777-777777777777', 'video/mp4')
    const api = gateway({
      createGenerationJob: vi.fn(async (request) =>
        job(request, 'complete', { outputs: [output] }),
      ),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      persistProject: async () => {},
    })

    await controller.start({
      sourceNodeId: 'target',
      targetNodeIds: ['target', 'target-2'],
      prompt: 'two requested',
    })

    expect(store.getState().snapshot.nodes.find((node) => node.id === 'target')).toMatchObject({
      data: { url: output.url, generation: { status: 'complete' } },
    })
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'target-2')).toMatchObject({
      data: {
        url: '',
        generation: {
          status: 'failed',
          error: { code: 'output_missing' },
          pendingRequest: undefined,
        },
      },
    })
    const completed = store.getState().snapshot
    store.getState().undo()
    expect(store.getState().snapshot).not.toBe(completed)
  })

  it('removes the abort listener after a normal polling delay', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')

    const delayed = waitForPollDelay(50, controller.signal)
    await vi.advanceTimersByTimeAsync(50)
    await delayed

    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0]?.[0]).toBe('abort')
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1])
    vi.useRealTimers()
  })

  it('uses bounded polling and leaves a wall-time timeout resumable', async () => {
    const persisted = snapshot()
    persisted.edges = []
    const target = persisted.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    target.data.generation = {
      prompt: 'resume',
      status: 'generating',
      phase: 'running',
      sourceNodeId: target.id,
      jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: 'persisted-client-request',
    }
    const store = createCanvasStore(persisted)
    let now = 0
    const delays: number[] = []
    const api = gateway({
      getGenerationJob: vi.fn(async () =>
        job(generationRequestForResume, 'running'),
      ),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      now: () => new Date(now),
      pollIntervalMs: 10_000,
      pollTimeoutMs: 25_000,
      wait: async (milliseconds) => {
        delays.push(milliseconds)
        now += milliseconds
      },
      persistProject: async () => {},
    })

    await controller.resumePersisted()

    expect(delays).toEqual([10_000, 15_000])
    expect(api.createGenerationJob).not.toHaveBeenCalled()
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'target')).toMatchObject({
      data: {
        generation: {
          status: 'generating',
          error: { code: 'poll_timeout' },
        },
      },
    })
  })

  it('keeps poll_timeout and its frozen request when persisting timeout state fails', async () => {
    const persisted = persistedJobSnapshot()
    const store = createCanvasStore(persisted)
    const output = asset('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'video/mp4')
    const api = gateway({
      getGenerationJob: vi
        .fn<GenerationGateway['getGenerationJob']>()
        .mockImplementationOnce(async () => job(generationRequestForResume, 'running'))
        .mockImplementationOnce(async (jobId) => job(
          generationRequestForResume,
          'complete',
          { id: jobId, outputs: [output] },
        )),
    })
    let now = 0
    const persistProject = vi
      .fn<(project: ProjectSnapshot) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('timeout recovery persistence failed'))
      .mockResolvedValue(undefined)
    const controller = new GenerationController({
      gateway: api,
      store,
      now: () => new Date(now),
      pollIntervalMs: 10,
      pollTimeoutMs: 10,
      wait: async (milliseconds) => {
        now += milliseconds
      },
      persistProject,
    })

    await controller.resumePersisted()

    const timedOut = store
      .getState()
      .snapshot.nodes.find((node) => node.id === 'target')?.data.generation
    expect(timedOut).toMatchObject({
      status: 'generating',
      jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      error: { code: 'poll_timeout' },
      pendingRequest: { request: generationRequestForResume },
    })

    await expect(controller.retry({
      sourceNodeId: 'target',
      targetNodeIds: ['target'],
      prompt: 'changed UI prompt',
    })).resolves.toMatchObject({ status: 'complete' })

    expect(api.createGenerationJob).not.toHaveBeenCalled()
    expect(api.getGenerationJob).toHaveBeenCalledTimes(2)
  })

  it('charges GET latency against the real wall-clock polling budget', async () => {
    const store = createCanvasStore(persistedJobSnapshot())
    let now = 0
    const delays: number[] = []
    const api = gateway({
      getGenerationJob: vi.fn(async () => {
        now += 8_000
        return job(generationRequestForResume, 'running')
      }),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      now: () => new Date(now),
      pollIntervalMs: 10_000,
      pollTimeoutMs: 25_000,
      wait: async (milliseconds) => {
        delays.push(milliseconds)
        now += milliseconds
      },
      persistProject: persistNoop,
    })

    await controller.resumePersisted()

    expect(api.getGenerationJob).toHaveBeenCalledTimes(2)
    expect(delays).toEqual([10_000])
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'target')).toMatchObject({
      data: { generation: { error: { code: 'poll_timeout' } } },
    })
  })

  it('bounds a hanging GET by the remaining wall-clock polling budget', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    const store = createCanvasStore(persistedJobSnapshot())
    const api = gateway({
      getGenerationJob: vi.fn(() => new Promise<GenerationJob>(() => {})),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      pollIntervalMs: 10,
      pollTimeoutMs: 100,
      persistProject: persistNoop,
    })

    try {
      const resumed = controller.resumePersisted()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(100)

      expect(store.getState().snapshot.nodes.find((node) => node.id === 'target')).toMatchObject({
        data: {
          generation: {
            status: 'generating',
            error: { code: 'poll_timeout' },
            pendingRequest: { request: generationRequestForResume },
          },
        },
      })
      await resumed
      expect(api.getGenerationJob).toHaveBeenCalledTimes(1)
    } finally {
      controller.dispose()
      vi.useRealTimers()
    }
  })

  it.each([
    [{ pollIntervalMs: 0 }, 'pollIntervalMs'],
    [{ pollIntervalMs: Number.NaN }, 'pollIntervalMs'],
    [{ pollIntervalMs: Number.POSITIVE_INFINITY }, 'pollIntervalMs'],
    [{ pollTimeoutMs: -1 }, 'pollTimeoutMs'],
    [{ pollTimeoutMs: Number.NaN }, 'pollTimeoutMs'],
    [{ pollTimeoutMs: Number.POSITIVE_INFINITY }, 'pollTimeoutMs'],
  ])('rejects invalid polling option %s', (override, optionName) => {
    expect(() => new GenerationController({
      gateway: gateway(),
      store: createCanvasStore(snapshot()),
      persistProject: persistNoop,
      ...override,
    })).toThrow(new RangeError(`${optionName} must be a finite positive number`))
  })

  it.each([500, 502, 503, 504])(
    'treats polling HTTP %i as temporarily unavailable and sanitizes its message',
    async (status) => {
      const store = createCanvasStore(persistedJobSnapshot())
      const api = gateway({
        getGenerationJob: vi.fn(async () => {
          throw new GatewayClientError(status, 'upstream_unavailable', sensitiveExternalMessage)
        }),
      })
      const controller = new GenerationController({
        gateway: api,
        store,
        persistProject: persistNoop,
      })

      await controller.resumePersisted()

      const generation = store
        .getState()
        .snapshot.nodes.find((node) => node.id === 'target')?.data.generation
      expect(generation).toMatchObject({
        status: 'generating',
        error: { code: 'poll_unavailable' },
        pendingRequest: { request: generationRequestForResume },
      })
      expectSanitizedMessage(generation?.error?.message)
    },
  )

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [200, 'invalid_response'],
  ] as const)(
    'treats polling HTTP %i/%s as a definitive failure',
    async (status, code) => {
      const store = createCanvasStore(persistedJobSnapshot())
      const api = gateway({
        getGenerationJob: vi.fn(async () => {
          throw new GatewayClientError(status, code, sensitiveExternalMessage)
        }),
      })
      const controller = new GenerationController({
        gateway: api,
        store,
        persistProject: persistNoop,
      })

      await controller.resumePersisted()

      const generation = store
        .getState()
        .snapshot.nodes.find((node) => node.id === 'target')?.data.generation
      expect(api.getGenerationJob).toHaveBeenCalledTimes(1)
      expect(generation).toMatchObject({
        status: 'failed',
        error: { code },
      })
      expect(generation?.pendingRequest).toBeUndefined()
      expectSanitizedMessage(generation?.error?.message)
    },
  )

  it('sanitizes a backend job error before writing it to generation state', async () => {
    const store = createCanvasStore(persistedJobSnapshot())
    const api = gateway({
      getGenerationJob: vi.fn(async (jobId) => job(
        generationRequestForResume,
        'failed',
        {
          id: jobId,
          error: { code: 'upstream_failed', message: sensitiveExternalMessage },
        },
      )),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      persistProject: persistNoop,
    })

    await controller.resumePersisted()

    const generation = store
      .getState()
      .snapshot.nodes.find((node) => node.id === 'target')?.data.generation
    expect(generation).toMatchObject({
      status: 'failed',
      error: { code: 'upstream_failed' },
    })
    expectSanitizedMessage(generation?.error?.message)
  })

  it('blocks generation when migration preserved unresolved legacy references', async () => {
    const unresolved = snapshot()
    unresolved.edges = []
    const target = unresolved.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    target.data.unresolvedReferenceNodeIds = ['missing-reference']
    const store = createCanvasStore(unresolved)
    const api = gateway()
    const controller = new GenerationController({
      gateway: api,
      store,
      persistProject: async () => {},
    })

    await expect(
      controller.start({
        sourceNodeId: 'target',
        targetNodeIds: ['target'],
        prompt: 'invalid references',
      }),
    ).rejects.toMatchObject({ code: 'unresolved_legacy_references' })
    expect(api.createGenerationJob).not.toHaveBeenCalled()
  })

  it('surfaces catalog and idempotency conflicts without auto-resubmitting', async () => {
    const simple = snapshot()
    simple.edges = []
    for (const error of [
      new CatalogChangedGatewayError('refresh'),
      new IdempotencyConflictGatewayError('conflict'),
    ]) {
      const store = createCanvasStore(simple)
      const api = gateway({
        createGenerationJob: vi.fn(async () => {
          throw error
        }),
      })
      const controller = new GenerationController({
        gateway: api,
        store,
        persistProject: persistNoop,
      })

      const rejection = controller.start({
          sourceNodeId: 'target',
          targetNodeIds: ['target'],
          prompt: 'text only',
        }).catch((caught: unknown) => caught)
      await expect(rejection).resolves.not.toBe(error)
      await expect(rejection).resolves.toMatchObject({
        status: error.status,
        code: error.code,
        message: error.message,
      })
      expect(api.createGenerationJob).toHaveBeenCalledTimes(1)
      expect(
        store.getState().snapshot.nodes.find((node) => node.id === 'target'),
      ).toMatchObject({
        data: {
          generation: {
            status: 'failed',
            error: { code: error.code },
          },
        },
      })
    }
  })

  it('aborts polling on dispose without converting the job to failed', async () => {
    const persisted = snapshot()
    const target = persisted.nodes.find((node) => node.id === 'target')!
    if (target.type !== 'video') throw new Error('Expected video')
    target.data.generation = {
      prompt: 'resume',
      status: 'generating',
      phase: 'running',
      sourceNodeId: 'target',
      jobId: 'ed70ebba-8b7d-4d37-86ab-b67bc5d0422e',
      clientRequestId: 'persisted-client-request',
    }
    const store = createCanvasStore(persisted)
    const api = gateway({
      getGenerationJob: vi.fn(
        (_jobId, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
          }),
      ),
    })
    const controller = new GenerationController({
      gateway: api,
      store,
      persistProject: persistNoop,
    })

    const resume = controller.resumePersisted()
    await Promise.resolve()
    controller.dispose()
    await resume

    expect(
      store.getState().snapshot.nodes.find((node) => node.id === 'target'),
    ).toMatchObject({ data: { generation: { status: 'generating' } } })
  })
})

const generationRequestForResume: GenerationRequest = {
  clientRequestId: 'persisted-client-request',
  projectId: 'generation-controller',
  providerId: 'aistartlab',
  catalogVersion: 'catalog-v1',
  mediaType: 'video',
  channel: 27,
  model: 'grok-1.0',
  prompt: 'resume',
  quality: '720p',
  aspectRatio: '16:9',
  n: 1,
  duration: 6,
  mode: 'image2video',
  references: [],
}
