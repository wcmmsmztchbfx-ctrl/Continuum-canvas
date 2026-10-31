// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('media load ownership', () => {
  let queue: typeof import('./mediaLoadQueue')
  let images: ControlledImage[]
  class ControlledImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    decoding = 'auto'
    src = ''
    constructor() { images.push(this) }
  }
  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    images = []
    vi.stubGlobal('Image', ControlledImage)
    queue = await import('./mediaLoadQueue')
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('settles queued cancellation without waiting for active loads', async () => {
    const active = Array.from({ length: 6 }, (_, i) => queue.requestMediaLoad('active-' + i))
    const waiting = queue.requestMediaLoad('waiting')
    let result: boolean | undefined
    void waiting.promise.then(value => { result = value })
    waiting.cancel()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBe(false)
    expect(images).toHaveLength(6)
    active.forEach(task => task.cancel())
  })
  it('keeps the second subscriber alive when the owner cancels', async () => {
    const owner = queue.requestMediaLoad('shared')
    const other = queue.requestMediaLoad('shared')
    owner.cancel()
    images[0].onload?.()
    expect(await owner.promise).toBe(false)
    expect(await other.promise).toBe(true)
    expect(images).toHaveLength(1)
  })
  it('deduplicates a resource while it is still queued', async () => {
    const active = Array.from({ length: 6 }, (_, i) => queue.requestMediaLoad('pool-' + i))
    const one = queue.requestMediaLoad('queued')
    const two = queue.requestMediaLoad('queued')
    images.slice(0, 6).forEach(image => image.onload?.())
    await vi.advanceTimersByTimeAsync(1)
    expect(images.filter(image => image.src === 'queued')).toHaveLength(1)
    images.at(-1)!.onload?.()
    expect(await Promise.all([one.promise, two.promise])).toEqual([true, true])
    active.forEach(task => task.cancel())
  })
  it('times out a hanging load and admits the next queued resource', async () => {
    const active = Array.from({ length: 6 }, (_, i) => queue.requestMediaLoad('hang-' + i))
    const next = queue.requestMediaLoad('next')
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await Promise.all(active.map(task => task.promise))).toEqual([false, false, false, false, false, false])
    expect(images.some(image => image.src === 'next')).toBe(true)
    next.cancel()
    expect(await next.promise).toBe(false)
  })
  it('limits explicit decodes and settles each subscriber only once', async () => {
    const complete: Array<(value: string) => void> = []
    const tasks = Array.from({ length: 3 }, (_, i) => queue.requestMediaTask({
      key: 'decode-' + i, kind: 'decode', priority: 'high', timeoutMs: 100,
      run: () => new Promise<string>(resolve => { complete.push(resolve) }),
    }))
    expect(complete).toHaveLength(2)
    const seen: unknown[] = []
    void tasks[0].result.then(value => seen.push(value))
    tasks[0].cancel()
    await vi.advanceTimersByTimeAsync(1)
    expect(complete).toHaveLength(2)
    complete[0]('late')
    await vi.advanceTimersByTimeAsync(1)
    expect(seen).toEqual([{ status: 'cancelled' }])
    expect(complete).toHaveLength(3)
    complete[1]('second')
    complete[2]('third')
    expect(await tasks[1].result).toEqual({ status: 'ready', value: 'second' })
    expect(await tasks[2].result).toEqual({ status: 'ready', value: 'third' })
  })
})
