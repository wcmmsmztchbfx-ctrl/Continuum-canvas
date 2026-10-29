import { CANVAS_SNAPSHOT_VERSION, type CanvasSnapshotV2, type ProjectSnapshotV1 } from '../model/project'
import { WorkspaceMutationQueue } from './workspaceMutationQueue'

export interface CapturedCanvasSave {
  readonly sessionId: symbol
  readonly sequence: number
  readonly document: CanvasSnapshotV2
}

interface CanvasSaveScope {
  canvasId: string
  projectId?: string
  owner: object
}

interface SaveCoordinator {
  sequence: number
  confirmed: Map<string, number>
  publications: WorkspaceMutationQueue
}

// Publication follows confirmed writes across editor mounts, not loading events.
const coordinators = new WeakMap<object, SaveCoordinator>()

export function createCanvasSaveSession(scope: CanvasSaveScope) {
  const sessionId = Symbol(scope.canvasId)
  let phase: 'loading' | 'ready' | 'error' | 'closed' = 'loading'
  let projectId = scope.projectId
  let lastOwnedSave: CapturedCanvasSave | undefined
  let queuedSequence: number | undefined
  let dirty = false
  let coordinator = coordinators.get(scope.owner)
  if (!coordinator) {
    coordinator = { sequence: 0, confirmed: new Map(), publications: new WorkspaceMutationQueue() }
    coordinators.set(scope.owner, coordinator)
  }

  const isLatest = (save: CapturedCanvasSave) =>
    save.sessionId === sessionId && save.sequence === lastOwnedSave?.sequence

  return {
    acceptLoaded(document: CanvasSnapshotV2): void {
      if (phase !== 'loading') throw new Error('画布加载会话已结束')
      if (document.canvasId !== scope.canvasId) throw new Error('画布内容与当前地址不一致')
      if (projectId && document.projectId !== projectId) throw new Error('画布归属与当前地址不一致')
      projectId = document.projectId
      phase = 'ready'
    },
    failLoading(): void {
      phase = 'error'
    },
    capture(snapshot: ProjectSnapshotV1): CapturedCanvasSave | undefined {
      if (phase !== 'ready' || snapshot.projectId !== projectId) return undefined
      lastOwnedSave = {
        sessionId,
        sequence: ++coordinator.sequence,
        document: {
          ...structuredClone(snapshot),
          version: CANVAS_SNAPSHOT_VERSION,
          canvasId: scope.canvasId,
        },
      }
      dirty = true
      return lastOwnedSave
    },
    markQueued(save: CapturedCanvasSave): void {
      if (isLatest(save)) queuedSequence = save.sequence
    },
    isLatest,
    succeed(save: CapturedCanvasSave): boolean {
      if (save.sessionId !== sessionId) return false
      if (isLatest(save)) {
        dirty = false
        queuedSequence = undefined
      }
      if ((coordinator.confirmed.get(scope.canvasId) ?? 0) >= save.sequence) return false
      coordinator.confirmed.set(scope.canvasId, save.sequence)
      return true
    },
    publish(save: CapturedCanvasSave, operation: () => Promise<unknown>): Promise<void> {
      return coordinator.publications.run(async () => {
        if (coordinator.confirmed.get(scope.canvasId) === save.sequence) await operation()
      })
    },
    fail(save: CapturedCanvasSave): boolean {
      if (!isLatest(save)) return false
      queuedSequence = undefined
      return true
    },
    close(): CapturedCanvasSave | undefined {
      phase = 'closed'
      if (dirty && lastOwnedSave && queuedSequence !== lastOwnedSave.sequence) return lastOwnedSave
      return undefined
    },
  }
}
