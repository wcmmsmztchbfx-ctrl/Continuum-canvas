import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenerationRequest } from '../src/contracts/generation.ts'
import { VolcengineAdapter } from './providers/volcengine-adapter.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'continuum-volcengine-'))
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeImageRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    clientRequestId: 'client-volc-1',
    projectId: 'project-1',
    providerId: 'volcengine',
    catalogVersion: 'v1',
    mediaType: 'image',
    channel: 1,
    model: 'doubao-image-generation',
    prompt: '唯美国风插画：云雾缭绕的高山流水',
    aspectRatio: '16:9',
    quality: '1K',
    n: 1,
    references: [],
    ...overrides,
  }
}

function makeVideoRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    clientRequestId: 'client-volc-2',
    projectId: 'project-1',
    providerId: 'volcengine',
    catalogVersion: 'v1',
    mediaType: 'video',
    channel: 2,
    model: 'doubao-seedance-2.0',
    prompt: '电影质感：阳光穿过树林洒在地面上',
    aspectRatio: '16:9',
    duration: 5,
    quality: '720p',
    n: 1,
    references: [],
    ...overrides,
  }
}

describe('VolcengineAdapter', () => {
  it('syncs Doubao and Seedance model catalog', async () => {
    const adapter = new VolcengineAdapter({
      apiKey: 'test-volc-key',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      stagingDir: await tempDirectory(),
    })

    const catalog = await adapter.syncCatalog()
    expect(catalog.providerId).toBe('volcengine')
    expect(catalog.models.length).toBeGreaterThanOrEqual(3)
    expect(catalog.models.some((m) => m.model === 'doubao-seedance-2.0')).toBe(true)
    expect(catalog.models.some((m) => m.model === 'doubao-image-generation')).toBe(true)
  })

  it('validates connection by querying /models', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [{ id: 'doubao-seedance-2.0' }],
      }),
    )

    const adapter = new VolcengineAdapter({
      apiKey: 'valid-volc-key',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    await expect(adapter.testConnection()).resolves.toBeUndefined()
  })

  it('rejects connection when API key is empty', async () => {
    const adapter = new VolcengineAdapter({
      apiKey: '   ',
      stagingDir: await tempDirectory(),
    })

    await expect(adapter.testConnection()).rejects.toThrow('API Key 不能为空')
  })

  it('creates image generation request and returns generated result', async () => {
    let capturedBody: any
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.body) capturedBody = JSON.parse(init.body as string)
      return jsonResponse({
        data: [{ url: 'https://ark-output.volces.com/doubao_img.png' }],
      })
    })

    const adapter = new VolcengineAdapter({
      apiKey: 'valid-volc-key',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const taskId = await adapter.createGeneration(makeImageRequest(), [])
    expect(taskId).toMatch(/^volc-direct-/)
    expect(capturedBody.model).toBe('doubao-image-generation')
    expect(capturedBody.prompt).toBe('唯美国风插画：云雾缭绕的高山流水')

    const statuses = await adapter.getGenerationStatus([taskId])
    expect(statuses[0]?.status).toBe(3) // STATUS_COMPLETE
    expect(statuses[0]?.outputs).toEqual(['https://ark-output.volces.com/doubao_img.png'])
  })

  it('creates video generation task on /contents/generations/tasks and polls progress', async () => {
    let capturedBody: any
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (typeof url === 'string' && url.endsWith('/contents/generations/tasks')) {
        if (init?.body) capturedBody = JSON.parse(init.body as string)
        return jsonResponse({
          id: 'volc-task-abc-123',
        })
      }
      return jsonResponse({
        status: 'SUCCEEDED',
        content: {
          video_url: 'https://ark-output.volces.com/doubao_video.mp4',
        },
      })
    })

    const adapter = new VolcengineAdapter({
      apiKey: 'valid-volc-key',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const taskId = await adapter.createGeneration(makeVideoRequest(), [])
    expect(taskId).toBe('volc-task-abc-123')
    expect(capturedBody.model).toBe('doubao-seedance-2.0')
    expect(capturedBody.duration).toBe(5)

    const statuses = await adapter.getGenerationStatus([taskId])
    expect(statuses[0]?.status).toBe(3)
    expect(statuses[0]?.outputs).toEqual(['https://ark-output.volces.com/doubao_video.mp4'])
  })
})
