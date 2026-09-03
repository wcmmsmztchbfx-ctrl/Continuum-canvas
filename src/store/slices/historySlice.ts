import type { ProjectSnapshot } from '../../model/project'
import { normalizeCanvasHierarchy, parseProjectSnapshot } from '../../model/project'
import type { CanvasStoreState, StoreGet, StoreSet } from '../types'
import { MAX_UNDO_STACK_SIZE, lockedGenerationNodeIds } from '../storeHelpers'

export interface HistoryContext {
  past: ProjectSnapshot[]
  future: ProjectSnapshot[]
  lastCommitted: { current: ProjectSnapshot | null }
  commitDocument: (next: ProjectSnapshot) => void
}

export function createHistoryContext(
  set: StoreSet,
  get: StoreGet,
  initialSnapshot?: ProjectSnapshot,
): HistoryContext {
  const past: ProjectSnapshot[] = []
  const future: ProjectSnapshot[] = []
  const lastCommitted: { current: ProjectSnapshot | null } = {
    current: initialSnapshot ?? null,
  }

  const commitDocument = (next: ProjectSnapshot) => {
    const base = lastCommitted.current ?? get().snapshot
    if (next === base) return

    past.push(base)
    if (past.length > MAX_UNDO_STACK_SIZE) {
      past.shift()
    }
    future.length = 0
    const committedSnapshot = { ...next, nodes: normalizeCanvasHierarchy(next.nodes) }
    lastCommitted.current = committedSnapshot
    set({
      snapshot: committedSnapshot,
      canUndo: true,
      canRedo: false,
    })
  }

  return { past, future, lastCommitted, commitDocument }
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

      ctx.future.push(ctx.lastCommitted.current ?? get().snapshot)
      ctx.lastCommitted.current = previous
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

      ctx.past.push(ctx.lastCommitted.current ?? get().snapshot)
      ctx.lastCommitted.current = next
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
      ctx.lastCommitted.current = snapshot
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
