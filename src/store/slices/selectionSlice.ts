import type { CanvasStoreState, StoreGet, StoreSet } from '../types.ts'

export function createSelectionActions(
  set: StoreSet,
  get: StoreGet,
): Pick<CanvasStoreState, 'selectNode' | 'selectNodes' | 'selectEdge' | 'setMode' | 'setViewport'> {
  return {
    selectNode: (nodeId, additive = false) => {
      if (nodeId === null) {
        set({ selectedNodeIds: [] })
        return
      }

      if (!get().snapshot.nodes.some((node) => node.id === nodeId)) return

      set((state) => {
        if (!additive) return { selectedNodeIds: [nodeId], selectedEdgeIds: [] }

        const isSelected = state.selectedNodeIds.includes(nodeId)
        return {
          selectedNodeIds: isSelected
            ? state.selectedNodeIds.filter((id) => id !== nodeId)
            : [...state.selectedNodeIds, nodeId],
        }
      })
    },
    selectNodes: (nodeIds, additive = false) => {
      const allNodes = get().snapshot.nodes
      const validIds = nodeIds.filter((id) => allNodes.some((n) => n.id === id))
      set((state) => {
        if (!additive) {
          return { selectedNodeIds: validIds, selectedEdgeIds: [] }
        }
        const setIds = new Set(state.selectedNodeIds)
        for (const id of validIds) {
          setIds.add(id)
        }
        return { selectedNodeIds: Array.from(setIds) }
      })
    },
    selectEdge: (edgeId, additive = false) => {
      if (edgeId === null) {
        set({ selectedEdgeIds: [] })
        return
      }

      if (!get().snapshot.edges.some((edge) => edge.id === edgeId)) return

      set((state) => {
        if (!additive) return { selectedEdgeIds: [edgeId], selectedNodeIds: [] }

        const isSelected = state.selectedEdgeIds.includes(edgeId)
        return {
          selectedEdgeIds: isSelected
            ? state.selectedEdgeIds.filter((id) => id !== edgeId)
            : [...state.selectedEdgeIds, edgeId],
        }
      })
    },
    setMode: (mode) => set({ mode }),
    setViewport: (viewport) => {
      const current = get().snapshot
      if (
        current.viewport.x === viewport.x &&
        current.viewport.y === viewport.y &&
        current.viewport.zoom === viewport.zoom
      ) {
        return
      }
      set({ snapshot: { ...current, viewport } })
    },
  }
}
