import type { CanvasFlowEdge } from './mapping'

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false
  }
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

export function mergeStableEdges(
  current: CanvasFlowEdge[],
  incoming: CanvasFlowEdge[],
): CanvasFlowEdge[] {
  const currentById = new Map(current.map((edge) => [edge.id, edge]))
  let unchanged = current.length === incoming.length
  const merged = incoming.map((edge, index) => {
    const existing = currentById.get(edge.id)
    const next = existing && sameValue(existing, edge) ? existing : edge
    if (next !== current[index]) unchanged = false
    return next
  })
  return unchanged ? current : merged
}
