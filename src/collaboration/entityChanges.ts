import type { CanvasEdge, CanvasNode, CanvasSnapshotV2 } from '../model/project.ts'

export interface CanvasEntityChangeSet {
  origin: 'local' | 'remote'
  name?: string
  nodes: {
    upserted: CanvasNode[]
    removed: string[]
  }
  edges: {
    upserted: CanvasEdge[]
    removed: string[]
  }
  nodeOrder?: string[]
  edgeOrder?: string[]
}

const sameEntity = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right)

function changedEntities<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
): { upserted: T[]; removed: string[]; order?: string[] } {
  const previousById = new Map(previous.map((entity) => [entity.id, entity]))
  const nextIds = new Set(next.map((entity) => entity.id))
  const upserted = next.filter((entity) => {
    const before = previousById.get(entity.id)
    return !before || !sameEntity(before, entity)
  })
  const removed = previous.flatMap((entity) => nextIds.has(entity.id) ? [] : [entity.id])
  const previousOrder = previous.map((entity) => entity.id)
  const nextOrder = next.map((entity) => entity.id)
  const order = sameEntity(previousOrder, nextOrder) ? undefined : nextOrder
  return { upserted, removed, ...(order ? { order } : {}) }
}

export function diffCanvasEntities(
  previous: CanvasSnapshotV2,
  next: CanvasSnapshotV2,
  origin: CanvasEntityChangeSet['origin'],
): CanvasEntityChangeSet {
  const nodes = changedEntities(previous.nodes, next.nodes)
  const edges = changedEntities(previous.edges, next.edges)
  return {
    origin,
    ...(previous.name !== next.name ? { name: next.name } : {}),
    nodes: { upserted: nodes.upserted, removed: nodes.removed },
    edges: { upserted: edges.upserted, removed: edges.removed },
    ...(nodes.order ? { nodeOrder: nodes.order } : {}),
    ...(edges.order ? { edgeOrder: edges.order } : {}),
  }
}

export function hasCanvasEntityChanges(changes: CanvasEntityChangeSet): boolean {
  return changes.name !== undefined ||
    changes.nodes.upserted.length > 0 || changes.nodes.removed.length > 0 ||
    changes.edges.upserted.length > 0 || changes.edges.removed.length > 0 ||
    Boolean(changes.nodeOrder || changes.edgeOrder)
}
