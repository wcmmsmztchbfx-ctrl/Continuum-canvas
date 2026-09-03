import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenerationRequest } from '../src/contracts/generation.ts'
import { MiniMaxAdapter } from './providers/minimax-adapter.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'continuum-minimax-'))
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeVideoRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    clientRequestId: 'client-minimax-1',
    projectId: 'project-1',
    providerId: 'minimax',
    catalogVersion: 'v1',
    mediaType: 'video',
    channel: 'video',
    model: 'MiniMax-H3',
    prompt: '电影级镜头：女舰长站在星舰舷窗前',
    aspectRatio: '16:9',
    duration: 5,
    quality: '2K',
    n: 1,
    references: [],
    ...overrides,
  }
}

describe('MiniMaxAdapter', () => {
  it('authenticates and syncs MiniMax-H3 video model catalog', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        error: { code: '2013', message: 'invalid task_id' },
      }, 400),
    )

    const adapter = new MiniMaxAdapter({
      apiKey: 'test-minimax-key',
      baseUrl: 'https://api.minimaxi.com',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const catalog = await adapter.syncCatalog()
    expect(catalog.providerId).toBe('minimax')
    expect(catalog.models.length).toBe(1)
    expect(catalog.models[0]?.model).toBe('MiniMax-H3')
    expect(catalog.models[0]?.mediaType).toBe('video')
    expect(catalog.models[0]?.qualityOptions?.map((q) => q.value)).toEqual(['2K', '768P'])
    expect(catalog.models[0]?.durationOptions).toContain(5)
    expect(catalog.models[0]?.durationOptions).toContain(15)
  })

  it('rejects with 401 when API Key is unauthorized', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        type: 'error',
        error: { type: 'authorized_error', message: 'login fail: invalid api key', code: '1004' },
      }, 401),
    )

    const adapter = new MiniMaxAdapter({
      apiKey: 'bad-key',
      baseUrl: 'https://api.minimaxi.com',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    await expect(adapter.testConnection()).rejects.toThrow('API Key 无效或鉴权失败')
  })

  it('creates video generation request with prompt and parameters', async () => {
    let capturedBody: any
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string)
      }
      return jsonResponse({
        task_id: 'task-h3-123456',
      })
    })

    const adapter = new MiniMaxAdapter({
      apiKey: 'valid-key',
      baseUrl: 'https://api.minimaxi.com',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const taskId = await adapter.createGeneration(makeVideoRequest(), [])
    expect(taskId).toBe('task-h3-123456')
    expect(capturedBody).toEqual({
      model: 'MiniMax-H3',
      content: [
        {
          type: 'text',
          text: '电影级镜头：女舰长站在星舰舷窗前',
        },
      ],
      resolution: '2K',
      duration: 5,
      ratio: '16:9',
      aigc_watermark: false,
    })
  })

  it('creates image-to-video request with first_frame role', async () => {
    const staging = await tempDirectory()
    await writeFile(join(staging, 'test-img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    let capturedBody: any
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string)
      }
      return jsonResponse({
        task_id: 'task-h3-i2v',
      })
    })

    const adapter = new MiniMaxAdapter({
      apiKey: 'valid-key',
      baseUrl: 'https://api.minimaxi.com',
      fetcher,
      stagingDir: staging,
    })

    const taskId = await adapter.createGeneration(
      makeVideoRequest({ mode: 'first_frame' }),
      [{ url: 'https://local.invalid/ref/test-img.png' }],
    )

    expect(taskId).toBe('task-h3-i2v')
    expect(capturedBody.content.length).toBe(2)
    expect(capturedBody.content[1].role).toBe('first_frame')
    expect(capturedBody.ratio).toBe('adaptive')
  })

  it('polls generation detail and returns status complete on success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        task: {
          id: 'task-h3-123456',
          model: 'MiniMax-H3',
          status: 'succeeded',
          content: {
            url: 'https://cdn.example.com/h3-output.mp4',
          },
        },
      }),
    )

    const adapter = new MiniMaxAdapter({
      apiKey: 'valid-key',
      baseUrl: 'https://api.minimaxi.com',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const detail = await adapter.getGenerationDetail('task-h3-123456')
    expect(detail.status).toBe(3)
    expect(detail.outputs).toEqual(['https://cdn.example.com/h3-output.mp4'])
    expect(detail.progress).toBe(100)
  })

  it('handles failed task query properly', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        task: {
          id: 'task-h3-failed',
          model: 'MiniMax-H3',
          status: 'failed',
          error: {
            code: '1026',
            message: 'sensitive content detected',
          },
        },
      }),
    )

    const adapter = new MiniMaxAdapter({
      apiKey: 'valid-key',
      baseUrl: 'https://api.minimaxi.com',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const detail = await adapter.getGenerationDetail('task-h3-failed')
    expect(detail.status).toBe(4)
    expect(detail.errorCode).toBe('1026')
    expect(detail.errorMessage).toBe('sensitive content detected')
  })
})
