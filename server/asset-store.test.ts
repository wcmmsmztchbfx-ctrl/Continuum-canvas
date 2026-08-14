import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { crc32 } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { AssetStore } from './asset-store.ts'

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 1, 2, 3, 4])
const MP3 = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0])
const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function pngSignatureBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set(PNG)
  return bytes
}

function validPngBytes(size: number): Uint8Array {
  const dataLength = size - MINIMAL_PNG.byteLength - 12
  if (dataLength <= 8) throw new RangeError('PNG fixture size is too small')
  const chunk = Buffer.alloc(12 + dataLength, 0x61)
  chunk.writeUInt32BE(dataLength, 0)
  chunk.write('tEXt', 4, 'ascii')
  chunk.write('Comment\0', 8, 'latin1')
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + dataLength)), 8 + dataLength)
  return Buffer.concat([
    MINIMAL_PNG.subarray(0, -12),
    chunk,
    MINIMAL_PNG.subarray(-12),
  ])
}

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'libtv-assets-'))
}

describe('AssetStore', () => {
  it('deletes only candidate assets absent from the complete reference set', async () => {
    const dataDir = await tempDirectory()
    const store = await AssetStore.open({ dataDir })
    const removable = await store.save({ filename: 'removable.png', contentType: 'image/png', bytes: PNG })
    const retained = await store.save({ filename: 'retained.png', contentType: 'image/png', bytes: PNG })

    await expect(store.deleteUnreferenced(
      [removable.id, retained.id],
      new Set([retained.id]),
    )).resolves.toEqual([removable.id])
    expect(store.get(removable.id)).toBeUndefined()
    expect(store.get(retained.id)).toEqual(expect.objectContaining({ id: retained.id }))
    const reopened = await AssetStore.open({ dataDir })
    expect(reopened.get(removable.id)).toBeUndefined()
    expect(reopened.get(retained.id)).toBeDefined()
  })
  it('uses the configured timeout for each remote asset request', async () => {
    const timeoutSignal = new AbortController().signal
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal)
    try {
      const store = await AssetStore.open({
        dataDir: await tempDirectory(),
        assetImportTimeoutMs: 45_000,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        pinnedFetcher: async () => new Response(PNG, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      })

      await store.importRemote('https://public.example/reference.png')

      expect(timeout).toHaveBeenCalledWith(45_000)
    } finally {
      timeout.mockRestore()
    }
  })

  it('converts its download timeout into a diagnostic error without retaining the URL', async () => {
    const sourceUrl = 'https://public.example/reference.png?token=source-secret'
    const reason = new DOMException(`Timed out downloading ${sourceUrl}`, 'TimeoutError')
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(reason))
    try {
      const store = await AssetStore.open({
        dataDir: await tempDirectory(),
        assetImportTimeoutMs: 45_000,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        pinnedFetcher: async () => { throw new Error('fetch should observe the aborted signal') },
      })

      const error = await store.importRemote(sourceUrl).catch((caught: unknown) => caught)

      expect(error).toMatchObject({
        code: 'asset_import_timeout',
        message: 'Remote asset import timed out',
      })
      expect(String((error as Error).message)).not.toContain(sourceUrl)
      expect(String((error as Error).message)).not.toContain('source-secret')
    } finally {
      timeout.mockRestore()
    }
  })

  it('removes only recognized orphan upload temp files during initialization', async () => {
    const dataDir = await tempDirectory()
    const filesRoot = join(dataDir, 'assets', 'files')
    await mkdir(filesRoot, { recursive: true })
    const recognized = '.asset-upload-11111111-1111-4111-8111-111111111111.tmp'
    const preserved = ['.user-notes.tmp', '.11111111-1111-4111-8111-111111111111.tmp', '.asset-upload-not-a-uuid.tmp']
    await writeFile(join(filesRoot, recognized), 'partial upload')
    await Promise.all(preserved.map((name) => writeFile(join(filesRoot, name), 'keep me')))

    await AssetStore.open({ dataDir })

    const names = await readdir(filesRoot)
    expect(names).not.toContain(recognized)
    expect(names).toEqual(expect.arrayContaining(preserved))
  })

  it('reconciles a crash-window UUID asset file without deleting indexed or unrelated files', async () => {
    const dataDir = await tempDirectory()
    const first = await AssetStore.open({ dataDir })
    const indexed = await first.save({ filename: 'indexed.png', contentType: 'image/png', bytes: PNG })
    const filesRoot = join(dataDir, 'assets', 'files')
    const orphan = '22222222-2222-4222-8222-222222222222.bin'
    const unrelated = ['notes.bin', 'not-a-uuid.bin', '.private-user-file']
    const matchingDirectory = '33333333-3333-4333-8333-333333333333.bin'
    await writeFile(join(filesRoot, orphan), PNG)
    await Promise.all(unrelated.map((name) => writeFile(join(filesRoot, name), 'keep me')))
    await mkdir(join(filesRoot, matchingDirectory))

    const reopened = await AssetStore.open({ dataDir })

    const names = await readdir(filesRoot)
    expect(names).toContain(`${indexed.id}.bin`)
    expect(names).not.toContain(orphan)
    expect(names).toEqual(expect.arrayContaining([...unrelated, matchingDirectory]))
    expect(await reopened.readBytes(indexed.id)).toEqual(PNG)
  })

  it('persists a bounded readable stream without requiring a whole-file byte array', async () => {
    const store = await AssetStore.open({ dataDir: await tempDirectory() })
    const chunks = [PNG.slice(0, 5), PNG.slice(5, 9), PNG.slice(9)]

    const asset = await store.saveStream({
      filename: 'streamed.png', contentType: 'image/png', expectedSize: PNG.length,
      stream: Readable.from(chunks),
    })

    expect(asset.size).toBe(PNG.length)
    expect(await store.readBytes(asset.id)).toEqual(PNG)
  })

  it('aborts and removes a partial streamed asset as soon as its limit is exceeded', async () => {
    const dataDir = await tempDirectory()
    const store = await AssetStore.open({ dataDir })
    const source = Readable.from([PNG.slice(0, 8), PNG.slice(8), new Uint8Array([1])])
    const destroyed = vi.spyOn(source, 'destroy')

    await expect(store.saveStream({
      filename: 'streamed.png', contentType: 'image/png', maxSize: PNG.length,
      stream: source,
    })).rejects.toThrow('size')

    expect(destroyed).toHaveBeenCalled()
  })
  it('persists valid uploads and rejects content whose magic does not match its MIME type', async () => {
    const dataDir = await tempDirectory()
    const store = await AssetStore.open({ dataDir })

    const asset = await store.save({ filename: 'reference.png', contentType: 'image/png', bytes: PNG })
    await expect(store.save({
      filename: 'spoofed.png', contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]),
    })).rejects.toThrow('signature')

    expect(asset).toEqual(expect.objectContaining({
      filename: 'reference.png', contentType: 'image/png', size: PNG.length,
      url: `/api/assets/${asset.id}`,
    }))
    const reopened = await AssetStore.open({ dataDir })
    expect(await reopened.readBytes(asset.id)).toEqual(PNG)
  })

  it('returns a satisfiable byte range for persisted video', async () => {
    const store = await AssetStore.open({ dataDir: await tempDirectory() })
    const asset = await store.save({ filename: 'clip.mp4', contentType: 'video/mp4', bytes: MP4 })

    const range = await store.openResponse(asset.id, 'bytes=4-8')

    expect(range.status).toBe(206)
    expect(range.headers).toEqual(expect.objectContaining({
      'accept-ranges': 'bytes',
      'content-range': `bytes 4-8/${MP4.length}`,
      'content-length': '5',
    }))
    const chunks: Buffer[] = []
    for await (const chunk of range.stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(MP4.slice(4, 9)))
  })

  it('accepts documented MIME aliases and enforces filename extension consistency', async () => {
    const store = await AssetStore.open({ dataDir: await tempDirectory() })

    const audio = await store.save({ filename: 'voice.mp3', contentType: 'audio/mp3', bytes: MP3 })
    expect(audio.contentType).toBe('audio/mpeg')
    await expect(store.save({ filename: 'photo.png', contentType: 'image/jpeg', bytes: PNG }))
      .rejects.toThrow('extension')
    await expect(store.save({ filename: 'clip.wmv', contentType: 'video/x-ms-wmv', bytes: MP4 }))
      .rejects.toThrow('signature')
  })

  it('disables remote import by default because an ordinary fetch is vulnerable to DNS rebinding', async () => {
    const store = await AssetStore.open({ dataDir: await tempDirectory() })
    await expect(store.importRemote('https://public.example/reference.png')).rejects.toThrow('disabled')
  })

  it('rejects loopback, private DNS results, and redirects to private destinations', async () => {
    const lookup = vi.fn(async (hostname: string) => [{
      address: hostname === 'public.example' ? '93.184.216.34' : '10.10.0.2',
      family: 4,
    }])
    const pinnedFetcher = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'http://private.example/asset.png' },
    }))
    const store = await AssetStore.open({
      dataDir: await tempDirectory(), lookup,
      fetcher: pinnedFetcher as typeof fetch,
      pinnedFetcher,
    } as never)

    await expect(store.importRemote('http://127.0.0.1/asset.png')).rejects.toThrow('public')
    await expect(store.importRemote('https://private.example/asset.png')).rejects.toThrow('public')
    await expect(store.importRemote('https://public.example/asset.png')).rejects.toThrow('public')
    expect(pinnedFetcher).toHaveBeenCalledTimes(1)
    expect(pinnedFetcher.mock.calls[0][2]).toBe('93.184.216.34')
  })

  it.each([
    '::1',
    '::ffff:7f00:1',
    '::ffff:0a00:1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '192.0.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '192.88.99.2',
  ])('rejects non-public resolved address %s', async (address) => {
    const pinnedFetcher = vi.fn().mockResolvedValue(new Response(PNG, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }))
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      pinnedFetcher,
    })

    await expect(store.importRemote('https://resolved.example/reference.png')).rejects.toThrow('public')
    expect(pinnedFetcher).not.toHaveBeenCalled()
  })

  it('accepts a globally routable IPv6 address and pins it unchanged', async () => {
    const address = '2606:4700:4700::1111'
    const pinnedFetcher = vi.fn().mockResolvedValue(new Response(PNG, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }))
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address, family: 6 }],
      pinnedFetcher,
    })

    await store.importRemote('https://resolved.example/reference.png')
    expect(pinnedFetcher.mock.calls[0][2]).toBe(address)
  })

  it('rejects an asset index containing an unsafe storageName before any file access', async () => {
    const dataDir = await tempDirectory()
    await mkdir(join(dataDir, 'assets'), { recursive: true })
    await writeFile(join(dataDir, 'assets', 'index.json'), JSON.stringify([{
      id: '11111111-1111-4111-8111-111111111111',
      filename: 'reference.png',
      contentType: 'image/png',
      size: PNG.length,
      url: '/api/assets/11111111-1111-4111-8111-111111111111',
      createdAt: '2026-07-16T00:00:00.000Z',
      storageName: '../../outside.bin',
    }]))

    await expect(AssetStore.open({ dataDir })).rejects.toThrow('invalid asset index')
  })

  it('cancels redirect and rejected response bodies and releases successful readers', async () => {
    const redirectCancelled = vi.fn()
    const unsupportedCancelled = vi.fn()
    const redirectBody = new ReadableStream({ cancel: redirectCancelled })
    const unsupportedBody = new ReadableStream({ cancel: unsupportedCancelled })
    const responses = [
      new Response(redirectBody, { status: 302, headers: { location: 'https://public.example/next.bin' } }),
      new Response(unsupportedBody, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    ]
    const pinnedFetcher = vi.fn(async () => responses.shift() as Response)
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher,
    })

    await expect(store.importRemote('https://public.example/reference.png')).rejects.toThrow('Unsupported')
    expect(redirectCancelled).toHaveBeenCalledTimes(1)
    expect(unsupportedCancelled).toHaveBeenCalledTimes(1)

    const successfulBody = new ReadableStream({
      start(controller) {
        controller.enqueue(PNG)
        controller.close()
      },
    })
    const successfulStore = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => new Response(successfulBody, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    })
    await successfulStore.importRemote('https://public.example/reference.png')
    expect(successfulBody.locked).toBe(false)
  })

  it('imports a public HTTPS asset after validating every destination', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
    const pinnedFetcher = vi.fn().mockResolvedValue(new Response(PNG, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
    }))
    const store = await AssetStore.open({
      dataDir: await tempDirectory(), lookup,
      fetcher: pinnedFetcher as typeof fetch,
      pinnedFetcher,
    } as never)

    const asset = await store.importRemote('https://public.example/reference.png')

    expect(asset.contentType).toBe('image/png')
    expect(await store.readBytes(asset.id)).toEqual(PNG)
    expect(pinnedFetcher).toHaveBeenCalledWith(
      'https://public.example/reference.png',
      expect.objectContaining({ redirect: 'manual' }),
      '93.184.216.34',
    )
  })

  it('infers a unique supported MIME for a generic octet-stream remote asset', async () => {
    const pinnedFetcher = vi.fn().mockResolvedValue(new Response(PNG, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(PNG.length),
      },
    }))
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher,
    })

    const asset = await store.importRemote('https://public.example/reference.png')

    expect(asset.contentType).toBe('image/png')
    expect(await store.readBytes(asset.id)).toEqual(PNG)
  })

  it('streams a large PNG whose server mislabels it as text/plain', async () => {
    const bytes = validPngBytes(5 * 1024 * 1024 + 512 * 1024)
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': String(bytes.byteLength),
        },
      }),
    })

    const asset = await store.importRemote('https://public.example/reference.png')
    const stored = await store.readBytes(asset.id)

    expect(asset).toEqual(expect.objectContaining({
      filename: 'reference.png',
      contentType: 'image/png',
      size: bytes.byteLength,
    }))
    expect(stored.slice(0, 8)).toEqual(PNG.slice(0, 8))
    expect(stored.byteLength).toBe(bytes.byteLength)
  })

  it.each([
    'https://public.example/download',
    'https://public.example/reference.txt',
    'https://public.example/reference.3gp',
  ])('rejects text/plain without one unambiguous supported media extension: %s', async (url) => {
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    })

    await expect(store.importRemote(url)).rejects.toThrow('Unsupported remote asset MIME type')
  })

  it.each([
    ['https://public.example/mismatched.jpg', PNG],
    ['https://public.example/not-an-image.png', new TextEncoder().encode('plain text, not image bytes')],
  ])('still applies magic-byte validation to inferred text/plain media: %s', async (url, bytes) => {
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    })

    await expect(store.importRemote(url)).rejects.toThrow('signature')
  })

  it('rejects a text/plain PNG whose declared size exceeds the image limit', async () => {
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => new Response(PNG, {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': String(20 * 1024 * 1024 + 1),
        },
      }),
    })

    await expect(store.importRemote('https://public.example/oversized.png'))
      .rejects.toThrow('allowed limit')
  })

  it('aborts a text/plain PNG stream when bytes exceed the image limit', async () => {
    const bytes = pngSignatureBytes(20 * 1024 * 1024 + 1)
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    })

    await expect(store.importRemote('https://public.example/streamed-oversized.png'))
      .rejects.toThrow('allowed limit')
  })

  it('uses an explicit trusted filename to infer a generic remote asset MIME', async () => {
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    })

    const asset = await store.importRemote('https://public.example/download', 'reference.png')

    expect(asset).toEqual(expect.objectContaining({
      filename: 'reference.png',
      contentType: 'image/png',
    }))
  })

  it.each([
    'https://public.example/download',
    'https://public.example/reference.bin',
    'https://public.example/reference.3gp',
  ])('rejects generic remote assets without one unambiguous supported extension: %s', async (url) => {
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    })

    await expect(store.importRemote(url)).rejects.toThrow('Unsupported remote asset MIME type')
  })

  it('still rejects spoofed bytes after inferring a generic remote asset MIME', async () => {
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    })

    await expect(store.importRemote('https://public.example/spoofed.png')).rejects.toThrow('signature')
  })

  it.each(['image/jpeg', 'application/x-octet-stream'])(
    'does not override a declared non-generic remote MIME type: %s',
    async (contentType) => {
      const store = await AssetStore.open({
        dataDir: await tempDirectory(),
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        pinnedFetcher: async () => new Response(PNG, {
          status: 200,
          headers: { 'content-type': contentType },
        }),
      })

      const error = contentType === 'image/jpeg' ? 'extension' : 'Unsupported remote asset MIME type'
      await expect(store.importRemote('https://public.example/reference.png')).rejects.toThrow(error)
    },
  )

  it('cancels a remote response body when asset preflight rejects it', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG)
      },
      cancel,
    })
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      pinnedFetcher: async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
    })

    await expect(store.importRemote('https://public.example/reference.png')).rejects.toThrow('extension')
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  })

  it('imports a base64 data URL without any network access', async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`
    const store = await AssetStore.open({
      dataDir: await tempDirectory(),
      pinnedFetcher: vi.fn(async () => new Response(null, { status: 500 })),
    })

    const asset = await store.importRemote(dataUrl)

    expect(asset.contentType).toBe('image/png')
    expect(asset.size).toBe(PNG.length)
    expect(store.get(asset.id)?.contentType).toBe('image/png')
  })

  it('rejects oversized and non-image data URLs', async () => {
    const store = await AssetStore.open({ dataDir: await tempDirectory() })
    const oversized = `data:image/png;base64,${'A'.repeat(21 * 1024 * 1024 * 4 / 3 + 64)}`
    await expect(store.importRemote(oversized)).rejects.toThrow('exceeds the allowed limit')
    await expect(store.importRemote(`data:application/pdf;base64,${Buffer.from('pdf').toString('base64')}`))
      .rejects.toThrow('Unsupported')
    await expect(store.importRemote('data:text/plain,hello')).rejects.toThrow('Unsupported')
  })
})
