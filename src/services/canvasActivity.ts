import { canvasPerformanceFlags } from '../performance/canvasPerformanceFlags'
let lastInteraction = 0
export function markCanvasInteraction() { lastInteraction = Date.now() }
export function waitForCanvasIdle(signal: AbortSignal, quietMs = 300): Promise<void> {
  if (!canvasPerformanceFlags.backgroundScheduling) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')) }
    const check = () => {
      if (signal.aborted) { abort(); return }
      const delay = lastInteraction + quietMs - Date.now()
      if (delay > 0) timer = setTimeout(check, delay)
      else { signal.removeEventListener('abort', abort); resolve() }
    }
    signal.addEventListener('abort', abort, { once: true }); check()
  })
}
