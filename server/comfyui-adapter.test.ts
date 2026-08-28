import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenerationRequest } from '../src/contracts/generation.ts'
import { ComfyUIAdapter } from './providers/comfyui-adapter.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'continuum-comfyui-'))
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    clientRequestId: 'client-comfy-1',
    projectId: 'project-1',
    providerId: 'comfyui',
    catalogVersion: 'v1',
    mediaType: 'image',
    channel: 1,
    model: 'comfyui-flux-local',
    prompt: '赛博朋克城市',
    aspectRatio: '1:1',
    quality: '1K',
    n: 1,
    references: [],
    ...overrides,
  }
}

describe('ComfyUIAdapter', () => {
  it('syncs local ComfyUI model catalog', async () => {
    const adapter = new ComfyUIAdapter({
      baseUrl: 'http://127.0.0.1:8188',
      stagingDir: await tempDirectory(),
    })

    const catalog = await adapter.syncCatalog()
    expect(catalog.providerId).toBe('comfyui')
    expect(catalog.models.some((m) => m.model === 'comfyui-flux-local')).toBe(true)
    expect(catalog.models.some((m) => m.model === 'comfyui-animatediff-local')).toBe(true)
  })

  it('submits prompt workflow and fetches output image url from history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (typeof url === 'string' && url.endsWith('/prompt')) {
        return jsonResponse({ prompt_id: 'prompt-7788' })
      }
      return jsonResponse({
        'prompt-7788': {
          outputs: {
            '9': {
              images: [{ filename: 'Continuum_0001.png', subfolder: '', type: 'output' }],
            },
          },
        },
      })
    })

    const adapter = new ComfyUIAdapter({
      baseUrl: 'http://127.0.0.1:8188',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const promptId = await adapter.createGeneration(makeRequest(), [])
    expect(promptId).toBe('prompt-7788')

    const statuses = await adapter.getGenerationStatus([promptId])
    expect(statuses[0]?.status).toBe(3)
    expect(statuses[0]?.outputs?.[0]).toContain('/view?filename=Continuum_0001.png')
  })
})
