import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

export const PREVIEW_SIZES = new Set([128, 360, 960, 1920])
export interface AssetPreview { bytes: Buffer; originalWidth: number; originalHeight: number; width: number; height: number }
export class PreviewBusyError extends Error {}
interface Job { result: Promise<AssetPreview | undefined>; controller: AbortController; consumers: number }
const CACHE_NAME = /^[0-9a-f-]{36}-(128|360|960|1920)\.preview$/i
// Bound native working memory as well as the number of jobs. This runs off the UI thread.
sharp.concurrency(1)
sharp.cache({ memory: 32, files: 0, items: 32 })

export class AssetPreviewStore {
  readonly root: string
  readonly maxBytes: number
  #jobs = new Map<string, Job>()
  #files = new Map<string, { size: number; touched: number }>()
  #unsupported = new Set<string>()
  #active = 0
  #waiting: Array<() => void> = []
  #initialized?: Promise<void>
  #cacheAvailable = true
  #pruning = Promise.resolve()
  constructor(root: string, maxBytes = 256 * 1024 * 1024) { this.root = root; this.maxBytes = maxBytes }

  async #initialize() {
    await mkdir(this.root, { recursive: true })
    for (const name of await readdir(this.root)) {
      if (!CACHE_NAME.test(name)) continue
      const info = await stat(join(this.root, name)).catch(() => undefined)
      if (info?.isFile()) this.#files.set(name, { size: info.size, touched: info.mtimeMs })
    }
    await this.#trim()
  }
  #trim() {
    this.#pruning = this.#pruning.catch(() => {}).then(async () => {
      let size = [...this.#files.values()].reduce((sum, entry) => sum + entry.size, 0)
      for (const [name, entry] of [...this.#files].sort((a, b) => a[1].touched - b[1].touched)) {
        if (size <= this.maxBytes && this.#files.size <= 2048) break
        await rm(join(this.root, name), { force: true })
        this.#files.delete(name); size -= entry.size
      }
    })
    return this.#pruning
  }
  async #limited<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (this.#active >= 2) await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener('abort', abort); resolve() }
      const abort = () => {
        this.#waiting = this.#waiting.filter(waiter => waiter !== ready)
        signal.removeEventListener('abort', abort)
        reject(signal.reason)
      }
      this.#waiting.push(ready)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    else this.#active++
    try { return await run() }
    finally {
      const next = this.#waiting.shift()
      if (next) next(); else this.#active--
    }
  }
  async get(id: string, file: string, size: number, signal?: AbortSignal): Promise<AssetPreview | undefined> {
    signal?.throwIfAborted()
    if (!PREVIEW_SIZES.has(size) || !/^[0-9a-f-]{36}$/i.test(id)) throw new RangeError('Invalid preview size or asset ID')
    const key = id + '-' + size
    let job = this.#jobs.get(key)
    if (!job) {
      if (this.#jobs.size >= 64) throw new PreviewBusyError('Preview queue is full')
      const controller = new AbortController()
      job = { controller, consumers: 0, result: Promise.resolve(undefined) }
      const owned = job
      this.#jobs.set(key, owned)
      owned.result = this.#limited(() => this.#render(id, file, size, controller.signal), controller.signal).finally(() => {
        if (this.#jobs.get(key) === owned) this.#jobs.delete(key)
      })
    }
    const owned = job
    owned.consumers++
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error: unknown, value?: AssetPreview) => {
        if (settled) return
        settled = true; signal?.removeEventListener('abort', abort)
        if (--owned.consumers === 0) {
          owned.controller.abort()
          if (this.#jobs.get(key) === owned) this.#jobs.delete(key)
        }
        if (error) reject(error); else resolve(value)
      }
      const abort = () => finish(signal?.reason ?? new Error('Preview cancelled'))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      void owned.result.then(value => finish(undefined, value), error => finish(error))
    })
  }
  async #render(id: string, file: string, size: number, signal: AbortSignal): Promise<AssetPreview | undefined> {
    signal.throwIfAborted()
    if (this.#unsupported.has(id)) return undefined
    await (this.#initialized ??= this.#initialize().catch(() => { this.#files.clear(); this.#cacheAvailable = false }))
    signal.throwIfAborted()
    const name = id + '-' + size + '.preview'
    const path = join(this.root, name)
    if (this.#files.has(name)) {
      const cached = await readFile(path).catch(() => undefined)
      if (cached && cached.length > 16) {
        const [originalWidth, originalHeight, width, height] = [0, 4, 8, 12].map(offset => cached.readUInt32LE(offset))
        if (width > 0 && height > 0 && width <= size && height <= size && originalWidth > 0 && originalHeight > 0) {
          this.#files.set(name, { size: cached.length, touched: Date.now() })
          return { bytes: cached.subarray(16), originalWidth, originalHeight, width, height }
        }
      }
      this.#files.delete(name)
    }
    let preview: AssetPreview
    try {
      const input = sharp(file, { limitInputPixels: 100_000_000, failOn: 'error' })
      const metadata = await input.metadata()
      signal.throwIfAborted()
      if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) {
        this.#rememberUnsupported(id); return undefined
      }
      const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1)
      const originalWidth = rotated ? metadata.height : metadata.width
      const originalHeight = rotated ? metadata.width : metadata.height
      const output = await input.autoOrient().resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80, effort: 2 }).timeout({ seconds: 15 }).toBuffer({ resolveWithObject: true })
      signal.throwIfAborted()
      preview = { bytes: output.data, originalWidth, originalHeight, width: output.info.width, height: output.info.height }
    } catch {
      signal.throwIfAborted()
      // Formats unsupported by the native decoder keep the original display path.
      this.#rememberUnsupported(id)
      return undefined
    }
    if (!this.#cacheAvailable) return preview
    const header = Buffer.alloc(16)
    ;[preview.originalWidth, preview.originalHeight, preview.width, preview.height].forEach((value, index) => header.writeUInt32LE(value, index * 4))
    const bytes = Buffer.concat([header, preview.bytes])
    const temporary = path + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, bytes, { flag: 'wx' })
      signal.throwIfAborted()
      await rename(temporary, path)
      this.#files.set(name, { size: bytes.length, touched: Date.now() })
      await this.#trim()
    } catch {
      await rm(temporary, { force: true }).catch(() => {})
      signal.throwIfAborted()
      // A full disposable cache must not make a valid asset inaccessible.
    }
    return preview
  }
  #rememberUnsupported(id: string) {
    if (this.#unsupported.size >= 2048) this.#unsupported.delete(this.#unsupported.values().next().value!)
    this.#unsupported.add(id)
  }
}
