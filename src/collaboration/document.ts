import * as Y from 'yjs'

import {
  COLLABORATIVE_CANVAS_DOCUMENT_VERSION,
} from '../contracts/collaboration.ts'
import type { CollaborativeCanvasDocumentV1 } from '../contracts/collaboration.ts'
import {
  parseCanvasSnapshot,
} from '../model/project.ts'
import type {
  CanvasEdge,
  CanvasComment,
  CanvasNode,
  CanvasSnapshotV2,
  ProjectSnapshotV1,
} from '../model/project.ts'
import type { CanvasEntityChangeSet } from './entityChanges.ts'

const META_KEY = 'meta'
const VIEWPORT_KEY = 'viewport'
const NODES_KEY = 'nodes'
const EDGES_KEY = 'edges'
const COMMENTS_KEY = 'comments'
const NODE_TOMBSTONES_KEY = 'nodeTombstones'
const EDGE_TOMBSTONES_KEY = 'edgeTombstones'
const NODE_DELETION_BACKUPS_KEY = 'nodeDeletionBackups'
const EDGE_DELETION_BACKUPS_KEY = 'edgeDeletionBackups'
const NODE_ORDER_KEY = 'nodeOrder'
const EDGE_ORDER_KEY = 'edgeOrder'
const COMMENT_ORDER_KEY = 'commentOrder'
const ORDER_FIELD = '__collaborationOrder'
const MAP_ROOT_KEYS = [
  META_KEY, VIEWPORT_KEY, NODES_KEY, EDGES_KEY, COMMENTS_KEY,
  NODE_TOMBSTONES_KEY, EDGE_TOMBSTONES_KEY,
  NODE_DELETION_BACKUPS_KEY, EDGE_DELETION_BACKUPS_KEY,
] as const
const ARRAY_ROOT_KEYS = [NODE_ORDER_KEY, EDGE_ORDER_KEY, COMMENT_ORDER_KEY] as const
const COLLABORATIVE_ROOT_KEYS = new Set<string>([...MAP_ROOT_KEYS, ...ARRAY_ROOT_KEYS])

export const COLLABORATIVE_DECODE_LIMITS = Object.freeze({
  maxDepth: 32,
  maxEntries: 100_000,
  maxArrayLength: 20_000,
})

type SnapshotInput = ProjectSnapshotV1 | CanvasSnapshotV2
type YRecord = Y.Map<unknown>

interface DecodeBudget {
  entries: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function usesCollaborativeText(path: readonly string[], key: string): boolean {
  if (key === 'prompt' || key === 'promptDraft') return true
  return key === 'text' && path.at(-1) === 'data'
}

function encodeValue(
  value: unknown,
  path: readonly string[],
  key: string,
): unknown {
  if (typeof value === 'string' && usesCollaborativeText(path, key)) {
    const text = new Y.Text()
    text.insert(0, value)
    return text
  }
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>()
    array.insert(0, value.map((item) => encodeValue(item, [...path, key], '[]')))
    return array
  }
  if (isRecord(value)) {
    return encodeRecord(value, [...path, key])
  }
  return value
}

function encodeRecord(
  value: Record<string, unknown>,
  path: readonly string[],
): YRecord {
  const map = new Y.Map<unknown>()
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) map.set(key, encodeValue(item, path, key))
  }
  return map
}

function consumeDecodeEntries(budget: DecodeBudget, count: number): void {
  budget.entries += count
  if (budget.entries > COLLABORATIVE_DECODE_LIMITS.maxEntries) {
    throw new Error(
      `协同画布文档解码条目数超过最大限制 ${COLLABORATIVE_DECODE_LIMITS.maxEntries} (Collaborative canvas document exceeds maximum decoded entries of ${COLLABORATIVE_DECODE_LIMITS.maxEntries})`,
    )
  }
}

function decodeValue(
  value: unknown,
  budget: DecodeBudget,
  depth: number,
): unknown {
  if (depth > COLLABORATIVE_DECODE_LIMITS.maxDepth) {
    throw new Error(
      `协同画布文档嵌套深度超过最大限制 ${COLLABORATIVE_DECODE_LIMITS.maxDepth} (Collaborative canvas document exceeds maximum decode depth of ${COLLABORATIVE_DECODE_LIMITS.maxDepth})`,
    )
  }
  if (value instanceof Y.Text) return value.toString()
  if (value instanceof Y.Array) {
    if (value.length > COLLABORATIVE_DECODE_LIMITS.maxArrayLength) {
      throw new Error(
        `协同画布文档数组长度超过最大限制 ${COLLABORATIVE_DECODE_LIMITS.maxArrayLength} (Collaborative canvas document exceeds maximum array length of ${COLLABORATIVE_DECODE_LIMITS.maxArrayLength})`,
      )
    }
    consumeDecodeEntries(budget, value.length)
    return value
      .toArray()
      .map((item) => decodeValue(item, budget, depth + 1))
  }
  if (value instanceof Y.Map) {
    consumeDecodeEntries(budget, value.size)
    const record: Record<string, unknown> = {}
    for (const [key, item] of value.entries()) {
      record[key] = decodeValue(item, budget, depth + 1)
    }
    return record
  }
  return value
}

function decodeEntity<T extends { id: string }>(
  value: unknown,
): T | undefined {
  if (!(value instanceof Y.Map)) return undefined
  const decoded = decodeValue(value, { entries: 0 }, 0)
  if (!isRecord(decoded)) return undefined
  delete decoded[ORDER_FIELD]
  return decoded as T
}

function hasNonEmptyCollaborativeRoots(doc: Y.Doc): boolean {
  for (const key of MAP_ROOT_KEYS) {
    const root = doc.share.get(key)
    if (root && (!(root instanceof Y.Map) || root.size > 0)) return true
  }
  for (const key of ARRAY_ROOT_KEYS) {
    const root = doc.share.get(key)
    if (root && (!(root instanceof Y.Array) || root.length > 0)) return true
  }
  return false
}

function registerCollaborativeRoots(doc: Y.Doc): void {
  for (const key of MAP_ROOT_KEYS) doc.getMap(key)
  for (const key of ARRAY_ROOT_KEYS) doc.getArray(key)
}

function assertCollaborativeRootStructure(doc: Y.Doc): void {
  for (const [key, root] of doc.share.entries()) {
    if (!COLLABORATIVE_ROOT_KEYS.has(key)) {
      throw new Error(`协同画布文档包含无效根节点: ${key} (Invalid collaborative canvas document root: ${key})`)
    }
    if (MAP_ROOT_KEYS.includes(key as (typeof MAP_ROOT_KEYS)[number]) && !(root instanceof Y.Map)) {
      throw new Error(`协同画布文档 Map 根节点类型无效: ${key} (Invalid collaborative canvas document map root: ${key})`)
    }
    if (ARRAY_ROOT_KEYS.includes(key as (typeof ARRAY_ROOT_KEYS)[number]) && !(root instanceof Y.Array)) {
      throw new Error(`协同画布文档 Array 根节点类型无效: ${key} (Invalid collaborative canvas document array root: ${key})`)
    }
  }
}

function initializeDocument(doc: Y.Doc, snapshot: SnapshotInput): void {
  const normalized = parseCanvasSnapshot(JSON.stringify(snapshot))
  const meta = doc.getMap<unknown>(META_KEY)
  const viewport = doc.getMap<unknown>(VIEWPORT_KEY)
  const nodes = doc.getMap<YRecord>(NODES_KEY)
  const edges = doc.getMap<YRecord>(EDGES_KEY)
  const comments = doc.getMap<YRecord>(COMMENTS_KEY)
  const nodeOrder = doc.getArray<string>(NODE_ORDER_KEY)
  const edgeOrder = doc.getArray<string>(EDGE_ORDER_KEY)
  const commentOrder = doc.getArray<string>(COMMENT_ORDER_KEY)

  doc.transact(() => {
    meta.set('version', COLLABORATIVE_CANVAS_DOCUMENT_VERSION)
    meta.set('canvasId', normalized.canvasId)
    meta.set('projectId', normalized.projectId)
    meta.set('name', normalized.name)
    for (const [key, value] of Object.entries(normalized.viewport)) {
      viewport.set(key, value)
    }
    for (const node of normalized.nodes) {
      const record = encodeRecord(node as unknown as Record<string, unknown>, ['node'])
      record.set(ORDER_FIELD, normalized.nodes.indexOf(node))
      nodes.set(node.id, record)
    }
    for (const edge of normalized.edges) {
      const record = encodeRecord(edge as unknown as Record<string, unknown>, ['edge'])
      record.set(ORDER_FIELD, normalized.edges.indexOf(edge))
      edges.set(edge.id, record)
    }
    for (const comment of normalized.comments) {
      const record = encodeRecord(comment as unknown as Record<string, unknown>, ['comment'])
      record.set(ORDER_FIELD, normalized.comments.indexOf(comment))
      comments.set(comment.id, record)
    }
    nodeOrder.insert(0, normalized.nodes.map((node) => node.id))
    edgeOrder.insert(0, normalized.edges.map((edge) => edge.id))
    commentOrder.insert(0, normalized.comments.map((comment) => comment.id))
  }, null)
}

function syncText(target: Y.Text, value: string): void {
  const current = target.toString()
  if (current === value) return
  let prefix = 0
  const sharedLength = Math.min(current.length, value.length)
  while (prefix < sharedLength && current[prefix] === value[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < sharedLength - prefix &&
    current[current.length - 1 - suffix] === value[value.length - 1 - suffix]
  ) suffix += 1
  const deleteLength = current.length - prefix - suffix
  if (deleteLength > 0) target.delete(prefix, deleteLength)
  const insertion = value.slice(prefix, value.length - suffix)
  if (insertion) target.insert(prefix, insertion)
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function applyTextChange(target: Y.Text, previous: string, next: string): void {
  if (previous === next) return
  let prefix = 0
  const sharedLength = Math.min(previous.length, next.length)
  while (prefix < sharedLength && previous[prefix] === next[prefix]) prefix += 1
  let suffix = 0
  while (suffix < sharedLength - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1
  const removed = previous.length - prefix - suffix
  if (removed > 0) target.delete(prefix, removed)
  const inserted = next.slice(prefix, next.length - suffix)
  if (inserted) target.insert(prefix, inserted)
}

function applyRecordChange(
  target: YRecord,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: readonly string[],
): void {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  for (const key of keys) {
    const before = previous[key]
    const after = next[key]
    if (sameJson(before, after)) continue
    if (after === undefined) { target.delete(key); continue }
    const current = target.get(key)
    if (typeof before === 'string' && typeof after === 'string' && usesCollaborativeText(path, key) && current instanceof Y.Text) {
      applyTextChange(current, before, after)
    } else if (isRecord(before) && isRecord(after) && current instanceof Y.Map) {
      applyRecordChange(current, before, after, [...path, key])
    } else {
      target.set(key, encodeValue(after, path, key))
    }
  }
}

function applyOrderChange(
  values: Y.Map<YRecord>,
  orderArray: Y.Array<string> | undefined,
  previous: readonly string[],
  next: readonly string[] | undefined,
): void {
  if (!next || sameJson(previous, next)) return
  next.forEach((id, index) => values.get(id)?.set(ORDER_FIELD, index))
  if (orderArray) {
    if (orderArray.length > 0) orderArray.delete(0, orderArray.length)
    if (next.length > 0) orderArray.insert(0, [...next])
  }
}

function decodedForComparison(value: unknown): unknown {
  return decodeValue(value, { entries: 0 }, 0)
}

function syncArray(target: Y.Array<unknown>, value: readonly unknown[], path: readonly string[]): void {
  const current = decodedForComparison(target)
  if (JSON.stringify(current) === JSON.stringify(value)) return
  if (target.length > 0) target.delete(0, target.length)
  if (value.length > 0) {
    target.insert(0, value.map((item) => encodeValue(item, path, '[]')))
  }
}

function syncRecord(target: YRecord, value: Record<string, unknown>, path: readonly string[]): void {
  for (const key of [...target.keys()]) {
    if (value[key] === undefined) target.delete(key)
  }
  for (const [key, next] of Object.entries(value)) {
    if (next === undefined) continue
    const current = target.get(key)
    if (typeof next === 'string' && usesCollaborativeText(path, key)) {
      if (current instanceof Y.Text) syncText(current, next)
      else target.set(key, encodeValue(next, path, key))
      continue
    }
    if (Array.isArray(next)) {
      if (current instanceof Y.Array) syncArray(current, next, [...path, key])
      else target.set(key, encodeValue(next, path, key))
      continue
    }
    if (isRecord(next)) {
      if (current instanceof Y.Map) syncRecord(current, next, [...path, key])
      else target.set(key, encodeRecord(next, [...path, key]))
      continue
    }
    if (!Object.is(current, next)) target.set(key, next)
  }
}

function syncOrderedRecords<T extends { id: string }>(
  values: Y.Map<YRecord>,
  records: readonly T[],
  path: readonly string[],
): void {
  const ids = new Set(records.map((record) => record.id))
  for (const id of [...values.keys()]) {
    if (!ids.has(id)) values.delete(id)
  }
  records.forEach((record, index) => {
    const encoded = record as unknown as Record<string, unknown>
    const current = values.get(record.id)
    if (current instanceof Y.Map) syncRecord(current, encoded, path)
    else values.set(record.id, encodeRecord(encoded, path))
    values.get(record.id)?.set(ORDER_FIELD, index)
  })
}

export function applyCollaborativeCanvasSnapshot(
  collaborative: Pick<CollaborativeCanvasDocumentV1, 'doc'>,
  snapshot: SnapshotInput,
  options: { includeViewport?: boolean } = {},
): void {
  const normalized = parseCanvasSnapshot(JSON.stringify(snapshot))
  const { doc } = collaborative
  const meta = doc.getMap<unknown>(META_KEY)
  meta.set('version', COLLABORATIVE_CANVAS_DOCUMENT_VERSION)
  meta.set('canvasId', normalized.canvasId)
  meta.set('projectId', normalized.projectId)
  meta.set('name', normalized.name)
  if (options.includeViewport !== false) {
    syncRecord(
      doc.getMap<unknown>(VIEWPORT_KEY),
      normalized.viewport as unknown as Record<string, unknown>,
      ['viewport'],
    )
  }
  syncOrderedRecords(
    doc.getMap<YRecord>(NODES_KEY),
    normalized.nodes,
    ['node'],
  )
  syncOrderedRecords(
    doc.getMap<YRecord>(EDGES_KEY),
    normalized.edges,
    ['edge'],
  )
  syncOrderedRecords(doc.getMap<YRecord>(COMMENTS_KEY), normalized.comments, ['comment'])
}

export function applyCollaborativeSnapshotChange(
  collaborative: Pick<CollaborativeCanvasDocumentV1, 'doc'>,
  previousSnapshot: SnapshotInput,
  nextSnapshot: SnapshotInput,
): void {
  const previous = parseCanvasSnapshot(JSON.stringify(previousSnapshot))
  const next = parseCanvasSnapshot(JSON.stringify(nextSnapshot))
  if (previous.canvasId !== next.canvasId || previous.projectId !== next.projectId) {
    throw new Error('Collaborative snapshot changes must stay within one canvas')
  }
  const { doc } = collaborative
  if (previous.name !== next.name) doc.getMap<unknown>(META_KEY).set('name', next.name)
  const nodes = doc.getMap<YRecord>(NODES_KEY)
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]))
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]))
  for (const [id, before] of previousNodes) {
    const after = nextNodes.get(id)
    if (!after) nodes.delete(id)
    else {
      const current = nodes.get(id)
      if (current instanceof Y.Map) applyRecordChange(current, before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, ['node'])
    }
  }
  for (const [id, node] of nextNodes) {
    if (!previousNodes.has(id)) nodes.set(id, encodeRecord(node as unknown as Record<string, unknown>, ['node']))
  }
  const edges = doc.getMap<YRecord>(EDGES_KEY)
  const previousEdges = new Map(previous.edges.map((edge) => [edge.id, edge]))
  const nextEdges = new Map(next.edges.map((edge) => [edge.id, edge]))
  for (const [id, before] of previousEdges) {
    const after = nextEdges.get(id)
    if (!after) edges.delete(id)
    else {
      const current = edges.get(id)
      if (current instanceof Y.Map) applyRecordChange(current, before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, ['edge'])
    }
  }
  for (const [id, edge] of nextEdges) {
    if (!previousEdges.has(id)) edges.set(id, encodeRecord(edge as unknown as Record<string, unknown>, ['edge']))
  }
  applyOrderChange(nodes, doc.getArray<string>(NODE_ORDER_KEY), previous.nodes.map((node) => node.id), next.nodes.map((node) => node.id))
  applyOrderChange(edges, doc.getArray<string>(EDGE_ORDER_KEY), previous.edges.map((edge) => edge.id), next.edges.map((edge) => edge.id))
  const comments = doc.getMap<YRecord>(COMMENTS_KEY)
  const previousComments = new Map(previous.comments.map((comment) => [comment.id, comment]))
  const nextComments = new Map(next.comments.map((comment) => [comment.id, comment]))
  for (const [id, before] of previousComments) {
    const after = nextComments.get(id)
    if (!after) comments.delete(id)
    else {
      const current = comments.get(id)
      if (current instanceof Y.Map) applyRecordChange(current, before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, ['comment'])
    }
  }
  for (const [id, comment] of nextComments) if (!previousComments.has(id)) comments.set(id, encodeRecord(comment as unknown as Record<string, unknown>, ['comment']))
  applyOrderChange(
    comments,
    doc.getArray<string>(COMMENT_ORDER_KEY),
    (previous.comments ?? []).map((comment) => comment.id),
    (next.comments ?? []).map((comment) => comment.id),
  )
}

export function applyCollaborativeEntityChanges(
  collaborative: Pick<CollaborativeCanvasDocumentV1, 'doc'>,
  changes: CanvasEntityChangeSet,
): void {
  const { doc } = collaborative
  if (changes.name !== undefined) doc.getMap<unknown>(META_KEY).set('name', changes.name)

  const nodes = doc.getMap<YRecord>(NODES_KEY)
  const nodeTombstones = doc.getMap<boolean>(NODE_TOMBSTONES_KEY)
  const nodeDeletionBackups = doc.getMap<string>(NODE_DELETION_BACKUPS_KEY)
  for (const id of changes.nodes.removed) {
    const current = decodeEntity<CanvasNode>(nodes.get(id))
    if (current && !nodeDeletionBackups.has(id)) {
      nodeDeletionBackups.set(id, JSON.stringify(current))
    }
    nodes.delete(id)
    nodeTombstones.set(id, true)
  }
  if (nodeDeletionBackups.size > 50) {
    const keys = Array.from(nodeDeletionBackups.keys())
    for (let i = 0; i < keys.length - 50; i++) {
      nodeDeletionBackups.delete(keys[i]!)
    }
  }
  for (const node of changes.nodes.upserted) {
    if (nodeTombstones.has(node.id)) continue
    const current = nodes.get(node.id)
    if (current instanceof Y.Map) syncRecord(current, node as unknown as Record<string, unknown>, ['node'])
    else nodes.set(node.id, encodeRecord(node as unknown as Record<string, unknown>, ['node']))
  }
  if (changes.nodeOrder) applyOrderChange(nodes, doc.getArray<string>(NODE_ORDER_KEY), [], changes.nodeOrder)

  const edges = doc.getMap<YRecord>(EDGES_KEY)
  const edgeTombstones = doc.getMap<boolean>(EDGE_TOMBSTONES_KEY)
  const edgeDeletionBackups = doc.getMap<string>(EDGE_DELETION_BACKUPS_KEY)
  for (const id of changes.edges.removed) {
    const current = decodeEntity<CanvasEdge>(edges.get(id))
    if (current && !edgeDeletionBackups.has(id)) {
      edgeDeletionBackups.set(id, JSON.stringify(current))
    }
    edges.delete(id)
    edgeTombstones.set(id, true)
  }
  if (edgeDeletionBackups.size > 50) {
    const keys = Array.from(edgeDeletionBackups.keys())
    for (let i = 0; i < keys.length - 50; i++) {
      edgeDeletionBackups.delete(keys[i]!)
    }
  }
  for (const edge of changes.edges.upserted) {
    if (edgeTombstones.has(edge.id)) continue
    const current = edges.get(edge.id)
    if (current instanceof Y.Map) syncRecord(current, edge as unknown as Record<string, unknown>, ['edge'])
    else edges.set(edge.id, encodeRecord(edge as unknown as Record<string, unknown>, ['edge']))
  }
  if (changes.edgeOrder) applyOrderChange(edges, doc.getArray<string>(EDGE_ORDER_KEY), [], changes.edgeOrder)

  if (changes.comments || changes.commentOrder) {
    const comments = doc.getMap<YRecord>(COMMENTS_KEY)
    for (const id of changes.comments?.removed ?? []) comments.delete(id)
    for (const comment of changes.comments?.upserted ?? []) {
      const current = comments.get(comment.id)
      if (current instanceof Y.Map) syncRecord(current, comment as unknown as Record<string, unknown>, ['comment'])
      else comments.set(comment.id, encodeRecord(comment as unknown as Record<string, unknown>, ['comment']))
    }
    if (changes.commentOrder) applyOrderChange(comments, doc.getArray<string>(COMMENT_ORDER_KEY), [], changes.commentOrder)
  }
}

function installDeletionUndoRestoration(doc: Y.Doc): () => void {
  let restoring = false
  const restore = (
    kind: 'node' | 'edge',
    event: Y.YMapEvent<boolean>,
  ) => {
    if (restoring) return
    const restoredIds = [...event.changes.keys.entries()]
      .filter(([, change]) => change.action === 'delete')
      .map(([id]) => id)
    if (restoredIds.length === 0) return
    const values = doc.getMap<YRecord>(kind === 'node' ? NODES_KEY : EDGES_KEY)
    const backups = doc.getMap<string>(
      kind === 'node' ? NODE_DELETION_BACKUPS_KEY : EDGE_DELETION_BACKUPS_KEY,
    )
    restoring = true
    try {
      doc.transact(() => {
        for (const id of restoredIds) {
          const serialized = backups.get(id)
          if (!serialized) continue
          const value = JSON.parse(serialized) as Record<string, unknown>
          values.set(id, encodeRecord(value, [kind]))
          backups.delete(id)
        }
      }, { type: 'delete-undo-restoration' })
    } finally {
      restoring = false
    }
  }
  const restoreNodes = (event: Y.YMapEvent<boolean>) => restore('node', event)
  const restoreEdges = (event: Y.YMapEvent<boolean>) => restore('edge', event)
  doc.getMap<boolean>(NODE_TOMBSTONES_KEY).observe(restoreNodes)
  doc.getMap<boolean>(EDGE_TOMBSTONES_KEY).observe(restoreEdges)
  return () => {
    doc.getMap<boolean>(NODE_TOMBSTONES_KEY).unobserve(restoreNodes)
    doc.getMap<boolean>(EDGE_TOMBSTONES_KEY).unobserve(restoreEdges)
  }
}

export function observeCollaborativeEntityChanges(
  collaborative: Pick<CollaborativeCanvasDocumentV1, 'doc'>,
  resolveOrigin: (origin: unknown) => CanvasEntityChangeSet['origin'] | undefined,
  listener: (changes: CanvasEntityChangeSet) => void,
): () => void {
  const { doc } = collaborative
  const nodes = doc.getMap<YRecord>(NODES_KEY)
  const edges = doc.getMap<YRecord>(EDGES_KEY)
  const nodeOrderArray = doc.getArray<string>(NODE_ORDER_KEY)
  const edgeOrderArray = doc.getArray<string>(EDGE_ORDER_KEY)
  const nodeTombstones = doc.getMap<boolean>(NODE_TOMBSTONES_KEY)
  const edgeTombstones = doc.getMap<boolean>(EDGE_TOMBSTONES_KEY)
  const pending = new WeakMap<Y.Transaction, {
    nodeIds: Set<string>
    edgeIds: Set<string>
    nameChanged: boolean
    nodeOrderChanged: boolean
    edgeOrderChanged: boolean
  }>()
  const state = (transaction: Y.Transaction) => {
    const current = pending.get(transaction) ?? {
      nodeIds: new Set<string>(),
      edgeIds: new Set<string>(),
      nameChanged: false,
      nodeOrderChanged: false,
      edgeOrderChanged: false,
    }
    pending.set(transaction, current)
    return current
  }
  const collectEntityIds = (
    kind: 'nodes' | 'edges',
    events: readonly Y.YEvent<any>[],
    transaction: Y.Transaction,
  ) => {
    const ids = kind === 'nodes' ? state(transaction).nodeIds : state(transaction).edgeIds
    for (const event of events) {
      if (event.path.length > 0 && typeof event.path[0] === 'string') ids.add(event.path[0])
      if (event.target === (kind === 'nodes' ? nodes : edges) && event instanceof Y.YMapEvent) {
        for (const id of event.keysChanged) ids.add(id)
      }
      if (event instanceof Y.YMapEvent && event.keysChanged.has(ORDER_FIELD)) {
        if (kind === 'nodes') state(transaction).nodeOrderChanged = true
        if (kind === 'edges') state(transaction).edgeOrderChanged = true
      }
    }
  }
  const collectNodes = (events: Y.YEvent<any>[], transaction: Y.Transaction) => collectEntityIds('nodes', events, transaction)
  const collectEdges = (events: Y.YEvent<any>[], transaction: Y.Transaction) => collectEntityIds('edges', events, transaction)
  const collectNodeOrder = (_event: Y.YArrayEvent<string>, transaction: Y.Transaction) => {
    state(transaction).nodeOrderChanged = true
  }
  const collectEdgeOrder = (_event: Y.YArrayEvent<string>, transaction: Y.Transaction) => {
    state(transaction).edgeOrderChanged = true
  }
  const collectNodeTombstones = (event: Y.YMapEvent<boolean>, transaction: Y.Transaction) => {
    for (const id of event.keysChanged) state(transaction).nodeIds.add(id)
  }
  const collectEdgeTombstones = (event: Y.YMapEvent<boolean>, transaction: Y.Transaction) => {
    for (const id of event.keysChanged) state(transaction).edgeIds.add(id)
  }
  const collectMeta = (event: Y.YMapEvent<unknown>, transaction: Y.Transaction) => {
    if (event.keysChanged.has('name')) state(transaction).nameChanged = true
  }
  const publish = (transaction: Y.Transaction) => {
    const changed = pending.get(transaction)
    const origin = resolveOrigin(transaction.origin)
    if (!changed || !origin) return
    const nodeUpserted: CanvasNode[] = []
    const nodeRemoved: string[] = []
    for (const id of changed.nodeIds) {
      const entity = nodeTombstones.has(id) ? undefined : decodeEntity<CanvasNode>(nodes.get(id))
      if (entity) nodeUpserted.push(entity)
      else nodeRemoved.push(id)
    }
    const edgeUpserted: CanvasEdge[] = []
    const edgeRemoved: string[] = []
    for (const id of changed.edgeIds) {
      const entity = edgeTombstones.has(id) ? undefined : decodeEntity<CanvasEdge>(edges.get(id))
      if (entity) edgeUpserted.push(entity)
      else edgeRemoved.push(id)
    }
    let nodeOrder: string[] | undefined
    if (changed.nodeOrderChanged) {
      nodeOrder = orderedRecords<CanvasNode>(nodes, nodeOrderArray, { entries: 0 })
        .filter((node) => !nodeTombstones.has(node.id))
        .map((node) => node.id)
    }
    let edgeOrder: string[] | undefined
    if (changed.edgeOrderChanged) {
      edgeOrder = orderedRecords<CanvasEdge>(edges, edgeOrderArray, { entries: 0 })
        .filter((edge) => !edgeTombstones.has(edge.id))
        .map((edge) => edge.id)
    }
    listener({
      origin,
      ...(changed.nameChanged ? { name: doc.getMap<unknown>(META_KEY).get('name') as string } : {}),
      nodes: { upserted: nodeUpserted, removed: nodeRemoved },
      edges: { upserted: edgeUpserted, removed: edgeRemoved },
      ...(nodeOrder ? { nodeOrder } : {}),
      ...(edgeOrder ? { edgeOrder } : {}),
    })
  }
  nodes.observeDeep(collectNodes)
  edges.observeDeep(collectEdges)
  nodeOrderArray.observe(collectNodeOrder)
  edgeOrderArray.observe(collectEdgeOrder)
  nodeTombstones.observe(collectNodeTombstones)
  edgeTombstones.observe(collectEdgeTombstones)
  doc.getMap<unknown>(META_KEY).observe(collectMeta)
  doc.on('afterTransaction', publish)
  return () => {
    nodes.unobserveDeep(collectNodes)
    edges.unobserveDeep(collectEdges)
    nodeOrderArray.unobserve(collectNodeOrder)
    edgeOrderArray.unobserve(collectEdgeOrder)
    nodeTombstones.unobserve(collectNodeTombstones)
    edgeTombstones.unobserve(collectEdgeTombstones)
    doc.getMap<unknown>(META_KEY).unobserve(collectMeta)
    doc.off('afterTransaction', publish)
  }
}

function orderedRecords<TRecord>(
  values: Y.Map<YRecord>,
  order: Y.Array<string>,
  budget: DecodeBudget,
): TRecord[] {
  const seen = new Set<string>()
  const result: TRecord[] = []
  const decodedOrder = decodeValue(order, budget, 0)
  if (!Array.isArray(decodedOrder)) {
    throw new Error('Invalid collaborative canvas document order')
  }
  consumeDecodeEntries(budget, values.size)
  const legacyIndex = new Map(decodedOrder.map((id, index) => [id, index]))
  const ids = [...values.keys()].sort((left, right) => {
    const leftRank = values.get(left)?.get(ORDER_FIELD)
    const rightRank = values.get(right)?.get(ORDER_FIELD)
    const leftOrder = typeof leftRank === 'number' ? leftRank : legacyIndex.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = typeof rightRank === 'number' ? rightRank : legacyIndex.get(right) ?? Number.MAX_SAFE_INTEGER
    return leftOrder - rightOrder || (left < right ? -1 : left > right ? 1 : 0)
  })
  for (const id of ids) {
    if (typeof id !== 'string') {
      throw new Error('Invalid collaborative canvas document order')
    }
    const value = values.get(id)
    if (!value || seen.has(id)) continue
    seen.add(id)
    const decoded = decodeValue(value, budget, 1)
    if (!isRecord(decoded)) throw new Error('Invalid collaborative canvas record')
    delete decoded[ORDER_FIELD]
    result.push(decoded as TRecord)
  }
  return result
}

export function createCollaborativeCanvasDocument(
  snapshot?: SnapshotInput,
  options: { doc?: Y.Doc; localOrigin?: object } = {},
): CollaborativeCanvasDocumentV1 {
  const ownsDocument = options.doc === undefined
  const doc = options.doc ?? new Y.Doc()
  registerCollaborativeRoots(doc)
  if (snapshot) {
    if (hasNonEmptyCollaborativeRoots(doc)) {
      throw new Error(
        'Cannot initialize collaborative canvas from snapshot: document roots are not empty',
      )
    }
    initializeDocument(doc, snapshot)
  }

  const localOrigin = options.localOrigin ?? Object.freeze({ type: 'local' })
  const stopDeletionUndoRestoration = installDeletionUndoRestoration(doc)
  const undoManager = new Y.UndoManager(
    [
      doc.getMap(META_KEY),
      doc.getMap(VIEWPORT_KEY),
      doc.getMap(NODES_KEY),
      doc.getMap(EDGES_KEY),
      doc.getMap(COMMENTS_KEY),
      doc.getMap(NODE_TOMBSTONES_KEY),
      doc.getMap(EDGE_TOMBSTONES_KEY),
      doc.getArray(NODE_ORDER_KEY),
      doc.getArray(EDGE_ORDER_KEY),
      doc.getArray(COMMENT_ORDER_KEY),
    ],
    { trackedOrigins: new Set([localOrigin]) },
  )

  return {
    version: COLLABORATIVE_CANVAS_DOCUMENT_VERSION,
    doc,
    localOrigin,
    undoManager,
    transact(callback) {
      undoManager.stopCapturing()
      try {
        doc.transact(callback, localOrigin)
      } finally {
        undoManager.stopCapturing()
      }
    },
    destroy() {
      stopDeletionUndoRestoration()
      undoManager.destroy()
      if (ownsDocument) doc.destroy()
    },
  }
}

export function exportCollaborativeCanvasSnapshot(
  collaborative: Pick<CollaborativeCanvasDocumentV1, 'doc'>,
): CanvasSnapshotV2 {
  const { doc } = collaborative
  assertCollaborativeRootStructure(doc)
  const meta = doc.getMap<unknown>(META_KEY)
  const viewport = doc.getMap<unknown>(VIEWPORT_KEY)
  const budget: DecodeBudget = { entries: 0 }
  const decodedMeta = decodeValue(meta, budget, 0)
  if (!isRecord(decodedMeta)) {
    throw new Error('Invalid collaborative canvas document metadata')
  }
  const documentVersion = decodedMeta.version
  if (documentVersion !== COLLABORATIVE_CANVAS_DOCUMENT_VERSION) {
    throw new Error(
      `Unsupported collaborative canvas document version: ${String(documentVersion)}`,
    )
  }
  const liveNodes = orderedRecords<CanvasNode>(
    doc.getMap<YRecord>(NODES_KEY),
    doc.getArray<string>(NODE_ORDER_KEY),
    budget,
  ).filter((node) => !doc.getMap<boolean>(NODE_TOMBSTONES_KEY).has(node.id))

  const liveNodeIds = new Set(liveNodes.map((node) => node.id))

  const candidate = {
    version: 3,
    canvasId: decodedMeta.canvasId,
    projectId: decodedMeta.projectId,
    name: decodedMeta.name,
    viewport: decodeValue(viewport, budget, 0),
    nodes: liveNodes,
    edges: orderedRecords<CanvasEdge>(
      doc.getMap<YRecord>(EDGES_KEY),
      doc.getArray<string>(EDGE_ORDER_KEY),
      budget,
    )
      .filter((edge) => !doc.getMap<boolean>(EDGE_TOMBSTONES_KEY).has(edge.id))
      .filter((edge) => liveNodeIds.has(edge.source) && liveNodeIds.has(edge.target)),
    comments: orderedRecords<CanvasComment>(
      doc.getMap<YRecord>(COMMENTS_KEY),
      doc.getArray<string>(COMMENT_ORDER_KEY),
      budget,
    ),
  }
  return parseCanvasSnapshot(JSON.stringify(candidate))
}

export { COLLABORATIVE_CANVAS_DOCUMENT_VERSION }
