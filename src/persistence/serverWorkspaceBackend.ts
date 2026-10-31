import { canvasContentIdentity } from '../model/canvasContentIdentity'
import { mergeCanvasSnapshots, type CanvasMergeConflict } from '../model/canvasMerge'
import { parseCanvasSnapshot, type CanvasSnapshotV2 } from '../model/project'
import { parseWorkspaceManifest, type WorkspaceCommit, type WorkspaceManifestV1 } from '../workspace/model'
import type { CanvasSynchronizationResult, WorkspaceInitialization, WorkspaceStorageBackend } from '../workspace/repository'
import type { CanvasDocumentResponse, WorkspaceManifestResponse, WorkspaceMutation, WorkspaceMutationReceipt } from '../workspace/persistenceProtocol'
import { createBrowserUuid } from '../utils/id'
import { createIndexedDbWorkspaceBackend } from './projectRepository'
import { WorkspaceSyncQueue } from './workspaceSyncQueue'
import { assertWorkspaceReceipt, mergeWorkspaceVersions, type WorkspaceSyncService, type WorkspaceSyncState, type WorkspaceSyncStorageBackend } from './workspaceSyncState'

export interface ServerWorkspaceBackendOptions {
  baseUrl?: string
  fallbackBackend?: WorkspaceSyncStorageBackend
  fetchImpl?: typeof fetch
}

export class WorkspaceCommitError extends Error {
  readonly savedLocally: boolean
  readonly localCause: unknown
  readonly remoteCause: unknown
  constructor(savedLocally: boolean, localCause: unknown, remoteCause: unknown) {
    const status = (remoteCause as { status?: number })?.status
    super(savedLocally
      ? status === 409 || status === 428
        ? '本地修改已保留，但与服务器存在版本冲突。请打开保存详情，重新检查同步或保留为副本。'
        : '已在本地保存，但服务器保存失败。连接恢复后会重试。'
      : '本地和服务器均保存失败，请重试。', { cause: remoteCause })
    this.name = 'WorkspaceCommitError'
    this.savedLocally = savedLocally
    this.localCause = localCause
    this.remoteCause = remoteCause
  }
}

export interface ServerWorkspaceBackend extends WorkspaceStorageBackend, WorkspaceSyncService {
  saveCanvas(snapshot: CanvasSnapshotV2, manifest?: string): Promise<void>
  synchronizeCanvas(snapshot: CanvasSnapshotV2, options?: { conflicts?: CanvasMergeConflict[] }): Promise<CanvasSynchronizationResult>
  confirmedCanvasRevision(canvasId: string): Promise<number>
}

export function createServerWorkspaceBackend(options: ServerWorkspaceBackendOptions = {}): ServerWorkspaceBackend {
  const local = options.fallbackBackend ?? createIndexedDbWorkspaceBackend()
  const baseUrl = options.baseUrl ?? ''
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const listeners = new Set<() => void>()
  let state: WorkspaceSyncState = { phase: 'saving', pendingCount: 0 }
  let manifestBasis: WorkspaceManifestV1 | undefined
  let workspaceBasis: number | undefined
  const canvasBasis = new Map<string, number>()
  const contentBasis = new Map<string, string>()
  const confirmedDocuments = new Map<string, { revision: number; canvas: CanvasSnapshotV2 }>()
  const loadedDocument = async (serialized: string | undefined) => {
    if (!serialized) return undefined
    const snapshot = parseCanvasSnapshot(serialized)
    contentBasis.set(snapshot.canvasId, canvasContentIdentity(snapshot))
    const viewport = (await local.readSyncRecord()).localViewports?.[snapshot.canvasId]
    return viewport ? JSON.stringify({ ...snapshot, viewport }) : serialized
  }
  // If both destinations fail, retain the request in this page for retry/export.
  // An empty durable outbox must not turn that failure into a success indication.
  const unpersisted = new Map<string, { commit: WorkspaceCommit; mutation: WorkspaceMutation; sequence: number }>()
  let nextSequence = 1
  const ownSequences = new Map<string, number>()
  const confirmedCanvasSequences = new Map<string, number>()
  const memoryCanvas = (canvasId: string) => [...unpersisted.values()]
    .sort((a, b) => b.sequence - a.sequence)
    .find((operation) => operation.mutation.kind === 'save-canvas' && operation.mutation.canvas.canvasId === canvasId)
  const setState = (next: WorkspaceSyncState) => {
    state = next.phase === 'synced' && unpersisted.size
      ? { phase: 'error', pendingCount: next.pendingCount, message: '有修改尚未保存，请重试或导出恢复文件后再关闭页面。' }
      : next
    for (const listener of listeners) listener()
  }

  const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined
      const message = response.status === 409 ? '服务器已有更新，本地修改已保留。请选择保留副本或重新加载。'
        : response.status === 428 ? '保存协议已更新，请保留本地副本后重新加载。'
        : payload?.error?.message ?? `服务器保存失败 (${response.status})`
      throw Object.assign(new Error(message), { status: response.status })
    }
    return response.json() as Promise<T>
  }
  const send = async (mutation: WorkspaceMutation) => {
    const receipt = await request<WorkspaceMutationReceipt>('/api/workspace/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mutation),
    })
    assertWorkspaceReceipt(receipt, mutation.operationId)
    return receipt
  }
  const confirmed = (mutation: WorkspaceMutation, receipt: WorkspaceMutationReceipt) => {
    unpersisted.delete(mutation.operationId)
    const sequence = ownSequences.get(mutation.operationId)
    if (mutation.kind === 'save-canvas' && sequence !== undefined) {
      const canvasId = mutation.canvas.canvasId
      confirmedCanvasSequences.set(canvasId, Math.max(sequence, confirmedCanvasSequences.get(canvasId) ?? 0))
      // Only a later confirmed save from this editor supersedes its failed
      // memory snapshot. Other tabs' durable conflict branches stay untouched.
      for (const [id, previous] of unpersisted) {
        if (previous.sequence < sequence && previous.mutation.kind === 'save-canvas' && previous.mutation.canvas.canvasId === canvasId) {
          unpersisted.delete(id)
          ownSequences.delete(id)
        }
      }
    }
    ownSequences.delete(mutation.operationId)
    const ids = mutation.kind === 'save-canvas' ? [mutation.canvas.canvasId] : Object.keys(mutation.expectedCanvasRevisions)
    for (const id of ids) canvasBasis.set(id, Math.max(canvasBasis.get(id) ?? 0, receipt.canvasRevisions[id] ?? 0))
    if (mutation.kind === 'save-canvas') {
      const revision = receipt.canvasRevisions[mutation.canvas.canvasId]
      if (revision !== undefined) confirmedDocuments.set(mutation.canvas.canvasId, { revision, canvas: structuredClone(mutation.canvas) })
    }
  }
  const queue = new WorkspaceSyncQueue(local, send, setState, confirmed)

  const fetchManifest = async () => {
    const data = await request<WorkspaceManifestResponse>('/api/workspace/manifest')
    parseWorkspaceManifest(JSON.stringify(data.manifest))
    if (!Number.isSafeInteger(data.workspaceRevision) || !data.canvasRevisions) throw new Error('服务器版本信息缺失，请重新加载')
    return data
  }
  const getManifest = async (): Promise<string | undefined> => {
    const initial = await local.readSyncSnapshot()
    let uncached: WorkspaceManifestResponse | undefined
    if (!initial.record.pending.length && !unpersisted.size) {
      try {
        const data = await fetchManifest()
        uncached = data
        await local.transactSync((current) => {
          if (current.pending.length || unpersisted.size || data.workspaceRevision < current.versions.workspaceRevision) return undefined
          mergeWorkspaceVersions(current.versions, data)
          current.localVersions = structuredClone(current.versions)
          return { manifest: data.manifest }
        })
        uncached = undefined
      } catch { /* Cached edits remain available when offline. */ }
    }
    const { manifest: cached, record: current } = await local.readSyncSnapshot()
    const remote = uncached && !current.pending.length && !unpersisted.size && uncached.workspaceRevision >= current.versions.workspaceRevision ? uncached : undefined
    const serialized = remote ? JSON.stringify(remote.manifest) : cached
    workspaceBasis = remote ? remote.workspaceRevision : current.localVersions.workspaceRevision
    if (serialized) manifestBasis = parseWorkspaceManifest(serialized)
    await queue.refresh()
    return serialized
  }

  const stage = async (commit: WorkspaceCommit, mutation: WorkspaceMutation): Promise<() => Promise<void>> => {
    const sequence = ownSequences.get(mutation.operationId) ?? nextSequence++
    ownSequences.set(mutation.operationId, sequence)
    let localCause: unknown
    let savedLocally = false
    try {
      await queue.enqueue(commit, mutation)
      savedLocally = true
      unpersisted.delete(mutation.operationId)
      const current = await local.readSyncSnapshot()
      workspaceBasis = current.record.localVersions.workspaceRevision
      if (current.manifest) manifestBasis = parseWorkspaceManifest(current.manifest)
      if (mutation.kind === 'save-canvas') canvasBasis.set(mutation.canvas.canvasId, mutation.expectedRevision + 1)
      else for (const [id, revision] of Object.entries(mutation.expectedCanvasRevisions)) canvasBasis.set(id, revision + 1)
    } catch (error) {
      localCause = error
      if (mutation.kind !== 'save-canvas' || sequence > (confirmedCanvasSequences.get(mutation.canvas.canvasId) ?? 0)) {
        unpersisted.set(mutation.operationId, structuredClone({ commit, mutation, sequence }))
      }
    }
    return async () => { try {
      if (savedLocally) await queue.drain()
      else {
        const receipt = await send(mutation)
        unpersisted.delete(mutation.operationId)
        confirmed(mutation, receipt)
        workspaceBasis = receipt.workspaceRevision
        manifestBasis = receipt.manifest
        setState({ phase: 'synced', pendingCount: 0, message: '已保存到服务器，本地缓存暂不可用' })
      }
    } catch (remoteCause) {
      if (!savedLocally) setState({ phase: 'error', pendingCount: 0, message: '本地和服务器均保存失败，请重试。' })
      throw new WorkspaceCommitError(savedLocally, localCause, remoteCause)
    } }
  }
  const persist = async (commit: WorkspaceCommit, mutation: WorkspaceMutation) => (await stage(commit, mutation))()

  const stageCanvasSave = async (snapshot: CanvasSnapshotV2, serializedManifest?: string) => {
    const document = parseCanvasSnapshot(JSON.stringify(snapshot))
    const cached = await local.readSyncSnapshot(document.canvasId)
    if (contentBasis.get(document.canvasId) === canvasContentIdentity(document)) {
      // Persist only this viewer's camera, without replacing another tab's cached document.
      try {
        await local.transactSync(record => {
          (record.localViewports ??= {})[document.canvasId] = document.viewport
          return undefined
        })
        return () => retry()
      } catch { /* Retain the full snapshot through the existing failure/recovery path. */ }
    }
    const expectedRevision = canvasBasis.get(document.canvasId) ?? cached.record.cachedCanvasRevisions[document.canvasId] ?? 0
    const serialized = serializedManifest ?? cached.manifest
    if (!serialized) throw new Error('工作区尚未加载，无法保存画布')
    const localManifest = parseWorkspaceManifest(serialized)
    const card = localManifest.canvases.find((item) => item.canvasId === document.canvasId)
    if (!card || card.deletedAt) throw new Error('画布不存在或已移入回收站')
    if (card.projectId !== document.projectId) throw new Error('画布文档与工作区归属不一致')
    card.name = document.name; card.nodeCount = document.nodes.length; card.updatedAt = new Date().toISOString()
    const confirm = await stage({ manifest: localManifest, putDocuments: [{ canvasId: document.canvasId, serialized: JSON.stringify(document) }] },
      { protocolVersion: 1, operationId: createBrowserUuid(), kind: 'save-canvas', expectedRevision, canvas: document })
    contentBasis.set(document.canvasId, canvasContentIdentity(document))
    return confirm
  }

  const commit = async (change: WorkspaceCommit): Promise<void> => {
    if (!manifestBasis || workspaceBasis === undefined) await getManifest()
    const next = parseWorkspaceManifest(typeof change.manifest === 'string' ? change.manifest : JSON.stringify(change.manifest))
    const previous = new Map(manifestBasis?.canvases.map((item) => [item.canvasId, item]))
    const affected = new Set([...(change.putDocuments ?? []).map((doc) => doc.canvasId), ...(change.deleteCanvasIds ?? [])])
    for (const item of next.canvases) if (JSON.stringify(previous.get(item.canvasId)) !== JSON.stringify(item)) affected.add(item.canvasId)
    for (const id of previous.keys()) if (!next.canvases.some((item) => item.canvasId === id)) affected.add(id)
    const localVersions = (await local.readSyncRecord()).localVersions
    const expectedCanvasRevisions = Object.fromEntries([...affected].map((id) => [id, canvasBasis.get(id) ?? localVersions.canvasRevisions[id] ?? 0]))
    await persist(change, { protocolVersion: 1, operationId: createBrowserUuid(), kind: 'edit-workspace',
      expectedWorkspaceRevision: workspaceBasis ?? localVersions.workspaceRevision, expectedCanvasRevisions, commit: change })
  }

  const retry = async (recheckConflict = false) => {
    if (recheckConflict) await local.transactSync(record => {
      // Re-send the exact request with its original revision. The server still
      // rejects content conflicts; only an identical-content camera save can pass.
      const first = record.pending[0]
      if (first?.status === 'conflict' && first.mutation.kind === 'save-canvas' && !record.canvasConflicts?.[first.mutation.canvas.canvasId]) first.status = 'pending'
      return undefined
    })
    // A newer durable save may confirm and supersede an older memory-only
    // failure. Do not append that older request behind it before confirmation.
    await queue.drain()
    for (const operation of [...unpersisted.values()]) {
      if (unpersisted.has(operation.mutation.operationId)) await persist(operation.commit, operation.mutation)
    }
    await queue.drain()
  }
  const exportRecovery = async () => {
    const record = await local.readSyncRecord()
    const serialized = await local.getManifest()
    const manifest = serialized ? parseWorkspaceManifest(serialized) : undefined
    const documents = await Promise.all((manifest?.canvases ?? []).map(async (canvas) => ({ canvasId: canvas.canvasId, serialized: await local.getCanvasDocument(canvas.canvasId) })))
    return JSON.stringify({ format: 'continuum-recovery', version: 1, exportedAt: new Date().toISOString(), manifest, documents, sync: record, unpersisted: [...unpersisted.values()] }, null, 2)
  }

  const synchronizeCanvas = async (snapshot: CanvasSnapshotV2, options?: { conflicts?: CanvasMergeConflict[] }): Promise<CanvasSynchronizationResult> => {
    const ours = parseCanvasSnapshot(JSON.stringify(snapshot))
    const id = ours.canvasId
    const result = await queue.withPaused(async () => {
      const data = await request<CanvasDocumentResponse>(`/api/canvases/${encodeURIComponent(id)}`)
      const remote = parseCanvasSnapshot(JSON.stringify(data.canvas))
      if (remote.canvasId !== id || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('画布版本信息无效')
      const initial = await local.readSyncSnapshot(id)
      const savedConflict = initial.record.canvasConflicts?.[id]
      if (savedConflict) {
        // A user may keep typing while the first conflict is being persisted.
        // Accepting it in the view must never mark those later edits as saved
        // without first retaining them in the durable conflict branch.
        const operationId = createBrowserUuid()
        let retained = false
        await local.transactSync(record => {
          const conflict = record.canvasConflicts?.[id]
          if (!conflict) throw new Error('冲突状态已改变，请重新同步')
          if (canvasContentIdentity(conflict.local) !== canvasContentIdentity(ours)) {
            record.pending.push({ operationId, sequence: record.nextSequence++, status: 'conflict',
              message: '后台更新与本地编辑冲突，双方内容均已保留，请在保存详情中处理。',
              mutation: { protocolVersion: 1, operationId, kind: 'save-canvas', expectedRevision: data.revision, canvas: ours } })
            conflict.local = ours
            retained = true
          }
          ;(record.localViewports ??= {})[id] = ours.viewport
          return { putDocuments: [{ canvasId: id, serialized: JSON.stringify(ours) }] }
        })
        if (retained) ownSequences.set(operationId, nextSequence++)
        contentBasis.set(id, canvasContentIdentity(ours))
        await queue.refresh()
        return { canvas: ours, conflicts: savedConflict.conflicts, revision: data.revision }
      }
      const known = initial.record.canvasBases?.[id] ?? confirmedDocuments.get(id)
      if (!known || data.revision < known.revision) throw new Error('画布同步基线尚未确认，请先完成保存或重新加载')
      const pending = initial.record.pending.filter(item => item.mutation.kind === 'save-canvas' ? item.mutation.canvas.canvasId === id : id in item.mutation.expectedCanvasRevisions)
      // Other tabs and workspace structure changes are independent branches.
      // Never discard them as if they belonged to this editor's current view.
      if (pending.some(item => item.mutation.kind !== 'save-canvas' || !ownSequences.has(item.operationId))) {
        throw new Error('此画布还有其他窗口或工作区修改，请在保存详情中保留并处理后同步')
      }
      const merged = mergeCanvasSnapshots(known.canvas, ours, remote)
      merged.conflicts.push(...options?.conflicts ?? [])
      const hasLocalChanges = canvasContentIdentity(merged.canvas) !== canvasContentIdentity(remote)
      const operationId = createBrowserUuid()
      const mutation: WorkspaceMutation = { protocolVersion: 1, operationId, kind: 'save-canvas', expectedRevision: data.revision, canvas: merged.canvas }
      const capturedIds = new Set(pending.map(item => item.operationId))
      await local.transactSync((record) => {
        const added = record.pending.some(item => !capturedIds.has(item.operationId) && (item.mutation.kind === 'save-canvas' ? item.mutation.canvas.canvasId === id : id in item.mutation.expectedCanvasRevisions))
        if (added) throw new Error('同步期间出现新的画布修改，请重试')
        record.pending = record.pending.filter(item => !capturedIds.has(item.operationId))
        record.versions.canvasRevisions[id] = data.revision
        record.versions.workspaceRevision = Math.max(record.versions.workspaceRevision, data.workspaceRevision ?? 0)
        record.localVersions.canvasRevisions[id] = data.revision + (hasLocalChanges ? 1 : 0)
        record.cachedCanvasRevisions[id] = record.localVersions.canvasRevisions[id]!
        ;(record.localViewports ??= {})[id] = ours.viewport
        ;(record.canvasBases ??= {})[id] = { revision: data.revision, canvas: remote }
        if (hasLocalChanges || merged.conflicts.length) {
          record.pending.push({ operationId, sequence: record.nextSequence++, mutation, status: merged.conflicts.length ? 'conflict' : 'pending',
            ...(merged.conflicts.length ? { message: '后台更新与本地编辑冲突，双方内容均已保留。请在保存详情中保留副本或选择服务器版本。' } : {}) })
        }
        if (merged.conflicts.length) (record.canvasConflicts ??= {})[id] = { base: known.canvas, local: ours, remote, conflicts: merged.conflicts }
        return { putDocuments: [{ canvasId: id, serialized: JSON.stringify(merged.canvas) }] }
      })
      for (const old of capturedIds) ownSequences.delete(old)
      for (const [key, operation] of unpersisted) if (operation.mutation.kind === 'save-canvas' && operation.mutation.canvas.canvasId === id) { unpersisted.delete(key); ownSequences.delete(key) }
      if (hasLocalChanges || merged.conflicts.length) ownSequences.set(operationId, nextSequence++)
      canvasBasis.set(id, data.revision + (hasLocalChanges ? 1 : 0))
      contentBasis.set(id, canvasContentIdentity(merged.canvas))
      confirmedDocuments.set(id, { revision: data.revision, canvas: remote })
      await queue.refresh()
      return { ...merged, revision: data.revision }
    })
    if (!result.conflicts.length) void queue.drain().catch(() => undefined)
    return result
  }

  return {
    async initializeFromLegacy(create: (legacyProjects: readonly string[]) => WorkspaceInitialization) {
      if (await getManifest()) return
      await local.initializeFromLegacy(create)
    },
    getManifest,
    synchronizeCanvas,
    async confirmedCanvasRevision(canvasId) {
      await retry()
      const current = await local.readSyncRecord()
      const revision = Math.max(current.versions.canvasRevisions[canvasId] ?? 0, confirmedDocuments.get(canvasId)?.revision ?? 0)
      if (!revision) throw new Error('画布尚未保存到服务器')
      return revision
    },
    async getCanvasDocument(canvasId, options) {
      const memory = memoryCanvas(canvasId)
      if (memory?.mutation.kind === 'save-canvas') {
        if (options?.requireRemote) throw new Error('请先保存本地修改，再完成协作交接')
        canvasBasis.set(canvasId, memory.mutation.expectedRevision)
        return loadedDocument(JSON.stringify(memory.mutation.canvas))
      }
      const initial = await local.readSyncSnapshot(canvasId)
      if (options?.requireRemote && (initial.record.pending.length || unpersisted.size)) throw new Error('请先处理未同步修改，再完成协作交接')
      let uncached: CanvasDocumentResponse | undefined
      let missing = false
      if (!initial.record.pending.length && !unpersisted.size) {
        try {
          const data = await request<CanvasDocumentResponse>(`/api/canvases/${encodeURIComponent(canvasId)}`)
          const parsed = parseCanvasSnapshot(JSON.stringify(data.canvas))
          if (parsed.canvasId !== canvasId || !Number.isSafeInteger(data.revision)) throw new Error('画布版本信息无效')
          uncached = { ...data, canvas: parsed }
          await local.transactSync((current) => {
            if (current.pending.length || unpersisted.size || data.revision < (current.cachedCanvasRevisions[canvasId] ?? 0)) return undefined
            current.versions.canvasRevisions[canvasId] = data.revision
            current.localVersions.canvasRevisions[canvasId] = data.revision
            current.cachedCanvasRevisions[canvasId] = data.revision
            ;(current.canvasBases ??= {})[canvasId] = { revision: data.revision, canvas: parsed }
            return { putDocuments: [{ canvasId, serialized: JSON.stringify(parsed) }] }
          })
          uncached = undefined
          confirmedDocuments.set(canvasId, { revision: data.revision, canvas: parsed })
        } catch (error) {
          if (options?.requireRemote && !uncached) throw error
          if ((error as { status?: number }).status === 404) {
            missing = true
            await local.transactSync((current) => {
              if (current.pending.length || unpersisted.size) return undefined
              delete current.cachedCanvasRevisions[canvasId]
              return { deleteCanvasIds: [canvasId] }
            }).catch(() => undefined)
          }
        }
      }
      const { record: current, document } = await local.readSyncSnapshot(canvasId)
      if (options?.requireRemote && (current.pending.length || unpersisted.size)) throw new Error('协作交接时出现未同步修改，请重试')
      const latestMemory = memoryCanvas(canvasId)
      if (latestMemory?.mutation.kind === 'save-canvas') {
        canvasBasis.set(canvasId, latestMemory.mutation.expectedRevision)
        return loadedDocument(JSON.stringify(latestMemory.mutation.canvas))
      }
      if (uncached && !current.pending.length && !unpersisted.size && uncached.revision >= (current.cachedCanvasRevisions[canvasId] ?? 0)) {
        canvasBasis.set(canvasId, uncached.revision)
        return loadedDocument(JSON.stringify(uncached.canvas))
      }
      if (missing && !current.pending.length && !unpersisted.size) { canvasBasis.delete(canvasId); return undefined }
      canvasBasis.set(canvasId, current.cachedCanvasRevisions[canvasId] ?? 0)
      return loadedDocument(document)
    },
    commit,
    stageCanvasSave,
    async saveCanvas(snapshot, serializedManifest) {
      await (await stageCanvasSave(snapshot, serializedManifest))()
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getState: () => state,
    retry: () => retry(true),
    exportRecovery,
    start() {
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let delay = 2_000
      let firstWake = true
      const wake = () => {
        if (stopped) return
        clearTimeout(timer)
        const recheck = firstWake; firstWake = false
        void retry(recheck).then(() => { delay = 2_000 }, () => { delay = Math.min(delay * 2, 30_000) }).finally(() => {
          if (!stopped) timer = setTimeout(wake, delay)
        })
      }
      const foreground = () => { if (document.visibilityState === 'visible') wake() }
      const beforeUnload = (event: BeforeUnloadEvent) => {
        if (unpersisted.size) { event.preventDefault(); event.returnValue = '' }
      }
      window.addEventListener('online', wake)
      window.addEventListener('focus', wake)
      document.addEventListener('visibilitychange', foreground)
      window.addEventListener('beforeunload', beforeUnload)
      wake()
      return () => { stopped = true; clearTimeout(timer); window.removeEventListener('online', wake); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', foreground); window.removeEventListener('beforeunload', beforeUnload) }
    },
    async resolveConflict(choice) {
      await queue.drain().catch(() => undefined)
      const captured = await local.readSyncRecord()
      if (!captured.pending.length) return
      const remote = await fetchManifest()
      let finalReceipt: WorkspaceMutationReceipt | undefined
      let copies: Array<{ canvasId: string; serialized: string }> = []
      let sourceOperationIds = captured.pending.map((operation) => operation.operationId)
      if (choice === 'copy' && !captured.recovery) {
        const snapshots = new Map<string, CanvasSnapshotV2>()
        // Tabs can queue independent branches of the same canvas. Only exact
        // duplicate snapshots are safe to collapse when preserving local work.
        const retainSnapshot = (snapshot: CanvasSnapshotV2) => snapshots.set(JSON.stringify(snapshot), snapshot)
        for (const operation of captured.pending) {
          const mutation = operation.mutation
          if (mutation.kind === 'save-canvas') retainSnapshot(mutation.canvas)
          else for (const doc of mutation.commit.putDocuments ?? []) retainSnapshot(parseCanvasSnapshot(doc.serialized))
        }
        if (!snapshots.size) throw new Error('这些修改涉及工作区结构，请先导出本地恢复副本，再选择服务器版本。')
        const next = structuredClone(remote.manifest)
        const expectedCanvasRevisions: Record<string, number> = {}
        const timestamp = new Date().toISOString()
        for (const snapshot of snapshots.values()) {
          const id = createBrowserUuid()
          const copy = { ...structuredClone(snapshot), canvasId: id, projectId: id, name: `${Array.from(snapshot.name).slice(0, 54).join('')} 副本` }
          copies.push({ canvasId: id, serialized: JSON.stringify(copy) })
          expectedCanvasRevisions[id] = 0
          next.canvases.push({ canvasId: id, projectId: id, name: copy.name, nodeCount: copy.nodes.length,
            position: { x: copies.length * 36, y: copies.length * 36 }, favorite: false, createdAt: timestamp, updatedAt: timestamp })
        }
        const mutation = { protocolVersion: 1 as const, operationId: createBrowserUuid(),
          kind: 'edit-workspace' as const, expectedWorkspaceRevision: remote.workspaceRevision, expectedCanvasRevisions,
          commit: { manifest: next, putDocuments: copies } }
        await local.transactSync((current) => {
          if (current.pending.some((operation) => !sourceOperationIds.includes(operation.operationId))) throw new Error('仍有新的本地修改，请稍后重试')
          current.recovery = { sourceOperationIds, mutation }
          return undefined
        })
      }
      if (choice === 'copy') {
        const recovery = (await local.readSyncRecord()).recovery!
        sourceOperationIds = recovery.sourceOperationIds
        copies = recovery.mutation.commit.putDocuments ?? []
        try { finalReceipt = await send(recovery.mutation) }
        catch (error) {
          // A definite conflict was not accepted. A timeout must reuse the exact saved request.
          if ((error as { status?: number }).status === 409) await local.transactSync((current) => { delete current.recovery; return undefined })
          throw error
        }
      }
      const version = finalReceipt ?? remote
      await local.transactSync((current) => {
        const capturedIds = new Set(sourceOperationIds)
        current.pending = current.pending.filter((operation) => !capturedIds.has(operation.operationId))
        const resolvedIds = captured.pending.flatMap(operation => operation.mutation.kind === 'save-canvas' ? [operation.mutation.canvas.canvasId] : Object.keys(operation.mutation.expectedCanvasRevisions))
        for (const id of resolvedIds) if (current.canvasConflicts) delete current.canvasConflicts[id]
        delete current.recovery
        if (current.pending.length) {
          mergeWorkspaceVersions(current.versions, version)
          for (const copy of copies) current.cachedCanvasRevisions[copy.canvasId] = version.canvasRevisions[copy.canvasId] ?? 0
          return { putDocuments: copies }
        }
        current.versions = { workspaceRevision: version.workspaceRevision, canvasRevisions: structuredClone(version.canvasRevisions) }
        current.localVersions = structuredClone(current.versions)
        const ids = new Set(captured.pending.flatMap((operation) => operation.mutation.kind === 'save-canvas'
          ? [operation.mutation.canvas.canvasId] : (operation.mutation.commit.putDocuments ?? []).map((doc) => doc.canvasId)))
        for (const id of ids) delete current.cachedCanvasRevisions[id]
        for (const copy of copies) current.cachedCanvasRevisions[copy.canvasId] = version.canvasRevisions[copy.canvasId] ?? 0
        return { manifest: version.manifest, deleteCanvasIds: [...ids], putDocuments: copies }
      })
      contentBasis.clear(); canvasBasis.clear(); manifestBasis = undefined; workspaceBasis = undefined
      await queue.refresh()
      if ((await local.readSyncRecord()).pending.length) throw new Error('副本已保存，较新的本地修改仍在等待处理。')
    },
  }
}
