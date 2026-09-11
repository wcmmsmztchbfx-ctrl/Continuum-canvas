import { EventEmitter } from 'node:events'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CanvasSnapshotV2 } from '../src/model/project.ts'
import { atomicWriteJson } from './atomic-json.ts'
import type { CanvasPersistenceService } from './canvas-storage.ts'
import type { CollaborationService } from './collaboration-service.ts'

interface RevisionState {
  version: 1
  revisions: Record<string, number>
}

export class CanvasRevisionConflictError extends Error {
  readonly code = 'canvas_revision_conflict'
  readonly expectedRevision: number
  readonly actualRevision: number
  constructor(expectedRevision: number, actualRevision: number) {
    super(`Canvas revision conflict: expected ${expectedRevision}, actual ${actualRevision}`)
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

export interface CanvasDocumentEvent {
  canvasId: string
  projectId: string
  revision: number
  snapshot: CanvasSnapshotV2
  origin: string
}

export class CanvasDocumentService {
  readonly #collaboration: CollaborationService
  readonly #canvases: CanvasPersistenceService
  readonly #revisionPath: string
  readonly #events = new EventEmitter()
  #state: RevisionState = { version: 1, revisions: {} }
  #queue = new Map<string, Promise<unknown>>()

  private constructor(options: {
    dataDir: string
    collaboration: CollaborationService
    canvases: CanvasPersistenceService
  }) {
    this.#collaboration = options.collaboration
    this.#canvases = options.canvases
    this.#revisionPath = join(options.dataDir, 'canvas-document-revisions.json')
    this.#events.setMaxListeners(100)
  }

  static async open(options: {
    dataDir: string
    collaboration: CollaborationService
    canvases: CanvasPersistenceService
  }): Promise<CanvasDocumentService> {
    const service = new CanvasDocumentService(options)
    try {
      const parsed = JSON.parse(await readFile(service.#revisionPath, 'utf8')) as RevisionState
      if (parsed?.version === 1 && parsed.revisions && typeof parsed.revisions === 'object') {
        service.#state = parsed
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return service
  }

  async get(canvasId: string): Promise<{ snapshot: CanvasSnapshotV2; revision: number } | undefined> {
    const collaborative = this.#collaboration.snapshotForCanvas(canvasId)
    if (collaborative) {
      return {
        snapshot: collaborative,
        revision: this.#collaboration.revisionForCanvas(canvasId, collaborative.projectId) ?? 0,
      }
    }
    const snapshot = await this.#canvases.getCanvas(canvasId)
    return snapshot ? { snapshot, revision: this.#state.revisions[canvasId] ?? 0 } : undefined
  }

  mutate<T>(input: {
    canvasId: string
    baseRevision?: number
    origin: string
    mutation: (snapshot: CanvasSnapshotV2) => { snapshot: CanvasSnapshotV2; result: T }
  }): Promise<{ result: T; snapshot: CanvasSnapshotV2; revision: number; changed: boolean }> {
    return this.#serial(input.canvasId, async () => {
      const current = await this.get(input.canvasId)
      if (!current) throw new Error('Canvas not found')
      if (input.baseRevision !== undefined && input.baseRevision !== current.revision) {
        throw new CanvasRevisionConflictError(input.baseRevision, current.revision)
      }
      const next = input.mutation(structuredClone(current.snapshot))
      const changed = JSON.stringify(current.snapshot) !== JSON.stringify(next.snapshot)
      if (!changed) return { result: next.result, snapshot: current.snapshot, revision: current.revision, changed }

      let revision: number
      const collaborative = this.#collaboration.applyCanvasSnapshot({
        snapshot: next.snapshot,
        baseRevision: input.baseRevision,
        origin: input.origin,
      })
      if (collaborative) {
        revision = collaborative.revision
      } else {
        revision = current.revision + 1
        await this.#canvases.saveCanvas(next.snapshot)
        this.#state.revisions[input.canvasId] = revision
        await this.#saveRevisions()
      }
      const event: CanvasDocumentEvent = {
        canvasId: input.canvasId,
        projectId: next.snapshot.projectId,
        revision,
        snapshot: structuredClone(next.snapshot),
        origin: input.origin,
      }
      this.#events.emit(input.canvasId, event)
      return { result: next.result, snapshot: next.snapshot, revision, changed }
    })
  }

  async importSnapshot(snapshot: CanvasSnapshotV2, baseRevision?: number, origin = 'browser'): Promise<number> {
    const existing = await this.get(snapshot.canvasId)
    if (!existing) {
      await this.#canvases.saveCanvas(snapshot)
      this.#state.revisions[snapshot.canvasId] = 1
      await this.#saveRevisions()
      return 1
    }
    const committed = await this.mutate({
      canvasId: snapshot.canvasId,
      baseRevision,
      origin,
      mutation: () => ({ snapshot, result: undefined }),
    })
    return committed.revision
  }

  subscribe(canvasId: string, listener: (event: CanvasDocumentEvent) => void): () => void {
    this.#events.on(canvasId, listener)
    return () => this.#events.off(canvasId, listener)
  }

  async #saveRevisions(): Promise<void> {
    await mkdir(join(this.#revisionPath, '..'), { recursive: true })
    await atomicWriteJson(this.#revisionPath, this.#state)
  }

  #serial<T>(canvasId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queue.get(canvasId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.#queue.set(canvasId, current)
    void current.finally(() => {
      if (this.#queue.get(canvasId) === current) this.#queue.delete(canvasId)
    }).catch(() => undefined)
    return current
  }
}
