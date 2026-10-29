import { describe, expect, it } from 'vitest'
import { WorkspaceSyncQueue } from './workspaceSyncQueue'
import { emptyWorkspaceSyncRecord, type WorkspaceSyncStorageBackend } from './workspaceSyncState'
import type { WorkspaceMutation, WorkspaceMutationReceipt } from '../workspace/persistenceProtocol'
import type { WorkspaceManifestV1 } from '../workspace/model'

const manifest: WorkspaceManifestV1 = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, projects: [], canvases: [], pendingOperations: [] }
const mutation = (operationId = 'operation-1'): WorkspaceMutation => ({
  protocolVersion: 1, operationId, kind: 'edit-workspace', expectedWorkspaceRevision: 0,
  expectedCanvasRevisions: {}, commit: { manifest },
})
const receipt = (operationId: string): WorkspaceMutationReceipt => ({
  protocolVersion: 1, operationId, workspaceRevision: 1, canvasRevisions: {}, manifest,
})

function storage() {
  let record = emptyWorkspaceSyncRecord()
  let serialized: string | undefined
  return {
    initializeFromLegacy: async () => {}, getManifest: async () => serialized,
    getCanvasDocument: async () => undefined, commit: async () => {},
    readSyncRecord: async () => structuredClone(record),
    readSyncSnapshot: async () => ({ record: structuredClone(record), manifest: serialized }),
    transactSync: async (update) => {
      const next = structuredClone(record)
      const changes = update(next, serialized)
      if (changes?.manifest) serialized = typeof changes.manifest === 'string' ? changes.manifest : JSON.stringify(changes.manifest)
      record = next
    },
  } satisfies WorkspaceSyncStorageBackend
}

describe('durable workspace sync queue', () => {
  it('drains a newly queued operation before confirming a caller that joined an idle drain', async () => {
    const backend = storage()
    const read = backend.readSyncRecord
    let captured!: () => void, release!: () => void
    const capturedEmpty = new Promise<void>((resolve) => { captured = resolve })
    const resumeEmpty = new Promise<void>((resolve) => { release = resolve })
    let pause = true
    backend.readSyncRecord = async () => {
      const record = await read()
      if (pause) { pause = false; captured(); await resumeEmpty }
      return record
    }
    const sent: string[] = []
    const queue = new WorkspaceSyncQueue(backend, async (input) => { sent.push(input.operationId); return receipt(input.operationId) })
    const idle = queue.drain()
    await capturedEmpty
    await queue.enqueue({ manifest }, mutation())
    const confirming = queue.drain()
    release()
    await Promise.all([idle, confirming])
    expect(sent).toEqual(['operation-1'])
    expect((await read()).pending).toEqual([])

    // Completion must clear the old worker instead of reusing its finished promise.
    await queue.enqueue({ manifest }, mutation('operation-2'))
    await queue.drain()
    expect(sent).toEqual(['operation-1', 'operation-2'])
  })

  it('retains an offline operation across queue recreation and reuses the same operation ID', async () => {
    const backend = storage()
    const offline = new WorkspaceSyncQueue(backend, async () => { throw new Error('offline') })
    await offline.enqueue({ manifest }, mutation())
    await expect(offline.drain()).rejects.toThrow('offline')
    expect((await backend.readSyncRecord()).pending).toHaveLength(1)
    const received: WorkspaceMutation[] = []
    const online = new WorkspaceSyncQueue(backend, async (input) => { received.push(input); return receipt(input.operationId) })
    await online.drain()
    expect(received).toEqual([mutation()])
    expect((await backend.readSyncRecord()).pending).toEqual([])
  })

  it('does not remove pending data for a mismatched receipt after a lost response', async () => {
    const backend = storage()
    const queue = new WorkspaceSyncQueue(backend, async () => receipt('wrong-operation'))
    await queue.enqueue({ manifest }, mutation())
    await expect(queue.drain()).rejects.toThrow('未确认')
    expect((await backend.readSyncRecord()).pending[0]?.operationId).toBe('operation-1')
  })

  it('stops at a conflict and preserves the later edits and local manifest', async () => {
    const backend = storage()
    let sends = 0
    const queue = new WorkspaceSyncQueue(backend, async () => { sends++; throw Object.assign(new Error('conflict'), { status: 409 }) })
    await queue.enqueue({ manifest }, mutation())
    await queue.enqueue({ manifest: { ...manifest, viewport: { x: 45, y: 0, zoom: 1 } } }, mutation('operation-2'))
    await expect(queue.drain()).rejects.toThrow('conflict')
    await expect(queue.drain()).rejects.toThrow('conflict')
    expect(sends).toBe(1)
    expect((await backend.readSyncRecord()).pending).toHaveLength(2)
    expect(JSON.parse((await backend.getManifest())!).viewport.x).toBe(45)
  })

  it('does not let an earlier receipt overwrite a later locally queued manifest', async () => {
    const backend = storage()
    let finish!: (receipt: WorkspaceMutationReceipt) => void
    const first = new Promise<WorkspaceMutationReceipt>((resolve) => { finish = resolve })
    const queue = new WorkspaceSyncQueue(backend, async (input) => {
      if (input.operationId === 'operation-1') return first
      throw new Error('offline again')
    })
    await queue.enqueue({ manifest }, mutation())
    const drain = queue.drain()
    await queue.enqueue({ manifest: { ...manifest, viewport: { x: 50, y: 0, zoom: 1 } } }, mutation('operation-2'))
    finish(receipt('operation-1'))
    await expect(drain).rejects.toThrow('offline again')
    expect(JSON.parse((await backend.getManifest())!).viewport.x).toBe(50)
    expect((await backend.readSyncRecord()).pending.map((item) => item.operationId)).toEqual(['operation-2'])
  })
})
