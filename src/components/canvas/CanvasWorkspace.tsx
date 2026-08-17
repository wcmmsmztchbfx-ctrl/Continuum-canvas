import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import {
  applyNodeChanges,
  ReactFlow,
  Handle,
  MiniMap,
  Position,
  SelectionMode,
  type Connection,
  type OnConnectEnd,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react'
import type { StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'

import {
  type CanvasEdge as ProjectCanvasEdge,
  type CanvasNode,
  type MediaGenerationSettings,
  type NodeSize,
  type Point,
  type Viewport,
} from '../../model/project'
import type { GenerationQuoteRequest } from '../../contracts/generation'
import type { InteractionPreview, NodeLease, NodeLeaseKind, PresenceState } from '../../contracts/collaboration'
import { selectCatalogModel } from '../../contracts/catalog'
import { getOrderedReferences } from '../../model/project'
import {
  GenerationController,
} from '../../services/generationController'
import { gatewayClient } from '../../services/gatewayClient'
import {
  canvasStore,
  type CanvasStoreState,
} from '../../store/canvas-store'
import { createBrowserUuid, createCanvasId } from '../../utils/id'
import type { SelectionAction } from '../overlays/SelectionToolbar'
import { useOptionalProviderCatalog } from '../providers/ProviderCatalogContext'
import { CanvasConnectionLine, CanvasEdge } from './CanvasEdge'
import {
  ConnectedNodeMenu,
  type ConnectedNodeKind,
} from './ConnectedNodeMenu'
import { GroupNode } from './GroupNode'
import { ImageNode } from './ImageNode'
import {
  mapProjectSnapshotToReactFlow,
  type CanvasFlowEdge,
  type CanvasFlowNode,
} from './mapping'
import { VideoNode } from './VideoNode'
import { TextNode } from './TextNode'
import { SpecialNode } from './SpecialNode'
import { FrameNode, PathNode, ShapeNode } from './CreativeNodes'
import { canEditReferencesWithCatalog, resolveVideoMode } from './generationUi'
import { CollaborationPresenceLayer } from './CollaborationPresenceLayer'
import { ImageEditorWorkspace } from './ImageEditorModal'
import { parseAspectRatio, sizeForAspectRatio } from './mediaGeometry'
import { snapRect, snapResizeRect, unionRect, type ResizeDirection, type SnapDistance, type SnapGuide, type SnapRect, type SnapState } from './smartSnapping'
import { stabilizeProjectedEdges, stabilizeProjectedNodes } from './flowProjection'
import { useCanvasDrop } from './useCanvasDrop'
import { SnapOverlay } from './CanvasSnapOverlay'
import { BrushPreview } from './CanvasBrushOverlay'
import { CreationPreview } from './CanvasCreationPreview'
import { LiveSelectionToolbar } from './LiveSelectionToolbar'
import '@xyflow/react/dist/style.css'
import './canvas.css'

export const CANVAS_MIN_ZOOM = 0.1
export const CANVAS_MAX_ZOOM = 8
export const CANVAS_CONNECTION_RADIUS = 64

function sameViewport(left: Viewport, right: Viewport): boolean {
  return (
    Math.abs(left.x - right.x) <= 0.5 &&
    Math.abs(left.y - right.y) <= 0.5 &&
    Math.abs(left.zoom - right.zoom) <= 0.001
  )
}

export interface CanvasWorkspaceProps {
  activeTool?: 'select' | 'frame' | 'shape' | 'pen' | 'text' | 'brush' | 'upload' | 'undo' | 'redo' | 'more'
  canvasId?: string
  store?: StoreApi<CanvasStoreState>
  generationController?: Pick<
    GenerationController,
    'start' | 'startSubmitted' | 'resumePersisted' | 'dispose'
  > &
    Partial<Pick<GenerationController, 'retry' | 'retrySubmitted'>>
  className?: string
  hideConnections?: boolean
  showMiniMap?: boolean
  snapToGrid?: boolean
  smartSnap?: boolean
  fitViewRequest?: number
  focusNodeRequest?: { id: string; nonce: number }
  readOnly?: boolean
  canGenerate?: boolean
  onConnect?: (edge: ProjectCanvasEdge) => void
  onNodesDelete?: (nodeIds: string[]) => void
  onEdgesDelete?: (edgeIds: string[]) => void
  onNodeResize?: (
    nodeId: string,
    size: { width: number; height: number },
  ) => void
  onNodeContextMenu?: (nodeId: string, position: { x: number; y: number }) => void
  onPaneContextMenu?: (position: { x: number; y: number }) => void
  onPaneDoubleClick?: (position: { x: number; y: number }) => void
  onPaneClick?: () => void
  onToolComplete?: (tool: 'frame' | 'shape' | 'text', nodeId: string) => void
  onSelectionAction?: (action: SelectionAction) => void
  onGenerationError?: (message: string) => void
  onImageEditingStateChange?: (state: { nodeId?: string; dirty: boolean; requestSelect?: (nodeId: string | null) => boolean }) => void
  collaboration?: CanvasWorkspaceCollaboration
}

export interface CanvasWorkspaceCollaboration {
  localMemberId?: string
  status?: 'inactive' | 'enabling' | 'connecting' | 'synced' | 'offline' | 'error'
  followingMemberId?: string
  onStopFollowing?: () => void
  presence: readonly PresenceState[]
  setCursor(cursor: Point | null): void
  setSelection(nodeIds: readonly string[]): void
  setViewport(viewport: Viewport): void
  acquireLease?(nodeIds: readonly string[], kind: NodeLeaseKind): NodeLease | undefined
  releaseLease?(): void
  getLease?(nodeId: string): NodeLease | undefined
  subscribeLeaseLost?(listener: (lease: NodeLease) => void): () => void
  setInteractionPreview?(preview: InteractionPreview): void
  clearPreview?(): void
  setInteraction?(interaction: { kind: 'dragging' | 'resizing'; nodeIds: string[] }): void
  clearInteraction?(): void
  withNodeLease?<T>(
    nodeIds: readonly string[],
    kind: NodeLeaseKind,
    operation: () => T | Promise<T>,
  ): Promise<Awaited<T> | undefined>
}


function PlaceholderNode() {
  return (
    <div aria-hidden="true" className="canvas-connection-anchor">
      <Handle
        className="canvas-connection-anchor__handle"
        id="target"
        isConnectable={false}
        position={Position.Left}
        type="target"
      />
      <Handle
        className="canvas-connection-anchor__handle"
        id="source"
        isConnectable={false}
        position={Position.Right}
        type="source"
      />
    </div>
  )
}

const canvasNodeTypes = {
  image: ImageNode,
  video: VideoNode,
  text: TextNode,
  placeholder: PlaceholderNode,
  group: GroupNode,
  audio: SpecialNode,
  script: SpecialNode,
  director: SpecialNode,
  'video-clip': SpecialNode,
  frame: FrameNode,
  shape: ShapeNode,
  path: PathNode,
}

const canvasEdgeTypes = {
  canvas: CanvasEdge,
}

const defaultEdgeOptions = { type: 'canvas' as const }
const multiSelectionKeys = ['Shift', 'Meta', 'Control']
const deleteKeys = ['Backspace', 'Delete']
const canvasSnapGrid: [number, number] = [12, 12]

interface PendingConnectedNode {
  node: CanvasFlowNode
  edge: CanvasFlowEdge
  menuPosition: Point
  direction: 'incoming' | 'outgoing'
  anchorNodeId: string
  flowPoint: Point
}

function connectedNodeSize(kind: ConnectedNodeKind) {
  if (kind === 'image') return { width: 480, height: 320 }
  if (kind === 'video') return { width: 480, height: 270 }
  if (kind === 'director') return { width: 560, height: 360 }
  return { width: 350, height: 350 }
}

function getPointerPosition(event: MouseEvent | TouchEvent): Point | null {
  if ('clientX' in event) {
    return { x: event.clientX, y: event.clientY }
  }

  const touch = event.changedTouches[0]
  return touch ? { x: touch.clientX, y: touch.clientY } : null
}

function createConnectedNode(
  kind: ConnectedNodeKind | 'image' | 'video' | 'text',
  id: string,
  position: Point,
): CanvasNode {
  if (kind === 'image') {
    return {
      id,
      type: 'image',
      name: '图片节点',
      position,
      size: { width: 480, height: 320 },
      data: { url: '', alt: '待生成图片' },
    }
  }

  if (kind === 'video') {
    return {
      id,
      type: 'video',
      name: '视频节点',
      position,
      size: { width: 480, height: 270 },
      data: { url: '' },
    }
  }

  if (kind === 'director') {
    return {
      id,
      type: 'group',
      name: '导演台',
      position,
      size: { width: 560, height: 360 },
      data: { childIds: [], nodeKind: 'director' },
    }
  }

  const name = kind === 'audio' ? '音频节点' : kind === 'script' ? '脚本节点' : '文本节点'
  return {
    id,
    type: 'text',
    name,
    position,
    size: { width: 350, height: 350 },
    data: {
      text: kind === 'audio' ? '描述需要生成的音乐或声音' : '',
      nodeKind:
        kind === 'audio' ? 'audio' : kind === 'script' ? 'script' : 'text',
    },
  }
}

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  const rightIds = new Set(right)
  return rightIds.size === right.length && left.every((id) => rightIds.has(id))
}

export function CanvasWorkspace({
  activeTool = 'select',
  canvasId,
  store = canvasStore,
  generationController: providedGenerationController,
  className,
  hideConnections = false,
  showMiniMap = false,
  snapToGrid = false,
  smartSnap = true,
  fitViewRequest = 0,
  focusNodeRequest,
  readOnly = false,
  canGenerate = true,
  onConnect,
  onNodesDelete,
  onEdgesDelete,
  onNodeResize,
  onNodeContextMenu,
  onPaneContextMenu,
  onPaneDoubleClick,
  onPaneClick,
  onToolComplete,
  onSelectionAction,
  onGenerationError,
  onImageEditingStateChange,
  collaboration,
}: CanvasWorkspaceProps) {
  const collaborationRef = useRef(collaboration)
  collaborationRef.current = collaboration
  const providerState = useOptionalProviderCatalog()
  const ownedGenerationController = useRef<GenerationController | null>(null)
  const generationControllerLifecycle = useRef({ current: 0 })
  if (!providedGenerationController && !ownedGenerationController.current) {
    ownedGenerationController.current = new GenerationController({ store })
  }
  const generationController =
    providedGenerationController ?? ownedGenerationController.current!
  const snapshot = useStore(store, (state) => state.snapshot)
  const resumableGenerationJobs = useMemo(
    () =>
      snapshot.nodes
        .flatMap((node) => {
          const generation =
            node.type === 'image' || node.type === 'video'
              ? node.data.generation
              : undefined
          if (
            generation?.status !== 'generating' &&
            generation?.pendingRequest === undefined
          ) {
            return []
          }
          return [
            `${generation.jobId ?? 'pending'}:${generation.clientRequestId ?? 'unknown'}:${node.id}`,
          ]
        })
        .sort()
        .join('|'),
    [snapshot.nodes],
  )
  const selectedNodeIds = useStore(store, (state) => state.selectedNodeIds)
  const mode = useStore(store, (state) => state.mode)
  const [referencePickTargetId, setReferencePickTargetId] = useState<
    string | null
  >(null)
  const [collaborationLockNotice, setCollaborationLockNotice] = useState<string>()
  const [imagePanelMode, setImagePanelMode] = useState<'generate' | 'edit'>('generate')
  const [imageEditorDirty, setImageEditorDirty] = useState(false)
  const [connectionGestureActive, setConnectionGestureActive] = useState(false)

  useEffect(() => {
    const handleGlobalPointerUp = () => {
      setConnectionGestureActive(false)
    }
    window.addEventListener('pointerup', handleGlobalPointerUp)
    window.addEventListener('pointercancel', handleGlobalPointerUp)
    window.addEventListener('mouseup', handleGlobalPointerUp)
    return () => {
      window.removeEventListener('pointerup', handleGlobalPointerUp)
      window.removeEventListener('pointercancel', handleGlobalPointerUp)
      window.removeEventListener('mouseup', handleGlobalPointerUp)
    }
  }, [])
  const [pendingImageMode, setPendingImageMode] = useState<'generate' | 'edit'>()
  const [pendingImageSelection, setPendingImageSelection] = useState<{ requested: true; nodeId: string | null }>()
  const imageEditorSaveRef = useRef<(() => void) | null>(null)
  const editingImageNodeId = imagePanelMode === 'edit' && selectedNodeIds.length === 1
    ? snapshot.nodes.find((node) => node.id === selectedNodeIds[0] && node.type === 'image')?.id
    : undefined
  useEffect(() => onImageEditingStateChange?.({
    nodeId: editingImageNodeId,
    dirty: imageEditorDirty,
    requestSelect: (nodeId) => {
      if (imageEditorDirty && editingImageNodeId && nodeId !== editingImageNodeId) {
        setPendingImageSelection({ requested: true, nodeId })
        setPendingImageMode('generate')
        return false
      }
      return true
    },
  }), [editingImageNodeId, imageEditorDirty, onImageEditingStateChange])
  const drawingPoints = useRef<Point[]>([])
  const activeBrushPointerId = useRef<number | undefined>(undefined)
  const penPoints = useRef<Point[]>([])
  const [brushPreview, setBrushPreview] = useState<Point[]>([])
  const [creationPreview, setCreationPreview] = useState<{
    tool: 'frame' | 'shape' | 'text'; start: Point; current: Point; constrained: boolean; rect?: SnapRect
  }>()
  const creationPreviewRef = useRef<typeof creationPreview>(undefined)
  const creationPointerId = useRef<number | undefined>(undefined)
  const suppressPaneClick = useRef(false)

  useEffect(() => {
    if (activeBrushPointerId.current !== undefined) {
      const pointerId = activeBrushPointerId.current
      activeBrushPointerId.current = undefined
      try {
        if (workspaceRef.current?.hasPointerCapture?.(pointerId)) {
          workspaceRef.current.releasePointerCapture(pointerId)
        }
      } catch {}
    }
    drawingPoints.current = []
    setBrushPreview([])
  }, [activeTool])

  const addCreativeNode = useCallback((tool: 'frame' | 'shape' | 'text', position: Point, size?: NodeSize, dragged = false) => {
    const id = createCanvasId(tool === 'frame' ? 'g' : 't')
    const node: CanvasNode = tool === 'frame' ? {
      id, type: 'frame', name: '画框', position,
      size: size ?? { width: 640, height: 420 },
      data: { childIds: [], fill: 'rgba(24,24,24,0.12)', stroke: '#777777', strokeWidth: 1, rotation: 0 },
    } : tool === 'shape' ? {
      id, type: 'shape', name: '矩形', position,
      size: size ?? { width: 220, height: 150 },
      data: { kind: 'rectangle', fill: '#d9d9d9', stroke: '#8c8c8c', strokeWidth: 1, opacity: 1, radius: 0, rotation: 0 },
    } : {
      id, type: 'text', name: '文本', position,
      size: size ?? { width: 160, height: 42 },
      data: { text: '', nodeKind: 'text', presentation: 'plain', autoWidth: !dragged, fontFamily: 'Noto Sans SC', fontSize: 24, fontWeight: 500, color: '#f4f4f4', textAlign: 'left', lineHeight: 1.4 },
    }
    store.getState().addNode(node)
    store.getState().selectNode(id)
    onToolComplete?.(tool, id)
  }, [onToolComplete, store])

  const commitPath = useCallback((points: Point[], kind: 'pen' | 'brush') => {
    if (points.length < 2) return
    const minX = Math.min(...points.map((point) => point.x))
    const minY = Math.min(...points.map((point) => point.y))
    const maxX = Math.max(...points.map((point) => point.x))
    const maxY = Math.max(...points.map((point) => point.y))
    const id = createCanvasId('t')
    store.getState().addNode({
      id, type: 'path', name: kind === 'brush' ? '画笔' : '路径',
      position: { x: minX, y: minY },
      size: { width: Math.max(16, maxX - minX), height: Math.max(16, maxY - minY) },
      data: {
        kind,
        anchors: points.map((point) => ({ x: point.x - minX, y: point.y - minY })),
        closed: false, fill: 'transparent', stroke: '#f4f4f4',
        strokeWidth: kind === 'brush' ? 6 : 3, opacity: 1,
      },
    })
    if (kind !== 'brush') {
      store.getState().selectNode(id)
    }
  }, [store])

  const captureFrame = useCallback(async (nodeId: string, video: HTMLVideoElement, capture: 'first' | 'current' | 'last') => {
    const source = store.getState().snapshot.nodes.find((node) => node.id === nodeId)
    if (!source || source.type !== 'video' || !video.videoWidth || !video.videoHeight) return
    const targetTime = capture === 'first' ? 0 : capture === 'last' ? Math.max(0, video.duration - 0.04) : video.currentTime
    if (Math.abs(video.currentTime - targetTime) > 0.001) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => { cleanup(); reject(new Error('视频定位超时，无法提取关键帧')) }, 5000)
        const cleanup = () => { window.clearTimeout(timeout); video.removeEventListener('seeked', handleSeeked); video.removeEventListener('error', handleError) }
        const handleSeeked = () => { cleanup(); resolve() }
        const handleError = () => { cleanup(); reject(new Error('浏览器无法解码该视频')) }
        video.addEventListener('seeked', handleSeeked, { once: true })
        video.addEventListener('error', handleError, { once: true })
        video.currentTime = targetTime
      })
    }
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')!.drawImage(video, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('无法提取视频帧')), 'image/png'))
    const asset = await gatewayClient.uploadAsset(blob, `${source.name}-${capture}-${Date.now()}.png`)
    const id = createCanvasId('i')
    const versionId = `capture:${id}`
    store.getState().addNode({
      id, type: 'image', name: `${source.name} ${capture === 'first' ? '首帧' : capture === 'last' ? '尾帧' : '关键帧'}`,
      position: { x: source.position.x + source.size.width + 80, y: source.position.y },
      size: { width: 480, height: 320 },
      data: { url: asset.url, assetId: asset.id, source: { nodeId, kind: 'video-frame', timeSec: video.currentTime, capture }, versions: [{ id: versionId, url: asset.url, assetId: asset.id, createdAt: new Date().toISOString(), label: '视频帧' }], activeVersionId: versionId },
    })
  }, [store])

  const project = useMemo(
    () => mapProjectSnapshotToReactFlow(snapshot),
    [snapshot],
  )
  const decorateEdges = useCallback(
    (sourceEdges: CanvasFlowEdge[]) => {
      const selectedIds = new Set(store.getState().selectedNodeIds)
      const soleSelectionId =
        selectedIds.size === 1 ? [...selectedIds][0] : undefined
      return sourceEdges.map((edge) => ({
        ...edge,
        data: {
          ...edge.data,
          relation: edge.data?.relation ?? 'flow',
          linkedToSelected:
            soleSelectionId === edge.source || soleSelectionId === edge.target,
        },
      }))
    },
    [store],
  )
  const activeResize = useRef<{
    lease: NodeLease
    nodeId: string
    size: { width: number; height: number }
  } | undefined>(undefined)
  const activeNodeInteraction = useRef<{
    lease: NodeLease
    nodeId: string
    kind: 'text' | 'settings'
  } | undefined>(undefined)
  const runWithNodeLease = useCallback(
    <T,>(
      nodeIds: readonly string[],
      kind: NodeLeaseKind,
      operation: () => T | Promise<T>,
    ): Promise<Awaited<T> | undefined> => {
      const controller = collaborationRef.current
      return controller?.withNodeLease
        ? controller.withNodeLease([...new Set(nodeIds)], kind, operation)
        : Promise.resolve(operation())
    },
    [],
  )
  const handleInteractionStart = useCallback(
    (nodeId: string, kind: 'text' | 'settings') => {
      if (readOnly) return false
      const controller = collaborationRef.current
      if (!controller?.acquireLease) return true
      const current = activeNodeInteraction.current
      if (
        current?.nodeId === nodeId && current.kind === kind &&
        controller.getLease?.(nodeId)?.leaseId === current.lease.leaseId
      ) return true
      if (current) {
        controller.clearInteraction?.()
        controller.releaseLease?.()
        activeNodeInteraction.current = undefined
      }
      const lease = controller.acquireLease([nodeId], kind)
      if (!lease) {
        const holder = controller.getLease?.(nodeId)
        const holderName = controller.presence.find(
          (entry) => entry.member.memberId === holder?.memberId,
        )?.member.displayName
        setCollaborationLockNotice(
          holderName
            ? `${holderName} 正在编辑此节点`
            : '节点正在由其他成员编辑',
        )
        return false
      }
      activeNodeInteraction.current = { lease, nodeId, kind }
      return true
    },
    [readOnly],
  )
  const handleInteractionEnd = useCallback(
    (nodeId: string, kind: 'text' | 'settings') => {
      const current = activeNodeInteraction.current
      if (!current || current.nodeId !== nodeId || current.kind !== kind) return
      const controller = collaborationRef.current
      controller?.clearInteraction?.()
      controller?.releaseLease?.()
      activeNodeInteraction.current = undefined
    },
    [],
  )
  const ownsInteraction = useCallback((nodeId: string, kind: 'text' | 'settings') => {
    const controller = collaborationRef.current
    if (!controller?.acquireLease) return true
    const current = activeNodeInteraction.current
    return current?.nodeId === nodeId && current.kind === kind &&
      controller.getLease?.(nodeId)?.leaseId === current.lease.leaseId
  }, [])
  const handleNodeResize = useCallback(
    (nodeId: string, size: { width: number; height: number }) => {
      if (readOnly) return
      const collaborationHandle = collaborationRef.current
      if (collaborationHandle?.acquireLease) {
        const resize = activeResize.current
        if (!resize || resize.nodeId !== nodeId ||
          collaborationHandle.getLease?.(nodeId)?.leaseId !== resize.lease.leaseId) return
      }
      store.getState().resizeNode(nodeId, size)
      setTransientGeometry((current) => {
        if (!current.has(nodeId)) return current
        const next = new Map(current)
        next.delete(nodeId)
        return next
      })
      onNodeResize?.(nodeId, size)
      if (collaborationHandle?.acquireLease) {
        collaborationHandle.clearPreview?.()
        collaborationHandle.clearInteraction?.()
        collaborationHandle.releaseLease?.()
        activeResize.current = undefined
      }
    },
    [onNodeResize, readOnly, store],
  )
  const handleTextChange = useCallback(
    (nodeId: string, text: string) => {
      if (readOnly || !ownsInteraction(nodeId, 'text')) return
      store.getState().updateTextNode(nodeId, text)
    },
    [ownsInteraction, readOnly, store],
  )

  const handleNodeRename = useCallback(
    (nodeId: string, name: string) => {
      if (readOnly) return
      void runWithNodeLease([nodeId], 'text', () => {
        store.getState().renameNode(nodeId, name)
      })
    },
    [readOnly, runWithNodeLease, store],
  )
  const handleSettingsChange = useCallback(
    (nodeId: string, settings: MediaGenerationSettings) => {
      if (readOnly || !ownsInteraction(nodeId, 'settings')) return
      store.getState().updateGenerationSettings(nodeId, settings)
    },
    [ownsInteraction, readOnly, store],
  )
  const handleImageNaturalSize = useCallback(
    (nodeId: string, naturalWidth: number, naturalHeight: number) => {
      if (readOnly) return
      store.getState().reconcileImageNaturalSize(
        nodeId,
        naturalWidth,
        naturalHeight,
      )
    },
    [readOnly, store],
  )
  const handlePromptChange = useCallback(
    (nodeId: string, prompt: string) => {
      if (readOnly || !ownsInteraction(nodeId, 'settings')) return
      store.getState().updateGenerationPrompt(nodeId, prompt)
    },
    [ownsInteraction, readOnly, store],
  )
  const handleReferencePickerChange = useCallback(
    (targetNodeId: string, active: boolean) => {
      if (readOnly) return
      setReferencePickTargetId(active ? targetNodeId : null)
    },
    [readOnly],
  )
  const canAttachReference = useCallback(
    (targetNodeId: string, sourceNodeId: string) => {
      if (readOnly) return false
      const current = store.getState().snapshot
      const target = current.nodes.find((node) => node.id === targetNodeId)
      const source = current.nodes.find((node) => node.id === sourceNodeId)
      const catalog = providerState?.catalog
      if (
        !target || !source ||
        (target.type !== 'image' && target.type !== 'video') ||
        (source.type !== 'image' && source.type !== 'video')
      ) {
        return false
      }
      // Standalone canvas consumers have no provider context. The product app
      // always supplies it and therefore always enforces catalog capabilities.
      if (!providerState) return true
      if (!canEditReferencesWithCatalog(catalog) || !source.data.url) return false
      const settings = target.data.generationSettings
      const model = settings
        ? selectCatalogModel(catalog, {
            providerId: settings.providerId ?? catalog.providerId,
            channel: settings.channel,
            model: settings.model,
            mediaType: target.type,
          })
        : catalog.models.find((candidate) => candidate.mediaType === target.type)
      if (!model) return false
      const existing = current.edges.some((edge) =>
        edge.relation === 'reference' &&
        edge.target === targetNodeId &&
        edge.source === sourceNodeId,
      )
      if (existing) return true
      const ordered = getOrderedReferences(current, targetNodeId)
      const sourceCount = ordered.filter(({ node }) => node.type === source.type).length
      const limit = source.type === 'image'
        ? model.inputLimits.images
        : model.inputLimits.videos
      if (sourceCount >= limit) return false
      if (target.type === 'video' && settings?.mode) {
        const mode = resolveVideoMode(settings.mode)
        if (mode?.referenceRule === 'none') return false
        if (
          mode?.referenceRule === 'exactly-two' &&
          (source.type !== 'image' || sourceCount >= 2)
        ) {
          return false
        }
      }
      return true
    },
    [providerState, readOnly, store],
  )
  const handleAttachReference = useCallback(
    async (targetNodeId: string, sourceNodeId: string) => {
      if (readOnly) return undefined
      return runWithNodeLease([sourceNodeId, targetNodeId], 'bulk', () => {
        if (!canAttachReference(targetNodeId, sourceNodeId)) {
          onGenerationError?.('当前模型不支持此参考类型，或已达到数量上限')
          return undefined
        }
        return store.getState().attachReference(targetNodeId, sourceNodeId)
          ?.referenceAlias
      })
    },
    [canAttachReference, onGenerationError, readOnly, runWithNodeLease, store],
  )
  const handleRemoveReference = useCallback(
    async (targetNodeId: string, sourceNodeId: string) => {
      if (readOnly) return
      return runWithNodeLease([sourceNodeId, targetNodeId], 'bulk', () => {
        store.getState().detachReference(targetNodeId, sourceNodeId)
      })
    },
    [readOnly, runWithNodeLease, store],
  )
  useEffect(() => {
    if (readOnly) return
    void generationController.resumePersisted()
  }, [generationController, readOnly, resumableGenerationJobs])

  useEffect(() => {
    const lifecycleState = generationControllerLifecycle.current
    const lifecycle = ++lifecycleState.current
    return () => {
      if (!providedGenerationController) {
        queueMicrotask(() => {
          if (lifecycleState.current === lifecycle) {
            generationController.dispose()
          }
        })
      }
    }
  }, [generationController, providedGenerationController])

  const createConnectedAfterNode = useCallback(
    (anchorNodeId: string, kind: 'image' | 'video' | 'text') => {
      if (readOnly) return
      const current = store.getState().snapshot
      const anchor = current.nodes.find((node) => node.id === anchorNodeId)
      if (!anchor) return

      const prefix = kind === 'image' ? 'i' : kind === 'video' ? 'v' : 't'
      const nodeId = createCanvasId(prefix)
      const node = createConnectedNode(
        kind,
        nodeId,
        {
          x: anchor.position.x + anchor.size.width + 180,
          y: anchor.position.y + (anchor.size.height - (kind === 'text' ? 350 : kind === 'image' ? 320 : 270)) / 2,
        },
      )
      const isReference =
        (anchor.type === 'image' || anchor.type === 'video') &&
        (node.type === 'image' || node.type === 'video')
      const edge: ProjectCanvasEdge = {
        id: createCanvasId('e'),
        source: anchorNodeId,
        target: nodeId,
        sourceHandle: 'source',
        targetHandle: 'target',
        type: 'canvas',
        relation: isReference ? 'reference' : 'flow',
        ...(isReference ? { referenceAlias: 1 } : {}),
      }
      const relatedNodeIds = current.edges.flatMap((candidate) =>
        candidate.source === anchorNodeId || candidate.target === anchorNodeId
          ? [candidate.source, candidate.target]
          : [],
      )
      void runWithNodeLease(
        [anchorNodeId, ...relatedNodeIds],
        'bulk',
        () => store.getState().addConnectedNode(node, edge),
      )
    },
    [readOnly, runWithNodeLease, store],
  )

  const performGenerate = useCallback(
    (sourceNodeId: string, request: GenerationQuoteRequest) => {
      if (readOnly) return
      const current = store.getState().snapshot
      const source = current.nodes.find((node) => node.id === sourceNodeId)
      if (!source || (source.type !== 'image' && source.type !== 'video')) return

      if (request.mediaType !== source.type) return
      if (request.projectId !== current.projectId) {
        onGenerationError?.('项目已切换，请重新确认本次生成')
        return
      }
      const configuredCount = request.n ?? 1
      const resultCount = Number.isInteger(configuredCount)
        ? Math.max(1, Math.min(16, configuredCount))
        : 1
      const targetNodeIds: string[] = []
      const targetNodes: CanvasNode[] = []
      const outputEdges: ProjectCanvasEdge[] = []
      const frozenReferences = getOrderedReferences(current, source.id).flatMap(
        ({ edge, node }) =>
          node.type === 'image' || node.type === 'video'
            ? [{
                alias: edge.referenceAlias,
                mediaType: node.type,
                nodeId: node.id,
              }]
            : [],
      )
      const frozenSettings: MediaGenerationSettings = request.mediaType === 'image'
        ? {
            kind: 'image',
            providerId: request.providerId,
            catalogVersion: request.catalogVersion,
            channel: request.channel,
            model: request.model,
            mode: request.mode,
            quality: request.quality ?? '',
            resolution: request.quality ?? '',
            aspectRatio: request.aspectRatio ?? '',
            count: request.n ?? 1,
          }
        : {
            kind: 'video',
            providerId: request.providerId,
            catalogVersion: request.catalogVersion,
            channel: request.channel,
            model: request.model,
            mode: request.mode,
            resolution: request.quality ?? '',
            aspectRatio: request.aspectRatio ?? '',
            durationSec: request.duration ?? 1,
            generateAudio: request.generateAudio ?? false,
            count: request.n ?? 1,
          }
      const resultSize = parseAspectRatio(request.aspectRatio ?? '')
        ? sizeForAspectRatio(request.aspectRatio ?? '16:9')
        : { ...source.size }
      const createResult = (index: number) => {
        const prefix = source.type === 'image' ? 'i' : 'v'
        const resultNodeId = createCanvasId(prefix)
        const resultHeight = resultSize.height
        const resultWidth = resultSize.width
        const resultNode = createConnectedNode(
          source.type,
          resultNodeId,
          {
            x:
              source.position.x +
              source.size.width +
              180 +
              Math.floor(index / 2) * (resultWidth + 80),
            y: source.position.y + (index % 2) * (resultHeight + 60),
          },
        )
        resultNode.size = { ...resultSize }
        if (source.type === 'image' && resultNode.type === 'image') {
          resultNode.data.generationSettings = frozenSettings.kind === 'image'
            ? { ...frozenSettings }
            : undefined
        }
        if (source.type === 'video' && resultNode.type === 'video') {
          resultNode.data.generationSettings = frozenSettings.kind === 'video'
            ? { ...frozenSettings }
            : undefined
        }
        targetNodes.push(resultNode)
        outputEdges.push({
          id: createCanvasId('e'),
          source: source.id,
          target: resultNode.id,
          sourceHandle: 'source',
          targetHandle: 'target',
          type: 'canvas',
          relation: 'output',
        })
        targetNodeIds.push(resultNode.id)
      }

      targetNodeIds.push(source.id)
      for (let index = 1; index < resultCount; index += 1) {
        createResult(index - 1)
      }
      const input = {
          canvasId: request.canvasId,
          projectId: request.projectId,
          sourceNodeId: source.id,
          targetNodeIds,
          targetNodes,
          outputEdges,
          prompt: request.prompt,
          clientRequestId: request.clientRequestId,
          references: frozenReferences,
          settings: frozenSettings,
        }
      return generationController.startSubmitted(input)
        .catch((error: unknown) => {
          onGenerationError?.(
            error instanceof Error ? error.message : '生成任务创建失败',
          )
        })
    },
    [generationController, onGenerationError, readOnly, store],
  )

  const handleGenerate = useCallback(
    (sourceNodeId: string, request: GenerationQuoteRequest) => {
      if (readOnly) return
      const lockIds = [
        sourceNodeId,
        ...getOrderedReferences(store.getState().snapshot, sourceNodeId)
          .map(({ node }) => node.id),
      ]
      let submitted = false
      void runWithNodeLease(lockIds, 'bulk', async () => {
          submitted = true
          await performGenerate(sourceNodeId, request)
        })
        .then(() => {
          if (!submitted) {
            onGenerationError?.('生成所需节点正在被其他协作者操作，请稍后再试')
          }
        })
    },
    [onGenerationError, performGenerate, readOnly, runWithNodeLease, store],
  )

  const performRetry = useCallback(
    (sourceNodeId: string, prompt: string) => {
      if (readOnly) return
      const targetNodeIds = store
        .getState()
        .snapshot.nodes.filter((node) => {
          if (node.type !== 'image' && node.type !== 'video') return false
          return node.data.generation?.sourceNodeId === sourceNodeId
        })
        .sort(
          (left, right) =>
            (left.type === 'image' || left.type === 'video'
              ? left.data.generation?.outputIndex ?? 0
              : 0) -
            (right.type === 'image' || right.type === 'video'
              ? right.data.generation?.outputIndex ?? 0
              : 0),
        )
        .map((node) => node.id)
      if (!generationController.retry || targetNodeIds.length === 0) {
        onGenerationError?.('没有可恢复的生成请求')
        return
      }
      const input = { sourceNodeId, targetNodeIds, prompt }
      return (generationController.retrySubmitted
        ? generationController.retrySubmitted(input)
        : generationController.retry?.(input))
        ?.catch((error: unknown) => {
          onGenerationError?.(
            error instanceof Error ? error.message : '生成任务恢复失败',
          )
        })
    },
    [generationController, onGenerationError, readOnly, store],
  )

  const handleRetry = useCallback(
    (sourceNodeId: string, prompt: string) => {
      if (readOnly) return
      const current = store.getState().snapshot
      const targetNodeIds = current.nodes.flatMap((node) =>
        (node.type === 'image' || node.type === 'video') &&
        node.data.generation?.sourceNodeId === sourceNodeId
          ? [node.id]
          : [],
      )
      const referenceSourceIds = getOrderedReferences(current, sourceNodeId)
        .map(({ node }) => node.id)
      void runWithNodeLease(
        [sourceNodeId, ...targetNodeIds, ...referenceSourceIds],
        'bulk',
        () => performRetry(sourceNodeId, prompt),
      )
    },
    [performRetry, readOnly, runWithNodeLease, store],
  )

  const handleResizeStart = useCallback((nodeId: string) => {
    const collaborationHandle = collaborationRef.current
    if (!collaborationHandle?.acquireLease) return true
    const node = store.getState().snapshot.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) return false
    const lease = collaborationHandle.acquireLease([nodeId], 'resize')
    if (!lease) {
      setCollaborationLockNotice('节点正在由其他成员调整')
      return false
    }
    activeResize.current = { lease, nodeId, size: { ...node.size } }
    collaborationHandle.setInteraction?.({ kind: 'resizing', nodeIds: [nodeId] })
    return true
  }, [store])

  const handleResizePreview = useCallback((nodeId: string, size: { width: number; height: number }) => {
    if (activeResize.current?.nodeId !== nodeId) return
    setTransientGeometry((current) => {
      const next = new Map(current)
      next.set(nodeId, { ...next.get(nodeId), width: size.width, height: size.height })
      return next
    })
    collaborationRef.current?.setInteractionPreview?.({
      kind: 'resize', coordinateSpace: 'canvas-absolute',
      nodes: [{ nodeId, width: size.width, height: size.height }],
    })
  }, [])

  const remoteLocks = useMemo(() => {
    const locks = new Map<string, NonNullable<CanvasFlowNode['data']['remoteLock']>>()
    for (const remote of collaboration?.presence ?? []) {
      if (remote.member.memberId === collaboration?.localMemberId || !remote.lease) continue
      for (const nodeId of remote.lease.nodeIds) {
        locks.set(nodeId, {
          memberId: remote.member.memberId,
          displayName: remote.member.displayName,
          color: remote.member.color,
          kind: remote.lease.kind,
        })
      }
    }
    return locks
  }, [collaboration?.localMemberId, collaboration?.presence])
  const remoteLocksRef = useRef(remoteLocks)
  remoteLocksRef.current = remoteLocks
  const remoteLockKey = [...remoteLocks.entries()]
    .map(([nodeId, lock]) => `${nodeId}:${lock.memberId}:${lock.kind}:${lock.color}:${lock.displayName}`)
    .sort()
    .join('|')
  const selectedNodeKey = [...selectedNodeIds].sort().join('|')
  const [pendingConnection, setPendingConnection] =
    useState<PendingConnectedNode | null>(null)
  const [frameDropTargetId, setFrameDropTargetId] = useState<string>()
  const [transientGeometry, setTransientGeometry] = useState<Map<string, {
    position?: Point
    width?: number
    height?: number
    measured?: { width?: number; height?: number }
    dragging?: boolean
    resizing?: boolean
  }>>(() => new Map())
  const [interactionLeaseLosses, setInteractionLeaseLosses] = useState<Map<string, number>>(
    () => new Map(),
  )
  const [snapOverlay, setSnapOverlay] = useState<{ guides: SnapGuide[]; distances: SnapDistance[] }>({ guides: [], distances: [] })
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

  const decorateNodes = useCallback(
    (sourceNodes: CanvasFlowNode[]) => {
      const selectedIds = new Set(store.getState().selectedNodeIds)
      const soleSelectionId =
        selectedIds.size === 1 ? [...selectedIds][0] : undefined
      const current = store.getState().snapshot
      const referenceCandidates = current.nodes.flatMap((candidate) =>
        (candidate.type === 'image' || candidate.type === 'video') && candidate.data.url
          ? [
              {
                id: candidate.id,
                name: candidate.name,
                kind: candidate.type,
                url: candidate.data.url,
                poster: candidate.type === 'video' ? candidate.data.poster : undefined,
              },
            ]
          : [],
      )

      return sourceNodes.map((node) => {
        const currentNode = current.nodes.find(
          (candidate) => candidate.id === node.id,
        )
        const sourceGenerations = current.nodes
          .flatMap((candidate) => {
            if (candidate.type !== 'image' && candidate.type !== 'video') {
              return []
            }
            const generation = candidate.data.generation
            return generation?.sourceNodeId === node.id ? [generation] : []
          })
          .sort((left, right) => (left.outputIndex ?? 0) - (right.outputIndex ?? 0))
        const activeGeneration = sourceGenerations.find(
          (generation) =>
            generation.status === 'generating' ||
            generation.pendingRequest !== undefined,
        )
        const generationError = sourceGenerations.find(
          (generation) => generation.error !== undefined,
        )?.error
        const finishPendingImageAction = () => {
          const nextMode = pendingImageMode ?? 'generate'
          const selection = pendingImageSelection
          setImageEditorDirty(false)
          setPendingImageMode(undefined)
          setPendingImageSelection(undefined)
          setImagePanelMode(nextMode)
          if (selection?.requested) store.getState().selectNode(selection.nodeId)
        }
        const imageEditorContent = node.id === soleSelectionId && imagePanelMode === 'edit' && currentNode?.type === 'image' && currentNode.data.url ? <>
          {pendingImageMode ? <div className="image-editor-confirm" role="alert"><span>当前编辑尚未保存</span><button onClick={() => imageEditorSaveRef.current?.()} type="button">保存</button><button onClick={finishPendingImageAction} type="button">放弃</button><button onClick={() => { setPendingImageMode(undefined); setPendingImageSelection(undefined) }} type="button">继续编辑</button></div> : null}
          <ImageEditorWorkspace
            name={currentNode.name}
            onCancel={() => imageEditorDirty ? setPendingImageMode('generate') : setImagePanelMode('generate')}
            onDirtyChange={setImageEditorDirty}
            onSave={async (blob) => {
              const asset = await gatewayClient.uploadAsset(blob, `${currentNode.name}-${Date.now()}.png`)
              store.getState().addImageVersion(currentNode.id, {
                id: `edit:${createBrowserUuid()}`,
                url: asset.url,
                assetId: asset.id,
                createdAt: new Date().toISOString(),
                label: `编辑 ${new Date().toLocaleString()}`,
                sourceVersionId: currentNode.data.activeVersionId,
              })
              finishPendingImageAction()
            }}
            registerSave={(save) => { imageEditorSaveRef.current = save; return () => { if (imageEditorSaveRef.current === save) imageEditorSaveRef.current = null } }}
            url={currentNode.data.url}
          />
        </> : undefined

        return {
          ...node,
          draggable: remoteLocksRef.current.has(node.id) ? false : node.draggable,
          selected: selectedIds.has(node.id),
          data: {
            ...node.data,
            canvasId,
            projectId: current.projectId,
            generationPending: activeGeneration !== undefined,
            generationError,
            isSoleSelection: node.id === soleSelectionId && !connectionGestureActive,
            onConnectionPointerDown: () => setConnectionGestureActive(true),
            references: getOrderedReferences(current, node.id).flatMap(
              ({ edge, node: reference }) =>
                reference.type === 'image' || reference.type === 'video'
                  ? [{
                      id: reference.id,
                      referenceAlias: edge.referenceAlias,
                      name: reference.name,
                      kind: reference.type,
                      url: reference.data.url,
                      poster: reference.type === 'video'
                        ? reference.data.poster
                        : undefined,
                    }]
                  : [],
            ),
            referenceCandidates: referenceCandidates.filter(
              (candidate) => candidate.id !== node.id,
            ),
            referencePickCandidate:
              referencePickTargetId !== null &&
              referencePickTargetId !== node.id &&
              canAttachReference(referencePickTargetId, node.id),
            referencePickTarget: referencePickTargetId === node.id,
            referencePickerActive: referencePickTargetId === node.id,
            unresolvedReferences:
              (currentNode?.type === 'image' || currentNode?.type === 'video') &&
              Boolean(currentNode.data.unresolvedReferenceNodeIds?.length),
            readOnly,
            remoteLock: remoteLocksRef.current.get(node.id),
            lockedBy: remoteLocksRef.current.get(node.id),
            interactionLeaseLost: interactionLeaseLosses.get(node.id),
            onResize: readOnly ? undefined : handleNodeResize,
            onResizeStart: readOnly ? undefined : handleResizeStart,
            onResizePreview: readOnly ? undefined : handleResizePreview,
            onImageNaturalSize: readOnly ? undefined : handleImageNaturalSize,
            imagePanelMode,
            onImagePanelModeChange: readOnly ? undefined : (_nodeId: string, nextMode: 'generate' | 'edit') => {
              if (nextMode === 'edit' && !(currentNode?.type === 'image' && currentNode.data.url)) return
              if (imagePanelMode === 'edit' && imageEditorDirty) setPendingImageMode(nextMode)
              else setImagePanelMode(nextMode)
            },
            imageEditorContent,
            onSetImageVersion: readOnly ? undefined : (nodeId: string, versionId: string) => store.getState().setImageVersion(nodeId, versionId),
            onCaptureFrame: readOnly ? undefined : (nodeId: string, video: HTMLVideoElement, capture: 'first' | 'current' | 'last') => { void captureFrame(nodeId, video, capture).catch((error) => onGenerationError?.(error instanceof Error ? error.message : '视频取帧失败')) },
            onCreativeChange: readOnly ? undefined : (nodeId: string, changes: Parameters<CanvasStoreState['updateCreativeNode']>[1]) => { setSnapOverlay({ guides: [], distances: [] }); store.getState().updateCreativeNode(nodeId, changes) },
            onCreativeResizeSnap: readOnly ? undefined : handleCreativeResizeSnap,
            onLayerChange: readOnly ? undefined : (nodeId: string, direction: 'front' | 'back') => store.getState().moveNodeLayer(nodeId, direction),
            versions: currentNode?.type === 'image' ? currentNode.data.versions : undefined,
            activeVersionId: currentNode?.type === 'image' ? currentNode.data.activeVersionId : undefined,
            onRename: readOnly ? undefined : handleNodeRename,
            onTextChange: readOnly ? undefined : handleTextChange,
            onInteractionStart: readOnly ? undefined : handleInteractionStart,
            onInteractionEnd: readOnly ? undefined : handleInteractionEnd,
            onGenerate: readOnly || !canGenerate ? undefined : handleGenerate,
            onPromptChange: readOnly ? undefined : handlePromptChange,
            onRetry: readOnly ? undefined : handleRetry,
            onSettingsChange: readOnly ? undefined : handleSettingsChange,
            onAttachReference: readOnly ? undefined : handleAttachReference,
            onRemoveReference: readOnly ? undefined : handleRemoveReference,
            onReferencePickerChange: readOnly ? undefined : handleReferencePickerChange,
            onCreateConnected: readOnly ? undefined : createConnectedAfterNode,
          },
        }
      })
    },
    [
      canvasId,
      canGenerate,
      captureFrame,
      onGenerationError,
      createConnectedAfterNode,
      canAttachReference,
      handleGenerate,
      imageEditorDirty,
      imagePanelMode,
      connectionGestureActive,
      pendingImageMode,
      pendingImageSelection,
      handleCreativeResizeSnap,
      handleImageNaturalSize,
      handleInteractionEnd,
      handleInteractionStart,
      handleAttachReference,
      handleReferencePickerChange,
      handleRemoveReference,
      handleRetry,
      handleNodeRename,
      handleNodeResize,
      handleResizePreview,
      handleResizeStart,
      handlePromptChange,
      handleSettingsChange,
      handleTextChange,
      referencePickTargetId,
      readOnly,
      interactionLeaseLosses,
      store,
    ],
  )
  const stableNodesRef = useRef<CanvasFlowNode[]>([])
  const stableEdgesRef = useRef<CanvasFlowEdge[]>([])
  const stableModelSignaturesRef = useRef<Map<string, string>>(new Map())
  const stableProjectIdRef = useRef(snapshot.projectId)
  const persistentNodes = useMemo(() => {
    void remoteLockKey
    void selectedNodeKey
    const previousSignatures = stableModelSignaturesRef.current
    const modelById = new Map(snapshot.nodes.map((node) => [node.id, node]))
    const previousById = new Map(stableNodesRef.current.map((n) => [n.id, n]))
    const incomingEdges = new Map<string, string>()
    for (const edge of snapshot.edges) {
      if (edge.relation === 'reference') {
        const prevTarget = incomingEdges.get(edge.target) ?? ''
        incomingEdges.set(edge.target, `${prevTarget}|${edge.source}:${edge.referenceAlias}`)
      }
    }
    const signatures = new Map(
      snapshot.nodes.map((node) => [
        node.id,
        `${node.type}:${node.position.x},${node.position.y},${node.size.width},${node.size.height},${node.name},${node.parentId ?? ''},${node.locked ? 1 : 0},${node.hidden ? 1 : 0},${'url' in node.data ? node.data.url : ''},${'text' in node.data ? node.data.text : ''},${'generation' in node.data ? node.data.generation?.status : ''}#${incomingEdges.get(node.id) ?? ''}`,
      ]),
    )
    const projectIdUnchanged = stableProjectIdRef.current === snapshot.projectId
    const incoming = decorateNodes(project.nodes).map((node) => {
      const previous = previousById.get(node.id)
      const previousModel = previous?.data.node
      const nextModel = modelById.get(node.id)
      if (
        !previous ||
        !previousModel ||
        !nextModel ||
        !projectIdUnchanged ||
        previousSignatures.get(node.id) !== signatures.get(node.id)
      ) {
        return node
      }
      return {
        ...node,
        data: {
          ...node.data,
          node: previousModel,
          references: node.data.references,
          referenceCandidates: previous.data.referenceCandidates,
        },
      }
    })
    const next = stabilizeProjectedNodes(stableNodesRef.current, incoming)
    stableNodesRef.current = next
    stableModelSignaturesRef.current = signatures
    stableProjectIdRef.current = snapshot.projectId
    return next
  }, [decorateNodes, project.nodes, remoteLockKey, selectedNodeKey, snapshot.edges, snapshot.nodes, snapshot.projectId])
  const persistentEdges = useMemo(() => {
    void selectedNodeKey
    const next = stabilizeProjectedEdges(stableEdgesRef.current, decorateEdges(project.edges))
    stableEdgesRef.current = next
    return next
  }, [decorateEdges, project.edges, selectedNodeKey])
  const flowNodes = useMemo(() => {
    const projected = persistentNodes.map((node) => {
      const geometry = transientGeometry.get(node.id)
      const dropTarget = node.id === frameDropTargetId
      if (!geometry && !dropTarget) return node
      return {
        ...node,
        ...(geometry?.position ? { position: geometry.position } : {}),
        ...(geometry?.width !== undefined ? { width: geometry.width } : {}),
        ...(geometry?.height !== undefined ? { height: geometry.height } : {}),
        ...(geometry?.measured ? { measured: geometry.measured } : {}),
        ...(geometry?.dragging !== undefined ? { dragging: geometry.dragging } : {}),
        ...(geometry?.resizing !== undefined ? { resizing: geometry.resizing } : {}),
        style: geometry
          ? {
              ...node.style,
              ...(geometry.width !== undefined ? { width: geometry.width } : {}),
              ...(geometry.height !== undefined ? { height: geometry.height } : {}),
            }
          : node.style,
        className: [
          node.className?.replace(/\s*canvas-frame-drop-target/g, ''),
          dropTarget ? 'canvas-frame-drop-target' : '',
        ].filter(Boolean).join(' '),
      }
    })
    return pendingConnection ? [...projected, pendingConnection.node] : projected
  }, [frameDropTargetId, pendingConnection, persistentNodes, transientGeometry])
  const flowNodesRef = useRef(flowNodes)
  flowNodesRef.current = flowNodes
  const flowEdges = useMemo(() => {
    if (hideConnections) return []
    return pendingConnection
      ? [...persistentEdges, pendingConnection.edge]
      : persistentEdges
  }, [hideConnections, pendingConnection, persistentEdges])
  const [committedZoom, setCommittedZoom] = useState(project.viewport.zoom)
  const viewportRef = useRef<Viewport>(project.viewport)
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const viewportFrameRef = useRef<number | null>(null)
  const lastProjectViewportRef = useRef(project.viewport)
  const connectionRadius =
    CANVAS_CONNECTION_RADIUS / Math.max(committedZoom, CANVAS_MIN_ZOOM)
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<
    CanvasFlowNode,
    CanvasFlowEdge
  > | null>(null)
  const collaborationFollowingMemberId = collaboration?.followingMemberId
  const collaborationPresence = collaboration?.presence
  const stopCollaborationFollowing = collaboration?.onStopFollowing
  const setCollaborationCursor = collaboration?.setCursor
  const setCollaborationSelection = collaboration?.setSelection
  const setCollaborationViewport = collaboration?.setViewport

  const cursorFrameRef = useRef<number | null>(null)
  const pendingCursorPos = useRef<{ x: number; y: number } | null>(null)

  const scheduleCollaborationCursor = useCallback((pos: { x: number; y: number }) => {
    if (
      typeof window === 'undefined' ||
      typeof requestAnimationFrame !== 'function' ||
      import.meta.env?.MODE === 'test'
    ) {
      setCollaborationCursor?.(pos)
      return
    }
    pendingCursorPos.current = pos
    if (cursorFrameRef.current !== null) return
    cursorFrameRef.current = requestAnimationFrame(() => {
      cursorFrameRef.current = null
      if (pendingCursorPos.current && setCollaborationCursor) {
        setCollaborationCursor(pendingCursorPos.current)
      }
    })
  }, [setCollaborationCursor])

  useEffect(() => {
    return () => {
      if (cursorFrameRef.current !== null) {
        cancelAnimationFrame(cursorFrameRef.current)
      }
    }
  }, [])
  type DragGeometry = { position: Point; positionAbsolute: Point }
  const activeDrag = useRef<{
    lease?: NodeLease
    geometries: Map<string, DragGeometry>
    candidates: SnapRect[]
    snapState: SnapState
    targetFrameId?: string
  } | undefined>(undefined)
  const blockedDrag = useRef<Map<string, DragGeometry> | undefined>(undefined)
  const followViewportRef = useRef<Viewport | undefined>(undefined)
  const viewportSourceRef = useRef<
    'follow' | 'local' | 'fit' | 'restore' | undefined
  >(undefined)

  const writeViewportUi = useCallback((nextViewport: Viewport) => {
    viewportRef.current = nextViewport
    workspaceRef.current?.style.setProperty(
      '--canvas-ui-scale',
      String(1 / Math.max(nextViewport.zoom, CANVAS_MIN_ZOOM)),
    )
  }, [])

  const scheduleViewportUi = useCallback(
    (nextViewport: Viewport) => {
      viewportRef.current = nextViewport
      if (viewportFrameRef.current !== null) return
      viewportFrameRef.current = requestAnimationFrame(() => {
        viewportFrameRef.current = null
        writeViewportUi(viewportRef.current)
      })
    },
    [writeViewportUi],
  )

  const flushViewportUi = useCallback(
    (nextViewport: Viewport) => {
      if (viewportFrameRef.current !== null) {
        cancelAnimationFrame(viewportFrameRef.current)
        viewportFrameRef.current = null
      }
      writeViewportUi(nextViewport)
    },
    [writeViewportUi],
  )

  useEffect(
    () => () => {
      if (viewportFrameRef.current !== null) {
        cancelAnimationFrame(viewportFrameRef.current)
      }
    },
    [],
  )

  const captureDragGeometry = useCallback((nodes: CanvasFlowNode[]) => new Map(
    nodes.map((node) => {
      const internal = flowInstance?.getInternalNode?.(node.id)
      const eventAbsolute = (node as CanvasFlowNode & {
        internals?: { positionAbsolute?: Point }
      }).internals?.positionAbsolute
      const parentAbsolute = node.parentId
        ? flowInstance?.getInternalNode?.(node.parentId)?.internals.positionAbsolute
        : undefined
      const positionAbsolute = node.parentId
        ? (internal?.internals.positionAbsolute ?? eventAbsolute ?? (
            parentAbsolute
              ? { x: parentAbsolute.x + node.position.x, y: parentAbsolute.y + node.position.y }
              : { ...node.position }
          ))
        : { ...node.position }
      return [node.id, { position: { ...node.position }, positionAbsolute }]
    }),
  ), [flowInstance])

  const snapCandidates = useCallback((excludedIds: readonly string[]) => {
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
      result.push({
        id: node.id,
        x: position.x,
        y: position.y,
        width: model.size.width,
        height: model.size.height,
        kind: model.type === 'frame' ? 'frame' : 'node',
      })
    }
    return result
  }, [flowInstance, store])

  const deepestFrameAt = useCallback((center: Point, excludedIds: readonly string[]) => {
    const snapshotNow = store.getState().snapshot
    const byId = new Map(snapshotNow.nodes.map((node) => [node.id, node]))
    const indexById = new Map(snapshotNow.nodes.map((node, idx) => [node.id, idx]))

    // Exclude all excluded nodes and their descendant subtrees
    const excluded = new Set(excludedIds)
    let added = true
    while (added) {
      added = false
      for (const node of snapshotNow.nodes) {
        if (node.parentId && excluded.has(node.parentId) && !excluded.has(node.id)) {
          excluded.add(node.id)
          added = true
        }
      }
    }

    const depthCache = new Map<string, number>()
    const getDepth = (node: CanvasNode | undefined): number => {
      if (!node) return 0
      const cached = depthCache.get(node.id)
      if (cached !== undefined) return cached
      let value = 0
      const visited = new Set<string>([node.id])
      let cursor = node.parentId ? byId.get(node.parentId) : undefined
      while (cursor && !visited.has(cursor.id)) {
        visited.add(cursor.id)
        value += 1
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
      }
      depthCache.set(node.id, value)
      return value
    }

    const candidates = snapCandidates(Array.from(excluded))
    let bestFrameId: string | undefined
    let bestDepth = -1
    let bestIndex = -1

    for (const rect of candidates) {
      if (rect.kind !== 'frame' || !rect.id || rect.width <= 0 || rect.height <= 0 || excluded.has(rect.id)) continue
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

  const restoreDragGeometry = useCallback((geometries: Map<string, DragGeometry>) => {
    setTransientGeometry((current) => {
      const next = new Map(current)
      for (const [nodeId, geometry] of geometries) {
        next.set(nodeId, { ...next.get(nodeId), position: { ...geometry.position } })
      }
      return next
    })
  }, [])

  const restoreActiveDrag = useCallback(() => {
    const drag = activeDrag.current
    if (!drag) return
    restoreDragGeometry(drag.geometries)
    collaboration?.clearPreview?.()
    collaboration?.clearInteraction?.()
    collaboration?.releaseLease?.()
    activeDrag.current = undefined
  }, [collaboration, restoreDragGeometry])

  const restoreActiveResize = useCallback(() => {
    const resize = activeResize.current
    if (!resize) return
    setTransientGeometry((current) => {
      const next = new Map(current)
      next.set(resize.nodeId, { width: resize.size.width, height: resize.size.height })
      return next
    })
    collaboration?.clearPreview?.()
    collaboration?.clearInteraction?.()
    collaboration?.releaseLease?.()
    activeResize.current = undefined
  }, [collaboration])

  useEffect(() => collaboration?.subscribeLeaseLost?.((lease) => {
    if (lease.leaseId === activeDrag.current?.lease?.leaseId) restoreActiveDrag()
    else if (lease.leaseId === activeResize.current?.lease.leaseId) restoreActiveResize()
    else if (lease.leaseId === activeNodeInteraction.current?.lease.leaseId) {
      const interaction = activeNodeInteraction.current
      activeNodeInteraction.current = undefined
      collaboration.clearInteraction?.()
      setInteractionLeaseLosses((current) => {
        const next = new Map(current)
        next.set(interaction.nodeId, (next.get(interaction.nodeId) ?? 0) + 1)
        return next
      })
    } else return
    setCollaborationLockNotice('节点正在由其他成员操作')
  }), [collaboration, restoreActiveDrag, restoreActiveResize])

  useEffect(() => {
    if (collaboration?.status === 'synced' || (!activeDrag.current && !activeResize.current)) return
    restoreActiveDrag()
    restoreActiveResize()
  }, [collaboration?.status, restoreActiveDrag, restoreActiveResize])

  useEffect(() => {
    if (!collaborationLockNotice) return
    const timer = window.setTimeout(() => setCollaborationLockNotice(undefined), 2500)
    return () => window.clearTimeout(timer)
  }, [collaborationLockNotice])

  useEffect(() => {
    setCollaborationSelection?.(selectedNodeIds)
  }, [selectedNodeIds, setCollaborationSelection])

  useEffect(() => () => {
    setCollaborationCursor?.(null)
    setCollaborationSelection?.([])
  }, [setCollaborationCursor, setCollaborationSelection])

  useEffect(() => {
    if (!collaborationFollowingMemberId) return
    const followed = collaborationPresence?.find(
      (remote) => remote.member.memberId === collaborationFollowingMemberId,
    )
    if (!followed) {
      stopCollaborationFollowing?.()
      return
    }
    if (!flowInstance || !followed.viewport) return
    followViewportRef.current = followed.viewport
    if (sameViewport(flowInstance.getViewport(), followed.viewport)) return
    viewportSourceRef.current = 'follow'
    void flowInstance.setViewport(followed.viewport, { duration: 60 })
  }, [
    collaborationFollowingMemberId,
    collaborationPresence,
    flowInstance,
    stopCollaborationFollowing,
  ])

  useEffect(() => {
    const isLocal = viewportSourceRef.current === 'local' ||
      sameViewport(viewportRef.current, project.viewport)
    const projectViewportChanged = !sameViewport(lastProjectViewportRef.current, project.viewport)
    lastProjectViewportRef.current = project.viewport
    if (collaborationFollowingMemberId && projectViewportChanged && !isLocal) {
      viewportSourceRef.current = 'local'
      stopCollaborationFollowing?.()
    }
    if (projectViewportChanged && !isLocal) {
      flushViewportUi(project.viewport)
      setCommittedZoom(project.viewport.zoom)
    }
    if (!flowInstance) return
    if (
      projectViewportChanged &&
      !isLocal &&
      !sameViewport(flowInstance.getViewport(), project.viewport)
    ) {
      viewportSourceRef.current = 'restore'
      void flowInstance
        .setViewport(project.viewport)
        .finally(() => {
          if (viewportSourceRef.current === 'restore') {
            viewportSourceRef.current = undefined
          }
        })
    }

  }, [
    flowInstance,
    flushViewportUi,
    project.viewport,
    collaborationFollowingMemberId,
    stopCollaborationFollowing,
  ])

  useEffect(() => {
    if (!flowInstance || fitViewRequest === 0) return

    viewportSourceRef.current = 'fit'
    stopCollaborationFollowing?.()
    void flowInstance.fitView({ padding: 0.12, duration: 180 }).then(() => {
      const nextViewport = flowInstance.getViewport()
      flushViewportUi(nextViewport)
      setCommittedZoom(nextViewport.zoom)
      setCollaborationViewport?.(nextViewport)
      store.getState().setViewport(nextViewport)
      if (viewportSourceRef.current === 'fit') {
        viewportSourceRef.current = undefined
      }
    })
  }, [
    fitViewRequest,
    flowInstance,
    flushViewportUi,
    setCollaborationViewport,
    stopCollaborationFollowing,
    store,
  ])

  useEffect(() => {
    if (!focusNodeRequest?.id || !flowInstance) return
    const modelNode = store.getState().snapshot.nodes.find((n) => n.id === focusNodeRequest.id)
    if (!modelNode) return

    const internal = flowInstance.getInternalNode(focusNodeRequest.id)
    const positionAbsolute = internal?.internals.positionAbsolute ?? modelNode.position
    const nodeWidth = modelNode.size.width
    const nodeHeight = modelNode.size.height
    const hasGenerator = modelNode.type === 'image' || modelNode.type === 'video'
    
    const extraHeight = hasGenerator ? 240 : 40
    const totalHeight = nodeHeight + extraHeight
    
    const visualCenterX = positionAbsolute.x + nodeWidth / 2
    const visualCenterY = positionAbsolute.y + (hasGenerator ? (nodeHeight + 200) / 2 : nodeHeight / 2)
    
    const stageHeight = workspaceRef.current?.clientHeight ?? window.innerHeight
    const stageWidth = workspaceRef.current?.clientWidth ?? window.innerWidth
    
    const availableHeight = Math.max(300, stageHeight - 140)
    const availableWidth = Math.max(400, stageWidth - 140)
    
    const verticalZoom = availableHeight / totalHeight
    const horizontalZoom = availableWidth / Math.max(nodeWidth, hasGenerator ? 680 : nodeWidth)
    const targetZoom = Math.min(1.0, Math.max(0.35, Math.min(verticalZoom, horizontalZoom)))

    void flowInstance.setCenter(visualCenterX, visualCenterY, {
      duration: 400,
      zoom: targetZoom,
    })
  }, [focusNodeRequest, flowInstance, store])

  const syncSelection = useCallback(
    (ids: string[]) => {
      const currentIds = store.getState().selectedNodeIds
      if (!sameIds(currentIds, ids)) {
        store.setState({ selectedNodeIds: ids })
      }
    },
    [store],
  )

  const selectionGesture = useRef<Set<string> | null>(null)

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      const geometryChanges = changes.filter(
        (change) => change.type === 'position' || change.type === 'dimensions',
      )
      if (geometryChanges.length > 0) {
        const changedIds = new Set(geometryChanges.map((change) => change.id))
        const changedById = new Map(geometryChanges.map((change) => [change.id, change]))
        const projected = applyNodeChanges(geometryChanges, flowNodesRef.current)
        setTransientGeometry((current) => {
          const next = new Map(current)
          for (const node of projected) {
            if (!changedIds.has(node.id)) continue
            const change = changedById.get(node.id)
            const previous = next.get(node.id)
            next.set(node.id, {
              ...previous,
              ...(change?.type === 'position' ? {
                position: { ...node.position },
                dragging: node.dragging,
              } : {}),
              ...(change?.type === 'dimensions' ? {
                measured: node.measured ? { ...node.measured } : previous?.measured,
                ...(change.setAttributes && node.width !== undefined
                  ? { width: node.width }
                  : {}),
                ...(change.setAttributes && node.height !== undefined
                  ? { height: node.height }
                  : {}),
                resizing: node.resizing,
              } : {}),
            })
          }
          return next
        })
      }

      const selectionChanges = changes.filter(
        (change) => change.type === 'select',
      )
      if (selectionChanges.length === 0) return
      if (imageEditorDirty && editingImageNodeId && selectionChanges.some((change) => change.type === 'select' && change.id !== editingImageNodeId && change.selected)) {
        const target = selectionChanges.find((change) => change.type === 'select' && change.id !== editingImageNodeId && change.selected)
        setPendingImageSelection({ requested: true, nodeId: target?.id ?? null })
        setPendingImageMode('generate')
        return
      }

      const nextIds = selectionGesture.current ?? new Set(store.getState().selectedNodeIds)
      for (const change of selectionChanges) {
        if (change.type !== 'select') continue
        if (change.selected) nextIds.add(change.id)
        else nextIds.delete(change.id)
      }
      syncSelection([...nextIds])
    },
    [editingImageNodeId, imageEditorDirty, store, syncSelection],
  )

  const handleConnect = useCallback(
    (connection: Connection) => {
      setConnectionGestureActive(false)
      if (readOnly) return
      if (!connection.source || !connection.target || connection.source === connection.target) return
      const current = store.getState().snapshot
      const sourceNode = current.nodes.find((node) => node.id === connection.source)
      const targetNode = current.nodes.find((node) => node.id === connection.target)
      const isMediaPair =
        (sourceNode?.type === 'image' || sourceNode?.type === 'video') &&
        (targetNode?.type === 'image' || targetNode?.type === 'video')

      let projectEdge: ProjectCanvasEdge | undefined
      if (isMediaPair && canAttachReference(connection.target, connection.source)) {
        const alias = store.getState().attachReference(
          connection.target,
          connection.source,
        )?.referenceAlias
        if (alias !== undefined) {
          projectEdge = store.getState().snapshot.edges.find((edge) =>
            edge.target === connection.target &&
            edge.source === connection.source &&
            edge.relation === 'reference' &&
            edge.referenceAlias === alias,
          )
        }
      }
      if (!projectEdge) {
        projectEdge = {
          id: createCanvasId('e'),
          source: connection.source,
          target: connection.target,
          sourceHandle: connection.sourceHandle ?? undefined,
          targetHandle: connection.targetHandle ?? undefined,
          type: 'canvas',
          relation: 'flow' as const,
        }
        store.getState().addEdge(projectEdge)
      }
      const persistedEdge = store.getState().snapshot.edges.find(
        (edge) => edge.id === projectEdge!.id,
      ) ?? (isMediaPair
        ? store.getState().snapshot.edges.find((edge) =>
            edge.source === projectEdge!.source &&
            edge.target === projectEdge!.target &&
            edge.relation === 'reference',
          )
        : undefined)
      if (persistedEdge) onConnect?.(persistedEdge)
    },
    [
      canAttachReference,
      onConnect,
      readOnly,
      store,
    ],
  )

  const deleteSelection = useCallback(async (
    nodes: readonly CanvasFlowNode[],
    edges: readonly CanvasFlowEdge[],
  ) => {
    if (readOnly) return false
    const snapshot = store.getState().snapshot
    const nodeIds = nodes.map((node) => node.id)
    const requestedEdgeIds = new Set(edges.map((edge) => edge.id))
    const affectedEdges = snapshot.edges.filter((edge) =>
      requestedEdgeIds.has(edge.id) ||
      nodeIds.includes(edge.source) ||
      nodeIds.includes(edge.target),
    )
    const edgeIds = affectedEdges.map((edge) => edge.id)
    if (nodeIds.length > 0) store.getState().deleteNodes(nodeIds)
    else if (edgeIds.length > 0) store.getState().deleteEdges(edgeIds)
    if (nodeIds.length > 0) onNodesDelete?.(nodeIds)
    if (edgeIds.length > 0) onEdgesDelete?.(edgeIds)
    return true
  }, [onEdgesDelete, onNodesDelete, readOnly, store])

  const cancelPendingConnection = useCallback(() => {
    if (!pendingConnection) return
    setPendingConnection(null)
    setConnectionGestureActive(false)
  }, [pendingConnection])

  useEffect(() => {
    if (!pendingConnection && referencePickTargetId === null) return

    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      cancelPendingConnection()
      setReferencePickTargetId(null)
    }
    document.addEventListener('keydown', cancelOnEscape)
    return () => document.removeEventListener('keydown', cancelOnEscape)
  }, [cancelPendingConnection, pendingConnection, referencePickTargetId])

  useEffect(() => {
    const cancelTool = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      drawingPoints.current = []
      setBrushPreview([])
      penPoints.current = []
      creationPreviewRef.current = undefined
      creationPointerId.current = undefined
      setCreationPreview(undefined)
      store.getState().setMode('select')
    }
    document.addEventListener('keydown', cancelTool)
    return () => document.removeEventListener('keydown', cancelTool)
  }, [store])

  const handleConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      setConnectionGestureActive(false)
      if (readOnly) return
      if (
        !flowInstance ||
        !connectionState.fromNode ||
        connectionState.isValid ||
        connectionState.toHandle
      ) {
        return
      }

      const pointer = getPointerPosition(event)
      if (!pointer) return
      const flowPoint = flowInstance.screenToFlowPosition(pointer)
      const direction =
        connectionState.fromHandle?.type === 'target'
          ? 'incoming'
          : 'outgoing'
      const nodeId = createCanvasId('i')
      const size = { width: 1, height: 1 }
      const pendingNode: CanvasFlowNode = {
        id: nodeId,
        type: 'placeholder',
        position: flowPoint,
        width: size.width,
        height: size.height,
        initialWidth: size.width,
        initialHeight: size.height,
        style: { ...size, pointerEvents: 'none' },
        data: {
          name: '',
          mediaType: 'image',
          url: '',
        },
      }
      const pendingEdge: CanvasFlowEdge = {
        id: createCanvasId('e'),
        source:
          direction === 'outgoing'
            ? connectionState.fromNode.id
            : pendingNode.id,
        target:
          direction === 'outgoing'
            ? pendingNode.id
            : connectionState.fromNode.id,
        sourceHandle: 'source',
        targetHandle: 'target',
        type: 'canvas',
        data: { relation: 'flow' },
      }
      const pending: PendingConnectedNode = {
        node: pendingNode,
        edge: pendingEdge,
        menuPosition: pointer,
        direction,
        anchorNodeId: connectionState.fromNode.id,
        flowPoint,
      }

      setPendingConnection(pending)
    },
    [flowInstance, readOnly],
  )

  const confirmPendingConnection = useCallback(
    (kind: ConnectedNodeKind) => {
      if (readOnly) return
      if (!pendingConnection) return
      const prefix =
        kind === 'image'
          ? 'i'
          : kind === 'video'
            ? 'v'
            : kind === 'director'
              ? 'g'
              : 't'
      const nodeId = pendingConnection.node.id.replace(
        /^i-canvas-/,
        `${prefix}-canvas-`,
      )
      const size = connectedNodeSize(kind)
      const position = {
        x:
          pendingConnection.direction === 'outgoing'
            ? pendingConnection.flowPoint.x
            : pendingConnection.flowPoint.x - size.width,
        y: pendingConnection.flowPoint.y - size.height / 2,
      }
      const node = createConnectedNode(kind, nodeId, position)
      const current = store.getState().snapshot
      const anchor = current.nodes.find(
        (candidate) => candidate.id === pendingConnection.anchorNodeId,
      )
      const isReference =
        (node.type === 'image' || node.type === 'video') &&
        (anchor?.type === 'image' || anchor?.type === 'video')
      const targetId =
        pendingConnection.direction === 'outgoing'
          ? node.id
          : pendingConnection.anchorNodeId
      const usedAliases = new Set(
        current.edges
          .filter(
            (candidate) =>
              candidate.target === targetId &&
              candidate.relation === 'reference' &&
              candidate.referenceAlias !== undefined,
          )
          .map((candidate) => candidate.referenceAlias as number),
      )
      let referenceAlias = 1
      while (usedAliases.has(referenceAlias)) referenceAlias += 1
      const edge: ProjectCanvasEdge = {
        id: pendingConnection.edge.id,
        source:
          pendingConnection.direction === 'outgoing'
            ? pendingConnection.anchorNodeId
            : node.id,
        target:
          pendingConnection.direction === 'outgoing'
            ? node.id
            : pendingConnection.anchorNodeId,
        sourceHandle: pendingConnection.edge.sourceHandle ?? undefined,
        targetHandle: pendingConnection.edge.targetHandle ?? undefined,
        type: 'canvas',
        relation: isReference ? 'reference' : 'flow',
        ...(isReference ? { referenceAlias } : {}),
      }

      const relatedNodeIds = current.edges.flatMap((candidate) =>
        candidate.source === pendingConnection.anchorNodeId ||
        candidate.target === pendingConnection.anchorNodeId
          ? [candidate.source, candidate.target]
          : [],
      )
      void runWithNodeLease(
        [pendingConnection.anchorNodeId, ...relatedNodeIds],
        'bulk',
        () => {
          setPendingConnection(null)
          setConnectionGestureActive(false)
          store.getState().addConnectedNode(node, edge)
        },
      )
    },
    [pendingConnection, readOnly, runWithNodeLease, store],
  )

  const isSelectMode = mode === 'select' && activeTool === 'select'
  const workspaceClassName = className
    ? `canvas-workspace ${className}`
    : 'canvas-workspace'
  const workspaceStyle = {
    '--canvas-ui-scale': String(
      1 / Math.max(viewportRef.current.zoom, CANVAS_MIN_ZOOM),
    ),
  } as CSSProperties
  const selectedGroup =
    selectedNodeIds.length === 1
      ? snapshot.nodes.find((node) => node.id === selectedNodeIds[0])
      : undefined
  const groupedSelection = Boolean(
    selectedGroup?.type === 'group' &&
      selectedGroup.data.childIds.length >= 2 &&
      (selectedGroup.data.nodeKind === undefined ||
        selectedGroup.data.nodeKind === 'group'),
  )
  const showSelectionToolbar = !readOnly &&
    (selectedNodeIds.length > 1 || groupedSelection)
  const { handleDragOver, handleDrop } = useCanvasDrop({
    readOnly,
    flowInstance,
    addNode: (node) => store.getState().addNode(node),
    selectNode: (nodeId) => store.getState().selectNode(nodeId),
  })

  return (
    <div
      className={workspaceClassName}
      data-testid="canvas-workspace"
      data-canvas-mode={mode}
      data-active-tool={activeTool}
      data-multiselect={selectedNodeIds.length > 1 || undefined}
      data-reference-pick-target={referencePickTargetId ?? undefined}
      data-frame-drop-target={frameDropTargetId ?? undefined}
      ref={workspaceRef}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPointerDownCapture={(event) => {
        const miniMapInteraction = event.target instanceof Element &&
          event.target.closest('.canvas-minimap') !== null
        if ((event.button === 1 || miniMapInteraction) && collaborationFollowingMemberId) {
          viewportSourceRef.current = 'local'
          stopCollaborationFollowing?.()
        }
        const onPane = event.target instanceof Element && event.target.classList.contains('react-flow__pane')
        if (event.button === 0 && !readOnly && flowInstance && onPane && ['frame', 'shape', 'text'].includes(activeTool)) {
          const point = flowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
          creationPointerId.current = event.pointerId
          const preview = { tool: activeTool as 'frame' | 'shape' | 'text', start: point, current: point, constrained: event.shiftKey }
          creationPreviewRef.current = preview
          setCreationPreview(preview)
          try {
            event.currentTarget.setPointerCapture?.(event.pointerId)
          } catch {}
        }
        const isInteractiveOverlay = event.target instanceof Element &&
          event.target.closest('.canvas-minimap, .comments-panel, .layers-panel, .canvas-video-scrubber, .canvas-video-preview__toggle, button, input, select, textarea, [role="button"], [role="toolbar"]') !== null
        if (event.button === 0 && !readOnly && activeTool === 'brush' && flowInstance && !isInteractiveOverlay) {
          event.stopPropagation()
          const startPoint = flowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
          drawingPoints.current = [startPoint]
          setBrushPreview([startPoint])
          activeBrushPointerId.current = event.pointerId
          try {
            event.currentTarget.setPointerCapture?.(event.pointerId)
          } catch {}
        }
      }}
      onPointerLeave={() => setCollaborationCursor?.(null)}
      onPointerCancel={(event) => {
        if (activeBrushPointerId.current !== undefined) {
          const pointerId = activeBrushPointerId.current
          activeBrushPointerId.current = undefined
          try {
            if (event.currentTarget.hasPointerCapture?.(pointerId)) {
              event.currentTarget.releasePointerCapture(pointerId)
            }
          } catch {}
          drawingPoints.current = []
          setBrushPreview([])
        }
        if (creationPointerId.current !== undefined) {
          const pointerId = creationPointerId.current
          creationPointerId.current = undefined
          try {
            if (event.currentTarget.hasPointerCapture?.(pointerId)) {
              event.currentTarget.releasePointerCapture(pointerId)
            }
          } catch {}
          setCreationPreview(undefined)
          creationPreviewRef.current = undefined
        }
      }}
      onPointerMove={(event) => {
        if (creationPreviewRef.current && flowInstance && creationPointerId.current === event.pointerId) {
          const rawCurrent = flowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
          const start = creationPreviewRef.current.start
          let width = Math.abs(rawCurrent.x - start.x)
          let height = Math.abs(rawCurrent.y - start.y)
          if (event.shiftKey && creationPreviewRef.current.tool !== 'text') width = height = Math.max(width, height)
          const rawRect = { x: rawCurrent.x < start.x ? start.x - width : start.x, y: rawCurrent.y < start.y ? start.y - height : start.y, width, height }
          const snapped = snapRect({ rect: rawRect, candidates: snapCandidates([]), zoom: viewportRef.current.zoom, enabled: smartSnap, grid: snapToGrid ? 12 : undefined, disable: event.ctrlKey, measure: event.altKey, previous: activeDrag.current?.snapState })
          const nextPreview = {
            ...creationPreviewRef.current,
            current: rawCurrent,
            constrained: event.shiftKey,
            rect: snapped.rect,
          }
          creationPreviewRef.current = nextPreview
          setCreationPreview(nextPreview)
          setSnapOverlay({ guides: snapped.guides, distances: snapped.distances })
        }
        if (activeTool === 'brush' && activeBrushPointerId.current === event.pointerId && drawingPoints.current.length > 0 && flowInstance) {
          const next = flowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
          const previous = drawingPoints.current.at(-1)!
          if (Number.isFinite(next.x) && Number.isFinite(next.y) && Math.hypot(next.x - previous.x, next.y - previous.y) >= 2) {
            drawingPoints.current.push(next)
            setBrushPreview([...drawingPoints.current])
          }
        }
        if (!setCollaborationCursor || !flowInstance) return
        scheduleCollaborationCursor(flowInstance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        }))
      }}
      onPointerUp={(event) => {
        const pendingCreation = creationPreviewRef.current
        if (pendingCreation && creationPointerId.current === event.pointerId) {
          const pointerId = creationPointerId.current
          creationPointerId.current = undefined
          try {
            if (event.currentTarget.hasPointerCapture?.(pointerId)) {
              event.currentTarget.releasePointerCapture(pointerId)
            }
          } catch {}
          const dx = pendingCreation.current.x - pendingCreation.start.x
          const dy = pendingCreation.current.y - pendingCreation.start.y
          const dragged = Math.hypot(dx, dy) >= 4 / Math.max(viewportRef.current.zoom, CANVAS_MIN_ZOOM)
          let width = Math.abs(dx)
          let height = Math.abs(dy)
          if (pendingCreation.constrained && pendingCreation.tool !== 'text') width = height = Math.max(width, height)
          const position = pendingCreation.rect ? { x: pendingCreation.rect.x, y: pendingCreation.rect.y } : dragged ? {
            x: dx < 0 ? pendingCreation.start.x - width : pendingCreation.start.x,
            y: dy < 0 ? pendingCreation.start.y - height : pendingCreation.start.y,
          } : pendingCreation.start
          const previewSize = pendingCreation.rect ? { width: Math.max(16, pendingCreation.rect.width), height: Math.max(16, pendingCreation.rect.height) } : { width: Math.max(16, width), height: Math.max(16, height) }
          addCreativeNode(pendingCreation.tool, position, dragged ? previewSize : undefined, dragged)
          suppressPaneClick.current = true
          setCreationPreview(undefined)
          creationPreviewRef.current = undefined
          setSnapOverlay({ guides: [], distances: [] })
          return
        }
        if (activeBrushPointerId.current !== undefined && activeBrushPointerId.current === event.pointerId) {
          const pointerId = activeBrushPointerId.current
          activeBrushPointerId.current = undefined
          try {
            if (event.currentTarget.hasPointerCapture?.(pointerId)) {
              event.currentTarget.releasePointerCapture(pointerId)
            }
          } catch {}
          if (drawingPoints.current.length >= 2) {
            commitPath(drawingPoints.current, 'brush')
          }
          drawingPoints.current = []
          setBrushPreview([])
          return
        }
        if (activeTool === 'brush') {
          drawingPoints.current = []
          setBrushPreview([])
          try {
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          } catch {}
        }
      }}
      onWheelCapture={() => {
        viewportSourceRef.current = 'local'
        if (collaborationFollowingMemberId) {
          stopCollaborationFollowing?.()
        }
      }}
      onDoubleClick={(event) => {
        if (readOnly) return
        if (
          !(event.target instanceof Element) ||
          !event.target.classList.contains('react-flow__pane')
        ) {
          return
        }

        if (activeTool === 'pen' && flowInstance) {
          event.preventDefault()
          const point = flowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
          commitPath([...penPoints.current, point], 'pen')
          penPoints.current = []
          return
        }

        onPaneDoubleClick?.({ x: event.clientX, y: event.clientY })
      }}
      style={workspaceStyle}
    >
      <ReactFlow<CanvasFlowNode, CanvasFlowEdge>
        id="canvas-workspace-flow"
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={canvasNodeTypes}
        edgeTypes={canvasEdgeTypes}
        defaultViewport={project.viewport}
        minZoom={CANVAS_MIN_ZOOM}
        maxZoom={CANVAS_MAX_ZOOM}
        connectionRadius={connectionRadius}
        defaultEdgeOptions={defaultEdgeOptions}
        onNodesChange={handleNodesChange}
        onSelectionStart={(event) => {
          selectionGesture.current = new Set(
            event.shiftKey ? store.getState().selectedNodeIds : [],
          )
        }}
        onSelectionEnd={() => {
          selectionGesture.current = null
        }}
        onNodeDragStart={(event, node, draggedNodes) => {
          let nodes = draggedNodes.length > 0 ? draggedNodes : [node]
          const isAlt = (event as MouseEvent).altKey
          if (isAlt && !readOnly) {
            const originalIds = nodes.map((item) => item.id)
            const dupIds = store.getState().duplicateNodes(originalIds)
            if (dupIds && dupIds.length > 0) {
              const liveFlowNodes = mapProjectSnapshotToReactFlow(store.getState().snapshot).nodes
              const matchedDups = liveFlowNodes.filter((n) => dupIds.includes(n.id))
              if (matchedDups.length > 0) {
                nodes = matchedDups
              }
            }
          }
          const ids = nodes.map((item) => item.id)
          const geometries = captureDragGeometry(nodes)
          blockedDrag.current = undefined
          const lease = collaboration?.acquireLease?.(ids, 'drag')
          if (collaboration?.acquireLease && !lease) {
            blockedDrag.current = geometries
            restoreDragGeometry(geometries)
            setCollaborationLockNotice('所选节点正在由其他成员操作')
            return
          }
          activeDrag.current = { lease, geometries, candidates: snapCandidates(ids), snapState: {} }
          setCollaborationLockNotice(undefined)
          collaboration?.setInteraction?.({ kind: 'dragging', nodeIds: ids })
        }}
        onNodeDrag={(event, node, draggedNodes) => {
          if (blockedDrag.current || !activeDrag.current) return
          const nodes = draggedNodes.length > 0 ? draggedNodes : [node]
          const initialGeometries = activeDrag.current.geometries
          const initialPrimary = initialGeometries.get(node.id)
          const rawDx = initialPrimary ? node.position.x - initialPrimary.position.x : 0
          const rawDy = initialPrimary ? node.position.y - initialPrimary.position.y : 0

          const rects = nodes.map((item) => {
            const init = initialGeometries.get(item.id)
            const baseX = init?.positionAbsolute.x ?? item.position.x
            const baseY = init?.positionAbsolute.y ?? item.position.y
            return {
              id: item.id,
              x: baseX + rawDx,
              y: baseY + rawDy,
              width: item.width ?? (Number(item.style?.width) || 0),
              height: item.height ?? (Number(item.style?.height) || 0),
            }
          })
          const selection = unionRect(rects)
          const keyboard = event as MouseEvent
          const snapped = snapRect({
            rect: selection,
            candidates: activeDrag.current.candidates,
            zoom: viewportRef.current.zoom,
            enabled: smartSnap,
            grid: snapToGrid ? 12 : undefined,
            disable: keyboard.ctrlKey,
            measure: keyboard.altKey,
            previous: activeDrag.current.snapState,
          })
          activeDrag.current.snapState = snapped.state
          const snapDx = snapped.rect.x - selection.x
          const snapDy = snapped.rect.y - selection.y

          setTransientGeometry((current) => {
            const next = new Map(current)
            for (const item of nodes) {
              const init = initialGeometries.get(item.id)
              const initPos = init?.position ?? item.position
              next.set(item.id, {
                ...next.get(item.id),
                position: {
                  x: initPos.x + rawDx + snapDx,
                  y: initPos.y + rawDy + snapDy,
                },
              })
            }
            return next
          })
          const center = { x: snapped.rect.x + snapped.rect.width / 2, y: snapped.rect.y + snapped.rect.height / 2 }
          const targetFrameId = deepestFrameAt(center, nodes.map((item) => item.id))
          activeDrag.current.targetFrameId = targetFrameId
          setFrameDropTargetId(targetFrameId)
          setSnapOverlay({ guides: snapped.guides, distances: snapped.distances })
          collaboration?.setInteractionPreview?.({
            kind: 'drag',
            coordinateSpace: 'canvas-absolute',
            nodes: nodes.map((item) => {
              const init = initialGeometries.get(item.id)
              const initAbs = init?.positionAbsolute ?? item.position
              return {
                nodeId: item.id,
                position: {
                  x: initAbs.x + rawDx + snapDx,
                  y: initAbs.y + rawDy + snapDy,
                },
              }
            }),
          })
        }}
        onNodeDragStop={(_event, node, draggedNodes) => {
          const nodes = draggedNodes.length > 0 ? draggedNodes : [node]
          if (blockedDrag.current) {
            restoreDragGeometry(blockedDrag.current)
            blockedDrag.current = undefined
            queueMicrotask(() => setTransientGeometry(new Map()))
            return
          }
          const drag = activeDrag.current
          if (!drag && !collaboration?.acquireLease) {
            store.getState().moveNodes(nodes.map((item) => ({ id: item.id, position: item.position })))
            return
          }
          if (!drag || (drag.lease && collaboration?.getLease?.(drag.lease.nodeIds[0]!)?.leaseId !== drag.lease.leaseId)) {
            restoreActiveDrag()
            return
          }
          const initial = drag.geometries
          const initialPrimary = initial.get(node.id)
          const rawDx = initialPrimary ? node.position.x - initialPrimary.position.x : 0
          const rawDy = initialPrimary ? node.position.y - initialPrimary.position.y : 0

          const rects = nodes.map((item) => {
            const init = initial.get(item.id)
            const baseX = init?.positionAbsolute.x ?? item.position.x
            const baseY = init?.positionAbsolute.y ?? item.position.y
            return {
              id: item.id,
              x: baseX + rawDx,
              y: baseY + rawDy,
              width: item.width ?? (Number(item.style?.width) || 0),
              height: item.height ?? (Number(item.style?.height) || 0),
            }
          })
          const selection = unionRect(rects)
          const snapped = snapRect({
            rect: selection,
            candidates: drag.candidates,
            zoom: viewportRef.current.zoom,
            enabled: smartSnap,
            grid: snapToGrid ? 12 : undefined,
            previous: drag.snapState,
          })
          const snapDx = snapped.rect.x - selection.x
          const snapDy = snapped.rect.y - selection.y

          store.getState().moveNodesInHierarchy(nodes.map((item) => {
            const before = initial.get(item.id)
            return {
              id: item.id,
              positionAbsolute: before
                ? {
                    x: before.positionAbsolute.x + rawDx + snapDx,
                    y: before.positionAbsolute.y + rawDy + snapDy,
                  }
                : item.position,
            }
          }), drag.targetFrameId)
          collaboration?.clearPreview?.()
          collaboration?.clearInteraction?.()
          collaboration?.releaseLease?.()
          activeDrag.current = undefined
          setTransientGeometry(new Map())
          setSnapOverlay({ guides: [], distances: [] })
          setFrameDropTargetId(undefined)
        }}
        onNodeClick={(event, node) => {
          setConnectionGestureActive(false)
          if (readOnly) return
          if (referencePickTargetId && node.id !== referencePickTargetId) {
            const source = store
              .getState()
              .snapshot.nodes.find((candidate) => candidate.id === node.id)
            if ((source?.type === 'image' || source?.type === 'video') && source.data.url) {
              event.stopPropagation()
              const targetId = referencePickTargetId
              let completed = false
              const finishPick = (alias: number | undefined) => {
                if (completed || alias === undefined) return
                completed = true
                setReferencePickTargetId(null)
                store.getState().selectNode(targetId)
              }
              const pendingAlias = handleAttachReference(targetId, node.id)
              const immediateAlias = store.getState().snapshot.edges.find((edge) =>
                edge.source === node.id && edge.target === targetId &&
                edge.relation === 'reference',
              )?.referenceAlias
              finishPick(immediateAlias)
              void pendingAlias.then((alias) => {
                finishPick(alias)
              })
              return
            }
          }
          if (!event.shiftKey) {
            store.getState().selectNode(node.id)
          }
        }}
        onConnect={handleConnect}
        onConnectStart={() => setConnectionGestureActive(true)}
        onConnectEnd={handleConnectEnd}
        onBeforeDelete={async ({ nodes, edges }) => {
          await deleteSelection(nodes, edges)
          return false
        }}
        connectionLineComponent={CanvasConnectionLine}
        onInit={setFlowInstance}
        onNodesDelete={(deletedNodes) => {
          void deleteSelection(deletedNodes, [])
        }}
        onEdgesDelete={(deletedEdges) => {
          void deleteSelection([], deletedEdges)
        }}
        onViewportChange={scheduleViewportUi}
        onMoveStart={(event) => {
          const prevSource = viewportSourceRef.current
          if (
            !event &&
            ['follow', 'fit', 'restore'].includes(
              prevSource ?? '',
            )
          ) return
          viewportSourceRef.current = 'local'
          workspaceRef.current?.setAttribute('data-viewport-moving', 'true')
          if (collaborationFollowingMemberId) {
            stopCollaborationFollowing?.()
          }
        }}
        onMoveEnd={(event, nextViewport) => {
          flushViewportUi(nextViewport)
          workspaceRef.current?.removeAttribute('data-viewport-moving')
          viewportRef.current = nextViewport
          if (Math.abs(committedZoom - nextViewport.zoom) > 0.05) {
            setCommittedZoom(nextViewport.zoom)
          }
          if (
            !event &&
            (viewportSourceRef.current === 'fit' ||
              viewportSourceRef.current === 'restore')
          ) return
          if (
            viewportSourceRef.current === 'follow' &&
            !event && followViewportRef.current &&
            sameViewport(nextViewport, followViewportRef.current)
          ) {
            viewportSourceRef.current = undefined
            return
          }
          if (
            collaborationFollowingMemberId && followViewportRef.current &&
            sameViewport(nextViewport, followViewportRef.current)
          ) return
          setCollaborationViewport?.(nextViewport)
          if (!collaborationFollowingMemberId) {
            store.getState().setViewport(nextViewport)
          }
        }}
        onPaneContextMenu={(event) => {
          event.preventDefault()
          cancelPendingConnection()
          setReferencePickTargetId(null)
          onPaneContextMenu?.({ x: event.clientX, y: event.clientY })
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault()
          setReferencePickTargetId(null)
          onNodeContextMenu?.(node.id, {
            x: event.clientX,
            y: event.clientY,
          })
        }}
        onPaneClick={(event) => {
          cancelPendingConnection()
          setReferencePickTargetId(null)
          if (activeTool === 'brush') {
            return
          }
          if (suppressPaneClick.current) {
            suppressPaneClick.current = false
            return
          }
          if (!readOnly && flowInstance && activeTool === 'pen') {
            penPoints.current.push(flowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
            return
          }
          if (imageEditorDirty && editingImageNodeId) { setPendingImageSelection({ requested: true, nodeId: null }); setPendingImageMode('generate'); return }
          store.getState().selectNode(null)
          onPaneClick?.()
        }}
        nodesDraggable={isSelectMode && !readOnly}
        nodesConnectable={mode !== 'pan' && !readOnly}
        elementsSelectable={isSelectMode && !referencePickTargetId}
        selectionOnDrag={isSelectMode}
        selectionMode={SelectionMode.Partial}
        panOnDrag={mode === 'pan' ? [0, 1] : [1]}
        panOnScroll
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        multiSelectionKeyCode={multiSelectionKeys}
        deleteKeyCode={isSelectMode && !readOnly ? deleteKeys : null}
        snapToGrid={false}
        snapGrid={canvasSnapGrid}
        isValidConnection={(connection) => Boolean(connection.source && connection.target && connection.source !== connection.target)}
        onlyRenderVisibleElements={false}
        proOptions={{ hideAttribution: true }}
      >
        {creationPreview ? <CreationPreview preview={creationPreview} /> : null}
        {snapOverlay.guides.length || snapOverlay.distances.length ? <SnapOverlay distances={snapOverlay.distances} guides={snapOverlay.guides} /> : null}
        {brushPreview.length > 1 ? <BrushPreview points={brushPreview} /> : null}
        {collaboration ? (
          <CollaborationPresenceLayer presence={collaboration.presence} />
        ) : null}
        {showSelectionToolbar ? (
          <LiveSelectionToolbar
            grouped={groupedSelection}
            nodeIds={selectedNodeIds}
            onAction={onSelectionAction}
          />
        ) : null}
        {showMiniMap ? (
          <MiniMap
            ariaLabel="画布小地图"
            className="canvas-minimap"
            maskColor="rgba(12, 12, 12, 0.68)"
            nodeColor="#5c5c5c"
            nodeStrokeColor="#8b8b8b"
            pannable
            zoomable
          />
        ) : null}
      </ReactFlow>
      {pendingConnection ? (
        <ConnectedNodeMenu
          onSelect={confirmPendingConnection}
          position={pendingConnection.menuPosition}
        />
      ) : null}
      {collaborationLockNotice ? (
        <div className="collaboration-lock-notice" role="status">{collaborationLockNotice}</div>
      ) : null}
      {collaborationFollowingMemberId ? (
        <div className="collaboration-following-pill" role="status">
          <span className="collaboration-following-dot" />
          <span>正在跟随 <strong>{collaborationPresence?.find((r) => r.member.memberId === collaborationFollowingMemberId)?.member.displayName || '协作者'}</strong> 的视角</span>
          <button
            aria-label="退出跟随"
            className="collaboration-following-exit"
            onClick={() => stopCollaborationFollowing?.()}
            type="button"
          >
            退出跟随 (Esc)
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default CanvasWorkspace
