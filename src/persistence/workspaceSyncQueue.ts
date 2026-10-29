import { parseWorkspaceManifest, type WorkspaceCommit } from '../workspace/model'
import type { WorkspaceMutation, WorkspaceMutationReceipt } from '../workspace/persistenceProtocol'
import { assertWorkspaceReceipt, mergeWorkspaceVersions, type WorkspaceSyncStorageBackend, type WorkspaceSyncState } from './workspaceSyncState'

export class WorkspaceSyncQueue {
  #running?: Promise<void>
  readonly storage: WorkspaceSyncStorageBackend
  readonly send: (mutation: WorkspaceMutation) => Promise<WorkspaceMutationReceipt>
  readonly changed: (state: WorkspaceSyncState) => void
  readonly confirmed: (mutation: WorkspaceMutation, receipt: WorkspaceMutationReceipt) => void
  constructor(
    storage: WorkspaceSyncStorageBackend,
    send: (mutation: WorkspaceMutation) => Promise<WorkspaceMutationReceipt>,
    changed: (state: WorkspaceSyncState) => void = () => {},
    confirmed: (mutation: WorkspaceMutation, receipt: WorkspaceMutationReceipt) => void = () => {},
  ) { this.storage = storage; this.send = send; this.changed = changed; this.confirmed = confirmed }

  async enqueue(commit: WorkspaceCommit, mutation: WorkspaceMutation): Promise<void> {
    await this.storage.transactSync((record, serializedManifest) => {
      if (record.pending.some((item) => item.operationId === mutation.operationId)) return undefined
      let change = commit
      if (mutation.kind === 'save-canvas') {
        // Like the server, derive only this canvas card from the current
        // manifest. A retried canvas snapshot must not restore old structure.
        const manifest = parseWorkspaceManifest(serializedManifest ?? (typeof commit.manifest === 'string' ? commit.manifest : JSON.stringify(commit.manifest)))
        const canvas = mutation.canvas
        const card = manifest.canvases.find((item) => item.canvasId === canvas.canvasId)
        if (!card || card.deletedAt || card.projectId !== canvas.projectId) throw new Error('画布不存在、已删除或归属已改变，请保留修改后重新加载')
        card.name = canvas.name; card.nodeCount = canvas.nodes.length; card.updatedAt = new Date().toISOString()
        change = { manifest, putDocuments: [{ canvasId: canvas.canvasId, serialized: JSON.stringify(canvas) }] }
      }
      record.pending.push({ operationId: mutation.operationId, sequence: record.nextSequence++, mutation: structuredClone(mutation), status: 'pending' })
      if (mutation.kind === 'save-canvas') {
        record.localVersions.workspaceRevision++
        record.localVersions.canvasRevisions[mutation.canvas.canvasId] = mutation.expectedRevision + 1
      } else {
        record.localVersions.workspaceRevision = mutation.expectedWorkspaceRevision + 1
        for (const [id, revision] of Object.entries(mutation.expectedCanvasRevisions)) record.localVersions.canvasRevisions[id] = revision + 1
      }
      for (const document of change.putDocuments ?? []) record.cachedCanvasRevisions[document.canvasId] = record.localVersions.canvasRevisions[document.canvasId] ?? 0
      for (const id of change.deleteCanvasIds ?? []) delete record.cachedCanvasRevisions[id]
      return change
    })
    await this.refresh()
  }

  async refresh(): Promise<void> {
    const { pending } = await this.storage.readSyncRecord()
    const blocked = pending.find((item) => item.status !== 'pending')
    this.changed({ phase: blocked?.status ?? (pending.length ? 'pending' : 'synced'), pendingCount: pending.length, message: blocked?.message })
  }

  async drain(): Promise<void> {
    for (;;) {
      if (!this.#running) this.#running = this.#drain().finally(() => { this.#running = undefined })
      await this.#running
      // A caller may enqueue while the previous worker is finishing an empty
      // read. Recheck after its finally clears #running before confirming it.
      if (!(await this.storage.readSyncRecord()).pending.length) return
    }
  }

  async #drain(): Promise<void> {
    for (;;) {
      const { pending } = await this.storage.readSyncRecord()
      const operation = pending[0]
      if (!operation) { await this.refresh(); return }
      if (operation.status !== 'pending') {
        await this.refresh()
        throw Object.assign(new Error(operation.message ?? '请先处理未同步的修改'), { status: operation.status === 'conflict' ? 409 : 400 })
      }
      this.changed({ phase: 'saving', pendingCount: pending.length })
      try {
        const receipt = await this.send(operation.mutation)
        assertWorkspaceReceipt(receipt, operation.operationId)
        await this.storage.transactSync((record) => {
          if (!record.pending.some((item) => item.operationId === receipt.operationId)) return undefined
          record.pending = record.pending.filter((item) => item.operationId !== receipt.operationId)
          mergeWorkspaceVersions(record.versions, receipt)
          if (!record.pending.length) {
            record.localVersions = structuredClone(record.versions)
            // An idempotent replay may be older than another tab's known
            // version. Its manifest must keep its own structural edit basis.
            record.localVersions.workspaceRevision = receipt.workspaceRevision
          }
          // A previous response must not replace newer offline edits.
          return record.pending.length ? undefined : { manifest: receipt.manifest }
        })
        this.confirmed(operation.mutation, receipt)
      } catch (error) {
        const status = (error as { status?: number })?.status
        const message = error instanceof Error ? error.message : '保存失败'
        await this.storage.transactSync((record) => {
          const current = record.pending.find((item) => item.operationId === operation.operationId)
          if (current) {
            current.status = status === 409 || status === 428 ? 'conflict' : status && status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'error' : 'pending'
            current.message = message
          }
          return undefined
        })
        await this.refresh()
        throw error
      }
    }
  }
}
