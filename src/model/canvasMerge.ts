import type { CanvasSnapshotV2 } from './project.ts'

export interface CanvasMergeConflict { path: string; base: unknown; local: unknown; remote: unknown }
export interface CanvasMergeResult { canvas: CanvasSnapshotV2; conflicts: CanvasMergeConflict[] }

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i]))
  if (record(a) && record(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].every(key => equal(a[key], b[key]))
  }
  return false
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

/** A conflict keeps the local value visible; its remote value is retained separately. */
export function mergeCanvasSnapshots(base: CanvasSnapshotV2, local: CanvasSnapshotV2, remote: CanvasSnapshotV2): CanvasMergeResult {
  if (base.canvasId !== local.canvasId || base.canvasId !== remote.canvasId || base.projectId !== remote.projectId || base.projectId !== local.projectId) {
    throw new Error('画布或项目已改变，无法合并后台更新')
  }
  const conflicts: CanvasMergeConflict[] = []
  const merge = (before: unknown, ours: unknown, theirs: unknown, path: string): unknown => {
    if (equal(ours, theirs) || equal(before, theirs)) return ours
    if (equal(before, ours)) return theirs
    if (record(before) && record(ours) && record(theirs)) {
      return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(ours), ...Object.keys(theirs)])]
        .map(key => [key, merge(before[key], ours[key], theirs[key], path ? `${path}.${key}` : key)]).filter(([, value]) => value !== undefined))
    }
    conflicts.push({ path, base: structuredClone(before), local: structuredClone(ours), remote: structuredClone(theirs) })
    return ours
  }
  const entities = <T extends { id: string }>(before: T[], ours: T[], theirs: T[], path: string): T[] => {
    const a = new Map(before.map(item => [item.id, item])), b = new Map(ours.map(item => [item.id, item])), c = new Map(theirs.map(item => [item.id, item]))
    // Preserve local ordering unless only the remote reordered existing objects.
    const sharedOrder = (items: T[]) => items.filter(item => a.has(item.id) && b.has(item.id) && c.has(item.id)).map(item => item.id)
    const order = equal(sharedOrder(before), sharedOrder(ours)) ? [...theirs, ...ours] : [...ours, ...theirs]
    return [...new Set(order.map(item => item.id))].flatMap(id => {
      const value = merge(a.get(id), b.get(id), c.get(id), `${path}.${id}`)
      return value === undefined ? [] : [value as T]
    })
  }
  const nodes = entities(base.nodes, local.nodes, remote.nodes, 'nodes')
  const edges = entities(base.edges, local.edges, remote.edges, 'edges')
  const canvas = { ...local, name: merge(base.name, local.name, remote.name, 'name') as string, nodes, edges }
  // A concurrent deletion must not produce a dangling edge that fails loading.
  const ids = new Set(nodes.map(node => node.id))
  canvas.edges = edges.filter(edge => {
    if (ids.has(edge.source) && ids.has(edge.target)) return true
    conflicts.push({ path: `edges.${edge.id}`, base: base.edges.find(item => item.id === edge.id), local: local.edges.find(item => item.id === edge.id), remote: remote.edges.find(item => item.id === edge.id) })
    return false
  })
  return { canvas, conflicts }
}
