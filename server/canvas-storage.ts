import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCanvasSnapshot, type CanvasSnapshotV2 } from '../src/model/project.ts'
import { atomicWriteJson } from './atomic-json.ts'

export interface CanvasStorageOptions {
  dataDir: string
}

export function defaultInitialCanvas(canvasId: string, projectId = canvasId, name = '画布 1'): CanvasSnapshotV2 {
  return {
    version: 3,
    canvasId,
    projectId,
    name,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    comments: [],
  }
}

export class CanvasPersistenceService {
  readonly #canvasesDir: string
  readonly #cache = new Map<string, CanvasSnapshotV2>()
  readonly #writeLocks = new Map<string, Promise<void>>()

  constructor(options: CanvasStorageOptions) {
    this.#canvasesDir = join(options.dataDir, 'canvases')
  }

  async getCanvas(canvasId: string): Promise<CanvasSnapshotV2 | undefined> {
    const cached = this.#cache.get(canvasId)
    if (cached) return structuredClone(cached)

    const filePath = join(this.#canvasesDir, canvasId, 'snapshot.json')
    try {
      const content = await readFile(filePath, 'utf8')
      const snapshot = parseCanvasSnapshot(content)
      this.#cache.set(canvasId, snapshot)
      return structuredClone(snapshot)
    } catch {
      return undefined
    }
  }

  async saveCanvas(snapshot: CanvasSnapshotV2): Promise<void> {
    this.#cache.set(snapshot.canvasId, structuredClone(snapshot))
    const canvasDir = join(this.#canvasesDir, snapshot.canvasId)
    const filePath = join(canvasDir, 'snapshot.json')

    const currentLock = this.#writeLocks.get(snapshot.canvasId) ?? Promise.resolve()
    let release!: () => void
    const nextLock = new Promise<void>((resolve) => { release = resolve })
    this.#writeLocks.set(snapshot.canvasId, nextLock)

    try {
      await currentLock
      await mkdir(canvasDir, { recursive: true })
      await atomicWriteJson(filePath, snapshot)
    } finally {
      release()
      if (this.#writeLocks.get(snapshot.canvasId) === nextLock) {
        this.#writeLocks.delete(snapshot.canvasId)
      }
    }
  }

  async deleteCanvas(canvasId: string): Promise<void> {
    this.#cache.delete(canvasId)
    const canvasDir = join(this.#canvasesDir, canvasId)
    try {
      await rm(canvasDir, { recursive: true, force: true })
    } catch {
      // ignore missing directory
    }
  }

  async getAgentChat(canvasId: string): Promise<unknown[]> {
    const filePath = join(this.#canvasesDir, canvasId, 'agent-chat.json')
    try {
      const content = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(content)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async saveAgentChat(canvasId: string, messages: unknown[]): Promise<void> {
    const canvasDir = join(this.#canvasesDir, canvasId)
    const filePath = join(canvasDir, 'agent-chat.json')

    const currentLock = this.#writeLocks.get(`${canvasId}:chat`) ?? Promise.resolve()
    let release!: () => void
    const nextLock = new Promise<void>((resolve) => { release = resolve })
    this.#writeLocks.set(`${canvasId}:chat`, nextLock)

    try {
      await currentLock
      await mkdir(canvasDir, { recursive: true })
      await atomicWriteJson(filePath, messages)
    } finally {
      release()
      if (this.#writeLocks.get(`${canvasId}:chat`) === nextLock) {
        this.#writeLocks.delete(`${canvasId}:chat`)
      }
    }
  }

  async clearAgentChat(canvasId: string): Promise<void> {
    const filePath = join(this.#canvasesDir, canvasId, 'agent-chat.json')
    try {
      await rm(filePath, { force: true })
    } catch {
      // ignore
    }
  }

  async flushAll(): Promise<void> {
    const locks = [...this.#writeLocks.values()]
    await Promise.allSettled(locks)
  }
}
