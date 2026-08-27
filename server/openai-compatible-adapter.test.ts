import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { GenerationRequest } from '../src/contracts/generation.ts'
import { OpenAICompatibleAdapter, openaiCompatibleStagedRefPrefix } from './providers/openai-compatible-adapter.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'libtv-openai-'))
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    clientRequestId: 'client-1',
    projectId: 'project-1',
    providerId: 'openai',
    catalogVersion: 'v1',
    mediaType: 'image',
    channel: 'image',
    model: 'gpt-image-1',
    prompt: 'a red balloon',
    aspectRatio: '1:1',
    n: 1,
    references: [],
    ...overrides,
  }
}

describe('OpenAICompatibleAdapter', () => {
  it('classifies image and video models from /v1/models', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({
      data: [
        { id: 'gpt-image-1', owned_by: 'openai' },
        { id: 'dall-e-3', owned_by: 'openai' },
        { id: 'black-forest-labs/FLUX.1-schnell', owned_by: 'system' },
        { id: 'kling-video-1.6', owned_by: 'kuaishou' },
        { id: 'text-embedding-3-small', owned_by: 'openai' },
      ],
    }))
    const adapter = new OpenAICompatibleAdapter({
      apiKey: 'unit-secret',
      baseUrl: 'https://api.siliconflow.cn/v1',
      fetcher,
      stagingDir: await tempDirectory(),
    })

    const catalog = await adapter.syncCatalog()

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.siliconflow.cn/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer unit-secret' }) }),
    )
    expect(catalog.providerId).toBe('openai-compatible')
    expect(catalog.models.map((model) => model.model)).toEqual([
      'gpt-image-1',
      'dall-e-3',
      'black-forest-labs/FLUX.1-schnell',
      'kling-video-1.6',
    ])
    expect(catalog.models[0]?.mediaType).toBe('image')
    expect(catalog.models[0]?.qualityOptions).toEqual([
      { value: 'standard', label: '标准', pricing: { type: 'fixed_total', credits: 1 } },
    ])
    expect(catalog.models[0]?.inputLimits).toEqual({ images: 4, videos: 0, audios: 0 })
    expect(catalog.models[3]?.mediaType).toBe('video')
    expect(catalog.version).toMatch(/^[0-9a-f]{64}$/)
    const again = await adapter.syncCatalog()
    expect(again.version).toBe(catalog.version)
  })

  it('rejects when /v1/models has no compatible media models', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      data: [{ id: 'text-embedding-3-small', owned_by: 'openai' }],
    }))
    const adapter = new OpenAICompatibleAdapter({
      apiKey: 'unit-secret',
      baseUrl: 'https://api.openai.com/v1',
      fetcher,
      stagingDir: await tempDirectory(),
    })
    await expect(adapter.syncCatalog()).rejects.toThrow('未能从该 OpenAI 兼容端点找到可用的生图或生视频模型')
  })

  it('maps rejected 4xx JSON to ProviderRequestRejectedError', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: { code: 'invalid_api_key', message: 'bad key' },
    }, 401))
    const adapter = new OpenAICompatibleAdapter({
      apiKey: 'bad',
      baseUrl: 'https://api.openai.com/v1',
      fetcher,
      stagingDir: await tempDirectory(),
    })
    await expect(adapter.testConnection()).rejects.toMatchObject({
      name: 'ProviderRequestRejectedError',
      providerCode: 'invalid_api_key',
    })
  })

  it('stages references locally with a synthetic grant and resolves them back', async () => {
    const dir = await tempDirectory()
    const adapter = new OpenAICompatibleAdapter({
      apiKey: 'unit-secret',
      baseUrl: 'https://api.openai.com/v1',
      fetcher: vi.fn<typeof fetch>(),
      stagingDir: dir,
    })
    const grant = await adapter.presignReference({
      filename: 'ref.png',
      contentType: 'image/png',
      size: 8,
      openStream: () => Readable.from(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    })
    expect(grant.fileKey).toMatch(/^ref-[0-9a-f-]{36}$/)
    expect(grant.uploadUrl.startsWith('https://local.invalid')).toBe(true)

    await adapter.uploadReference(
      { filename: 'ref.png', contentType: 'image/png', size: 8, openStream: () => Readable.from(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
      grant,
    )
    const staged = await readFile(join(dir, grant.fileKey))
    expect(staged).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

    const complete = await adapter.completeReference(grant.fileKey)
    expect(complete.url).toBe(`${openaiCompatibleStagedRefPrefix}${grant.fileKey}`)
  })

  it('creates a text2image task, persists it, and returns it from status across instances', async () => {
    const dir = await tempDirectory()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      data: [{ url: 'https://cdn.example/out.png' }],
    }))
    const adapter = new OpenAICompatibleAdapter({
      apiKey: 'unit-secret',
      baseUrl: 'https://api.openai.com/v1',
      fetcher,
      stagingDir: dir,
    })

    const taskId = await adapter.createGeneration(makeRequest(), [])

    expect(taskId).toMatch(/^sync-[0-9a-f-]{36}$/)
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer unit-secret' }),
      }),
    )
    const init = fetcher.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-image-1',
      prompt: 'a red balloon',
      size: '1024x1024',
    })

    const restarted = new OpenAICompatibleAdapter({
      apiKey: 'unit-secret',
      baseUrl: 'https://api.openai.com/v1',
      fetcher: vi.fn<typeof fetch>(),
      stagingDir: dir,
    })
    const first = await restarted.getGenerationStatus([taskId])
    const second = await restarted.getGenerationStatus([taskId])
    expect(first).toEqual([{ taskId, status: 3, outputs: ['https://cdn.example/out.png'] }])
    expect(second).toEqual(first)
  })

  it('creates an image2image edit with FormData and converts b64 output to a data URL', async () => {
    const dir = await tempDirectory()
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      data: [{ b64_json: pngBytes.toString('base64') }],
    }))
    const adapter = new OpenAICompatibleAdapter({
      apiKey: 'unit-secret',
      baseUrl: 'https://api.openai.com/v1',
      fetcher,
      stagingDir: dir,
    })
    const grant = await adapter.presignReference({
      filename: 'ref.png', contentType: 'image/png', size: 8,
      openStream: () => Readable.from(pngBytes),
    })
    await adapter.uploadReference(
      { filename: 'ref.png', contentType: 'image/png', size: 8, openStream: () => Readable.from(pngBytes) },
      grant,
    )

    const taskId = await adapter.createGeneration(
      makeRequest({ references: [] }),
      [{ alias: 1, url: `${openaiCompatibleStagedRefPrefix}${grant.fileKey}`, mediaType: 'image' }],
    )

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/images/edits',
      expect.objectContaining({ method: 'POST' }),
    )
    const init = fetcher.mock.calls[0]?.[1] as RequestInit
    expect(init.body).toBeInstanceOf(FormData)
    const headers = new Headers(init.headers)
    expect(headers.has('content-type')).toBe(false) // undici 生成 multipart boundary
    const [status] = await adapter.getGenerationStatus([taskId])
    expect(status?.outputs?.[0]).toMatch(/^data:image\/png;base64,/)

    // staging 引用文件在生成后被清理
    const remaining = (await readdir(dir)).filter((name) => name.startsWith('ref-'))
    expect(remaining).toHaveLength(0)
  })

  it('maps upstream failures without leaking secrets', async () => {
    const dir = await tempDirectory()
    const timedOutFetcher = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('timeout', 'TimeoutError'))
    const adapter = new OpenAICompatibleAdapter({
      apiKey: 'secret-key',
      baseUrl: 'https://api.openai.com/v1',
      fetcher: timedOutFetcher,
      signalForTimeout: () => AbortSignal.timeout(1),
      stagingDir: dir,
    })
    await expect(adapter.testConnection()).rejects.toThrow('Provider request timed out')

    const fiveHundred = vi.fn<typeof fetch>().mockResolvedValue(new Response('boom', { status: 503 }))
    const failing = new OpenAICompatibleAdapter({
      apiKey: 'secret-key',
      baseUrl: 'https://api.openai.com/v1',
      fetcher: fiveHundred,
      stagingDir: dir,
    })
    await expect(failing.testConnection()).rejects.toThrow('Provider request failed (503)')

    const empty = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [] }))
    const emptyData = new OpenAICompatibleAdapter({
      apiKey: 'secret-key',
      baseUrl: 'https://api.openai.com/v1',
      fetcher: empty,
      stagingDir: dir,
    })
    await expect(emptyData.createGeneration(makeRequest(), [])).rejects.toThrow('Provider returned no output')
  })

  describe('imageRequestMode variants', () => {
    function stagedReference(fileKey: string): { alias: number; url: string; mediaType: 'image' } {
      return {
        alias: 1,
        url: `${openaiCompatibleStagedRefPrefix}${fileKey}`,
        mediaType: 'image',
      }
    }

    it('sends a JSON edits body for openai-json mode', async () => {
      const dir = await tempDirectory()
      const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        data: [{ url: 'https://cdn.example/out.png' }],
      }))
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.openai.com/v1',
        fetcher,
        stagingDir: dir,
        imageRequestMode: 'openai-json',
      })
      const grant = await adapter.presignReference({
        filename: 'ref.png', contentType: 'image/png', size: 8,
        openStream: () => Readable.from(pngBytes),
      })
      await adapter.uploadReference(
        { filename: 'ref.png', contentType: 'image/png', size: 8, openStream: () => Readable.from(pngBytes) },
        grant,
      )

      const taskId = await adapter.createGeneration(makeRequest(), [stagedReference(grant.fileKey)])

      expect(taskId).toMatch(/^sync-/)
      expect(fetcher).toHaveBeenCalledWith(
        'https://api.openai.com/v1/images/edits',
        expect.objectContaining({ method: 'POST' }),
      )
      const init = fetcher.mock.calls[0]?.[1] as RequestInit
      const headers = new Headers(init.headers)
      expect(headers.get('content-type')).toContain('application/json')
      expect(init.body).not.toBeInstanceOf(FormData)
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      expect(body.image).toMatch(/^data:image\/png;base64,/)
    })

    it('sends a responses request with a generate tool for openai-responses mode', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        id: 'resp_123',
        output: [{ type: 'image_generation', content: [{ type: 'image', url: 'https://cdn.example/out.png' }] }],
      }))
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.openai.com/v1',
        fetcher,
        stagingDir: await tempDirectory(),
        imageRequestMode: 'openai-responses',
      })

      const taskId = await adapter.createGeneration(makeRequest(), [])

      expect(taskId).toMatch(/^sync-/)
      expect(fetcher).toHaveBeenCalledWith(
        'https://api.openai.com/v1/responses',
        expect.objectContaining({ method: 'POST' }),
      )
      const init = fetcher.mock.calls[0]?.[1] as RequestInit
      const body = JSON.parse(String(init.body)) as {
        model: string
        input: Array<{ role: string; content: Array<Record<string, unknown>> }>
        tools: Array<{ type: string; action: string }>
      }
      expect(body.model).toBe('gpt-image-1')
      expect(body.input[0]?.content[0]).toEqual({ type: 'input_text', text: 'a red balloon' })
      expect(body.tools[0]).toEqual({ type: 'image_generation', action: 'generate', size: '1024x1024' })
    })

    it('sends an edit action with an inlined image for openai-responses mode', async () => {
      const dir = await tempDirectory()
      const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        id: 'resp_123',
        output: [{ type: 'image_generation', content: [{ type: 'image', url: 'https://cdn.example/out.png' }] }],
      }))
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.openai.com/v1',
        fetcher,
        stagingDir: dir,
        imageRequestMode: 'openai-responses',
      })
      const grant = await adapter.presignReference({
        filename: 'ref.png', contentType: 'image/png', size: 8,
        openStream: () => Readable.from(pngBytes),
      })
      await adapter.uploadReference(
        { filename: 'ref.png', contentType: 'image/png', size: 8, openStream: () => Readable.from(pngBytes) },
        grant,
      )

      await adapter.createGeneration(makeRequest(), [stagedReference(grant.fileKey)])

      const init = fetcher.mock.calls[0]?.[1] as RequestInit
      const body = JSON.parse(String(init.body)) as {
        input: Array<{ content: Array<Record<string, unknown>> }>
        tools: Array<{ action: string }>
      }
      expect(body.tools[0]?.action).toBe('edit')
      const imagePart = body.input[0]?.content.find((part) => part.type === 'input_image')
      expect(imagePart?.image_url).toMatch(/^data:image\/png;base64,/)
    })

    it('parses responses data-array output variants', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        id: 'resp_456',
        output: [{ type: 'image_generation', data: [{ url: 'https://cdn.example/variant.png' }] }],
      }))
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.openai.com/v1',
        fetcher,
        stagingDir: await tempDirectory(),
        imageRequestMode: 'openai-responses',
      })
      const taskId = await adapter.createGeneration(makeRequest(), [])
      expect(taskId).toMatch(/^sync-/)
      const [status] = await adapter.getGenerationStatus([taskId])
      expect(status?.outputs?.[0]).toBe('https://cdn.example/variant.png')
    })
  })

  describe('async task support', () => {
    it('returns the upstream task id when the platform responds asynchronously', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        data: [{ id: 'task_abc123' }],
      }))
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.openai.com/v1',
        fetcher,
        stagingDir: await tempDirectory(),
      })
      const taskId = await adapter.createGeneration(makeRequest(), [])
      expect(taskId).toBe('task_abc123')
      expect(taskId.startsWith('sync-')).toBe(false)
    })

    it('returns a root-level task_id as the async id', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        task_id: 'task_root42',
      }))
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.openai.com/v1',
        fetcher,
        stagingDir: await tempDirectory(),
      })
      expect(await adapter.createGeneration(makeRequest(), [])).toBe('task_root42')
    })

    it('keeps sync responses writing local task files', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        data: [{ url: 'https://cdn.example/sync.png' }],
      }))
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.openai.com/v1',
        fetcher,
        stagingDir: await tempDirectory(),
      })
      expect(await adapter.createGeneration(makeRequest(), [])).toMatch(/^sync-/)
    })

    it('polls the upstream task endpoint and maps statuses', async () => {
      const dir = await tempDirectory()
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = String(input)
        void init
        if (url.endsWith('/images/generations')) {
          return jsonResponse({ data: [{ id: 'task_poll1' }] })
        }
        if (url.endsWith('/tasks/task_poll1')) {
          return jsonResponse({ data: { taskId: 'task_poll1', status: 'running' } })
        }
        return jsonResponse({})
      })
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.openai.com/v1',
        fetcher,
        stagingDir: dir,
      })
      const taskId = await adapter.createGeneration(makeRequest(), [])
      expect(taskId).toBe('task_poll1')
      expect(await adapter.getGenerationStatus([taskId])).toEqual([
        { taskId, status: 2 },
      ])
      expect(fetcher).toHaveBeenCalledWith(
        'https://api.openai.com/v1/tasks/task_poll1',
        expect.anything(),
      )
    })

    it('maps completed/failed/queued statuses from the task endpoint', async () => {
      const dir = await tempDirectory()
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input)
        if (url.endsWith('/images/generations')) {
          return jsonResponse({ data: [{ id: 'task_poll2' }] })
        }
        if (url.endsWith('/tasks/task_poll2')) {
          return jsonResponse({ data: { status: 'completed', outputs: [{ url: 'https://cdn.example/done.png' }] } })
        }
        return jsonResponse({})
      })
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.openai.com/v1',
        fetcher,
        stagingDir: dir,
      })
      const taskId = await adapter.createGeneration(makeRequest(), [])
      expect(await adapter.getGenerationStatus([taskId])).toEqual([
        { taskId, status: 3, outputs: ['https://cdn.example/done.png'] },
      ])

      const failedFetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input)
        if (url.endsWith('/images/generations')) return jsonResponse({ data: [{ id: 'task_fail' }] })
        if (url.endsWith('/tasks/task_fail')) return jsonResponse({ task_id: 'task_fail', status: 'failed' })
        return jsonResponse({})
      })
      const failing = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.openai.com/v1',
        fetcher: failedFetcher,
        stagingDir: dir,
      })
      const failedId = await failing.createGeneration(makeRequest(), [])
      expect(await failing.getGenerationStatus([failedId])).toEqual([{ taskId: failedId, status: 4 }])
    })

    it('treats a missing task endpoint as still running', async () => {
      const dir = await tempDirectory()
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input)
        if (url.endsWith('/images/generations')) return jsonResponse({ data: [{ id: 'task_missing' }] })
        return jsonResponse({}, 404)
      })
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.openai.com/v1',
        fetcher,
        stagingDir: dir,
      })
      const taskId = await adapter.createGeneration(makeRequest(), [])
      expect(await adapter.getGenerationStatus([taskId])).toEqual([{ taskId, status: 2 }])
    })

    it('gracefully falls back to /images/generations when /images/edits returns 404', async () => {
      const dir = await tempDirectory()
      const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input)
        if (url.endsWith('/images/edits')) {
          return jsonResponse({ error: { message: 'Not Found', code: '404' } }, 404)
        }
        if (url.endsWith('/images/generations')) {
          return jsonResponse({ data: [{ url: 'https://cdn.example/fallback-out.png' }] })
        }
        return jsonResponse({}, 404)
      })
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.topapis.cn/v1',
        fetcher,
        stagingDir: dir,
      })
      const grant = await adapter.presignReference({
        filename: 'ref.png', contentType: 'image/png', size: 8,
        openStream: () => Readable.from(pngBytes),
      })
      await adapter.uploadReference(
        { filename: 'ref.png', contentType: 'image/png', size: 8, openStream: () => Readable.from(pngBytes) },
        grant,
      )

      const taskId = await adapter.createGeneration(makeRequest(), [{
        alias: 1,
        url: `${openaiCompatibleStagedRefPrefix}${grant.fileKey}`,
        mediaType: 'image',
      }])

      expect(taskId).toMatch(/^sync-/)
      const [status] = await adapter.getGenerationStatus([taskId])
      expect(status?.outputs?.[0]).toBe('https://cdn.example/fallback-out.png')
    })

    it('submits video generation to /videos/generations and returns task id', async () => {
      const dir = await tempDirectory()
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input)
        if (url.endsWith('/videos/generations')) {
          return jsonResponse({ task_id: 'vid_task_123', status: 'processing' })
        }
        if (url.endsWith('/tasks/vid_task_123')) {
          return jsonResponse({ status: 'completed', video_url: 'https://cdn.example/out.mp4' })
        }
        return jsonResponse({})
      })
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.openai.com/v1',
        fetcher,
        stagingDir: dir,
      })
      const taskId = await adapter.createGeneration(makeRequest({
        mediaType: 'video',
        channel: 'video',
        model: 'kling-v1.5',
      }), [])
      expect(taskId).toBe('vid_task_123')
      const [status] = await adapter.getGenerationStatus([taskId])
      expect(status).toEqual({ taskId: 'vid_task_123', status: 3, outputs: ['https://cdn.example/out.mp4'] })
    })

    it('formats Flux model requests with aspect_ratio and resolution without size', async () => {
      const dir = await tempDirectory()
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const body = JSON.parse(String(init?.body))
        expect(body.size).toBeUndefined()
        expect(body.aspect_ratio).toBe('16:9')
        expect(body.resolution).toBe('2k')
        return jsonResponse({ data: [{ url: 'https://cdn.example/flux-out.png' }] })
      })
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.topapis.cn/v1',
        fetcher,
        stagingDir: dir,
      })
      const taskId = await adapter.createGeneration(makeRequest({
        model: 'flux-2-max-2k',
        aspectRatio: '16:9',
      }), [])
      expect(taskId).toMatch(/^sync-/)
      const [status] = await adapter.getGenerationStatus([taskId])
      expect(status?.outputs?.[0]).toBe('https://cdn.example/flux-out.png')
    })

    it('auto-recovers when upstream rejects size with aspect_ratio instruction', async () => {
      const dir = await tempDirectory()
      let callCount = 0
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        callCount++
        const body = JSON.parse(String(init?.body))
        if (callCount === 1) {
          expect(body.size).toBeDefined()
          return jsonResponse({
            error: { message: 'size is not supported for Custom Max; use resolution and aspect_ratio', code: '400' },
          }, 400)
        }
        expect(body.size).toBeUndefined()
        expect(body.aspect_ratio).toBe('16:9')
        expect(body.resolution).toBe('2k')
        return jsonResponse({ data: [{ url: 'https://cdn.example/recovered.png' }] })
      })
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'unit-secret',
        baseUrl: 'https://api.topapis.cn/v1',
        fetcher,
        stagingDir: dir,
      })
      const taskId = await adapter.createGeneration(makeRequest({
        model: 'custom-diffusion-model',
        aspectRatio: '16:9',
      }), [])
      expect(taskId).toMatch(/^sync-/)
      const [status] = await adapter.getGenerationStatus([taskId])
      expect(status?.outputs?.[0]).toBe('https://cdn.example/recovered.png')
    })
  })
})
