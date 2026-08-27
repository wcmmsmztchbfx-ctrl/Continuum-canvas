import type { ProjectSnapshot } from '../../model/project'
import { normalizeCanvasHierarchy, parseProjectSnapshot } from '../../model/project'
import type { CanvasStoreState, StoreGet, StoreSet } from '../types'
import { MAX_UNDO_STACK_SIZE, lockedGenerationNodeIds } from '../storeHelpers'

export interface HistoryContext {
  past: ProjectSnapshot[]
  future: ProjectSnapshot[]
  commitDocument: (next: ProjectSnapshot) => void
}

export function createHistoryContext(set: StoreSet, get: StoreGet): HistoryContext {
  const past: ProjectSnapshot[] = []
  const future: ProjectSnapshot[] = []

  const commitDocument = (next: ProjectSnapshot) => {
    const current = get().snapshot
    if (next === current) return

    past.push(current)
    if (past.length > MAX_UNDO_STACK_SIZE) {
      past.shift()
    }
    future.length = 0
    set({
      snapshot: { ...next, nodes: normalizeCanvasHierarchy(next.nodes) },
      canUndo: true,
      canRedo: false,
    })
  }

  return { past, future, commitDocument }
}

export function createHistoryActions(
  set: StoreSet,
  get: StoreGet,
  ctx: HistoryContext,
): Pick<CanvasStoreState, 'undo' | 'redo' | 'serialize' | 'restore'> {
  return {
    undo: () => {
      if (lockedGenerationNodeIds(get().snapshot).size > 0) return
      const previous = ctx.past.pop()
      if (!previous) return

      ctx.future.push(get().snapshot)
      const ids = new Set(previous.nodes.map((node) => node.id))
      set({
        snapshot: previous,
        selectedNodeIds: get().selectedNodeIds.filter((id) => ids.has(id)),
        canUndo: ctx.past.length > 0,
        canRedo: true,
      })
    },
    redo: () => {
      const next = ctx.future.pop()
      if (!next) return

      ctx.past.push(get().snapshot)
      const ids = new Set(next.nodes.map((node) => node.id))
      set({
        snapshot: next,
        selectedNodeIds: get().selectedNodeIds.filter((id) => ids.has(id)),
        canUndo: true,
        canRedo: ctx.future.length > 0,
      })
    },
    serialize: () => JSON.stringify(get().snapshot),
    restore: (serialized) => {
      const snapshot = parseProjectSnapshot(serialized)
      ctx.past.length = 0
      ctx.future.length = 0
      set({
        snapshot,
        selectedNodeIds: [],
        mode: 'select',
        canUndo: false,
        canRedo: false,
      })
    },
  }
}
