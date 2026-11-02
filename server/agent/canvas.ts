import { isDeepStrictEqual } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCanvasSnapshot, type CanvasSnapshotV2 } from '../../src/model/project.ts'
import type { GatewayRuntime } from '../runtime.ts'
import { AgentError, type FieldChange, type StoredRun } from './types.ts'

type RecordValue = Record<string, unknown>
const plain = (v: unknown): v is RecordValue => v !== null && typeof v === 'object' && !Array.isArray(v)
export function changesBetween(before: CanvasSnapshotV2, after: CanvasSnapshotV2, complete = false): FieldChange[] {
  const changes: FieldChange[] = []
  for (const collection of ['nodes', 'edges'] as const) {
    const a = new Map<string, unknown>(before[collection].map(n => [n.id, n]))
    const b = new Map<string, unknown>(after[collection].map(n => [n.id, n]))
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      const diff = (left: unknown, right: unknown, path: string[]) => {
        if (isDeepStrictEqual(left, right)) return
        if (plain(left) && plain(right) && path.length > 0) {
          for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) diff(left[key], right[key], [...path, key])
        } else if (path.length === 0 && a.has(id) && b.has(id)) {
          for (const key of new Set([...Object.keys(left as RecordValue), ...Object.keys(right as RecordValue)])) diff((left as RecordValue)[key], (right as RecordValue)[key], [key])
        } else changes.push({ collection, id, path, before: left, after: right })
      }
      diff(a.get(id), b.get(id), [])
    }
  }
  if (complete) {
    if (before.name !== after.name) changes.push({ collection: 'canvas', id: before.canvasId, path: ['name'], before: before.name, after: after.name })
    for (const key of ['nodes', 'edges'] as const) {
      const a = before[key].map(n => n.id); const b = after[key].map(n => n.id)
      if (!isDeepStrictEqual(a, b)) changes.push({ collection: 'canvas', id: before.canvasId, path: [key], before: a, after: b })
    }
  }
  return changes
}
function valueAt(object: unknown, path: string[]): unknown { return path.reduce((value, key) => plain(value) ? value[key] : undefined, object) }
/** Inspect committed fields without applying an undo or touching later objects. */
export function changesMatch(snapshot: CanvasSnapshotV2, changes: FieldChange[]): boolean {
  return changes.every(change => {
    if (change.collection === 'canvas') {
      const key = change.path[0]
      if (key === 'name') return snapshot.name === change.after
      if ((key === 'nodes' || key === 'edges') && Array.isArray(change.after)) {
        const desired = change.after; const ids = snapshot[key].map(n => n.id); const live = new Set(ids)
        return isDeepStrictEqual(ids.filter(id => desired.includes(id)), desired.filter(id => live.has(id)))
      }
      return false
    }
    const entity = snapshot[change.collection].find(n => n.id === change.id)
    if (change.path.length && !entity) return false
    return isDeepStrictEqual(valueAt(entity, change.path), change.after)
  })
}
export function applyChanges(snapshot: CanvasSnapshotV2, changes: FieldChange[], reverse = false) {
  const result = structuredClone(snapshot); const conflicts: string[] = []
  const reorderedCreations = new Set<string>()
  if (reverse) for (const change of changes) {
    const key = change.path[0]
    if (change.collection !== 'canvas' || (key !== 'nodes' && key !== 'edges') || !Array.isArray(change.before) || !Array.isArray(change.after)) continue
    const expected = change.after; const currentIds = snapshot[key].map(n => n.id)
    const live = new Set(currentIds)
    if (!isDeepStrictEqual(currentIds.filter(id => expected.includes(id)), expected.filter(id => live.has(id)))) {
      for (const id of expected) if (!change.before.includes(id)) reorderedCreations.add(`${key}:${id}`)
    }
  }
  const ordered = (reverse ? [...changes].reverse() : [...changes]).sort((a, b) => Number(a.collection === 'canvas') - Number(b.collection === 'canvas'))
  for (const change of ordered) {
    if (change.collection === 'canvas') {
      const expected = reverse ? change.after : change.before; const desired = reverse ? change.before : change.after
      const key = change.path[0]
      if (key === 'name') {
        if (result.name === expected) result.name = String(desired)
        else conflicts.push('canvas:name')
      } else if ((key === 'nodes' || key === 'edges') && Array.isArray(expected) && Array.isArray(desired)) {
        const list = result[key]; const live = new Set(list.map(n => n.id))
        // Added/deleted objects are handled separately; compare order only among
        // identities present in both versions and in the current document.
        const common = new Set(expected.filter(id => desired.includes(id) && live.has(id)))
        const currentOrder = list.filter(n => common.has(n.id)).map(n => n.id)
        if (!isDeepStrictEqual(currentOrder, expected.filter(id => common.has(id)))) conflicts.push(`canvas:${key}`)
        else {
          const tracked = new Set(desired); const byId = new Map(list.map(n => [n.id, n]))
          const ordered = desired.filter(id => live.has(id)).map(id => byId.get(id)!)
          let cursor = 0
          const reordered = list.map(n => tracked.has(n.id) ? ordered[cursor++] ?? n : n)
          result[key] = reordered as typeof result.nodes & typeof result.edges
        }
      }
      continue
    }
    const list = result[change.collection] as unknown as RecordValue[]
    const index = list.findIndex(n => n.id === change.id); const current = list[index]
    const expected = reverse ? change.after : change.before; const desired = reverse ? change.before : change.after
    if (reverse && !change.path.length && desired === undefined && reorderedCreations.has(`${change.collection}:${change.id}`)) { conflicts.push(`${change.id}:reordered`); continue }
    if (!current && change.path.length) { conflicts.push(`${change.id}:missing`); continue }
    if (!isDeepStrictEqual(valueAt(current, change.path), expected)) { conflicts.push(`${change.id}:${change.path.join('.')}`); continue }
    if (change.path.length === 0) {
      if (desired === undefined) { if (index >= 0) list.splice(index, 1) }
      else if (index >= 0) list[index] = structuredClone(desired as RecordValue)
      else list.push(structuredClone(desired as RecordValue))
    } else {
      let target = current
      for (const key of change.path.slice(0, -1)) { if (!plain(target[key])) target[key] = {}; target = target[key] as RecordValue }
      const key = change.path.at(-1)!
      if (desired === undefined) delete target[key]; else target[key] = structuredClone(desired)
    }
  }
  // Never delete a task-created object while a later manual object references it.
  if (reverse) {
    const ids = new Set(result.nodes.map(n => n.id))
    const referenced = new Set([...result.edges.flatMap(e => [e.source, e.target]), ...result.nodes.flatMap(n => n.parentId ? [n.parentId] : [])])
    for (const node of snapshot.nodes) if (!ids.has(node.id) && referenced.has(node.id)) { result.nodes.push(node); conflicts.push(`${node.id}:referenced`) }
  }
  return { snapshot: parseCanvasSnapshot(JSON.stringify(result)), conflicts }
}
export async function readCanvas(runtime: GatewayRuntime, record: StoredRun) {
  if (record.grant.kind === 'local-admin' && record.grant.tokenDigest) {
    let metadata: { tokenDigest?: string }
    try { metadata = JSON.parse(await readFile(join(runtime.dataDir, 'local-admin.json'), 'utf8')) } catch { throw new AgentError(403, 'grant_revoked', '本地管理员授权无法核验，请重新授权后继续。') }
    if (metadata.tokenDigest !== record.grant.tokenDigest) throw new AgentError(403, 'grant_revoked', '本地管理员授权已更新，请重新授权后继续。')
  }
  const state = await runtime.workspace.getCanvasRecord(record.run.canvasId)
  if (!state || state.deleted || !state.snapshot || state.projectId !== record.run.projectId) throw new AgentError(409, 'canvas_missing', '原画布已删除或不再属于原项目。')
  const authority = runtime.collaboration.agentAuthority(record.run.projectId, record.run.canvasId)
  if (authority !== record.authority) throw new AgentError(409, 'authority_changed', '画布协作状态已改变；请核对后继续任务。')
  if (record.grant.kind === 'collaboration') {
    runtime.collaboration.authorizeAgentGrant(record.grant, record.run.canvasId)
    if (state.roomId !== record.grant.roomId || state.epoch !== record.grant.epoch) throw new AgentError(409, 'authority_changed', '画布权威状态已改变，请核对后继续。')
    return { snapshot: runtime.collaboration.exportSnapshot(record.grant.roomId), revision: state.revision }
  }
  if (authority !== 'local') throw new AgentError(403, 'collaboration_grant_required', '协作画布需要有效的成员授权。')
  return { snapshot: state.snapshot, revision: state.revision }
}
