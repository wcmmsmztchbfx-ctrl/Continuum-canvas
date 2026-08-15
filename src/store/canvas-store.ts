import { createStore } from 'zustand/vanilla'

import type { GenerationHistoryEntry } from '../contracts/generation'
import { getOrderedReferences, normalizeCanvasHierarchy, parseProjectSnapshot } from '../model/project'
import type {
  CanvasEdge,
  CanvasNode,
  MediaGeneration,
  MediaGenerationSettings,
  NodeSize,
  OrderedReference,
  Point,
  ProjectSnapshot,
  Viewport,
} from '../model/project'
import type { CanvasEntityChangeSet } from '../collaboration/entityChanges'
import {
  materiallyDifferentRatio,
  parseAspectRatio,
  ratioStringFromDimensions,
  resizeAroundCenter,
  sizeForAspectRatio,
} from '../components/canvas/mediaGeometry'

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
  mode: CanvasMode
  canUndo: boolean
  canRedo: boolean
  selectNode: (nodeId: string | null, additive?: boolean) => void
  setMode: (mode: CanvasMode) => void
  moveNode: (nodeId: string, position: Point) => void
  moveNodes: (moves: Array<{ id: string; position: Point }>) => void
  moveNodesInHierarchy: (moves: Array<{ id: string; positionAbsolute: Point }>, parentId?: string) => void
  reparentNodes: (nodeIds: string[], parentId?: string, index?: number) => boolean
  reorderNodes: (nodeIds: string[], targetId: string, placement: 'before' | 'after' | 'inside') => boolean
  reconcileFrameMembership: (nodeIds: string[]) => void
  renameNode: (nodeId: string, name: string) => void
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
  resizeNode: (nodeId: string, size: NodeSize) => void
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
  ) => void
  updateTextNode: (nodeId: string, text: string) => void
  addImageVersion: (nodeId: string, version: import('../model/project').ImageVersion) => void
  setImageVersion: (nodeId: string, versionId: string) => void
  addComment: (comment: import('../model/project').CanvasComment) => void
  updateComment: (commentId: string, updater: (comment: import('../model/project').CanvasComment) => import('../model/project').CanvasComment) => void
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
  reconcileRemoteSnapshot: (snapshot: ProjectSnapshot) => void
  applyEntityChanges: (changes: CanvasEntityChangeSet) => void
}

const MAX_UNDO_STACK_SIZE = 100

export function createCanvasStore(initialSnapshot: ProjectSnapshot) {
  const past: ProjectSnapshot[] = []
  const future: ProjectSnapshot[] = []

  return createStore<CanvasStoreState>((set, get) => {
    const sameEntity = (left: unknown, right: unknown): boolean => {
      if (left === right) return true
      if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
      const a = left as Record<string, unknown>
      const b = right as Record<string, unknown>
      if (a.id !== b.id || a.type !== b.type || a.name !== b.name || a.parentId !== b.parentId) return false
      if (a.hidden !== b.hidden || a.locked !== b.locked) return false
      if (a.source !== b.source || a.target !== b.target || a.relation !== b.relation) return false
      const posA = a.position as Point | undefined
      const posB = b.position as Point | undefined
      if (posA && posB && (posA.x !== posB.x || posA.y !== posB.y)) return false
      const sizeA = a.size as NodeSize | undefined
      const sizeB = b.size as NodeSize | undefined
      if (sizeA && sizeB && (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height)) return false
      return JSON.stringify(left) === JSON.stringify(right)
    }
    const reconcileEntities = <T extends { id: string }>(current: readonly T[], incoming: readonly T[]) => {
      const currentById = new Map(current.map((entity) => [entity.id, entity]))
      return incoming.map((entity) => {
        const previous = currentById.get(entity.id)
        return previous && sameEntity(previous, entity) ? previous : entity
      })
    }
    const commitDocument = (next: ProjectSnapshot) => {
      const current = get().snapshot
      if (next === current) return

      past.push(current)
      if (past.length > MAX_UNDO_STACK_SIZE) {
        past.shift()
      }
      future.length = 0
      set({ snapshot: { ...next, nodes: normalizeCanvasHierarchy(next.nodes) }, canUndo: true, canRedo: false })
    }

    const absolutePositions = (nodes: readonly CanvasNode[]) => {
      const byId = new Map(nodes.map((node) => [node.id, node]))
      const cache = new Map<string, Point>()
      const resolve = (id: string, visiting = new Set<string>()): Point => {
        const cached = cache.get(id)
        if (cached) return cached
        const node = byId.get(id)
        if (!node || visiting.has(id)) return { x: 0, y: 0 }
        visiting.add(id)
        const parent = node.parentId ? resolve(node.parentId, visiting) : { x: 0, y: 0 }
        const result = { x: parent.x + node.position.x, y: parent.y + node.position.y }
        cache.set(id, result)
        return result
      }
      for (const node of nodes) resolve(node.id)
      return cache
    }

    const canReparent = (nodes: readonly CanvasNode[], nodeIds: readonly string[], parentId?: string) => {
      if (!parentId) return true
      const byId = new Map(nodes.map((node) => [node.id, node]))
      const parent = byId.get(parentId)
      if (!parent || (parent.type !== 'frame' && parent.type !== 'group')) return false
      const moving = new Set(nodeIds)
      let cursor: CanvasNode | undefined = parent
      while (cursor) {
        if (moving.has(cursor.id)) return false
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
      }
      return true
    }

    const applyReparent = (
      current: ProjectSnapshot,
      nodeIds: readonly string[],
      parentId?: string,
      index?: number,
      movedAbsolute?: ReadonlyMap<string, Point>,
    ): ProjectSnapshot | undefined => {
      const requested = new Set(nodeIds)
      const roots = current.nodes.filter((node) => requested.has(node.id) && !current.nodes.some((candidate) => requested.has(candidate.id) && node.parentId === candidate.id))
      const rootIds = roots.map((node) => node.id)
      if (roots.length === 0 || !canReparent(current.nodes, rootIds, parentId)) return undefined
      const absolute = absolutePositions(current.nodes)
      const parentAbsolute = parentId ? absolute.get(parentId) ?? { x: 0, y: 0 } : { x: 0, y: 0 }
      const moving = new Set(rootIds)
      const siblings = current.nodes.filter((node) => node.parentId === parentId && !moving.has(node.id))
      const insertion = Math.max(0, Math.min(index ?? siblings.length, siblings.length))
      const orderedSiblingIds = [...siblings.slice(0, insertion).map((node) => node.id), ...rootIds, ...siblings.slice(insertion).map((node) => node.id)]
      const rank = new Map(orderedSiblingIds.map((id, order) => [id, order]))
      const nodes = current.nodes.map((node) => {
        if (!moving.has(node.id)) return node
        const positionAbsolute = movedAbsolute?.get(node.id) ?? absolute.get(node.id) ?? node.position
        const { parentId: _previousParentId, ...nodeWithoutParent } = node
        return {
          ...nodeWithoutParent,
          ...(parentId ? { parentId } : {}),
          position: { x: positionAbsolute.x - parentAbsolute.x, y: positionAbsolute.y - parentAbsolute.y },
        } as CanvasNode
      }).sort((left, right) => {
        if (left.parentId !== parentId || right.parentId !== parentId) return 0
        return (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      })
      return { ...current, nodes }
    }

    const referenceEdgeId = (sourceNodeId: string, targetNodeId: string) => {
      const existingIds = new Set(get().snapshot.edges.map((edge) => edge.id))
      const base = `reference-${sourceNodeId}-${targetNodeId}`
      let id = base
      let suffix = 2
      while (existingIds.has(id)) {
        id = `${base}-${suffix}`
        suffix += 1
      }
      return id
    }

    const lockedGenerationNodeIds = (snapshot: ProjectSnapshot): Set<string> => {
      const locked = new Set<string>()
      for (const node of snapshot.nodes) {
        if (node.type !== 'image' && node.type !== 'video') continue
        const generation = node.data.generation
        if (generation?.status !== 'generating' && !generation?.pendingRequest) {
          continue
        }
        locked.add(node.id)
        if (generation.sourceNodeId) locked.add(generation.sourceNodeId)
      }
      return locked
    }

    return {
    snapshot: initialSnapshot,
    selectedNodeIds: [],
    mode: 'select',
    canUndo: false,
    canRedo: false,
    selectNode: (nodeId, additive = false) => {
      if (nodeId === null) {
        set({ selectedNodeIds: [] })
        return
      }

      if (!get().snapshot.nodes.some((node) => node.id === nodeId)) return

      set((state) => {
        if (!additive) return { selectedNodeIds: [nodeId] }

        const isSelected = state.selectedNodeIds.includes(nodeId)
        return {
          selectedNodeIds: isSelected
            ? state.selectedNodeIds.filter((id) => id !== nodeId)
            : [...state.selectedNodeIds, nodeId],
        }
      })
    },
    setMode: (mode) => set({ mode }),
    moveNode: (nodeId, position) => {
      get().moveNodes([{ id: nodeId, position }])
    },
    moveNodes: (moves) => {
      if (moves.length === 0) return

      const current = get().snapshot
      const positions = new Map(moves.map((move) => [move.id, move.position]))
      let changed = false

      const deltas = new Map<string, Point>()
      const next: ProjectSnapshot = {
        ...current,
        nodes: current.nodes.map((candidate) => {
          const position = positions.get(candidate.id)
          if (
            !position ||
            (candidate.position.x === position.x &&
              candidate.position.y === position.y)
          ) {
            return candidate
          }
          changed = true
          deltas.set(candidate.id, { x: position.x - candidate.position.x, y: position.y - candidate.position.y })
          return { ...candidate, position }
        }),
        comments: current.comments?.map((comment) => {
          const delta = comment.nodeId ? deltas.get(comment.nodeId) : undefined
          return delta ? { ...comment, position: { x: comment.position.x + delta.x, y: comment.position.y + delta.y } } : comment
        }),
      }
      if (changed) commitDocument(next)
    },
    moveNodesInHierarchy: (moves, parentId) => {
      if (moves.length === 0) return
      const current = get().snapshot
      const positions = new Map(moves.map((move) => [move.id, move.positionAbsolute]))
      const next = applyReparent(current, moves.map((move) => move.id), parentId, undefined, positions)
      if (next) commitDocument(next)
    },
    reparentNodes: (nodeIds, parentId, index) => {
      const next = applyReparent(get().snapshot, nodeIds, parentId, index)
      if (!next) return false
      commitDocument(next)
      return true
    },
    reorderNodes: (nodeIds, targetId, placement) => {
      const current = get().snapshot
      const target = current.nodes.find((node) => node.id === targetId)
      if (!target) return false
      const parentId = placement === 'inside' ? target.id : target.parentId
      if (placement === 'inside' && target.type !== 'frame' && target.type !== 'group') return false
      const siblings = current.nodes.filter((node) => node.parentId === parentId && !nodeIds.includes(node.id))
      const targetIndex = placement === 'inside' ? siblings.length : siblings.findIndex((node) => node.id === targetId)
      const index = placement === 'after' ? targetIndex + 1 : targetIndex
      const next = applyReparent(current, nodeIds, parentId, Math.max(0, index))
      if (!next) return false
      commitDocument(next)
      return true
    },
    reconcileFrameMembership: (nodeIds) => {
      const current = get().snapshot
      const ids = new Set(nodeIds)
      const frames = current.nodes.filter((node) => node.type === 'frame')
      if (frames.length === 0) return
      let changed = false
      const nodeById = new Map(current.nodes.map((node) => [node.id, node]))
      const membership = new Map<string, string | undefined>()
      const absolute = new Map<string, Point>()
      for (const node of current.nodes) {
        const parent = node.parentId ? nodeById.get(node.parentId) : undefined
        absolute.set(node.id, parent ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y } : node.position)
      }
      for (const node of current.nodes) {
        if (!ids.has(node.id) || node.type === 'frame' || node.type === 'group') continue
        const position = absolute.get(node.id)!
        const center = { x: position.x + node.size.width / 2, y: position.y + node.size.height / 2 }
        const target = [...frames].reverse().find((frame) => center.x >= frame.position.x && center.x <= frame.position.x + frame.size.width && center.y >= frame.position.y && center.y <= frame.position.y + frame.size.height)
        membership.set(node.id, target?.id)
        if (target?.id !== node.parentId) changed = true
      }
      if (!changed) return
      const nodes = current.nodes.map((node) => {
        if (node.type === 'frame') {
          const childIds = current.nodes.flatMap((child) => {
            const nextParent = membership.has(child.id) ? membership.get(child.id) : child.parentId
            return nextParent === node.id ? [child.id] : []
          })
          return { ...node, data: { ...node.data, childIds } }
        }
        if (!membership.has(node.id)) return node
        const targetId = membership.get(node.id)
        const position = absolute.get(node.id)!
        if (!targetId) {
          const { parentId: _parentId, ...released } = node
          return { ...released, position } as CanvasNode
        }
        const frame = nodeById.get(targetId)!
        return { ...node, parentId: targetId, position: { x: position.x - frame.position.x, y: position.y - frame.position.y } } as CanvasNode
      })
      commitDocument({ ...current, nodes })
    },
    renameNode: (nodeId, name) => {
      const normalizedName = name.trim().slice(0, 48)
      if (!normalizedName) return

      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node) return

      const nextNode: CanvasNode = (() => {
        if (node.type === 'text') {
          const nodeKind =
            node.data.nodeKind ??
            (node.name === '音频节点'
              ? 'audio'
              : node.name === '脚本节点'
                ? 'script'
                : 'text')
          return {
            ...node,
            name: normalizedName,
            data: { ...node.data, nodeKind },
          }
        }
        if (node.type === 'group') {
          const nodeKind =
            node.data.nodeKind ??
            (node.name === '导演台'
              ? 'director'
              : node.name === '视频合成'
                ? 'video-clip'
                : 'group')
          return {
            ...node,
            name: normalizedName,
            data: { ...node.data, nodeKind },
          }
        }
        return { ...node, name: normalizedName }
      })()

      if (
        nextNode.name === node.name &&
        nextNode.type === node.type &&
        nextNode.data === node.data
      ) {
        return
      }

      commitDocument({
        ...current,
        nodes: current.nodes.map((candidate) =>
          candidate.id === nodeId ? nextNode : candidate,
        ),
      })
    },
    addNode: (node) => {
      const current = get().snapshot
      if (current.nodes.some((candidate) => candidate.id === node.id)) return

      commitDocument({ ...current, nodes: [...current.nodes, node] })
    },
    createNodeFromHistory: (entry, center) => {
      const current = get().snapshot
      if (entry.projectId !== current.projectId) {
        throw new Error('History entry belongs to another project')
      }
      const random = globalThis.crypto?.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      const nodeId = `history-${entry.mediaType}-${random}`
      const aspectRatio = entry.settings.aspectRatio ??
        (entry.mediaType === 'image' ? '1:1' : '16:9')
      const size = entry.mediaType === 'audio'
        ? { width: 350, height: 160 }
        : sizeForAspectRatio(aspectRatio)
      const position = {
        x: center.x - size.width / 2,
        y: center.y - size.height / 2,
      }
      const output = {
        assetId: entry.asset.id,
        url: entry.asset.url,
        contentType: entry.asset.contentType,
        size: entry.asset.size,
      }
      const baseGeneration = {
        prompt: entry.prompt,
        status: 'complete' as const,
        phase: 'complete' as const,
        jobId: entry.jobId,
        outputIndex: entry.outputIndex,
        providerId: entry.providerId,
        createdAt: entry.completedAt,
        outputs: [output],
      }
      let node: CanvasNode
      if (entry.mediaType === 'image') {
        const quality = entry.settings.quality ?? 'original'
        node = {
          id: nodeId,
          type: 'image',
          name: entry.asset.filename || '历史图片',
          position,
          size,
          data: {
            url: entry.asset.url,
            assetId: entry.asset.id,
            generationSettings: {
              kind: 'image',
              providerId: entry.providerId,
              channel: entry.channel,
              model: entry.model,
              mode: entry.settings.mode,
              quality,
              resolution: quality,
              aspectRatio,
              count: entry.settings.count ?? 1,
            },
            generation: baseGeneration,
          },
        }
      } else if (entry.mediaType === 'video') {
        const resolution = entry.settings.quality ?? 'original'
        const settings: MediaGenerationSettings = {
          kind: 'video',
          providerId: entry.providerId,
          channel: entry.channel,
          model: entry.model,
          mode: entry.settings.mode,
          resolution,
          aspectRatio,
          durationSec: entry.settings.duration ?? 1,
          generateAudio: false,
          count: entry.settings.count ?? 1,
        }
        node = {
          id: nodeId,
          type: 'video',
          name: entry.asset.filename || '历史视频',
          position,
          size,
          data: {
            url: entry.asset.url,
            assetId: entry.asset.id,
            durationSec: entry.settings.duration,
            generationSettings: settings,
            generation: { ...baseGeneration, actualSettings: settings },
          },
        }
      } else {
        node = {
          id: nodeId,
          type: 'text',
          name: entry.asset.filename || '历史音频',
          position,
          size,
          data: {
            nodeKind: 'audio',
            text: entry.prompt,
            url: entry.asset.url,
            assetId: entry.asset.id,
          },
        }
      }
      if (node.type === 'image' && node.data.generationSettings) {
        node.data.generation = {
          ...node.data.generation!,
          actualSettings: { ...node.data.generationSettings },
        }
      }
      commitDocument({ ...current, nodes: [...current.nodes, node] })
      set({ selectedNodeIds: [nodeId] })
      return nodeId
    },
    addEdge: (edge) => {
      const current = get().snapshot
      const hasSource = current.nodes.some((node) => node.id === edge.source)
      const hasTarget = current.nodes.some((node) => node.id === edge.target)
      const hasId = current.edges.some((candidate) => candidate.id === edge.id)
      if (!hasSource || !hasTarget || hasId) return

      const next: ProjectSnapshot = {
        ...current,
        edges: [...current.edges, edge],
      }
      commitDocument(next)
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

      commitDocument({
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
            id: referenceEdgeId(sourceNodeId, targetNodeId),
            source: sourceNodeId,
            target: targetNodeId,
            sourceHandle: 'source',
            targetHandle: 'target',
            relation: 'reference',
            referenceAlias,
          }

      commitDocument({
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
      const edges = current.edges.filter(
        (edge) =>
          !(
            edge.target === targetNodeId &&
            edge.source === sourceNodeId &&
            edge.relation === 'reference'
          ),
      )
      if (edges.length !== current.edges.length) {
        commitDocument({ ...current, edges })
      }
    },
    getOrderedReferences: (targetNodeId) =>
      getOrderedReferences(get().snapshot, targetNodeId),
    deleteNodes: (nodeIds) => {
      const ids = new Set(nodeIds)
      if (ids.size === 0) return
      const current = get().snapshot
      const locked = lockedGenerationNodeIds(current)
      if ([...ids].some((id) => locked.has(id))) return
      const deletedParents = new Map(current.nodes.flatMap((node) =>
        ids.has(node.id) && (node.type === 'group' || node.type === 'frame')
          ? [[node.id, node] as const]
          : [],
      ))
      const nodes = current.nodes.flatMap((node) => {
        if (ids.has(node.id)) return []
        const parent = node.parentId ? deletedParents.get(node.parentId) : undefined
        if (!parent) return [node]
        const { parentId: _parentId, ...released } = node
        return [{
          ...released,
          position: {
            x: parent.position.x + node.position.x,
            y: parent.position.y + node.position.y,
          },
        } as CanvasNode]
      })
      if (nodes.length === current.nodes.length) return

      const edges = current.edges.filter(
        (edge) => !ids.has(edge.source) && !ids.has(edge.target),
      )
      const comments = current.comments?.map((comment) =>
        comment.nodeId && ids.has(comment.nodeId)
          ? { ...comment, nodeDeleted: true, nodeId: undefined }
          : comment,
      )
      commitDocument({ ...current, nodes, edges, comments })
      set((state) => ({
        selectedNodeIds: state.selectedNodeIds.filter((id) => !ids.has(id)),
      }))
    },
    deleteEdges: (edgeIds) => {
      const ids = new Set(edgeIds)
      if (ids.size === 0) return
      const current = get().snapshot
      const edges = current.edges.filter((edge) => !ids.has(edge.id))
      if (edges.length === current.edges.length) return
      commitDocument({ ...current, edges })
    },
    pasteImportedGraph: ({ nodes: sourceNodes, edges: sourceEdges, anchor }) => {
      if (sourceNodes.length === 0) return []
      const sourceIds = new Set<string>()
      for (const node of sourceNodes) {
        if (!node.id || sourceIds.has(node.id)) return []
        sourceIds.add(node.id)
      }

      const normalizedSourceNodes = normalizeCanvasHierarchy(structuredClone(sourceNodes))
      const current = get().snapshot
      const usedIds = new Set([
        ...current.nodes.map((node) => node.id),
        ...current.edges.map((edge) => edge.id),
      ])
      const createId = (kind: 'node' | 'edge') => {
        let id = ''
        do {
          const random = globalThis.crypto?.randomUUID?.() ??
            `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
          id = `clipboard-${kind}-${random}`
        } while (usedIds.has(id))
        usedIds.add(id)
        return id
      }
      const ids = new Map(normalizedSourceNodes.map((node) => [node.id, createId('node')]))
      const roots = normalizedSourceNodes.filter((node) => !node.parentId)
      const origin = {
        x: Math.min(...roots.map((node) => node.position.x)),
        y: Math.min(...roots.map((node) => node.position.y)),
      }
      const importedNodes = normalizedSourceNodes.map((source) => {
        const node = structuredClone(source)
        node.id = ids.get(source.id)!
        if (node.parentId && ids.has(node.parentId)) {
          node.parentId = ids.get(node.parentId)
        } else {
          delete node.parentId
          node.position = {
            x: anchor.x + source.position.x - origin.x,
            y: anchor.y + source.position.y - origin.y,
          }
        }
        if (node.type === 'group' || node.type === 'frame') {
          node.data.childIds = node.data.childIds.flatMap((id) => ids.get(id) ?? [])
        }
        if (node.type === 'image' || node.type === 'video') {
          delete node.data.generation
          node.data.referenceNodeIds = node.data.referenceNodeIds?.map(
            (id) => ids.get(id) ?? id,
          )
          node.data.unresolvedReferenceNodeIds = node.data.unresolvedReferenceNodeIds?.map(
            (id) => ids.get(id) ?? id,
          )
        }
        return node as CanvasNode
      })
      const importedEdges = sourceEdges.flatMap((source) => {
        const sourceId = ids.get(source.source)
        const targetId = ids.get(source.target)
        if (!source.id || !sourceId || !targetId) return []
        return [{
          ...structuredClone(source),
          id: createId('edge'),
          source: sourceId,
          target: targetId,
        }]
      })
      const importedIds = importedNodes.map((node) => node.id)
      commitDocument({
        ...current,
        nodes: [...current.nodes, ...importedNodes],
        edges: [...current.edges, ...importedEdges],
      })
      set({ selectedNodeIds: importedIds })
      return importedIds
    },
    duplicateNodes: (nodeIds) => {
      const current = get().snapshot
      const requestedIds = new Set(nodeIds)
      const sourceIds = new Set(nodeIds)
      let addedGroupChild = true
      while (addedGroupChild) {
        addedGroupChild = false
        for (const node of current.nodes) {
          if (
            node.type !== 'group' ||
            !sourceIds.has(node.id)
          ) continue
          for (const childId of node.data.childIds) {
            if (sourceIds.has(childId)) continue
            sourceIds.add(childId)
            addedGroupChild = true
          }
        }
      }

      const existingIds = new Set(current.nodes.map((node) => node.id))
      const duplicateIds = new Map<string, string>()
      for (const node of current.nodes) {
        if (!sourceIds.has(node.id)) continue
        let index = 1
        let id = `${node.id}-copy-${index}`
        while (existingIds.has(id)) {
          index += 1
          id = `${node.id}-copy-${index}`
        }
        existingIds.add(id)
        duplicateIds.set(node.id, id)
      }

      const duplicates = current.nodes
        .filter((node) => sourceIds.has(node.id))
        .map((node) => {
          const duplicate = structuredClone(node)
          duplicate.id = duplicateIds.get(node.id)!
          duplicate.name = `${node.name} - 副本`
          if (duplicate.parentId && duplicateIds.has(duplicate.parentId)) {
            duplicate.parentId = duplicateIds.get(duplicate.parentId)
          } else {
            duplicate.position = {
              x: node.position.x + 40,
              y: node.position.y + 40,
            }
          }
          if (duplicate.type === 'group') {
            duplicate.data.childIds = duplicate.data.childIds.flatMap((childId) => {
              const duplicateChildId = duplicateIds.get(childId)
              return duplicateChildId ? [duplicateChildId] : []
            })
          }
          if (duplicate.type === 'image' || duplicate.type === 'video') {
            delete duplicate.data.generation
            duplicate.data.referenceNodeIds = duplicate.data.referenceNodeIds?.map(
              (sourceId) => duplicateIds.get(sourceId) ?? sourceId,
            )
            duplicate.data.unresolvedReferenceNodeIds =
              duplicate.data.unresolvedReferenceNodeIds?.map(
                (sourceId) => duplicateIds.get(sourceId) ?? sourceId,
              )
          }
          return duplicate as CanvasNode
        })

      if (duplicates.length === 0) return []

      const existingEdgeIds = new Set(current.edges.map((edge) => edge.id))
      const duplicateEdges = current.edges.flatMap((edge) => {
        const sourceDuplicated = duplicateIds.has(edge.source)
        const targetDuplicated = duplicateIds.has(edge.target)
        if (!sourceDuplicated && !targetDuplicated) {
          return []
        }

        let index = 1
        let id = `${edge.id}-copy-${index}`
        while (existingEdgeIds.has(id)) {
          index += 1
          id = `${edge.id}-copy-${index}`
        }
        existingEdgeIds.add(id)
        return [{
          ...structuredClone(edge),
          id,
          source: duplicateIds.get(edge.source) ?? edge.source,
          target: duplicateIds.get(edge.target) ?? edge.target,
        }]
      })

      commitDocument({
        ...current,
        nodes: [...current.nodes, ...duplicates],
        edges: [...current.edges, ...duplicateEdges],
      })
      const createdIds = nodeIds.flatMap((nodeId) => {
        if (!requestedIds.has(nodeId)) return []
        const duplicateId = duplicateIds.get(nodeId)
        return duplicateId ? [duplicateId] : []
      })
      set({
        selectedNodeIds: createdIds,
      })
      return createdIds
    },
    groupNodes: (nodeIds, groupId, name) => {
      const current = get().snapshot
      if (current.nodes.some((node) => node.id === groupId)) return
      const ids = new Set(nodeIds)
      const children = current.nodes.filter(
        (node) => ids.has(node.id) && !node.parentId,
      )
      if (children.length < 2) return

      const padding = 40
      const labelSpace = 60
      const minX = Math.min(...children.map((node) => node.position.x))
      const minY = Math.min(...children.map((node) => node.position.y))
      const maxX = Math.max(
        ...children.map((node) => node.position.x + node.size.width),
      )
      const maxY = Math.max(
        ...children.map((node) => node.position.y + node.size.height),
      )
      const groupPosition = { x: minX - padding, y: minY - labelSpace }
      const group: CanvasNode = {
        id: groupId,
        type: 'group',
        name,
        position: groupPosition,
        size: {
          width: maxX - minX + padding * 2,
          height: maxY - minY + padding + labelSpace,
        },
        data: {
          childIds: children.map((node) => node.id),
          nodeKind: 'group',
        },
      }
      const groupedChildren = children.map(
        (node) =>
          ({
            ...node,
            parentId: groupId,
            position: {
              x: node.position.x - groupPosition.x,
              y: node.position.y - groupPosition.y,
            },
          }) as CanvasNode,
      )
      const untouched = current.nodes.filter((node) => !ids.has(node.id))

      commitDocument({
        ...current,
        nodes: [...untouched, group, ...groupedChildren],
      })
      set({ selectedNodeIds: [groupId] })
    },
    ungroupNodes: (groupIds) => {
      const current = get().snapshot
      const ids = new Set(groupIds)
      const groups = current.nodes.filter(
        (node) => ids.has(node.id) && node.type === 'group',
      )
      if (groups.length === 0) return

      const groupById = new Map(groups.map((group) => [group.id, group]))
      const releasedIds: string[] = []
      const nodes = current.nodes
        .filter((node) => !groupById.has(node.id))
        .map((node) => {
          if (!node.parentId || !groupById.has(node.parentId)) return node
          const parent = groupById.get(node.parentId)!
          releasedIds.push(node.id)
          const { parentId: _parentId, ...released } = node
          return {
            ...released,
            position: {
              x: parent.position.x + node.position.x,
              y: parent.position.y + node.position.y,
            },
          } as CanvasNode
        })
      const edges = current.edges.filter(
        (edge) => !ids.has(edge.source) && !ids.has(edge.target),
      )

      commitDocument({ ...current, nodes, edges })
      set({ selectedNodeIds: releasedIds })
    },
    resizeNode: (nodeId, size) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (
        !node ||
        (node.size.width === size.width && node.size.height === size.height)
      ) {
        return
      }

      commitDocument({
        ...current,
        nodes: current.nodes.map((candidate) =>
          candidate.id === nodeId ? { ...candidate, size } : candidate,
        ),
      })
    },
    updateCreativeNode: (nodeId, changes) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || (node.type !== 'frame' && node.type !== 'shape')) return
      const data = {
        ...node.data,
        ...(changes.rotation !== undefined ? { rotation: changes.rotation } : {}),
        ...(changes.fill !== undefined ? { fill: changes.fill } : {}),
        ...(changes.stroke !== undefined ? { stroke: changes.stroke } : {}),
        ...(changes.strokeWidth !== undefined ? { strokeWidth: Math.max(0, changes.strokeWidth) } : {}),
        ...(node.type === 'shape' && changes.opacity !== undefined ? { opacity: Math.min(1, Math.max(0, changes.opacity)) } : {}),
        ...(node.type === 'shape' && changes.radius !== undefined ? { radius: Math.max(0, changes.radius) } : {}),
      }
      commitDocument({
        ...current,
        nodes: current.nodes.map((candidate) => candidate.id === nodeId ? {
          ...candidate,
          ...(changes.position ? { position: changes.position } : {}),
          ...(changes.size ? { size: changes.size } : {}),
          data,
        } as CanvasNode : candidate),
      })
    },
    moveNodeLayer: (nodeId, direction) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node) return
      const siblings = current.nodes.filter((candidate) => candidate.parentId === node.parentId && candidate.id !== nodeId)
      const next = applyReparent(current, [nodeId], node.parentId, direction === 'front' ? siblings.length : 0)
      if (next) commitDocument(next)
    },
    setNodeVisibility: (nodeId, visible) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.hidden === !visible) return
      commitDocument({ ...current, nodes: current.nodes.map((candidate) => candidate.id === nodeId ? { ...candidate, hidden: !visible } as CanvasNode : candidate) })
    },
    setNodeLocked: (nodeId, locked) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.locked === locked) return
      commitDocument({ ...current, nodes: current.nodes.map((candidate) => candidate.id === nodeId ? { ...candidate, locked } as CanvasNode : candidate) })
    },
    patchNode: (nodeId, changes) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node) return
      const nextNode = {
        ...node,
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.position !== undefined ? { position: changes.position } : {}),
        ...(changes.size !== undefined ? { size: changes.size } : {}),
        ...(changes.data !== undefined ? { data: { ...node.data, ...changes.data } } : {}),
      }
      commitDocument({
        ...current,
        nodes: current.nodes.map((candidate) =>
          candidate.id === nodeId ? (nextNode as CanvasNode) : candidate,
        ),
      })
    },
    updateTextNode: (nodeId, text) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.type !== 'text' || node.data.text === text) return

      commitDocument({
        ...current,
        nodes: current.nodes.map((candidate) =>
          candidate.id === nodeId && candidate.type === 'text'
            ? { ...candidate, data: { ...candidate.data, text } }
            : candidate,
        ),
      })
    },
    addImageVersion: (nodeId, version) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.type !== 'image') return
      const versions = node.data.versions ?? []
      if (versions.some((candidate) => candidate.id === version.id)) return
      commitDocument({ ...current, nodes: current.nodes.map((candidate) =>
        candidate.id === nodeId && candidate.type === 'image' ? {
          ...candidate,
          data: { ...candidate.data, url: version.url, assetId: version.assetId, versions: [...versions, version], activeVersionId: version.id },
        } : candidate,
      ) })
    },
    setImageVersion: (nodeId, versionId) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.type !== 'image') return
      const version = node.data.versions?.find((candidate) => candidate.id === versionId)
      if (!version || node.data.activeVersionId === versionId) return
      commitDocument({ ...current, nodes: current.nodes.map((candidate) =>
        candidate.id === nodeId && candidate.type === 'image' ? {
          ...candidate, data: { ...candidate.data, url: version.url, assetId: version.assetId, activeVersionId: version.id },
        } : candidate,
      ) })
    },
    addComment: (comment) => {
      const current = get().snapshot
      if (current.comments?.some((candidate) => candidate.id === comment.id)) return
      commitDocument({ ...current, comments: [...(current.comments ?? []), comment] })
    },
    updateComment: (commentId, updater) => {
      const current = get().snapshot
      const comments = current.comments ?? []
      const index = comments.findIndex((comment) => comment.id === commentId)
      if (index < 0) return
      commitDocument({ ...current, comments: comments.map((comment) => comment.id === commentId ? updater(comment) : comment) })
    },
    toggleNodeFlag: (nodeId, flag) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || (node.type !== 'frame' && node.type !== 'shape' && node.type !== 'path')) return
      commitDocument({ ...current, nodes: current.nodes.map((candidate) =>
        candidate.id === nodeId && (candidate.type === 'frame' || candidate.type === 'shape' || candidate.type === 'path')
          ? { ...candidate, data: { ...candidate.data, [flag]: !candidate.data[flag] } } as CanvasNode
          : candidate,
      ) })
    },
    updateGenerationSettings: (nodeId, settings) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (
        !node ||
        (node.type !== 'image' && node.type !== 'video') ||
        node.type !== settings.kind
      ) {
        return
      }

      const resized =
        parseAspectRatio(settings.aspectRatio) !== undefined
          ? resizeAroundCenter(
              node.position,
              node.size,
              sizeForAspectRatio(settings.aspectRatio),
            )
          : undefined
      commitDocument({
        ...current,
        nodes: current.nodes.map((candidate) => {
          if (candidate.id !== nodeId) return candidate
          if (candidate.type === 'image' && settings.kind === 'image') {
            return {
              ...candidate,
              ...(resized ?? {}),
              data: {
                ...candidate.data,
                generationSettings: { ...settings },
              },
            }
          }
          if (candidate.type === 'video' && settings.kind === 'video') {
            return {
              ...candidate,
              ...(resized ?? {}),
              data: {
                ...candidate.data,
                generationSettings: { ...settings },
              },
            }
          }
          return candidate
        }),
      })
    },
    reconcileImageNaturalSize: (nodeId, naturalWidth, naturalHeight) => {
      if (
        !Number.isFinite(naturalWidth) ||
        !Number.isFinite(naturalHeight) ||
        naturalWidth <= 0 ||
        naturalHeight <= 0
      ) {
        return
      }
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (node?.type !== 'image') return
      const requested = node.data.generation?.actualSettings?.aspectRatio ??
        node.data.generationSettings?.aspectRatio
      if (!requested || !materiallyDifferentRatio(requested, naturalWidth, naturalHeight)) {
        return
      }
      const next = resizeAroundCenter(
        node.position,
        node.size,
        sizeForAspectRatio(ratioStringFromDimensions(naturalWidth, naturalHeight)),
      )
      const outputAspectRatio = ratioStringFromDimensions(naturalWidth, naturalHeight)
      if (
        next.size.width === node.size.width &&
        next.size.height === node.size.height &&
        node.data.generation?.outputAspectRatio === outputAspectRatio
      ) {
        return
      }
      set({
        snapshot: {
          ...current,
          nodes: current.nodes.map((candidate) =>
            candidate.id === nodeId && candidate.type === 'image'
              ? {
                  ...candidate,
                  ...next,
                  data: candidate.data.generation
                    ? {
                        ...candidate.data,
                        generation: {
                          ...candidate.data.generation,
                          outputAspectRatio,
                        },
                      }
                    : candidate.data,
                }
              : candidate,
          ),
        },
      })
    },
    updateGenerationPrompt: (nodeId, prompt) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (
        !node ||
        (node.type !== 'image' && node.type !== 'video') ||
        node.data.promptDraft === prompt
      ) {
        return
      }

      commitDocument({
        ...current,
        nodes: current.nodes.map((candidate) => {
          if (candidate.id !== nodeId) return candidate
          if (candidate.type === 'image') {
            return {
              ...candidate,
              data: { ...candidate.data, promptDraft: prompt },
            }
          }
          if (candidate.type === 'video') {
            return {
              ...candidate,
              data: { ...candidate.data, promptDraft: prompt },
            }
          }
          return candidate
        }),
      })
    },
    createGenerationBatch: (input) => {
      const current = get().snapshot
      if (current.projectId !== input.projectId) return undefined
      const source = current.nodes.find((node) => node.id === input.sourceNodeId)
      if (!source || (source.type !== 'image' && source.type !== 'video')) {
        return undefined
      }
      if (
        current.nodes.some((node) => {
          if (node.type !== 'image' && node.type !== 'video') return false
          return (
            node.data.generation?.sourceNodeId === input.sourceNodeId &&
            (node.data.generation.status === 'generating' ||
              node.data.generation.pendingRequest !== undefined)
          )
        })
      ) {
        return undefined
      }

      const existingNodeIds = new Set(current.nodes.map((node) => node.id))
      const existingEdgeIds = new Set(current.edges.map((edge) => edge.id))
      const targetIds = [
        ...input.existingTargetNodeIds,
        ...input.targetNodes.map((node) => node.id),
      ]
      if (
        new Set(targetIds).size !== targetIds.length ||
        targetIds[0] !== source.id ||
        input.targetNodes.some(
          (node) => existingNodeIds.has(node.id) || node.type !== source.type,
        ) ||
        input.outputEdges.some(
          (edge) =>
            existingEdgeIds.has(edge.id) ||
            edge.source !== source.id ||
            edge.relation !== 'output' ||
            !targetIds.includes(edge.target),
        ) ||
        input.existingTargetNodeIds.some((id) => {
          const node = current.nodes.find((candidate) => candidate.id === id)
          return !node || node.type !== source.type
        })
      ) {
        return undefined
      }

      const generationFor = (outputIndex: number): MediaGeneration => ({
        prompt: input.prompt,
        status: 'generating',
        phase: 'queued',
        progress: 0,
        sourceNodeId: source.id,
        clientRequestId: input.clientRequestId,
        outputIndex,
        providerId: input.settings.providerId,
        createdAt: input.createdAt,
        actualSettings: { ...input.settings },
      })
      const outputIndexById = new Map(
        targetIds.map((id, outputIndex) => [id, outputIndex]),
      )
      const existingNodes = current.nodes.map((node) => {
        const outputIndex = outputIndexById.get(node.id)
        if (
          outputIndex === undefined ||
          (node.type !== 'image' && node.type !== 'video')
        ) {
          return node
        }
        return {
          ...node,
          data: { ...node.data, generation: generationFor(outputIndex) },
        } as CanvasNode
      })
      const targetNodes = input.targetNodes.map((node) => {
        const outputIndex = outputIndexById.get(node.id)!
        if (node.type === 'image' || node.type === 'video') {
          return {
            ...node,
            data: { ...node.data, generation: generationFor(outputIndex) },
          } as CanvasNode
        }
        return node
      })

      commitDocument({
        ...current,
        nodes: [...existingNodes, ...targetNodes],
        edges: [...current.edges, ...input.outputEdges],
      })
      set({ selectedNodeIds: [targetIds[0] ?? source.id] })
      return targetIds
    },
    setMediaGenerationGuarded: (input) => {
      const current = get().snapshot
      if (current.projectId !== input.projectId) return false
      const node = current.nodes.find((candidate) => candidate.id === input.nodeId)
      if (!node || (node.type !== 'image' && node.type !== 'video')) return false
      const existing = node.data.generation
      if (
        (input.clientRequestId === null
          ? existing?.clientRequestId !== undefined
          : existing?.clientRequestId !== input.clientRequestId) ||
        (input.expectedJobId === null
          ? existing?.jobId !== undefined
          : existing?.jobId !== input.expectedJobId)
      ) {
        return false
      }

      set({
        snapshot: {
          ...current,
          nodes: current.nodes.map((candidate) => {
            if (candidate.id !== input.nodeId) return candidate
            if (candidate.type === 'image') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  ...(input.asset
                    ? { url: input.asset.url, assetId: input.asset.assetId }
                    : {}),
                  generation: { ...input.generation },
                },
              }
            }
            if (candidate.type === 'video') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  ...(input.asset
                    ? { url: input.asset.url, assetId: input.asset.assetId }
                    : {}),
                  ...(input.asset?.poster ? { poster: input.asset.poster } : {}),
                  generation: { ...input.generation },
                },
              }
            }
            return candidate
          }),
        },
      })
      return true
    },
    setMediaAssetGuarded: (input) => {
      const current = get().snapshot
      if (current.projectId !== input.projectId) return false
      const node = current.nodes.find((candidate) => candidate.id === input.nodeId)
      if (
        !node ||
        (node.type !== 'image' && node.type !== 'video') ||
        node.data.url !== input.expectedUrl
      ) {
        return false
      }
      set({
        snapshot: {
          ...current,
          nodes: current.nodes.map((candidate) => {
            if (candidate.id !== input.nodeId) return candidate
            if (candidate.type === 'image') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  url: input.asset.url,
                  assetId: input.asset.assetId,
                },
              }
            }
            if (candidate.type === 'video') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  url: input.asset.url,
                  assetId: input.asset.assetId,
                  ...(input.asset.poster ? { poster: input.asset.poster } : {}),
                },
              }
            }
            return candidate
          }),
        },
      })
      return true
    },
    setMediaGeneration: (nodeId, generation, result = {}) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || (node.type !== 'image' && node.type !== 'video')) return

      set({
        snapshot: {
          ...current,
          nodes: current.nodes.map((candidate) => {
            if (candidate.id !== nodeId) return candidate
            if (candidate.type === 'image') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  ...(result.url ? { url: result.url } : {}),
                  generation: { ...generation },
                },
              }
            }
            if (candidate.type === 'video') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  ...(result.url ? { url: result.url } : {}),
                  ...(result.poster ? { poster: result.poster } : {}),
                  generation: { ...generation },
                },
              }
            }
            return candidate
          }),
        },
      })
    },
    setMediaAsset: (nodeId, asset) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || (node.type !== 'image' && node.type !== 'video')) return
      if (
        node.data.url === asset.url &&
        (node.type !== 'video' ||
          asset.poster === undefined ||
          node.data.poster === asset.poster)
      ) {
        return
      }
      set({
        snapshot: {
          ...current,
          nodes: current.nodes.map((candidate) => {
            if (candidate.id !== nodeId) return candidate
            if (candidate.type === 'image') {
              return {
                ...candidate,
                data: { ...candidate.data, url: asset.url },
              }
            }
            if (candidate.type === 'video') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  url: asset.url,
                  ...(asset.poster ? { poster: asset.poster } : {}),
                },
              }
            }
            return candidate
          }),
        },
      })
    },
    layoutNodes: (nodeIds) => {
      const current = get().snapshot
      const ids = nodeIds ? new Set(nodeIds) : null
      const targetNodes = current.nodes.filter((node) => !ids || ids.has(node.id))
      if (targetNodes.length === 0) return

      // Calculate centroid / bounding box of target nodes
      const minX = Math.min(...targetNodes.map((n) => n.position.x))
      const minY = Math.min(...targetNodes.map((n) => n.position.y))
      const maxX = Math.max(...targetNodes.map((n) => n.position.x + (n.size?.width || 400)))
      const maxY = Math.max(...targetNodes.map((n) => n.position.y + (n.size?.height || 300)))
      const centerOrigX = (minX + maxX) / 2
      const centerOrigY = (minY + maxY) / 2

      // Determine grid dimensions
      const count = targetNodes.length
      const cols = count <= 3 ? count : Math.ceil(Math.sqrt(count))
      const rows = Math.ceil(count / cols)
      const gapX = 48
      const gapY = 48

      // Determine column widths and row heights
      const colWidths = new Array(cols).fill(0)
      const rowHeights = new Array(rows).fill(0)

      targetNodes.forEach((node, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        const w = node.size?.width || 400
        const h = node.size?.height || 300
        if (w > colWidths[col]) colWidths[col] = w
        if (h > rowHeights[row]) rowHeights[row] = h
      })

      const totalWidth = colWidths.reduce((a, b) => a + b, 0) + (cols - 1) * gapX
      const totalHeight = rowHeights.reduce((a, b) => a + b, 0) + (rows - 1) * gapY
      const startX = centerOrigX - totalWidth / 2
      const startY = centerOrigY - totalHeight / 2

      const colOffsets = [0]
      for (let c = 0; c < cols - 1; c += 1) {
        colOffsets.push(colOffsets[c] + colWidths[c] + gapX)
      }
      const rowOffsets = [0]
      for (let r = 0; r < rows - 1; r += 1) {
        rowOffsets.push(rowOffsets[r] + rowHeights[r] + gapY)
      }

      const positionMap = new Map<string, Point>()
      targetNodes.forEach((node, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        positionMap.set(node.id, {
          x: Math.round(startX + colOffsets[col]),
          y: Math.round(startY + rowOffsets[row]),
        })
      })

      let changed = false
      const nodes = current.nodes.map((node) => {
        const nextPos = positionMap.get(node.id)
        if (!nextPos || (node.position.x === nextPos.x && node.position.y === nextPos.y)) {
          return node
        }
        changed = true
        return { ...node, position: nextPos }
      })
      if (changed) commitDocument({ ...current, nodes })
    },
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
    undo: () => {
      if (lockedGenerationNodeIds(get().snapshot).size > 0) return
      const previous = past.pop()
      if (!previous) return

      future.push(get().snapshot)
      const ids = new Set(previous.nodes.map((node) => node.id))
      set({
        snapshot: previous,
        selectedNodeIds: get().selectedNodeIds.filter((id) => ids.has(id)),
        canUndo: past.length > 0,
        canRedo: true,
      })
    },
    redo: () => {
      const next = future.pop()
      if (!next) return

      past.push(get().snapshot)
      const ids = new Set(next.nodes.map((node) => node.id))
      set({
        snapshot: next,
        selectedNodeIds: get().selectedNodeIds.filter((id) => ids.has(id)),
        canUndo: true,
        canRedo: future.length > 0,
      })
    },
    serialize: () => JSON.stringify(get().snapshot),
    restore: (serialized) => {
      const snapshot = parseProjectSnapshot(serialized)
      past.length = 0
      future.length = 0
      set({
        snapshot,
        selectedNodeIds: [],
        mode: 'select',
        canUndo: false,
        canRedo: false,
      })
    },
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
    applyEntityChanges: (changes) => {
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
      const currentComments = current.comments ?? []
      const comments = changes.comments || changes.commentOrder
        ? mergeEntities(
            currentComments,
            changes.comments?.upserted ?? [],
            new Set(changes.comments?.removed ?? []),
            changes.commentOrder,
          )
        : currentComments
      const selectedNodeIds = currentState.selectedNodeIds.filter((id) => liveNodeIds.has(id))
      const name = changes.name ?? current.name
      const changed = name !== current.name ||
        nodes.length !== current.nodes.length || nodes.some((node, index) => node !== current.nodes[index]) ||
        edges.length !== current.edges.length || edges.some((edge, index) => edge !== current.edges[index]) ||
        comments.length !== currentComments.length || comments.some((comment, index) => comment !== currentComments[index])
      const selectionChanged = selectedNodeIds.length !== currentState.selectedNodeIds.length ||
        selectedNodeIds.some((id, index) => id !== currentState.selectedNodeIds[index])
      if (!changed && !selectionChanged) return

      const normalizedNodes = reconcileEntities(nodes, normalizeCanvasHierarchy(nodes))
      set({
        ...(changed
          ? { snapshot: { ...current, name, nodes: normalizedNodes, edges, comments } }
          : {}),
        ...(selectionChanged ? { selectedNodeIds } : {}),
      })
    },
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

