import type { CanvasFlowNode } from './mapping'

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left === 'function' && typeof right === 'function') return true
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

export function mergeStableNodes(
  current: CanvasFlowNode[],
  incoming: CanvasFlowNode[],
): CanvasFlowNode[] {
  const currentById = new Map(current.map((node) => [node.id, node]))
  let unchanged = current.length === incoming.length
  const merged = incoming.map((node, index) => {
    const existing = currentById.get(node.id)
    const next = existing && sameValue(existing, node) ? existing : node
    if (next !== current[index]) unchanged = false
    return next
  })
  return unchanged ? current : merged
}
