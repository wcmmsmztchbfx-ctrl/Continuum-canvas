import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenerationRequest } from '../src/contracts/generation.ts'
import { ModelScopeAdapter } from './providers/modelscope-adapter.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'continuum-modelscope-'))
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    clientRequestId: 'client-ms-1',
    projectId: 'project-1',
    providerId: 'modelscope',
    catalogVersion: 'v1',
    mediaType: 'image',
    channel: 1,
    model: 'FLUX.1-dev',
    prompt: '国风水墨画：青山绿水',
    aspectRatio: '16:9',
    quality: '1K',
    n: 1,
    references: [],
    ...overrides,
  }
}

describe('ModelScopeAdapter', () => {
  it('syncs ModelScope free model catalog', async () => {
    const adapter = new ModelScopeAdapter({
      apiKey: 'test-ms-token',
      baseUrl: 'https://api-inference.modelscope.cn/v1',
      stagingDir: await tempDirectory(),
    })

    const catalog = await adapter.syncCatalog()
    expect(catalog.providerId).toBe('modelscope')
    expect(catalog.models.some((m) => m.model === 'FLUX.1-dev')).toBe(true)
    expect(catalog.models.some((m) => m.model === 'Kolors')).toBe(true)
  })

  it('verifies connection by querying /models', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: [{ id: 'FLUX.1-dev' }] }),
    )

    const adapter = new ModelScopeAdapter({
      apiKey: 'valid-ms-token',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    await expect(adapter.testConnection()).resolves.toBeUndefined()
  })

  it('submits image generation task and polls task output', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (typeof url === 'string' && url.endsWith('/tasks')) {
        return jsonResponse({ task_id: 'ms-task-1234' })
      }
      return jsonResponse({
        task_status: 'SUCCEED',
        output_images: ['https://modelscope.cn/outputs/img_1.png'],
      })
    })

    const adapter = new ModelScopeAdapter({
      apiKey: 'valid-ms-token',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const taskId = await adapter.createGeneration(makeRequest(), [])
    expect(taskId).toBe('ms-task-1234')

    const statuses = await adapter.getGenerationStatus([taskId])
    expect(statuses[0]?.status).toBe(3)
    expect(statuses[0]?.outputs).toEqual(['https://modelscope.cn/outputs/img_1.png'])
  })
})
