import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenerationRequest } from '../src/contracts/generation.ts'
import { DashScopeAdapter } from './providers/dashscope-adapter.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'continuum-dashscope-'))
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeImageRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    clientRequestId: 'client-ds-1',
    projectId: 'project-1',
    providerId: 'dashscope',
    catalogVersion: 'v1',
    mediaType: 'image',
    channel: 1,
    model: 'wanx-2.1-t2i-plus',
    prompt: '超写实商业人像摄影',
    aspectRatio: '16:9',
    quality: '2K',
    n: 1,
    references: [],
    ...overrides,
  }
}

describe('DashScopeAdapter', () => {
  it('syncs Wanx 2.1 model catalog', async () => {
    const adapter = new DashScopeAdapter({
      apiKey: 'test-ds-key',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      stagingDir: await tempDirectory(),
    })

    const catalog = await adapter.syncCatalog()
    expect(catalog.providerId).toBe('dashscope')
    expect(catalog.models.some((m) => m.model === 'wanx-2.1-t2i-plus')).toBe(true)
    expect(catalog.models.some((m) => m.model === 'wanx-2.1-t2v-plus')).toBe(true)
  })

  it('submits task and polls task output', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (typeof url === 'string' && url.includes('image-synthesis')) {
        return jsonResponse({ output: { task_id: 'ds-task-999' } })
      }
      return jsonResponse({
        output: {
          task_status: 'SUCCEEDED',
          results: [{ url: 'https://dashscope-result.oss.aliyuncs.com/img1.png' }],
        },
      })
    })

    const adapter = new DashScopeAdapter({
      apiKey: 'valid-ds-key',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const taskId = await adapter.createGeneration(makeImageRequest(), [])
    expect(taskId).toBe('ds-task-999')

    const statuses = await adapter.getGenerationStatus([taskId])
    expect(statuses[0]?.status).toBe(3)
    expect(statuses[0]?.outputs).toEqual(['https://dashscope-result.oss.aliyuncs.com/img1.png'])
  })
})
