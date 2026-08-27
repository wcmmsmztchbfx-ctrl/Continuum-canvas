import type { CanvasEdge, CanvasNode } from '../model/project'

export interface LineageTreeNode {
  id: string
  node: CanvasNode
  depth: number
  children: LineageTreeNode[]
  parentIds: string[]
  prompt?: string
  generationStatus?: string
  mediaType: 'image' | 'video' | 'text' | 'frame' | 'shape' | 'path' | 'group' | 'other'
}

export interface LineageGraphResult {
  trees: LineageTreeNode[]
  allNodeCount: number
  connectedNodeCount: number
  nodeMap: Map<string, CanvasNode>
  parentMap: Map<string, string[]>
  childrenMap: Map<string, string[]>
}

export function extractNodePrompt(node: CanvasNode): string | undefined {
  if (node.type === 'text') {
    return node.data.text || undefined
  }
  if (node.type === 'image' || node.type === 'video') {
    return node.data.generation?.prompt || node.data.promptDraft || undefined
  }
  return undefined
}

export function extractNodeGenerationStatus(node: CanvasNode): string | undefined {
  if (node.type === 'image' || node.type === 'video') {
    return node.data.generation?.status
  }
  return undefined
}

function getNodeMediaType(node: CanvasNode): LineageTreeNode['mediaType'] {
  if (node.type === 'image') return 'image'
  if (node.type === 'video') return 'video'
  if (node.type === 'text') return 'text'
  if (node.type === 'frame') return 'frame'
  if (node.type === 'shape') return 'shape'
  if (node.type === 'path') return 'path'
  if (node.type === 'group') return 'group'
  return 'other'
}

/**
 * Builds a structured AI lineage tree from canvas nodes and edges.
 * Correctly identifies parent-child generation and reference causality.
 */
export function buildCanvasLineage(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
): LineageGraphResult {
  const nodeMap = new Map<string, CanvasNode>()
  for (const node of nodes) {
    nodeMap.set(node.id, node)
  }

  const parentMap = new Map<string, Set<string>>()
  const childrenMap = new Map<string, Set<string>>()

  for (const node of nodes) {
    parentMap.set(node.id, new Set())
    childrenMap.set(node.id, new Set())
  }

  // 1. Traverse edges
  for (const edge of edges) {
    if (nodeMap.has(edge.source) && nodeMap.has(edge.target) && edge.source !== edge.target) {
      parentMap.get(edge.target)?.add(edge.source)
      childrenMap.get(edge.source)?.add(edge.target)
    }
  }

  // 2. Traverse generation sourceNodeId & frame capture source
  for (const node of nodes) {
    if (node.type === 'image' || node.type === 'video') {
      const genSourceId = node.data.generation?.sourceNodeId
      if (genSourceId && nodeMap.has(genSourceId) && genSourceId !== node.id) {
        parentMap.get(node.id)?.add(genSourceId)
        childrenMap.get(genSourceId)?.add(node.id)
      }
    }

    if (node.type === 'image') {
      const frameSourceId = node.data.source?.nodeId
      if (frameSourceId && nodeMap.has(frameSourceId) && frameSourceId !== node.id) {
        parentMap.get(node.id)?.add(frameSourceId)
        childrenMap.get(frameSourceId)?.add(node.id)
      }
    }
  }

  // Helper to build recursive tree with cycle guard
  const buildTree = (
    nodeId: string,
    depth: number,
    visitedInPath: Set<string>,
  ): LineageTreeNode | null => {
    const node = nodeMap.get(nodeId)
    if (!node || visitedInPath.has(nodeId)) return null

    const nextPath = new Set(visitedInPath)
    nextPath.add(nodeId)

    const childIds = [...(childrenMap.get(nodeId) ?? [])]
    const children: LineageTreeNode[] = []

    for (const childId of childIds) {
      const childTree = buildTree(childId, depth + 1, nextPath)
      if (childTree) children.push(childTree)
    }

    const parents = [...(parentMap.get(nodeId) ?? [])]

    return {
      id: node.id,
      node,
      depth,
      children,
      parentIds: parents,
      prompt: extractNodePrompt(node),
      generationStatus: extractNodeGenerationStatus(node),
      mediaType: getNodeMediaType(node),
    }
  }

  // Identify roots: Nodes with no parents
  const rootIds: string[] = []
  const nonRoots = new Set<string>()

  for (const [nodeId, parents] of parentMap.entries()) {
    if (parents.size === 0) {
      rootIds.push(nodeId)
    } else {
      nonRoots.add(nodeId)
    }
  }

  // If there are disconnected nodes or cycles where every node has a parent, pick unvisited
  const visitedGlobal = new Set<string>()
  const trees: LineageTreeNode[] = []

  const appendTree = (id: string) => {
    if (visitedGlobal.has(id)) return
    const tree = buildTree(id, 0, new Set())
    if (tree) {
      trees.push(tree)
      const markVisited = (item: LineageTreeNode) => {
        visitedGlobal.add(item.id)
        for (const c of item.children) markVisited(c)
      }
      markVisited(tree)
    }
  }

  for (const rootId of rootIds) {
    appendTree(rootId)
  }

  // Catch any remaining nodes in cycles
  for (const node of nodes) {
    if (!visitedGlobal.has(node.id)) {
      appendTree(node.id)
    }
  }

  // Sort trees: trees with multiple children first, then by node name
  trees.sort((a, b) => {
    if (b.children.length !== a.children.length) {
      return b.children.length - a.children.length
    }
    return a.node.name.localeCompare(b.node.name)
  })

  const parentMapPlain = new Map<string, string[]>()
  const childrenMapPlain = new Map<string, string[]>()
  for (const [k, v] of parentMap.entries()) parentMapPlain.set(k, [...v])
  for (const [k, v] of childrenMap.entries()) childrenMapPlain.set(k, [...v])

  return {
    trees,
    allNodeCount: nodes.length,
    connectedNodeCount: visitedGlobal.size,
    nodeMap,
    parentMap: parentMapPlain,
    childrenMap: childrenMapPlain,
  }
}

/**
 * Gets all upstream ancestors of a specific node.
 */
export function getNodeAncestors(
  targetNodeId: string,
  parentMap: Map<string, string[]>,
  nodeMap: Map<string, CanvasNode>,
): CanvasNode[] {
  const result: CanvasNode[] = []
  const visited = new Set<string>()
  const queue = [...(parentMap.get(targetNodeId) ?? [])]

  while (queue.length > 0) {
    const currentId = queue.shift()!
    if (visited.has(currentId)) continue
    visited.add(currentId)
    const node = nodeMap.get(currentId)
    if (node) {
      result.push(node)
      const parents = parentMap.get(currentId) ?? []
      for (const p of parents) {
        if (!visited.has(p)) queue.push(p)
      }
    }
  }

  return result
}

/**
 * Gets all downstream descendants of a specific node.
 */
export function getNodeDescendants(
  targetNodeId: string,
  childrenMap: Map<string, string[]>,
  nodeMap: Map<string, CanvasNode>,
): CanvasNode[] {
  const result: CanvasNode[] = []
  const visited = new Set<string>()
  const queue = [...(childrenMap.get(targetNodeId) ?? [])]

  while (queue.length > 0) {
    const currentId = queue.shift()!
    if (visited.has(currentId)) continue
    visited.add(currentId)
    const node = nodeMap.get(currentId)
    if (node) {
      result.push(node)
      const children = childrenMap.get(currentId) ?? []
      for (const c of children) {
        if (!visited.has(c)) queue.push(c)
      }
    }
  }

  return result
}
