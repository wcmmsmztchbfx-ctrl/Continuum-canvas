import { canvasDiagnostics } from '../../performance/canvasDiagnostics'
import { useEffect, useId, useRef, useState } from 'react'
import { acquireMediaResource, type MediaResource, type MediaResourceLease, type MediaSource } from '../../services/mediaResource'
import { requestMediaTask, type MediaTaskSubscription } from '../../services/mediaLoadQueue'
import type { MediaDemand, MediaVariant } from './canvasMediaDemand'
/** A DOM binding is a separate scheduled job, including native CORS fallbacks. */
export function useMediaResource(source: MediaSource, variant: MediaVariant, demand: MediaDemand) {
  const id = useId()
  const current = useRef<{ lease: MediaResourceLease; url?: string; loaded?: boolean; binding?: MediaTaskSubscription<void> } | undefined>(undefined)
  const complete = useRef<((error?: boolean) => void) | undefined>(undefined)
  const [display, setDisplay] = useState<({ url: string; source: string } & Pick<MediaResource, 'preserveAnimation' | 'preview' | 'originalWidth' | 'originalHeight'>) | undefined>(() =>
    typeof window === 'undefined' && source.url ? { url: source.url, source: source.url } : undefined)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!source.url || demand === 'none') {
      setDisplay(undefined); setFailed(false)
      current.current?.binding?.cancel(); current.current?.lease.release(); current.current = undefined
      return
    }
    let active = true
    const previous = current.current
    const lease = acquireMediaResource({ source, variant, demand, sessionId: id })
    const owned = { lease } as NonNullable<typeof current.current>
    setFailed(false)
    void lease.result.then(result => {
      if (!active) return
      if (result.status !== 'ready') { if (result.status !== 'cancelled') setFailed(true); return }
      if (previous?.url === result.value.displayUrl && previous.loaded) {
        lease.release()
        return
      }
      owned.url = result.value.displayUrl
      owned.binding = requestMediaTask({
        key: 'dom:' + id + ':' + result.value.displayUrl, kind: 'image', priority: demand === 'active' ? 'high' : 'normal', timeoutMs: 30000,
        run: signal => new Promise<void>((resolve, reject) => {
          let done = false
          const finish = (error = false) => {
            if (done) return; done = true
            signal.removeEventListener('abort', abort)
            if (complete.current === finish) complete.current = undefined
            if (error) reject(new Error('DOM image failed')); else resolve()
          }
          const abort = () => finish(true)
          signal.addEventListener('abort', abort, { once: true })
          complete.current = finish
          current.current = owned
          canvasDiagnostics.increment('media.domBindings.' + result.value.mode)
          setDisplay({ url: result.value.displayUrl, source: source.url, preserveAnimation: result.value.preserveAnimation,
            preview: result.value.preview, originalWidth: result.value.originalWidth, originalHeight: result.value.originalHeight })
          previous?.binding?.cancel(); previous?.lease.release()
        }),
      })
      void owned.binding.result.then(result => { if (active && result.status !== 'ready' && result.status !== 'cancelled') setFailed(true) })
    })
    return () => {
      active = false
      // A displayed lease survives a quality change until its replacement is ready.
      if (current.current !== owned) { owned.binding?.cancel(); lease.release() }
    }
  }, [source.url, source.assetId, source.version, source.mimeType, variant, demand === 'none', id, attempt])
  useEffect(() => { current.current?.lease.updateDemand(demand) }, [demand])
  useEffect(() => () => { current.current?.binding?.cancel(); current.current?.lease.release(); current.current = undefined }, [])
  return { bindingKey: id + ':' + attempt, displayUrl: display?.url, displayedSource: display?.source, preserveAnimation: display?.preserveAnimation, preview: display?.preview, originalWidth: display?.originalWidth, originalHeight: display?.originalHeight, failed, retry: () => setAttempt(value => value + 1),
    onLoad: () => { if (current.current) current.current.loaded = true; complete.current?.() }, onError: () => { complete.current?.(true); setFailed(true) } }
}
