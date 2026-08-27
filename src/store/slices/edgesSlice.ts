import type { CanvasEdge } from '../../model/project'
import { getOrderedReferences } from '../../model/project'
import type { CanvasStoreState, StoreGet, StoreSet } from '../types'
import type { HistoryContext } from './historySlice'
import { applyReferenceRemovals, referenceEdgeId } from '../storeHelpers'

export function createEdgesActions(
  set: StoreSet,
  get: StoreGet,
  history: HistoryContext,
): Pick<
  CanvasStoreState,
  | 'addEdge'
  | 'addConnectedNode'
  | 'attachReference'
  | 'detachReference'
  | 'getOrderedReferences'
  | 'deleteEdges'
> {
  return {
    addEdge: (edge) => {
      if (edge.source === edge.target) return
      const current = get().snapshot
      const hasSource = current.nodes.some((node) => node.id === edge.source)
      const hasTarget = current.nodes.some((node) => node.id === edge.target)
      const hasId = current.edges.some((candidate) => candidate.id === edge.id)
      if (!hasSource || !hasTarget || hasId) return

      history.commitDocument({
        ...current,
        edges: [...current.edges, edge],
      })
    },

    addConnectedNode: (node, edge) => {
      const current = get().snapshot
      if (
        current.nodes.some((candidate) => candidate.id === node.id) ||
        current.edges.some((candidate) => candidate.id === edge.id)
      ) {
        return
      }

      const nodeIds = new Set(current.nodes.map((candidate) => candidate.id))
      nodeIds.add(node.id)
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return

      history.commitDocument({
        ...current,
        nodes: [...current.nodes, node],
        edges: [...current.edges, edge],
      })
      set({ selectedNodeIds: [node.id] })
    },

    attachReference: (targetNodeId, sourceNodeId) => {
      const current = get().snapshot
      const target = current.nodes.find((node) => node.id === targetNodeId)
      const source = current.nodes.find((node) => node.id === sourceNodeId)
      if (
        !target ||
        !source ||
        target.id === source.id ||
        (target.type !== 'image' && target.type !== 'video') ||
        (source.type !== 'image' && source.type !== 'video')
      ) {
        return undefined
      }

      const existing = current.edges.find(
        (edge) =>
          edge.target === targetNodeId &&
          edge.source === sourceNodeId &&
          edge.relation === 'reference',
      )
      if (existing) return existing

      const usedAliases = new Set(
        current.edges
          .filter(
            (edge) =>
              edge.target === targetNodeId &&
              edge.relation === 'reference' &&
              edge.referenceAlias !== undefined,
          )
          .map((edge) => edge.referenceAlias as number),
      )
      let referenceAlias = 1
      while (usedAliases.has(referenceAlias)) referenceAlias += 1

      const convertible = current.edges.find(
        (edge) =>
          edge.target === targetNodeId &&
          edge.source === sourceNodeId &&
          (edge.relation === undefined || edge.relation === 'flow'),
      )
      const reference: CanvasEdge = convertible
        ? { ...convertible, relation: 'reference', referenceAlias }
        : {
            id: referenceEdgeId(current.edges, sourceNodeId, targetNodeId),
            source: sourceNodeId,
            target: targetNodeId,
            sourceHandle: 'source',
            targetHandle: 'target',
            relation: 'reference',
            referenceAlias,
          }

      history.commitDocument({
        ...current,
        edges: convertible
          ? current.edges.map((edge) =>
              edge.id === convertible.id ? reference : edge,
            )
          : [...current.edges, reference],
      })
      return reference
    },

    detachReference: (targetNodeId, sourceNodeId) => {
      const current = get().snapshot
      const targetEdge = current.edges.find(
        (edge) =>
          edge.target === targetNodeId &&
          edge.source === sourceNodeId &&
          edge.relation === 'reference',
      )
      if (!targetEdge) return
      const remainingEdges = current.edges.filter((edge) => edge.id !== targetEdge.id)
      const removedAlias = targetEdge.referenceAlias
      if (removedAlias !== undefined) {
        const result = applyReferenceRemovals(current.nodes, remainingEdges, [
          { targetNodeId, removedAlias },
        ])
        history.commitDocument({ ...current, nodes: result.nodes, edges: result.edges })
      } else {
        history.commitDocument({ ...current, edges: remainingEdges })
      }
    },

    getOrderedReferences: (targetNodeId) =>
      getOrderedReferences(get().snapshot, targetNodeId),

    deleteEdges: (edgeIds) => {
      const ids = new Set(edgeIds)
      if (ids.size === 0) return
      const current = get().snapshot
      const removals: Array<{ targetNodeId: string; removedAlias: number }> = []
      for (const edge of current.edges) {
        if (
          ids.has(edge.id) &&
          edge.relation === 'reference' &&
          edge.referenceAlias !== undefined
        ) {
          removals.push({ targetNodeId: edge.target, removedAlias: edge.referenceAlias })
        }
      }
      const remainingEdges = current.edges.filter((edge) => !ids.has(edge.id))
      if (remainingEdges.length === current.edges.length) return

      const { nodes, edges } = applyReferenceRemovals(
        current.nodes,
        remainingEdges,
        removals,
      )
      history.commitDocument({ ...current, nodes, edges })
    },
  }
}
