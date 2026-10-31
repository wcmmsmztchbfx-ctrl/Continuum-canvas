import { canvasDiagnostics } from '../performance/canvasDiagnostics'
export type LoadPriority = 'high' | 'normal' | 'low'
export type MediaTaskKind = 'image' | 'decode' | 'poster' | 'encode'
export type MediaTaskResult<T> = { status: 'ready'; value: T } | { status: 'cancelled' | 'failed' | 'timeout' }
export interface MediaTaskSubscription<T> {
  result: Promise<MediaTaskResult<T>>
  cancel(): void
  setPriority(priority: LoadPriority): void
}
interface TaskSubscriber { priority: LoadPriority; settle(result: MediaTaskResult<unknown>): void }
interface MediaTask {
  key: string; kind: MediaTaskKind; timeoutMs: number
  run(signal: AbortSignal): Promise<unknown>
  subscribers: Map<symbol, TaskSubscriber>
  state: 'queued' | 'running' | 'finished'
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
  slotReleased?: boolean
}
const limits: Record<MediaTaskKind, number> = { image: 6, decode: 2, poster: 1, encode: 1 }
const active: Record<MediaTaskKind, number> = { image: 0, decode: 0, poster: 0, encode: 0 }
const order: Record<LoadPriority, number> = { high: 0, normal: 1, low: 2 }
const tasks = new Map<string, MediaTask>()
const loadedCache = new Map<string, number>()
let pumping = false
function priority(task: MediaTask): number {
  let value = 2
  for (const subscriber of task.subscribers.values()) value = Math.min(value, order[subscriber.priority])
  return value
}
function releaseSlot(task: MediaTask): void {
  if (task.slotReleased || task.state === 'queued') return
  task.slotReleased = true
  active[task.kind]--
  void Promise.resolve().then(pump)
}
function finish(task: MediaTask, result: MediaTaskResult<unknown>): void {
  if (task.state === 'finished') return
  const wasRunning = task.state === 'running'
  task.state = 'finished'
  canvasDiagnostics.increment('tasks.' + result.status + '.' + task.kind)
  clearTimeout(task.timer)
  if (tasks.get(task.key) === task) tasks.delete(task.key)
  if (wasRunning && task.kind !== 'decode' && task.kind !== 'encode') releaseSlot(task)
  if (result.status !== 'ready') task.controller.abort()
  for (const subscriber of task.subscribers.values()) subscriber.settle(result)
  task.subscribers.clear()
  void Promise.resolve().then(pump)
}
function pump(): void {
  if (pumping) return
  pumping = true
  try {
    const queued = [...tasks.values()].filter(task => task.state === 'queued').sort((a, b) => priority(a) - priority(b))
    for (const task of queued) {
      if (active[task.kind] >= limits[task.kind] || task.state !== 'queued') continue
      task.state = 'running'
      active[task.kind]++
      canvasDiagnostics.increment('tasks.started.' + task.kind)
      task.timer = setTimeout(() => finish(task, { status: 'timeout' }), task.timeoutMs)
      try {
        void task.run(task.controller.signal).then(
          value => finish(task, { status: 'ready', value }),
          () => finish(task, { status: 'failed' }),
        ).finally(() => releaseSlot(task))
      } catch { finish(task, { status: 'failed' }); releaseSlot(task) }
    }
  } finally { pumping = false }
}
/** Consumers own subscriptions, never a shared operation's abort controller. */
export function requestMediaTask<T>(input: {
  key: string; kind: MediaTaskKind; priority: LoadPriority; timeoutMs: number
  run(signal: AbortSignal): Promise<T>
}): MediaTaskSubscription<T> {
  const key = input.kind + ':' + input.key
  let task = tasks.get(key)
  if (!task) {
    task = { ...input, key, subscribers: new Map(), state: 'queued', controller: new AbortController() }
    tasks.set(key, task)
  }
  const ownedTask = task
  const id = Symbol(key)
  const result = new Promise<MediaTaskResult<T>>(resolve => {
    ownedTask.subscribers.set(id, { priority: input.priority, settle: value => resolve(value as MediaTaskResult<T>) })
  })
  pump()
  return {
    result,
    cancel() {
      const subscriber = ownedTask.subscribers.get(id)
      if (!subscriber) return
      ownedTask.subscribers.delete(id)
      subscriber.settle({ status: 'cancelled' })
      if (ownedTask.subscribers.size === 0) finish(ownedTask, { status: 'cancelled' })
    },
    setPriority(next) {
      const subscriber = ownedTask.subscribers.get(id)
      if (subscriber) subscriber.priority = next
      pump()
    },
  }
}
function performImageLoad(url: string, signal: AbortSignal): Promise<boolean> {
  if (typeof Image === 'undefined') return Promise.resolve(true)
  return new Promise(resolve => {
    const img = new Image()
    let settled = false
    let decode: MediaTaskSubscription<void> | undefined
    const complete = (success: boolean) => {
      if (settled) return
      settled = true
      img.onload = null
      img.onerror = null
      signal.removeEventListener('abort', abort)
      resolve(success)
    }
    const abort = () => { decode?.cancel(); complete(false); img.src = '' }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    img.decoding = 'async'
    img.onerror = () => complete(false)
    img.onload = () => {
      if (settled) return
      if (typeof img.decode !== 'function') { complete(true); return }
      decode = requestMediaTask({ key: url, kind: 'decode', priority: 'high', timeoutMs: 30_000, run: () => img.decode() })
      void decode.result.then(result => {
        // Native display can work even when explicit decode rejects.
        complete(!signal.aborted && result.status !== 'cancelled' && result.status !== 'timeout')
      })
    }
    img.src = url
  })
}
export function requestMediaLoad(url: string, priority: LoadPriority = 'normal'): {
  promise: Promise<boolean>; cancel(): void; setPriority(priority: LoadPriority): void
} {
  if (!url || isMediaLoaded(url)) return { promise: Promise.resolve(true), cancel() {}, setPriority() {} }
  const subscription = requestMediaTask({ key: url, kind: 'image', priority, timeoutMs: 30_000,
    run: signal => performImageLoad(url, signal) })
  return {
    promise: subscription.result.then(result => {
      const success = result.status === 'ready' && result.value
      if (success) {
        loadedCache.delete(url)
        loadedCache.set(url, Date.now())
        while (loadedCache.size > 256) loadedCache.delete(loadedCache.keys().next().value!)
      }
      return success
    }),
    cancel: subscription.cancel, setPriority: subscription.setPriority,
  }
}
export function isMediaLoaded(url?: string): boolean {
  if (!url) return false
  const loadedAt = loadedCache.get(url)
  if (loadedAt === undefined) return false
  if (Date.now() - loadedAt > 60_000) { loadedCache.delete(url); return false }
  return true
}
export function invalidateMediaLoad(url: string): void { loadedCache.delete(url) }

export function calculateLoadPriority(
  nodePos: { x: number; y: number } | undefined,
  nodeSize: { width: number; height: number } | undefined,
  viewport: { x: number; y: number; zoom: number },
): LoadPriority {
  if (!nodePos || typeof window === 'undefined') return 'normal'
  const zoom = Math.max(0.01, viewport.zoom)
  const viewLeft = -viewport.x / zoom
  const viewTop = -viewport.y / zoom
  const viewRight = (window.innerWidth - viewport.x) / zoom
  const viewBottom = (window.innerHeight - viewport.y) / zoom

  const buffer = 1000 / zoom
  const nodeWidth = nodeSize?.width || 300
  const nodeHeight = nodeSize?.height || 200
  const nodeRight = nodePos.x + nodeWidth
  const nodeBottom = nodePos.y + nodeHeight

  if (
    nodeRight >= viewLeft &&
    nodePos.x <= viewRight &&
    nodeBottom >= viewTop &&
    nodePos.y <= viewBottom
  ) {
    return 'high'
  }

  if (
    nodeRight >= viewLeft - buffer &&
    nodePos.x <= viewRight + buffer &&
    nodeBottom >= viewTop - buffer &&
    nodePos.y <= viewBottom + buffer
  ) {
    return 'normal'
  }

  return 'low'
}
