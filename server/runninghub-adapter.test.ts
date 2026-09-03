import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenerationRequest } from '../src/contracts/generation.ts'
import { RunningHubAdapter } from './providers/runninghub-adapter.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'continuum-runninghub-'))
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeImageRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    clientRequestId: 'client-rh-1',
    projectId: 'project-1',
    providerId: 'runninghub',
    catalogVersion: 'v1',
    mediaType: 'image',
    channel: 1,
    model: 'runninghub-flux-schnell',
    prompt: '未来科技城市，赛博朋克霓虹夜景',
    aspectRatio: '16:9',
    quality: '1K',
    n: 1,
    references: [],
    ...overrides,
  }
}

function makeVideoRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    clientRequestId: 'client-rh-2',
    projectId: 'project-1',
    providerId: 'runninghub',
    catalogVersion: 'v1',
    mediaType: 'video',
    channel: 2,
    model: 'runninghub-kling-video',
    prompt: '超高清：一只金毛犬在草地上奔跑',
    aspectRatio: '16:9',
    duration: 5,
    quality: '720p',
    n: 1,
    references: [],
    ...overrides,
  }
}

describe('RunningHubAdapter', () => {
  it('syncs RunningHub image and video model catalog', async () => {
    const adapter = new RunningHubAdapter({
      apiKey: 'test-rh-key',
      baseUrl: 'https://www.runninghub.cn',
      stagingDir: await tempDirectory(),
    })

    const catalog = await adapter.syncCatalog()
    expect(catalog.providerId).toBe('runninghub')
    expect(catalog.models.length).toBeGreaterThanOrEqual(4)
    expect(catalog.models.some((m) => m.model === 'runninghub-flux-schnell')).toBe(true)
    expect(catalog.models.some((m) => m.model === 'runninghub-kling-video')).toBe(true)
  })

  it('verifies connection using task outputs probe', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        code: 0,
        data: { taskId: 'probe' },
      }),
    )

    const adapter = new RunningHubAdapter({
      apiKey: 'valid-key',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    await expect(adapter.testConnection()).resolves.toBeUndefined()
  })

  it('rejects connection when API key is empty', async () => {
    const adapter = new RunningHubAdapter({
      apiKey: '  ',
      stagingDir: await tempDirectory(),
    })

    await expect(adapter.testConnection()).rejects.toThrow('API Key 不能为空')
  })

  it('creates image generation request and extracts taskId', async () => {
    let capturedBody: any
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.body) capturedBody = JSON.parse(init.body as string)
      return jsonResponse({
        code: 0,
        msg: 'success',
        data: { taskId: 'rh-task-9988' },
      })
    })

    const adapter = new RunningHubAdapter({
      apiKey: 'valid-rh-key',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const taskId = await adapter.createGeneration(makeImageRequest(), [])
    expect(taskId).toBe('rh-task-9988')
    expect(capturedBody.model).toBe('runninghub-flux-schnell')
    expect(capturedBody.prompt).toBe('未来科技城市，赛博朋克霓虹夜景')
    expect(capturedBody.aspectRatio).toBe('16:9')
  })

  it('creates video generation request with duration and quality', async () => {
    let capturedBody: any
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.body) capturedBody = JSON.parse(init.body as string)
      return jsonResponse({
        code: 0,
        data: { taskId: 'rh-video-task-1122' },
      })
    })

    const adapter = new RunningHubAdapter({
      apiKey: 'valid-rh-key',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const taskId = await adapter.createGeneration(makeVideoRequest(), [])
    expect(taskId).toBe('rh-video-task-1122')
    expect(capturedBody.model).toBe('runninghub-kling-video')
    expect(capturedBody.duration).toBe(5)
    expect(capturedBody.resolution).toBe('720p')
  })

  it('polls task outputs and returns complete status when code 0', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        code: 0,
        data: [
          { fileUrl: 'https://output.runninghub.cn/image_123.png' },
        ],
      }),
    )

    const adapter = new RunningHubAdapter({
      apiKey: 'valid-rh-key',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const statuses = await adapter.getGenerationStatus(['rh-task-9988'])
    expect(statuses[0]?.status).toBe(3) // STATUS_COMPLETE
    expect(statuses[0]?.progress).toBe(100)
    expect(statuses[0]?.outputs).toEqual(['https://output.runninghub.cn/image_123.png'])
  })

  it('polls task outputs and returns running status when code is 804 or 813', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        code: 804,
        msg: 'Task running',
      }),
    )

    const adapter = new RunningHubAdapter({
      apiKey: 'valid-rh-key',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const statuses = await adapter.getGenerationStatus(['rh-task-9988'])
    expect(statuses[0]?.status).toBe(1) // STATUS_RUNNING
  })
})
