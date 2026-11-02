import { normalizeCanvasHierarchy, parseProjectSnapshot } from '../../model/project.ts'
import type { CanvasEntityChangeSet } from '../../collaboration/entityChanges.ts'
import type { CanvasStoreState, StoreGet, StoreSet } from '../types.ts'
import { reconcileEntities, sameEntity } from '../storeHelpers.ts'
import type { HistoryContext } from './historySlice.ts'
import { mergeCanvasSnapshots } from '../../model/canvasMerge.ts'
import type { ProjectSnapshot } from '../../model/project.ts'

export function createRemoteSyncActions(
  set: StoreSet,
  get: StoreGet,
  history?: HistoryContext,
): Pick<CanvasStoreState, 'reconcileRemoteSnapshot' | 'applyEntityChanges'> {
  return {
    reconcileRemoteSnapshot: (incoming, options) => {
      const current = get().snapshot
      const nodes = reconcileEntities(current.nodes, incoming.nodes)
      const edges = reconcileEntities(current.edges, incoming.edges)
      const snapshot = {
        ...incoming,
        viewport: current.viewport,
        nodes,
        edges,
      }
      const selectedNodeIds = get().selectedNodeIds.filter((id) =>
        nodes.some((node) => node.id === id),
      )
      const selectedEdgeIds = get().selectedEdgeIds.filter(id => edges.some(edge => edge.id === id))
      let invalidatedHistory = 0
      if (options?.rebaseHistory && history) {
        // Saving fills legacy/default metadata (for example text nodeKind and
        // edge relation). Compare the same canonical form so that this round
        // trip does not look like a remote edit that invalidates local undo.
        const asCanvas = (project: ProjectSnapshot) => ({
          ...parseProjectSnapshot(JSON.stringify(project)),
          version: 3 as const,
          canvasId: project.projectId,
        })
        const base = asCanvas(current)
        const remote = asCanvas(snapshot)
        const rebase = (entries: ProjectSnapshot[]) => {
          const valid = entries.flatMap(entry => {
            const merged = mergeCanvasSnapshots(base, asCanvas(entry), remote)
            if (merged.conflicts.length) { invalidatedHistory++; return [] }
            const { canvasId: _id, ...project } = merged.canvas
            return [{ ...project, version: 1 as const, viewport: current.viewport }]
          })
          entries.splice(0, entries.length, ...valid)
        }
        rebase(history.past)
        rebase(history.future)
        history.lastCommitted.current = snapshot
      }
      set({ snapshot, selectedNodeIds, selectedEdgeIds,
        ...(options?.rebaseHistory && history ? { canUndo: !!history.past.length, canRedo: !!history.future.length } : {}),
      })
      if (invalidatedHistory) options?.onHistoryInvalidated?.(invalidatedHistory)
    },

    applyEntityChanges: (changes: CanvasEntityChangeSet) => {
      const currentState = get()
      const current = currentState.snapshot
      const removedNodeIds = new Set(changes.nodes.removed)
      const removedEdgeIds = new Set(changes.edges.removed)

      const mergeEntities = <T extends { id: string }>(
        existing: readonly T[],
        upserted: readonly T[],
        removed: ReadonlySet<string>,
        order?: readonly string[],
      ): T[] => {
        const incoming = new Map(upserted.map((entity) => [entity.id, entity]))
        const merged = new Map<string, T>()
        for (const entity of existing) {
          if (removed.has(entity.id)) continue
          const replacement = incoming.get(entity.id)
          merged.set(
            entity.id,
            replacement && !sameEntity(entity, replacement) ? replacement : entity,
          )
          incoming.delete(entity.id)
        }
        for (const entity of upserted) {
          if (!removed.has(entity.id) && incoming.has(entity.id)) {
            merged.set(entity.id, entity)
            incoming.delete(entity.id)
          }
        }
        if (!order) return [...merged.values()]
        const rank = new Map(order.map((id, index) => [id, index]))
        return [...merged.values()].sort((left, right) =>
          (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
        )
      }

      const nodes = mergeEntities(
        current.nodes,
        changes.nodes.upserted,
        removedNodeIds,
        changes.nodeOrder,
      )
      const liveNodeIds = new Set(nodes.map((node) => node.id))
      const edges = mergeEntities(
        current.edges,
        changes.edges.upserted,
        removedEdgeIds,
        changes.edgeOrder,
      ).filter((edge) => liveNodeIds.has(edge.source) && liveNodeIds.has(edge.target))
      const selectedNodeIds = currentState.selectedNodeIds.filter((id) => liveNodeIds.has(id))
      const name = changes.name ?? current.name
      const changed = name !== current.name ||
        nodes.length !== current.nodes.length || nodes.some((node, index) => node !== current.nodes[index]) ||
        edges.length !== current.edges.length || edges.some((edge, index) => edge !== current.edges[index])
      const selectionChanged = selectedNodeIds.length !== currentState.selectedNodeIds.length ||
        selectedNodeIds.some((id, index) => id !== currentState.selectedNodeIds[index])
      if (!changed && !selectionChanged) return

      const normalizedNodes = reconcileEntities(nodes, normalizeCanvasHierarchy(nodes))
      set({
        ...(changed
          ? { snapshot: { ...current, name, nodes: normalizedNodes, edges } }
          : {}),
        ...(selectionChanged ? { selectedNodeIds } : {}),
      })
    },
  }
}
