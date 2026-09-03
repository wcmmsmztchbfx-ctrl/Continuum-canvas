import type { Edge, Node, Viewport } from '@xyflow/react'

import type {
  CanvasNode,
  MediaGeneration,
  MediaGenerationSettings,
  Point,
  ProjectSnapshot,
} from '../../model/project'
import type { GenerationQuoteRequest } from '../../contracts/generation'
import { getOrderedReferences } from '../../model/project'

export type CanvasFlowNodeType =
  | 'image'
  | 'video'
  | 'text'
  | 'placeholder'
  | 'group'
  | 'audio'
  | 'script'
  | 'director'
  | 'video-clip'
  | 'frame'
  | 'shape'
  | 'path'

export type CanvasFlowNodeData = {
  canvasId?: string
  projectId?: string
  name: string
  mediaType: CanvasNode['type']
  isSoleSelection?: boolean
  onConnectionPointerDown?: () => void
  remoteLock?: {
    memberId: string
    displayName: string
    color: string
    kind: 'drag' | 'resize' | 'text' | 'settings' | 'bulk'
  }
  lockedBy?: CanvasFlowNodeData['remoteLock']
  interactionLeaseLost?: number
  url: string
  thumbnailUrl?: string
  alt?: string
  poster?: string
  durationSec?: number
  hasAudio?: boolean
  text?: string
  node?: CanvasNode
  editingVector?: boolean
  referenceNodeIds?: string[]
  references?: Array<{
    id: string
    referenceAlias: number
    name: string
    kind: 'image' | 'video' | 'audio'
    url?: string
    poster?: string
  }>
  referenceCandidates?: Array<{
    id: string
    name: string
    kind: 'image' | 'video' | 'audio'
    url?: string
    poster?: string
  }>
  referencePickCandidate?: boolean
  referencePickTarget?: boolean
  referencePickerActive?: boolean
  unresolvedReferences?: boolean
  generation?: MediaGeneration
  generationPending?: boolean
  generationError?: { code: string; message: string }
  generationSettings?: MediaGenerationSettings
  promptDraft?: string
  onResize?: (nodeId: string, size: { width: number; height: number }, position?: { x: number; y: number }) => void
  onResizeStart?: (nodeId: string) => boolean
  onResizePreview?: (nodeId: string, size: { width: number; height: number }, position?: { x: number; y: number }) => void
  onImageNaturalSize?: (
    nodeId: string,
    naturalWidth: number,
    naturalHeight: number,
  ) => void
  onRename?: (nodeId: string, name: string) => void
  onTextChange?: (nodeId: string, text: string, commit?: boolean) => void
  onInteractionStart?: (nodeId: string, kind: 'text' | 'settings') => boolean
  onInteractionEnd?: (nodeId: string, kind: 'text' | 'settings') => void
  onGenerate?: (nodeId: string, request: GenerationQuoteRequest) => void
  onPromptChange?: (nodeId: string, prompt: string) => void
  onRetry?: (nodeId: string, prompt: string) => void
  onSettingsChange?: (
    nodeId: string,
    settings: MediaGenerationSettings,
  ) => void
  onAttachReference?: (
    targetNodeId: string,
    sourceNodeId: string,
  ) => Promise<number | undefined>
  onRemoveReference?: (targetNodeId: string, sourceNodeId: string) => Promise<void | undefined>
  onReferencePickerChange?: (targetNodeId: string, active: boolean) => void
  onCreateConnected?: (
    nodeId: string,
    kind: 'image' | 'video' | 'text',
  ) => void
  imagePanelMode?: 'generate' | 'edit'
  onImagePanelModeChange?: (nodeId: string, mode: 'generate' | 'edit') => void
  imageEditorContent?: import('react').ReactNode
  versions?: import('../../model/project').ImageVersion[]
  activeVersionId?: string
  onSetImageVersion?: (nodeId: string, versionId: string) => void
  onCaptureFrame?: (nodeId: string, video: HTMLVideoElement, capture: 'first' | 'current' | 'last') => void
  onCreativeChange?: (
    nodeId: string,
    changes: { size?: { width: number; height: number }; position?: Point; rotation?: number; fill?: string; stroke?: string; strokeWidth?: number; opacity?: number; radius?: number },
  ) => void
  onCreativeResizeSnap?: (
    nodeId: string,
    geometry: { x: number; y: number; width: number; height: number; direction: number[] },
    modifiers: { ctrlKey: boolean; altKey: boolean },
  ) => { x: number; y: number; width: number; height: number }
  onLayerChange?: (nodeId: string, direction: 'front' | 'back') => void
}

export type CanvasFlowNode = Node<CanvasFlowNodeData, CanvasFlowNodeType>
export interface CanvasFlowEdgeData extends Record<string, unknown> {
  linkedToSelected?: boolean
  relation: 'reference' | 'output' | 'flow'
  referenceAlias?: number
}

export type CanvasFlowEdge = Edge<CanvasFlowEdgeData, 'canvas'>

export interface ReactFlowProject {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
  viewport: Viewport
}

export function mapNode(
  node: CanvasNode,
  references: CanvasFlowNodeData['references'] = [],
  zIndex = 1,
): CanvasFlowNode {
  let type: CanvasFlowNodeType = node.type
  if (node.type === 'text') {
    const nodeKind =
      node.data.nodeKind ??
      (node.name === '音频节点'
        ? 'audio'
        : node.name === '脚本节点'
          ? 'script'
          : 'text')
    type = nodeKind
  }
  if (node.type === 'group') {
    const nodeKind =
      node.data.nodeKind ??
      (node.name === '导演台'
        ? 'director'
        : node.name === '视频合成'
          ? 'video-clip'
          : 'group')
    type = nodeKind
  }

  const mediaData =
    node.type === 'image' || node.type === 'video'
      ? node.data
      : node.type === 'text'
        ? { url: node.data.url ?? '', text: node.data.text }
        : { url: '' }

  return {
    id: node.id,
    type,
    position: { ...node.position },
    parentId: node.parentId,
    zIndex,
    width: node.size.width,
    height: node.size.height,
    initialWidth: node.size.width,
    initialHeight: node.size.height,
    style: {
      width: node.size.width,
      height: node.size.height,
      zIndex,
      ...(node.hidden || ('hidden' in node.data && node.data.hidden) ? { display: 'none' } : {}),
    },
    draggable: !(node.locked || ('locked' in node.data && node.data.locked)),
    selectable: !(node.locked || ('locked' in node.data && node.data.locked)),
    ariaLabel: node.name,
    data: {
      name: node.name,
      mediaType: node.type,
      ...mediaData,
      node,
      references,
    },
  }
}

export function mapProjectSnapshotToReactFlow(
  snapshot: ProjectSnapshot,
): ReactFlowProject {
  return {
    viewport: { ...snapshot.viewport },
    nodes: snapshot.nodes.map((node, index) =>
      mapNode(
        node,
        getOrderedReferences(snapshot, node.id).flatMap(({ edge, node: reference }) =>
          reference.type === 'image' || reference.type === 'video'
            ? [{
                id: reference.id,
                referenceAlias: edge.referenceAlias,
                name: reference.name,
                kind: reference.type,
                url: reference.data.url,
                poster: reference.type === 'video' ? reference.data.poster : undefined,
              }]
            : [],
        ),
        index + 1,
      ),
    ),
    edges: snapshot.edges.map((edge) => ({
      ...edge,
      type: 'canvas',
      data: {
        relation: edge.relation ?? 'flow',
        ...(edge.referenceAlias !== undefined
          ? { referenceAlias: edge.referenceAlias }
          : {}),
      },
    })),
  }
}

export const mapFixtureToReactFlow = mapProjectSnapshotToReactFlow
