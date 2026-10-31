// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestMediaTask } from './mediaLoadQueue'
import { mediaPreviewKey } from './mediaPreviewIdentity'
import { storePreview, clearIdlePreviews } from './imageThumbnailCache'
import { acquireMediaResource, clearIdleMediaResources, resolveMediaUrl } from './mediaResource'
afterEach(() => { clearIdleMediaResources(); clearIdlePreviews(); vi.unstubAllGlobals() })
describe('media resource ownership', () => {
  it('requests a real local preview at each numeric zoom tier, including static WebP', () => {
    const url = '/api/assets/12345678-1234-4234-8234-123456789012'
    for (const variant of [128, 360, 960, 1920] as const) {
      expect(resolveMediaUrl({ url, mimeType: 'image/webp' }, variant)).toBe(url + '?preview=' + variant + '&v=1')
    }
    expect(resolveMediaUrl({ url }, 'original')).toBe(url)
    expect(resolveMediaUrl({ url: 'https://untrusted.test' + url }, 128)).toBe('https://untrusted.test' + url)
    expect(resolveMediaUrl({ url: url + '?signature=secret' }, 128)).toBe(url + '?signature=secret')
  })

  it('does not bypass the queue with a full original when a local preview request fails', async () => {
    const url = '/api/assets/12345678-1234-4234-8234-123456789012'
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    const lease = acquireMediaResource({ source: { url }, variant: 128, demand: 'visible', sessionId: 'failed-preview' })
    expect(await lease.result).toEqual({ status: 'failed' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe(url + '?preview=128&v=1')
    lease.release()
  })
  it('promotes a shared pending request when an active consumer joins', async () => {
    const finish: (() => void)[] = []
    const blockers = Array.from({ length: 6 }, (_, i) => requestMediaTask({
      key: 'priority-blocker-' + i, kind: 'image', priority: 'normal', timeoutMs: 1000,
      run: () => new Promise<void>(resolve => { finish.push(resolve) }),
    }))
    const fetcher = vi.fn().mockRejectedValue(new TypeError('CORS'))
    vi.stubGlobal('fetch', fetcher)
    const source = { url: '/priority-a.png' }
    const background = acquireMediaResource({ source, variant: 360, demand: 'background', sessionId: 'bg' })
    const normal = acquireMediaResource({ source: { url: '/priority-b.png' }, variant: 360, demand: 'visible', sessionId: 'normal' })
    const active = acquireMediaResource({ source, variant: 360, demand: 'active', sessionId: 'active' })
    background.updateDemand('nearby')
    finish[0]()
    await Promise.all([background.result, normal.result, active.result])
    expect(fetcher.mock.calls[0][0]).toBe('/priority-a.png')
    background.release(); normal.release(); active.release()
    finish.forEach(resolve => resolve())
    await Promise.all(blockers.map(task => task.result))
  })
  it('separates preview keys by resource version and output dimensions', () => {
    const first = mediaPreviewKey({ url: '/same.png', assetId: 'a', version: 'v1' })
    expect(mediaPreviewKey({ url: '/same.png', assetId: 'a', version: 'v2' })).not.toBe(first)
    expect(mediaPreviewKey({ url: '/same.png', assetId: 'b', version: 'v1' })).not.toBe(first)
    expect(mediaPreviewKey({ url: '/same.png', assetId: 'a', version: 'v1' }, 128)).not.toBe(first)
  })
  it('never serves an unversioned preview for a newly versioned source', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:old-preview'), revokeObjectURL: vi.fn() })
    const old = storePreview('/versioned.png', new Blob(['old']), { width: 320, height: 200 })
    old.release()
    const fetcher = vi.fn().mockRejectedValue(new TypeError('CORS'))
    vi.stubGlobal('fetch', fetcher)
    const lease = acquireMediaResource({ source: { url: '/versioned.png', version: 'v2' }, variant: 128, demand: 'visible', sessionId: 'new' })
    try { await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)) } finally { lease.release() }
  })
  it('does not start a request without demand', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const lease = acquireMediaResource({ source: { url: '/offscreen.png' }, variant: 360, demand: 'none', sessionId: 'one' })
    expect(fetcher).not.toHaveBeenCalled()
    lease.release()
    expect(await lease.result).toEqual({ status: 'cancelled' })
  })
  it('deduplicates subscriptions, isolates cancellation and falls back on CORS failure', async () => {
    let reject!: (reason: Error) => void
    const fetcher = vi.fn(() => new Promise((_resolve, fail) => { reject = fail }))
    vi.stubGlobal('fetch', fetcher)
    const input = { source: { url: 'https://example.test/image.png' }, variant: 360 as const, demand: 'visible' as const, sessionId: 'one' }
    const first = acquireMediaResource(input)
    const second = acquireMediaResource({ ...input, sessionId: 'two' })
    first.release()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    reject(new TypeError('CORS'))
    expect(await first.result).toEqual({ status: 'cancelled' })
    expect(await second.result).toMatchObject({ status: 'ready', value: { mode: 'native', displayUrl: input.source.url, preserveAnimation: true } })
    expect(fetcher).toHaveBeenCalledTimes(1)
    second.release()
  })
  it('keeps signed URLs and versions distinct', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('CORS')))
    const a = acquireMediaResource({ source: { url: 'https://x.test/a?sig=1' }, variant: 360, demand: 'visible', sessionId: 'a' })
    const b = acquireMediaResource({ source: { url: 'https://x.test/a?sig=2' }, variant: 360, demand: 'visible', sessionId: 'a' })
    await Promise.all([a.result, b.result])
    expect(fetch).toHaveBeenCalledTimes(2)
    a.release(); b.release()
  })
})
