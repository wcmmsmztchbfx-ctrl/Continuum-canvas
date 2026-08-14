import type { CanvasFlowEdge, CanvasFlowNode } from './mapping'

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left === 'function' && typeof right === 'function') return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]))
}

export function stabilizeProjectedNodes(
  previous: readonly CanvasFlowNode[],
  incoming: readonly CanvasFlowNode[],
): CanvasFlowNode[] {
  const previousById = new Map(previous.map((node) => [node.id, node]))
  let unchanged = previous.length === incoming.length
  const next = incoming.map((node, index) => {
    const existing = previousById.get(node.id)
    const stable = existing && sameValue(existing, node) ? existing : node
    if (stable !== previous[index]) unchanged = false
    return stable
  })
  return unchanged ? previous as CanvasFlowNode[] : next
}

export function stabilizeProjectedEdges(
  previous: readonly CanvasFlowEdge[],
  incoming: readonly CanvasFlowEdge[],
): CanvasFlowEdge[] {
  const previousById = new Map(previous.map((edge) => [edge.id, edge]))
  let unchanged = previous.length === incoming.length
  const next = incoming.map((edge, index) => {
    const existing = previousById.get(edge.id)
    const stable = existing && sameValue(existing, edge) ? existing : edge
    if (stable !== previous[index]) unchanged = false
    return stable
  })
  return unchanged ? previous as CanvasFlowEdge[] : next
}
