import { useCallback, useState } from 'react'
import type { StoreApi } from 'zustand/vanilla'
import type { ReactFlowInstance } from '@xyflow/react'

import type { CanvasNode, Point } from '../../model/project'
import type { CanvasStoreState } from '../../store/canvas-store'
import {
  rotatedBounds,
  snapResizeRect,
  type ResizeDirection,
  type SnapDistance,
  type SnapGuide,
  type SnapRect,
} from './smartSnapping'
import { mapProjectSnapshotToReactFlow, type CanvasFlowEdge, type CanvasFlowNode } from './mapping'

export interface UseCanvasSnappingOptions {
  store: StoreApi<CanvasStoreState>
  flowInstance: ReactFlowInstance<CanvasFlowNode, CanvasFlowEdge> | null
  smartSnap?: boolean
  snapToGrid?: boolean
}

export function useCanvasSnapping({
  store,
  flowInstance,
  smartSnap = true,
  snapToGrid = false,
}: UseCanvasSnappingOptions) {
  const [snapOverlay, setSnapOverlay] = useState<{
    guides: SnapGuide[]
    distances: SnapDistance[]
  }>({ guides: [], distances: [] })

  const snapCandidates = useCallback((excludedIds: readonly string[]): SnapRect[] => {
    const excluded = new Set(excludedIds)
    const result: SnapRect[] = []
    const snapshot = store.getState().snapshot
    const modelById = new Map(snapshot.nodes.map((candidate) => [candidate.id, candidate]))
    const liveNodes = typeof flowInstance?.getNodes === 'function'
      ? flowInstance.getNodes()
      : mapProjectSnapshotToReactFlow(snapshot).nodes
    for (const node of liveNodes) {
      if (excluded.has(node.id)) continue
      const model = modelById.get(node.id)
      if (!model || model.hidden || model.locked) continue
      const internal = flowInstance?.getInternalNode(node.id)
      const position = internal?.internals.positionAbsolute ?? node.position
      const baseRect: SnapRect = {
        id: node.id,
        x: position.x,
        y: position.y,
        width: model.size.width,
        height: model.size.height,
        kind: model.type === 'frame' ? 'frame' : 'node',
      }
      const nodeRotation = 'rotation' in model.data && typeof model.data.rotation === 'number' ? model.data.rotation : 0
      result.push(nodeRotation ? rotatedBounds(baseRect, nodeRotation) : baseRect)

      if (model.type === 'frame' && model.size.width > 64 && model.size.height > 64) {
        result.push({
          id: `${node.id}-inner`,
          x: position.x + 16,
          y: position.y + 16,
          width: model.size.width - 32,
          height: model.size.height - 32,
          kind: 'frame',
        })
      }
    }
    return result
  }, [flowInstance, store])

  const deepestFrameAt = useCallback((center: Point, excludedIds: readonly string[]) => {
    const excluded = new Set(excludedIds)
    const snapshotNow = store.getState().snapshot
    const byId = new Map(snapshotNow.nodes.map((node) => [node.id, node]))
    const indexById = new Map(snapshotNow.nodes.map((node, idx) => [node.id, idx]))
    const depthCache = new Map<string, number>()
    const getDepth = (node: CanvasNode | undefined): number => {
      if (!node) return 0
      const cached = depthCache.get(node.id)
      if (cached !== undefined) return cached
      let value = 0
      let cursor = node.parentId ? byId.get(node.parentId) : undefined
      while (cursor) {
        value += 1
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
      }
      depthCache.set(node.id, value)
      return value
    }

    const candidates = snapCandidates(excludedIds)
    let bestFrameId: string | undefined
    let bestDepth = -1
    let bestIndex = -1

    for (const rect of candidates) {
      if (rect.kind !== 'frame' || !rect.id || excluded.has(rect.id)) continue
      if (
        center.x >= rect.x &&
        center.x <= rect.x + rect.width &&
        center.y >= rect.y &&
        center.y <= rect.y + rect.height
      ) {
        const frameNode = byId.get(rect.id)
        const frameDepth = getDepth(frameNode)
        const frameIndex = indexById.get(rect.id) ?? -1
        if (
          frameDepth > bestDepth ||
          (frameDepth === bestDepth && frameIndex > bestIndex)
        ) {
          bestDepth = frameDepth
          bestIndex = frameIndex
          bestFrameId = rect.id
        }
      }
    }
    return bestFrameId
  }, [snapCandidates, store])

  const handleCreativeResizeSnap = useCallback((
    nodeId: string,
    geometry: { x: number; y: number; width: number; height: number; direction: number[] },
    modifiers: { ctrlKey: boolean; altKey: boolean },
  ) => {
    const current = store.getState().snapshot
    const byId = new Map(current.nodes.map((node) => [node.id, node]))
    const absolute = (node: CanvasNode): Point => {
      const parent = node.parentId ? byId.get(node.parentId) : undefined
      const parentPosition = parent ? absolute(parent) : { x: 0, y: 0 }
      return { x: parentPosition.x + node.position.x, y: parentPosition.y + node.position.y }
    }
    const node = byId.get(nodeId)
    if (!node) return geometry
    const parentPosition = node.parentId && byId.get(node.parentId) ? absolute(byId.get(node.parentId)!) : { x: 0, y: 0 }
    const excluded = new Set([nodeId])
    const collectDescendants = (id: string) => {
      for (const child of current.nodes.filter((candidate) => candidate.parentId === id)) {
        excluded.add(child.id)
        collectDescendants(child.id)
      }
    }
    collectDescendants(nodeId)
    const candidates = current.nodes.flatMap((candidate): SnapRect[] => {
      if (excluded.has(candidate.id) || candidate.hidden || candidate.locked) return []
      const position = absolute(candidate)
      return [{ id: candidate.id, x: position.x, y: position.y, width: candidate.size.width, height: candidate.size.height, kind: candidate.type === 'frame' ? 'frame' : 'node' }]
    })
    const snapped = snapResizeRect({
      rect: { x: parentPosition.x + geometry.x, y: parentPosition.y + geometry.y, width: geometry.width, height: geometry.height },
      direction: { x: Math.sign(geometry.direction[0] ?? 0) as ResizeDirection['x'], y: Math.sign(geometry.direction[1] ?? 0) as ResizeDirection['y'] },
      candidates,
      zoom: current.viewport.zoom,
      enabled: smartSnap,
      grid: snapToGrid ? 12 : undefined,
      disable: modifiers.ctrlKey,
      measure: modifiers.altKey,
    })
    setSnapOverlay({ guides: snapped.guides, distances: snapped.distances })
    return { x: snapped.rect.x - parentPosition.x, y: snapped.rect.y - parentPosition.y, width: snapped.rect.width, height: snapped.rect.height }
  }, [smartSnap, snapToGrid, store])

  return {
    snapOverlay,
    setSnapOverlay,
    snapCandidates,
    deepestFrameAt,
    handleCreativeResizeSnap,
  }
}
