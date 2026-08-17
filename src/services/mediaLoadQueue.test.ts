// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  calculateLoadPriority,
  isMediaLoaded,
  requestMediaLoad,
} from './mediaLoadQueue'

describe('mediaLoadQueue', () => {
  let originalImage: typeof Image

  beforeEach(() => {
    originalImage = globalThis.Image
  })

  afterEach(() => {
    globalThis.Image = originalImage
    vi.restoreAllMocks()
  })

  it('calculates priority correctly based on viewport position', () => {
    const viewport = { x: 0, y: 0, zoom: 1 }

    // Inside viewport
    expect(
      calculateLoadPriority(
        { x: 100, y: 100 },
        { width: 200, height: 200 },
        viewport,
      ),
    ).toBe('high')

    // Inside buffer zone (within 1000px)
    expect(
      calculateLoadPriority(
        { x: 1500, y: 100 },
        { width: 200, height: 200 },
        viewport,
      ),
    ).toBe('normal')

    // Far away
    expect(
      calculateLoadPriority(
        { x: 5000, y: 5000 },
        { width: 200, height: 200 },
        viewport,
      ),
    ).toBe('low')
  })

  it('returns false for unpassed or unloaded url', () => {
    expect(isMediaLoaded('')).toBe(false)
    expect(isMediaLoaded(undefined)).toBe(false)
    expect(isMediaLoaded('https://example.com/not-yet.png')).toBe(false)
  })

  it('handles empty or missing url without throwing', async () => {
    const { promise, cancel } = requestMediaLoad('')
    const result = await promise
    expect(result).toBe(true)
    expect(typeof cancel).toBe('function')
  })

  it('loads image successfully using Image mock and records cache', async () => {
    const loadedUrl = 'https://example.com/test-img-1.png'

    // Mock Image
    class MockImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      decoding = 'auto'
      private _src = ''

      set src(value: string) {
        this._src = value
        if (value) {
          queueMicrotask(() => {
            this.onload?.()
          })
        }
      }

      get src() {
        return this._src
      }
    }

    globalThis.Image = MockImage as any

    const { promise } = requestMediaLoad(loadedUrl, 'high')
    const success = await promise

    expect(success).toBe(true)
    expect(isMediaLoaded(loadedUrl)).toBe(true)

    // Second request to same URL hits loadedCache immediately
    const immediate = await requestMediaLoad(loadedUrl).promise
    expect(immediate).toBe(true)
  })

  it('handles image error gracefully and resolves false', async () => {
    const errorUrl = 'https://example.com/bad-image.png'

    class FailingImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      private _src = ''

      set src(value: string) {
        this._src = value
        if (value) {
          queueMicrotask(() => {
            this.onerror?.()
          })
        }
      }

      get src() {
        return this._src
      }
    }

    globalThis.Image = FailingImage as any

    const { promise } = requestMediaLoad(errorUrl, 'normal')
    const result = await promise

    expect(result).toBe(false)
    expect(isMediaLoaded(errorUrl)).toBe(false)
  })

  it('supports cancellation before or during load', async () => {
    const cancelUrl = 'https://example.com/cancel-target.png'

    class HangingImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      private _src = ''

      set src(value: string) {
        this._src = value
      }

      get src() {
        return this._src
      }
    }

    globalThis.Image = HangingImage as any

    const { promise, cancel } = requestMediaLoad(cancelUrl, 'low')
    cancel()

    const result = await promise
    expect(result).toBe(false)
  })

  it('respects concurrency limits and orders queue by priority', async () => {
    const startedOrder: string[] = []
    const completionResolvers: Record<string, () => void> = {}

    class ControlledImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      private _src = ''

      set src(value: string) {
        this._src = value
        if (value) {
          startedOrder.push(value)
          completionResolvers[value] = () => {
            this.onload?.()
          }
        }
      }

      get src() {
        return this._src
      }
    }

    globalThis.Image = ControlledImage as any

    // Enqueue 6 normal priority items (fills concurrency pool)
    for (let i = 1; i <= 6; i++) {
      requestMediaLoad(`https://example.com/pool-${i}.png`, 'normal')
    }

    // Now pool has 6 items started
    expect(startedOrder).toHaveLength(6)

    // Enqueue 1 low priority item, then 1 high priority item
    requestMediaLoad('https://example.com/queued-low.png', 'low')
    requestMediaLoad('https://example.com/queued-high.png', 'high')

    // Finish 1 active item from the pool
    completionResolvers['https://example.com/pool-1.png']?.()
    await new Promise((r) => setTimeout(r, 10))

    // High priority item should be picked next before the low priority item
    expect(startedOrder).toContain('https://example.com/queued-high.png')
    expect(startedOrder.indexOf('https://example.com/queued-high.png')).toBeLessThan(
      startedOrder.indexOf('https://example.com/queued-low.png') === -1
        ? 999
        : startedOrder.indexOf('https://example.com/queued-low.png'),
    )
  })
})
