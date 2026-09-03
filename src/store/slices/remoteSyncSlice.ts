import { normalizeCanvasHierarchy } from '../../model/project'
import type { CanvasEntityChangeSet } from '../../collaboration/entityChanges'
import type { CanvasStoreState, StoreGet, StoreSet } from '../types'
import { reconcileEntities, sameEntity } from '../storeHelpers'

export function createRemoteSyncActions(
  set: StoreSet,
  get: StoreGet,
): Pick<CanvasStoreState, 'reconcileRemoteSnapshot' | 'applyEntityChanges'> {
  return {
    reconcileRemoteSnapshot: (incoming) => {
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
      set({ snapshot, selectedNodeIds })
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
