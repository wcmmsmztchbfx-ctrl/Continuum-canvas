import type { CanvasNode, CanvasEdge, MediaGeneration, OrderedReference } from './project.ts'
export interface CanvasContentIndex {
  nodeById: ReadonlyMap<string, CanvasNode>
  orderById: ReadonlyMap<string, number>
  incomingByTarget: ReadonlyMap<string, readonly CanvasEdge[]>
  outgoingBySource: ReadonlyMap<string, readonly CanvasEdge[]>
  childrenByParent: ReadonlyMap<string, readonly CanvasNode[]>
  generationsBySource: ReadonlyMap<string, readonly MediaGeneration[]>
  orderedReferences(targetId: string): readonly OrderedReference[]
}
const cache = new WeakMap<readonly CanvasNode[], WeakMap<readonly CanvasEdge[], CanvasContentIndex>>()
const emptyReferences: readonly OrderedReference[] = []
export function createCanvasContentIndex(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]): CanvasContentIndex {
  let byEdges = cache.get(nodes)
  if (!byEdges) { byEdges = new WeakMap(); cache.set(nodes, byEdges) }
  const existing = byEdges.get(edges)
  if (existing) return existing
  const nodeById = new Map<string, CanvasNode>()
  const orderById = new Map<string, number>()
  const childrenByParent = new Map<string, CanvasNode[]>()
  const generationsBySource = new Map<string, MediaGeneration[]>()
  const incomingByTarget = new Map<string, CanvasEdge[]>()
  const outgoingBySource = new Map<string, CanvasEdge[]>()
  const references = new Map<string, OrderedReference[]>()
  for (const node of nodes) {
    orderById.set(node.id, orderById.size)
    nodeById.set(node.id, node)
    const parent = node.parentId ?? ''
    let children = childrenByParent.get(parent)
    if (!children) { children = []; childrenByParent.set(parent, children) }
    children.push(node)
    if (node.type === 'image' || node.type === 'video') {
      const generation = node.data.generation
      if (generation?.sourceNodeId) {
        let outputs = generationsBySource.get(generation.sourceNodeId)
        if (!outputs) { outputs = []; generationsBySource.set(generation.sourceNodeId, outputs) }
        outputs.push(generation)
      }
    }
  }
  for (const outputs of generationsBySource.values()) outputs.sort((a, b) => (a.outputIndex ?? 0) - (b.outputIndex ?? 0))
  for (const edge of edges) {
    let incoming = incomingByTarget.get(edge.target)
    if (!incoming) { incoming = []; incomingByTarget.set(edge.target, incoming) }
    incoming.push(edge)
    let outgoing = outgoingBySource.get(edge.source)
    if (!outgoing) { outgoing = []; outgoingBySource.set(edge.source, outgoing) }
    outgoing.push(edge)
    const node = nodeById.get(edge.source)
    if (node && edge.relation === 'reference' && edge.referenceAlias !== undefined) {
      let entries = references.get(edge.target)
      if (!entries) { entries = []; references.set(edge.target, entries) }
      entries.push({ edge: edge as OrderedReference['edge'], node })
    }
  }
  for (const entries of references.values()) entries.sort((a, b) => a.edge.referenceAlias - b.edge.referenceAlias || a.edge.id.localeCompare(b.edge.id))
  const result = { nodeById, orderById, childrenByParent, incomingByTarget, outgoingBySource, generationsBySource,
    orderedReferences: (id: string) => references.get(id) ?? emptyReferences }
  byEdges.set(edges, result)
  return result
}
