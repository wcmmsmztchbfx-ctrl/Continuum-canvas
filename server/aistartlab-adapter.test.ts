import { describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { GenerationRequest } from '../src/contracts/generation.ts'
import { AIStartLabAdapter } from './providers/aistartlab-adapter.ts'
import { ProviderRequestRejectedError } from './providers/provider-adapter.ts'

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('AIStartLabAdapter', () => {
  it('does not expose a public whole-pipeline stageReferences method', () => {
    const adapter = new AIStartLabAdapter({ apiKey: 'unit-secret', fetcher: vi.fn() })
    expect(adapter).not.toHaveProperty('stageReferences')
  })

  it('loads the dynamic catalog from the exact official endpoint with bearer auth', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ code: 0, data: {
      imageConfig: [{
        channel: 46, title: 'Image', description: 'Image generation',
        defaultOption: { model: 'gpt-image-2', quality: '1K' }, models: [{
        model: 'gpt-image-2', label: 'GPT',
        qualities: [{
          quality: '1K',
          pricing: { type: 'fixed_total', credits: 6 },
        }],
        aspectRatios: ['1:1'], n: { min: 1, max: 4, options: null }, inputImagesMax: 6,
        inputVideosMax: 0, inputAudiosMax: 0,
      }]}],
      videoConfig: [],
    } }))
    const adapter = new AIStartLabAdapter({ apiKey: 'unit-secret', fetcher })

    await adapter.syncCatalog()

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.video.aistarslab.com/openapi/generation/config',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer unit-secret' }) }),
    )
  })

  it('rejects any non-official OpenAPI base URL before a key can be sent', () => {
    const fetcher = vi.fn<typeof fetch>()

    expect(() => new AIStartLabAdapter({
      apiKey: 'unit-secret',
      baseUrl: 'https://gateway.example.test/custom/openapi/',
      fetcher,
    })).toThrow('official AIStartLab endpoint')
    expect(() => new AIStartLabAdapter({
      apiKey: 'unit-secret',
      baseUrl: 'http://127.0.0.1:4174/openapi',
      fetcher,
    })).toThrow('official AIStartLab endpoint')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uploads through a public pinned PUT stream without inheriting OpenAPI auth', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const uploadCalls: Array<{ url: string; init: Record<string, unknown>; pinnedAddress: string }> = []
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/uploads/presign')) {
        return jsonResponse({ data: {
          fileKey: 'uploads/ref.png',
          uploadUrl: 'https://storage.example/signed-upload',
          method: 'PUT',
          headers: {
            'x-upload-token': 'signed',
            'content-type': 'image/png',
            Authorization: 'Storage signed-authorization',
          },
          expireSeconds: 300,
        } })
      }
      return jsonResponse({ data: { url: 'https://cdn.example/ref.png' } })
    }
    const pinnedFetcher = vi.fn(async (url: string, init: Record<string, unknown>, pinnedAddress: string) => {
      uploadCalls.push({ url, init, pinnedAddress })
      const body = init.body as Readable
      const chunks: Buffer[] = []
      for await (const chunk of body) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      return new Response(null, { status: 200 })
    })
    const adapter = new AIStartLabAdapter({
      apiKey: 'unit-secret', fetcher, pinnedFetcher,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    } as never)

    const reference = {
      filename: 'ref.png',
      contentType: 'image/png',
      size: 8,
      openStream: () => Readable.from([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]),
    }
    const grant = await adapter.presignReference(reference)
    await adapter.uploadReference(reference, grant)
    const staged = await adapter.completeReference(grant.fileKey)

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.video.aistarslab.com/openapi/uploads/presign',
      'https://api.video.aistarslab.com/openapi/uploads/complete',
    ])
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      filename: 'ref.png', contentType: 'image/png', size: 8,
    })
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer unit-secret')
    expect(uploadCalls[0]).toEqual(expect.objectContaining({
      url: 'https://storage.example/signed-upload', pinnedAddress: '93.184.216.34',
    }))
    expect(uploadCalls[0].init.method).toBe('PUT')
    expect(new Headers(uploadCalls[0].init.headers as HeadersInit).get('authorization')).toBe('Storage signed-authorization')
    expect(new Headers(uploadCalls[0].init.headers as HeadersInit).get('x-upload-token')).toBe('signed')
    expect(uploadCalls[0].init.body).toBeInstanceOf(Readable)
    expect(calls.every((call) => call.init?.signal instanceof AbortSignal)).toBe(true)
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ fileKey: 'uploads/ref.png' })
    expect(grant.expiresAt).toBeGreaterThan(Date.now())
    expect(staged).toEqual({ url: 'https://cdn.example/ref.png' })
  })

  it('rejects private upload destinations and storage redirects before exposing signed data', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ data: {
      fileKey: 'uploads/ref.png', uploadUrl: 'https://storage.example/upload', method: 'PUT',
      headers: { 'x-amz-token': 'signed' }, expireSeconds: 300,
    } }))
    const pinnedFetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://other.example' } }))
    const privateAdapter = new AIStartLabAdapter({
      apiKey: 'unit-secret', fetcher, pinnedFetcher,
      lookup: async () => [{ address: '10.0.0.2', family: 4 }],
    } as never)
    const reference = {
      filename: 'ref.png', contentType: 'image/png', size: 8,
      openStream: () => Readable.from([new Uint8Array(8)]),
    }
    const privateGrant = await privateAdapter.presignReference(reference as never)
    await expect(privateAdapter.uploadReference(reference as never, privateGrant)).rejects.toThrow('public')
    expect(pinnedFetcher).not.toHaveBeenCalled()

    const redirectAdapter = new AIStartLabAdapter({
      apiKey: 'unit-secret', fetcher, pinnedFetcher,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    } as never)
    const redirectGrant = await redirectAdapter.presignReference(reference as never)
    await expect(redirectAdapter.uploadReference(reference as never, redirectGrant)).rejects.toThrow('redirect')
  })

  it.each([
    [{ uploadUrl: 'http://storage.example/upload', method: 'PUT', headers: {} }, 'HTTPS'],
    [{ uploadUrl: 'https://storage.example/upload', method: 'PATCH', headers: {} }, 'PUT'],
    [{ uploadUrl: 'https://storage.example/upload', method: 'PUT', headers: { host: 'evil.example' } }, 'headers'],
    [{ uploadUrl: 'https://user:pass@storage.example/upload', method: 'PUT', headers: {} }, 'HTTPS'],
  ])('rejects unsafe presigned upload authorization %#', async (grant, message) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: {
      fileKey: 'uploads/ref.png', expireSeconds: 300, ...grant,
    } }))
    const adapter = new AIStartLabAdapter({ apiKey: 'unit-secret', fetcher })

    await expect(adapter.presignReference({
      filename: 'ref.png', contentType: 'image/png', size: 8,
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    })).rejects.toThrow(message)
  })

  it('applies a configurable timeout signal and sanitizes timeout errors', async () => {
    const timeout = AbortSignal.abort(new DOMException('Bearer unit-secret https://secret.example', 'TimeoutError'))
    const signalForTimeout = vi.fn(() => timeout)
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBe(timeout)
      throw timeout.reason
    })
    const adapter = new AIStartLabAdapter({
      apiKey: 'unit-secret', fetcher, timeoutMs: 1_234, signalForTimeout,
    } as never)

    await expect(adapter.testConnection()).rejects.toThrow('Provider request timed out')
    expect(signalForTimeout).toHaveBeenCalledWith(1_234)
    await expect(adapter.testConnection()).rejects.not.toThrow('unit-secret')
  })

  it('cancels OpenAPI and storage response bodies on rejected responses', async () => {
    const openApiCancelled = vi.fn()
    const storageCancelled = vi.fn()
    const openApiBody = new ReadableStream({ cancel: openApiCancelled })
    const storageBody = new ReadableStream({ cancel: storageCancelled })
    const openApiAdapter = new AIStartLabAdapter({
      apiKey: 'unit-secret',
      fetcher: async () => new Response(openApiBody, { status: 503 }),
    })
    await expect(openApiAdapter.testConnection()).rejects.toThrow('Provider request failed')
    expect(openApiCancelled).toHaveBeenCalledTimes(1)

    const storageAdapter = new AIStartLabAdapter({
      apiKey: 'unit-secret',
      pinnedFetcher: async () => new Response(storageBody, { status: 403 }),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    await expect(storageAdapter.uploadReference({
      filename: 'ref.png', contentType: 'image/png', size: 8,
      openStream: () => Readable.from([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]),
    }, {
      fileKey: 'file-key', uploadUrl: 'https://storage.example/upload', method: 'PUT',
      headers: { 'x-amz-signed': 'value' }, expiresAt: Date.now() + 60_000,
    })).rejects.toThrow('Reference upload failed')
    expect(storageCancelled).toHaveBeenCalledTimes(1)
  })

  it('preserves a bounded provider rejection reason without classifying it as an ambiguous create', async () => {
    const adapter = new AIStartLabAdapter({
      apiKey: 'unit-secret',
      fetcher: async () => jsonResponse({ code: 40017, msg: 'Prompt is too long' }),
    })

    await expect(adapter.createGeneration({
      clientRequestId: 'client-rejected', providerId: 'aistartlab', mediaType: 'video',
      channel: 37, model: 'seedance-2.0', prompt: 'portrait', quality: '720p',
      aspectRatio: '16:9', duration: 15, mode: 'image2video', generateAudio: false,
      references: [],
    }, [])).rejects.toEqual(expect.objectContaining({
      constructor: ProviderRequestRejectedError,
      providerCode: '40017',
      message: 'Provider rejected the request: Prompt is too long',
    }))
  })

  it('creates image and video tasks with the official request shapes and preserves reference order', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return jsonResponse({ data: { taskId: `task-${requests.length}` } })
    }
    const adapter = new AIStartLabAdapter({ apiKey: 'unit-secret', fetcher })
    const base: GenerationRequest = {
      clientRequestId: 'client-1', providerId: 'aistartlab', mediaType: 'image',
      channel: 46, model: 'gpt-image-2', prompt: 'portrait', quality: '1K',
      aspectRatio: '1:1', n: 1, references: [],
    }

    await adapter.createGeneration(base, [
      { mediaType: 'image', url: 'https://cdn.example/alias-2.png', alias: 2 },
      { mediaType: 'image', url: 'https://cdn.example/alias-1.png', alias: 1 },
    ])
    await adapter.createGeneration({
      ...base, clientRequestId: 'client-2', mediaType: 'video', prompt: '@1 then @2',
      channel: 27, model: 'grok-imagine-video', quality: '720P', duration: 6,
      mode: 'image2video', generateAudio: true, n: undefined,
    }, [
      { mediaType: 'image', url: 'https://cdn.example/alias-1.png', alias: 1 },
      { mediaType: 'image', url: 'https://cdn.example/alias-2.png', alias: 2 },
    ])

    expect(requests).toEqual([
      {
        url: 'https://api.video.aistarslab.com/openapi/generation/create/image',
        body: {
          channel: 46, model: 'gpt-image-2', prompt: 'portrait', quality: '1K',
          aspectRatio: '1:1', n: 1,
          inputImages: ['https://cdn.example/alias-1.png', 'https://cdn.example/alias-2.png'],
        },
      },
      {
        url: 'https://api.video.aistarslab.com/openapi/generation/create/video',
        body: {
          channel: 27, model: 'grok-imagine-video', prompt: '@1 then @2', quality: '720P',
          aspectRatio: '1:1', duration: 6, mode: 'image2video', generateAudio: true,
          inputImages: ['https://cdn.example/alias-1.png', 'https://cdn.example/alias-2.png'],
        },
      },
    ])
  })

  it('queries batch status through the official endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [{ taskId: 'task-1', status: 3 }] }))
    const adapter = new AIStartLabAdapter({ apiKey: 'unit-secret', fetcher })

    const result = await adapter.getGenerationStatus(['task-1'])

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.video.aistarslab.com/openapi/generation/status/batch',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ taskIds: ['task-1'] }) }),
    )
    expect(result).toEqual([{ taskId: 'task-1', status: 3 }])
  })

  it('loads task detail from the exact documented endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: {
      taskId: 'task-1', status: 3, outputs: ['https://cdn.example/result.png'],
    } }))
    const adapter = new AIStartLabAdapter({ apiKey: 'unit-secret', fetcher })

    const result = await adapter.getGenerationDetail('task-1')

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.video.aistarslab.com/openapi/generation/detail?taskId=task-1',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer unit-secret' }) }),
    )
    expect(result.outputs).toEqual(['https://cdn.example/result.png'])
  })
})
