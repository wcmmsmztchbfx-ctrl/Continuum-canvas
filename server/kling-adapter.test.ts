import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenerationRequest } from '../src/contracts/generation.ts'
import { KlingAdapter } from './providers/kling-adapter.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'continuum-kling-'))
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeVideoRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    clientRequestId: 'client-kling-1',
    projectId: 'project-1',
    providerId: 'kling',
    catalogVersion: 'v1',
    mediaType: 'video',
    channel: 2,
    model: 'kling-v1-5',
    prompt: '电影镜头：无人机飞过蔚蓝海岸线',
    aspectRatio: '16:9',
    duration: 5,
    quality: '720p',
    n: 1,
    references: [],
    ...overrides,
  }
}

describe('KlingAdapter', () => {
  it('syncs Kling video model catalog', async () => {
    const adapter = new KlingAdapter({
      apiKey: 'test-kling-key',
      baseUrl: 'https://api.klingai.com/v1',
      stagingDir: await tempDirectory(),
    })

    const catalog = await adapter.syncCatalog()
    expect(catalog.providerId).toBe('kling')
    expect(catalog.models.some((m) => m.model === 'kling-v1-5')).toBe(true)
    expect(catalog.models.some((m) => m.model === 'kling-v2')).toBe(true)
  })

  it('submits video task and polls result', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (typeof url === 'string' && url.includes('/videos/text2video') && !url.includes('kling-task-123')) {
        return jsonResponse({ data: { task_id: 'kling-task-123' } })
      }
      return jsonResponse({
        data: {
          task_status: 'succeed',
          task_result: {
            videos: [{ url: 'https://kling-cdn.kuaishou.com/vid1.mp4' }],
          },
        },
      })
    })

    const adapter = new KlingAdapter({
      apiKey: 'valid-kling-key',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const taskId = await adapter.createGeneration(makeVideoRequest(), [])
    expect(taskId).toBe('kling-task-123')

    const statuses = await adapter.getGenerationStatus([taskId])
    expect(statuses[0]?.status).toBe(3)
    expect(statuses[0]?.outputs).toEqual(['https://kling-cdn.kuaishou.com/vid1.mp4'])
  })
})
