import { createStore } from 'zustand/vanilla'

import type { ProjectSnapshot } from '../model/project.ts'
import type { CanvasStoreState } from './types.ts'
import { createHistoryActions, createHistoryContext } from './slices/historySlice.ts'
import { createSelectionActions } from './slices/selectionSlice.ts'
import { createNodesActions } from './slices/nodesSlice.ts'
import { createEdgesActions } from './slices/edgesSlice.ts'
import { createGenerationActions } from './slices/generationSlice.ts'
import { createRemoteSyncActions } from './slices/remoteSyncSlice.ts'

export * from './types.ts'

export function createCanvasStore(initialSnapshot: ProjectSnapshot) {
  return createStore<CanvasStoreState>((set, get) => {
    const history = createHistoryContext(set, get, initialSnapshot)

    const historyActions = createHistoryActions(set, get, history)
    const selectionActions = createSelectionActions(set, get)
    const nodesActions = createNodesActions(set, get, history)
    const edgesActions = createEdgesActions(set, get, history)
    const generationActions = createGenerationActions(set, get, history)
    const remoteSyncActions = createRemoteSyncActions(set, get, history)

    return {
      snapshot: initialSnapshot,
      selectedNodeIds: [],
      selectedEdgeIds: [],
      mode: 'select',
      canUndo: false,
      canRedo: false,

      ...selectionActions,
      ...nodesActions,
      ...edgesActions,
      ...generationActions,
      ...historyActions,
      ...remoteSyncActions,
    }
  })
}

export const EMPTY_CANVAS_SNAPSHOT: ProjectSnapshot = {
  version: 1,
  projectId: 'default-project',
  name: '未命名画布',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
}

export type CanvasStore = ReturnType<typeof createCanvasStore>
export const canvasStore = createCanvasStore(EMPTY_CANVAS_SNAPSHOT)
