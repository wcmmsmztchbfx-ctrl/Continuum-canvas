type RequestFrame = (callback: FrameRequestCallback) => number
type CancelFrame = (handle: number) => void

export function createAnimationFrameResizeObserver(
  NativeResizeObserver: typeof ResizeObserver,
  requestFrame: RequestFrame,
  cancelFrame: CancelFrame,
): typeof ResizeObserver {
  class AnimationFrameResizeObserver implements ResizeObserver {
    private readonly native: ResizeObserver
    private readonly pending = new Map<Element, ResizeObserverEntry>()
    private frame: number | undefined

    constructor(callback: ResizeObserverCallback) {
      this.native = new NativeResizeObserver((entries) => {
        for (const entry of entries) this.pending.set(entry.target, entry)
        if (this.frame !== undefined) return
        this.frame = requestFrame(() => {
          this.frame = undefined
          if (this.pending.size === 0) return
          const batch = [...this.pending.values()]
          this.pending.clear()
          callback(batch, this)
        })
      })
    }

    disconnect(): void {
      if (this.frame !== undefined) cancelFrame(this.frame)
      this.frame = undefined
      this.pending.clear()
      this.native.disconnect()
    }

    observe(target: Element, options?: ResizeObserverOptions): void {
      this.native.observe(target, options)
    }

    unobserve(target: Element): void {
      this.pending.delete(target)
      this.native.unobserve(target)
    }
  }

  return AnimationFrameResizeObserver as typeof ResizeObserver
}

export function installAnimationFrameResizeObserver(): void {
  if (typeof window === 'undefined' || typeof window.ResizeObserver === 'undefined') return
  window.ResizeObserver = createAnimationFrameResizeObserver(
    window.ResizeObserver,
    window.requestAnimationFrame.bind(window),
    window.cancelAnimationFrame.bind(window),
  )
}
