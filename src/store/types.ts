import type { GenerationHistoryEntry } from '../contracts/generation.ts'
import type {
  CanvasEdge,
  CanvasNode,
  ImageVersion,
  MediaGeneration,
  MediaGenerationSettings,
  NodeSize,
  OrderedReference,
  Point,
  ProjectSnapshot,
  Viewport,
} from '../model/project.ts'
import type { CanvasEntityChangeSet } from '../collaboration/entityChanges.ts'

export type CanvasMode = 'select' | 'pan' | 'connect'

export interface GenerationBatchInput {
  projectId: string
  sourceNodeId: string
  clientRequestId: string
  prompt: string
  createdAt: string
  settings: MediaGenerationSettings
  existingTargetNodeIds: string[]
  targetNodes: CanvasNode[]
  outputEdges: CanvasEdge[]
}

export interface GuardedGenerationUpdate {
  projectId: string
  nodeId: string
  clientRequestId: string | null
  expectedJobId: string | null
  generation: MediaGeneration
  asset?: { assetId: string; url: string; poster?: string }
}

export interface GuardedMediaAssetUpdate {
  projectId: string
  nodeId: string
  expectedUrl: string
  asset: { assetId: string; url: string; poster?: string }
}

export interface ImportedCanvasGraph {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  anchor: Point
}

export interface CanvasStoreState {
  snapshot: ProjectSnapshot
  selectedNodeIds: string[]
  selectedEdgeIds: string[]
  mode: CanvasMode
  canUndo: boolean
  canRedo: boolean
  selectNode: (nodeId: string | null, additive?: boolean) => void
  selectNodes: (nodeIds: string[], additive?: boolean) => void
  selectEdge: (edgeId: string | null, additive?: boolean) => void
  setMode: (mode: CanvasMode) => void
  moveNode: (nodeId: string, position: Point) => void
  moveNodes: (moves: Array<{ id: string; position: Point }>) => void
  moveNodesInHierarchy: (moves: Array<{ id: string; positionAbsolute: Point }>, parentId?: string) => void
  reparentNodes: (nodeIds: string[], parentId?: string, index?: number) => boolean
  reorderNodes: (nodeIds: string[], targetId: string, placement: 'before' | 'after' | 'inside') => boolean
  reconcileFrameMembership: (nodeIds: string[]) => void
  renameNode: (nodeId: string, name: string) => void
  renameCanvas: (name: string) => void
  addNode: (node: CanvasNode) => void
  createNodeFromHistory: (
    entry: GenerationHistoryEntry,
    center: Point,
  ) => string
  addEdge: (edge: CanvasEdge) => void
  addConnectedNode: (node: CanvasNode, edge: CanvasEdge) => void
  attachReference: (
    targetNodeId: string,
    sourceNodeId: string,
  ) => CanvasEdge | undefined
  detachReference: (targetNodeId: string, sourceNodeId: string) => void
  getOrderedReferences: (targetNodeId: string) => OrderedReference[]
  deleteNodes: (nodeIds: string[]) => void
  deleteEdges: (edgeIds: string[]) => void
  duplicateNodes: (nodeIds: string[]) => string[]
  pasteImportedGraph: (graph: ImportedCanvasGraph) => string[]
  groupNodes: (nodeIds: string[], groupId: string, name: string) => void
  ungroupNodes: (groupIds: string[]) => void
  resizeNode: (nodeId: string, size: NodeSize, position?: Point) => void
  updateCreativeNode: (
    nodeId: string,
    changes: { size?: NodeSize; position?: Point; rotation?: number; fill?: string; stroke?: string; strokeWidth?: number; opacity?: number; radius?: number },
  ) => void
  moveNodeLayer: (nodeId: string, direction: 'front' | 'back') => void
  setNodeVisibility: (nodeId: string, visible: boolean) => void
  setNodeLocked: (nodeId: string, locked: boolean) => void
  patchNode: (
    nodeId: string,
    changes: Partial<{
      name: string
      position: Point
      size: NodeSize
      data: Record<string, unknown>
    }>,
    commit?: boolean,
  ) => void
  updateTextNode: (nodeId: string, text: string, commit?: boolean) => void
  addImageVersion: (nodeId: string, version: ImageVersion) => void
  setImageVersion: (nodeId: string, versionId: string) => void
  toggleNodeFlag: (nodeId: string, flag: 'locked' | 'hidden') => void
  updateGenerationSettings: (
    nodeId: string,
    settings: MediaGenerationSettings,
  ) => void
  reconcileImageNaturalSize: (
    nodeId: string,
    naturalWidth: number,
    naturalHeight: number,
  ) => void
  updateGenerationPrompt: (nodeId: string, prompt: string) => void
  createGenerationBatch: (input: GenerationBatchInput) => string[] | undefined
  setMediaGenerationGuarded: (input: GuardedGenerationUpdate) => boolean
  setMediaAssetGuarded: (input: GuardedMediaAssetUpdate) => boolean
  setMediaGeneration: (
    nodeId: string,
    generation: MediaGeneration,
    result?: { url?: string; poster?: string },
  ) => void
  setMediaAsset: (
    nodeId: string,
    asset: { url: string; poster?: string },
  ) => void
  layoutNodes: (nodeIds?: string[]) => void
  setViewport: (viewport: Viewport) => void
  undo: () => void
  redo: () => void
  serialize: () => string
  restore: (serialized: string) => void
  reconcileRemoteSnapshot: (snapshot: ProjectSnapshot, options?: { rebaseHistory?: boolean; onHistoryInvalidated?: (count: number) => void }) => void
  applyEntityChanges: (changes: CanvasEntityChangeSet) => void
}

import type { StoreApi } from 'zustand/vanilla'

export type StoreSet = StoreApi<CanvasStoreState>['setState']
export type StoreGet = StoreApi<CanvasStoreState>['getState']
