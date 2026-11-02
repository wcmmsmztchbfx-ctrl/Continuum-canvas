import type {
  CanvasEdge,
  CanvasNode,
  NodeSize,
  Point,
  ProjectSnapshot,
} from '../model/project.ts'
import { compactPromptReferences } from '../model/project.ts'

export const MAX_UNDO_STACK_SIZE = 100

export function sameEntity(left: unknown, right: unknown): boolean {
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

export function reconcileEntities<T extends { id: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const currentById = new Map(current.map((entity) => [entity.id, entity]))
  return incoming.map((entity) => {
    const previous = currentById.get(entity.id)
    return previous && sameEntity(previous, entity) ? previous : entity
  })
}

export function absolutePositions(nodes: readonly CanvasNode[]): Map<string, Point> {
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

export function canReparent(nodes: readonly CanvasNode[], nodeIds: readonly string[], parentId?: string): boolean {
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

export function applyReparent(
  current: ProjectSnapshot,
  nodeIds: readonly string[],
  parentId?: string,
  index?: number,
  movedAbsolute?: ReadonlyMap<string, Point>,
): ProjectSnapshot | undefined {
  const requested = new Set(nodeIds)
  const roots = current.nodes.filter(
    (node) =>
      requested.has(node.id) &&
      !current.nodes.some(
        (candidate) => requested.has(candidate.id) && node.parentId === candidate.id,
      ),
  )
  const rootIds = roots.map((node) => node.id)
  if (roots.length === 0 || !canReparent(current.nodes, rootIds, parentId)) return undefined
  const absolute = absolutePositions(current.nodes)
  const parentAbsolute = parentId ? absolute.get(parentId) ?? { x: 0, y: 0 } : { x: 0, y: 0 }
  const moving = new Set(rootIds)
  const reparentNeeded = roots.some((node) => node.parentId !== parentId)

  const mappedNodes = current.nodes.map((node) => {
    if (!moving.has(node.id)) return node
    const positionAbsolute = movedAbsolute?.get(node.id) ?? absolute.get(node.id) ?? node.position
    const { parentId: _previousParentId, ...nodeWithoutParent } = node
    return {
      ...nodeWithoutParent,
      ...(parentId ? { parentId } : {}),
      position: { x: positionAbsolute.x - parentAbsolute.x, y: positionAbsolute.y - parentAbsolute.y },
    } as CanvasNode
  })

  // When index is undefined and no reparenting occurred (pure coordinate movement on canvas),
  // preserve the EXACT array order of current.nodes to avoid changing layer hierarchy or z-index.
  if (index === undefined && !reparentNeeded) {
    return { ...current, nodes: mappedNodes }
  }

  // When reparenting or reordering with an explicit or default index:
  const movingSiblings = mappedNodes.filter((node) => moving.has(node.id) && node.parentId === parentId)
  const remainingSiblings = mappedNodes.filter((node) => !moving.has(node.id) && node.parentId === parentId)
  const insertion = Math.max(0, Math.min(index ?? remainingSiblings.length, remainingSiblings.length))
  const newSiblingList = [
    ...remainingSiblings.slice(0, insertion),
    ...movingSiblings,
    ...remainingSiblings.slice(insertion),
  ]

  let siblingCursor = 0
  const nodes: CanvasNode[] = []
  for (const node of mappedNodes) {
    if (moving.has(node.id)) {
      if (node.parentId !== parentId) {
        nodes.push(node)
      }
      continue
    }
    if (node.parentId === parentId) {
      while (siblingCursor < newSiblingList.length) {
        const nextSibling = newSiblingList[siblingCursor++]!
        nodes.push(nextSibling)
        if (!moving.has(nextSibling.id)) break
      }
    } else {
      nodes.push(node)
    }
  }
  while (siblingCursor < newSiblingList.length) {
    nodes.push(newSiblingList[siblingCursor++]!)
  }

  return { ...current, nodes }
}

export function referenceEdgeId(edges: readonly CanvasEdge[], sourceNodeId: string, targetNodeId: string): string {
  const existingIds = new Set(edges.map((edge) => edge.id))
  const base = `reference-${sourceNodeId}-${targetNodeId}`
  let id = base
  let suffix = 2
  while (existingIds.has(id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  return id
}

export function lockedGenerationNodeIds(snapshot: ProjectSnapshot): Set<string> {
  const locked = new Set<string>()
  for (const node of snapshot.nodes) {
    if (node.type !== 'image' && node.type !== 'video') continue
    const generation = node.data.generation
    if (generation?.status !== 'generating') {
      continue
    }
    locked.add(node.id)
    if (generation.sourceNodeId) locked.add(generation.sourceNodeId)
  }
  return locked
}

export function applyReferenceRemovals(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  removals: Array<{ targetNodeId: string; removedAlias: number }>,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  if (removals.length === 0) return { nodes, edges }

  const removalsByTarget = new Map<string, number[]>()
  for (const { targetNodeId, removedAlias } of removals) {
    const list = removalsByTarget.get(targetNodeId) ?? []
    list.push(removedAlias)
    removalsByTarget.set(targetNodeId, list)
  }

  let updatedEdges = [...edges]
  let updatedNodes = [...nodes]

  for (const [targetId, aliases] of removalsByTarget.entries()) {
    const sortedAliases = [...new Set(aliases)].sort((a, b) => b - a)

    for (const removedAlias of sortedAliases) {
      updatedEdges = updatedEdges.map((edge) => {
        if (
          edge.target === targetId &&
          edge.relation === 'reference' &&
          edge.referenceAlias !== undefined &&
          edge.referenceAlias > removedAlias
        ) {
          return {
            ...edge,
            referenceAlias: edge.referenceAlias - 1,
          }
        }
        return edge
      })

      updatedNodes = updatedNodes.map((node) => {
        if (node.id !== targetId) return node
        if (node.type !== 'image' && node.type !== 'video') return node

        const draft = node.data.promptDraft
        const genPrompt = node.data.generation?.prompt
        const currentPrompt = draft ?? genPrompt ?? ''
        const nextPrompt = compactPromptReferences(currentPrompt, removedAlias)

        return {
          ...node,
          data: {
            ...node.data,
            promptDraft: nextPrompt,
            ...(node.data.generation ? {
              generation: {
                ...node.data.generation,
                prompt: compactPromptReferences(node.data.generation.prompt, removedAlias),
              },
            } : {}),
          },
        } as CanvasNode
      })
    }
  }

  return { nodes: updatedNodes, edges: updatedEdges }
}
