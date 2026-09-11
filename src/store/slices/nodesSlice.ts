import type {
  CanvasNode,
  MediaGenerationSettings,
  Point,
  ProjectSnapshot,
} from '../../model/project'
import { normalizeCanvasHierarchy } from '../../model/project'
import { sizeForAspectRatio } from '../../components/canvas/mediaGeometry'
import type { CanvasStoreState, StoreGet, StoreSet } from '../types'
import type { HistoryContext } from './historySlice'
import {
  applyReferenceRemovals,
  applyReparent,
  lockedGenerationNodeIds,
} from '../storeHelpers'

export function createNodesActions(
  set: StoreSet,
  get: StoreGet,
  history: HistoryContext,
): Pick<
  CanvasStoreState,
  | 'moveNode'
  | 'moveNodes'
  | 'moveNodesInHierarchy'
  | 'reparentNodes'
  | 'reorderNodes'
  | 'reconcileFrameMembership'
  | 'renameNode'
  | 'renameCanvas'
  | 'addNode'
  | 'addNodes'
  | 'createNodeFromHistory'
  | 'deleteNodes'
  | 'duplicateNodes'
  | 'pasteImportedGraph'
  | 'groupNodes'
  | 'ungroupNodes'
  | 'resizeNode'
  | 'updateCreativeNode'
  | 'moveNodeLayer'
  | 'setNodeVisibility'
  | 'setNodeLocked'
  | 'patchNode'
  | 'updateTextNode'
  | 'addImageVersion'
  | 'setImageVersion'
  | 'toggleNodeFlag'
  | 'layoutNodes'
> {
  return {
    moveNode: (nodeId, position) => {
      get().moveNodes([{ id: nodeId, position }])
    },

    moveNodes: (moves) => {
      if (moves.length === 0) return

      const current = get().snapshot
      const positions = new Map(moves.map((move) => [move.id, move.position]))
      let changed = false

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
          return { ...candidate, position }
        }),
      }
      if (changed) history.commitDocument(next)
    },

    moveNodesInHierarchy: (moves, parentId) => {
      if (moves.length === 0) return
      const current = get().snapshot
      const positions = new Map(moves.map((move) => [move.id, move.positionAbsolute]))
      const next = applyReparent(current, moves.map((move) => move.id), parentId, undefined, positions)
      if (next) history.commitDocument(next)
    },

    reparentNodes: (nodeIds, parentId, index) => {
      const next = applyReparent(get().snapshot, nodeIds, parentId, index)
      if (!next) return false
      history.commitDocument(next)
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
      history.commitDocument(next)
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
      history.commitDocument({ ...current, nodes })
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
            (node.name === '导演台' || node.name === 'Agent 导演台'
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

      history.commitDocument({
        ...current,
        nodes: current.nodes.map((candidate) =>
          candidate.id === nodeId ? nextNode : candidate,
        ),
      })
    },

    renameCanvas: (name) => {
      const normalizedName = name.trim().slice(0, 60)
      if (!normalizedName) return
      const current = get().snapshot
      if (current.name === normalizedName) return
      history.commitDocument({ ...current, name: normalizedName })
    },

    addNode: (node) => {
      const current = get().snapshot
      if (current.nodes.some((candidate) => candidate.id === node.id)) return

      history.commitDocument({ ...current, nodes: [...current.nodes, node] })
    },

    addNodes: (nodes: CanvasNode[]): string[] => {
      if (nodes.length === 0) return []
      const current = get().snapshot
      const existingIds = new Set(current.nodes.map((candidate: CanvasNode) => candidate.id))
      const filtered = nodes.filter((candidate: CanvasNode) => !existingIds.has(candidate.id))
      if (filtered.length === 0) return []

      history.commitDocument({ ...current, nodes: [...current.nodes, ...filtered] })
      return filtered.map((candidate: CanvasNode) => candidate.id)
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
      history.commitDocument({ ...current, nodes: [...current.nodes, node] })
      set({ selectedNodeIds: [nodeId] })
      return nodeId
    },

    deleteNodes: (nodeIds, options) => {
      const ids = new Set(nodeIds)
      if (ids.size === 0) return
      const current = get().snapshot
      if (!options?.force) {
        const locked = lockedGenerationNodeIds(current)
        if ([...ids].some((id) => locked.has(id))) return
      }
      const deletedParents = new Map(current.nodes.flatMap((node) =>
        ids.has(node.id) && (node.type === 'group' || node.type === 'frame')
          ? [[node.id, node] as const]
          : [],
      ))
      const rawRemainingNodes = current.nodes.flatMap((node) => {
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
      if (rawRemainingNodes.length === current.nodes.length) return

      const removals: Array<{ targetNodeId: string; removedAlias: number }> = []
      for (const edge of current.edges) {
        if (
          ids.has(edge.source) &&
          !ids.has(edge.target) &&
          edge.relation === 'reference' &&
          edge.referenceAlias !== undefined
        ) {
          removals.push({ targetNodeId: edge.target, removedAlias: edge.referenceAlias })
        }
      }

      const rawRemainingEdges = current.edges.filter(
        (edge) => !ids.has(edge.source) && !ids.has(edge.target),
      )
      const { nodes, edges } = applyReferenceRemovals(
        rawRemainingNodes,
        rawRemainingEdges,
        removals,
      )

      history.commitDocument({ ...current, nodes, edges })
      set((state) => ({
        selectedNodeIds: state.selectedNodeIds.filter((id) => !ids.has(id)),
      }))
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

      history.commitDocument({
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
      history.commitDocument({
        ...current,
        nodes: [...current.nodes, ...importedNodes],
        edges: [...current.edges, ...importedEdges],
      })
      set({ selectedNodeIds: importedIds })
      return importedIds
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

      history.commitDocument({
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

      history.commitDocument({ ...current, nodes, edges })
      set({ selectedNodeIds: releasedIds })
    },

    resizeNode: (nodeId, size, position) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node) return
      const sameSize = node.size.width === size.width && node.size.height === size.height
      const samePos = !position || (node.position.x === position.x && node.position.y === position.y)
      if (sameSize && samePos) return

      history.commitDocument({
        ...current,
        nodes: current.nodes.map((candidate) =>
          candidate.id === nodeId
            ? {
                ...candidate,
                size,
                ...(position ? { position } : {}),
              }
            : candidate,
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
      history.commitDocument({
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
      if (next) history.commitDocument(next)
    },

    setNodeVisibility: (nodeId, visible) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.hidden === !visible) return
      history.commitDocument({ ...current, nodes: current.nodes.map((candidate) => candidate.id === nodeId ? { ...candidate, hidden: !visible } as CanvasNode : candidate) })
    },

    setNodeLocked: (nodeId, locked) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.locked === locked) return
      history.commitDocument({ ...current, nodes: current.nodes.map((candidate) => candidate.id === nodeId ? { ...candidate, locked } as CanvasNode : candidate) })
    },

    patchNode: (nodeId, changes, commit = true) => {
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
      const nextSnapshot = {
        ...current,
        nodes: current.nodes.map((candidate) =>
          candidate.id === nodeId ? (nextNode as CanvasNode) : candidate,
        ),
      }
      if (commit) {
        history.commitDocument(nextSnapshot)
      } else {
        set({ snapshot: nextSnapshot })
      }
    },

    updateTextNode: (nodeId, text, commit = true) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.type !== 'text' || node.data.text === text) return

      const nextSnapshot = {
        ...current,
        nodes: current.nodes.map((candidate) =>
          candidate.id === nodeId && candidate.type === 'text'
            ? { ...candidate, data: { ...candidate.data, text } }
            : candidate,
        ),
      }
      if (commit) {
        history.commitDocument(nextSnapshot)
      } else {
        set({ snapshot: nextSnapshot })
      }
    },

    addImageVersion: (nodeId, version) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.type !== 'image') return
      const versions = node.data.versions?.length
        ? node.data.versions
        : [{
            id: `original:${node.id}`,
            url: node.data.url,
            ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
            createdAt: '1970-01-01T00:00:00.000Z',
            label: '原始版本',
          }]
      if (versions.some((candidate) => candidate.id === version.id)) return
      history.commitDocument({ ...current, nodes: current.nodes.map((candidate) =>
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
      history.commitDocument({ ...current, nodes: current.nodes.map((candidate) =>
        candidate.id === nodeId && candidate.type === 'image' ? {
          ...candidate, data: { ...candidate.data, url: version.url, assetId: version.assetId, activeVersionId: version.id },
        } : candidate,
      ) })
    },



    toggleNodeFlag: (nodeId, flag) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || (node.type !== 'frame' && node.type !== 'shape' && node.type !== 'path')) return
      history.commitDocument({ ...current, nodes: current.nodes.map((candidate) =>
        candidate.id === nodeId && (candidate.type === 'frame' || candidate.type === 'shape' || candidate.type === 'path')
          ? { ...candidate, data: { ...candidate.data, [flag]: !candidate.data[flag] } } as CanvasNode
          : candidate,
      ) })
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
      if (changed) history.commitDocument({ ...current, nodes })
    },
  }
}
