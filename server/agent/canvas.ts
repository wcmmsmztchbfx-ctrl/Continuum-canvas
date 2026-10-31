import { isDeepStrictEqual } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCanvasSnapshot, type CanvasSnapshotV2 } from '../../src/model/project.ts'
import type { GatewayRuntime } from '../runtime.ts'
import { AgentError, type FieldChange, type StoredRun } from './types.ts'

type RecordValue = Record<string, unknown>
const plain = (v: unknown): v is RecordValue => v !== null && typeof v === 'object' && !Array.isArray(v)
export function changesBetween(before: CanvasSnapshotV2, after: CanvasSnapshotV2): FieldChange[] {
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
  return changes
}
function valueAt(object: unknown, path: string[]): unknown { return path.reduce((value, key) => plain(value) ? value[key] : undefined, object) }
export function applyChanges(snapshot: CanvasSnapshotV2, changes: FieldChange[], reverse = false) {
  const result = structuredClone(snapshot); const conflicts: string[] = []
  for (const change of (reverse ? [...changes].reverse() : changes)) {
    const list = result[change.collection] as unknown as RecordValue[]
    const index = list.findIndex(n => n.id === change.id); const current = list[index]
    const expected = reverse ? change.after : change.before; const desired = reverse ? change.before : change.after
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
