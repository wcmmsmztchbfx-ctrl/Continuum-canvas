// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

import { createAnimationFrameResizeObserver } from './resizeObserverScheduler'

describe('animation-frame ResizeObserver', () => {
  it('coalesces synchronous resize deliveries into one next-frame callback', () => {
    let deliver: ((entries: ResizeObserverEntry[]) => void) | undefined
    const disconnect = vi.fn()
    class FakeResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {
        deliver = (entries) => this.callback(entries, this as unknown as ResizeObserver)
      }
      disconnect = disconnect
      observe = vi.fn()
      takeRecords = vi.fn(() => [])
      unobserve = vi.fn()
    }
    let scheduled: FrameRequestCallback | undefined
    const cancel = vi.fn()
    const Observer = createAnimationFrameResizeObserver(
      FakeResizeObserver as unknown as typeof ResizeObserver,
      (callback) => {
        scheduled = callback
        return 7
      },
      cancel,
    )
    const callback = vi.fn<ResizeObserverCallback>()
    const observer = new Observer(callback)
    const target = document.createElement('div')
    const first = { target, contentRect: { width: 100 } } as unknown as ResizeObserverEntry
    const latest = { target, contentRect: { width: 120 } } as unknown as ResizeObserverEntry

    deliver?.([first])
    deliver?.([latest])
    expect(callback).not.toHaveBeenCalled()

    scheduled?.(16)
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith([latest], observer)

    observer.disconnect()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(cancel).not.toHaveBeenCalled()
  })
})
