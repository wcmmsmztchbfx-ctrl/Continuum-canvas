import { describe, expect, it, vi } from 'vitest'
import { createServerWorkspaceBackend } from './serverWorkspaceBackend'
import { emptyWorkspaceSyncRecord, type WorkspaceCacheChange, type WorkspaceSyncStorageBackend } from './workspaceSyncState'
import type { CanvasSnapshotV2 } from '../model/project'
import type { WorkspaceManifestV1 } from '../workspace/model'
import type { WorkspaceMutation } from '../workspace/persistenceProtocol'
import { createWorkspaceRepository } from '../workspace/repository'

const canvas: CanvasSnapshotV2 = { version: 3, canvasId: 'canvas-a', projectId: 'canvas-a', name: 'original', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }
const manifest: WorkspaceManifestV1 = { version: 1, projects: [], pendingOperations: [], viewport: { x: 0, y: 0, zoom: 1 }, canvases: [{ canvasId: 'canvas-a', projectId: 'canvas-a', name: 'original', nodeCount: 0, position: { x: 0, y: 0 }, favorite: false, createdAt: 'now', updatedAt: 'now' }] }

export function memorySyncBackend() {
  let sync = emptyWorkspaceSyncRecord()
  let localManifest: string | undefined
  const docs = new Map<string, string>()
  const apply = (change?: WorkspaceCacheChange) => {
    if (change?.manifest !== undefined) localManifest = typeof change.manifest === 'string' ? change.manifest : JSON.stringify(change.manifest)
    for (const doc of change?.putDocuments ?? []) docs.set(doc.canvasId, doc.serialized)
    for (const id of change?.deleteCanvasIds ?? []) docs.delete(id)
  }
  return {
    initializeFromLegacy: async () => {}, getManifest: async () => localManifest,
    getCanvasDocument: async (id) => docs.get(id), commit: async (change) => { apply(change) },
    readSyncRecord: async () => structuredClone(sync),
    readSyncSnapshot: async (id) => ({ record: structuredClone(sync), manifest: localManifest, document: id ? docs.get(id) : undefined }),
    transactSync: async (update) => { const next = structuredClone(sync); const change = update(next, localManifest); apply(change); sync = next },
  } satisfies WorkspaceSyncStorageBackend
}

function server() {
  let document = structuredClone(canvas)
  let workspace = structuredClone(manifest)
  let revision = 1
  let canvasRevision = 1
  let offline = false
  let loseResponse = false
  const requests: WorkspaceMutation[] = []
  const receipts = new Map<string, unknown>()
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(_url)
    if (init?.method === 'POST') {
      const mutation = JSON.parse(String(init.body)) as WorkspaceMutation
      requests.push(mutation)
      if (offline) throw new TypeError('offline')
      if (receipts.has(mutation.operationId)) return Response.json(receipts.get(mutation.operationId))
      const expected = mutation.kind === 'save-canvas' ? mutation.expectedRevision : mutation.expectedWorkspaceRevision
      if (expected !== (mutation.kind === 'save-canvas' ? canvasRevision : revision)) return Response.json({ error: { message: 'conflict' } }, { status: 409 })
      if (mutation.kind === 'save-canvas') { document = structuredClone(mutation.canvas); canvasRevision++ }
      else workspace = typeof mutation.commit.manifest === 'string' ? JSON.parse(mutation.commit.manifest) : structuredClone(mutation.commit.manifest)
      revision++
      workspace.canvases[0]!.name = document.name
      const receipt = { protocolVersion: 1, operationId: mutation.operationId, workspaceRevision: revision, canvasRevisions: { 'canvas-a': canvasRevision }, manifest: workspace }
      receipts.set(mutation.operationId, structuredClone(receipt))
      if (loseResponse) { loseResponse = false; throw new TypeError('response lost') }
      return Response.json(receipt)
    }
    if (url.endsWith('/manifest')) return Response.json({ manifest: workspace, workspaceRevision: revision, canvasRevisions: { 'canvas-a': canvasRevision } })
    return Response.json({ canvas: document, revision: canvasRevision, workspaceRevision: revision })
  }
  return { fetchImpl, requests, setOffline: (value: boolean) => { offline = value }, loseNextResponse: () => { loseResponse = true }, changeRemote: () => { document.name = 'remote edit'; revision++; canvasRevision++ }, document: () => document, revision: () => revision, manifest: () => structuredClone(workspace) }
}

describe('workspace synchronization integration', () => {
  it('refuses a cached document when collaboration handoff requires a remote read', async () => {
    const local = memorySyncBackend(), remote = server()
    let disconnected = false
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: async (url, init) => {
      if (disconnected) throw new Error('disconnected')
      return remote.fetchImpl(url, init)
    } })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    disconnected = true
    await expect(createWorkspaceRepository(backend).loadCanvas('canvas-a', { requireRemote: true })).rejects.toThrow()
    expect(JSON.parse((await backend.getCanvasDocument('canvas-a'))!).name).toBe('original')
  })
  it('durably stages later edits while an earlier server response is still pending', async () => {
    const local = memorySyncBackend(), remote = server()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let began!: () => void
    const started = new Promise<void>((resolve) => { began = resolve })
    let blocked = false
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: async (url, init) => {
      if (init?.method === 'POST' && !blocked) { blocked = true; began(); await gate }
      return remote.fetchImpl(url, init)
    } })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    const repository = createWorkspaceRepository(backend)
    const first = repository.saveCanvas({ ...canvas, name: 'first' })
    await started
    const second = repository.saveCanvas({ ...canvas, name: 'second' })
    try {
      await vi.waitFor(async () => expect((await local.readSyncRecord()).pending).toHaveLength(2), { timeout: 150 })
      expect(JSON.parse((await local.getCanvasDocument('canvas-a'))!).name).toBe('second')
    } finally { release(); await Promise.all([first, second]) }
    expect(remote.document().name).toBe('second')
  })
  it('persists edits without waiting for another remote manifest read', async () => {
    const local = memorySyncBackend(), remote = server()
    const fetchImpl = vi.fn(remote.fetchImpl)
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    fetchImpl.mockClear()
    await createWorkspaceRepository(backend).saveCanvas({ ...canvas, name: 'edited' })
    expect(fetchImpl.mock.calls.filter(([, options]) => options?.method !== 'POST')).toHaveLength(0)
    expect(remote.document().name).toBe('edited')
  })
  it('keeps local edits on a fresh backend while online GET still returns the old server version', async () => {
    const local = memorySyncBackend()
    const remote = server()
    const first = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: remote.fetchImpl })
    await first.getManifest(); await first.getCanvasDocument('canvas-a')
    remote.setOffline(true)
    await expect(first.saveCanvas({ ...canvas, name: 'offline edit' }, JSON.stringify(manifest))).rejects.toMatchObject({ savedLocally: true })
    const reopened = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: remote.fetchImpl })
    expect(JSON.parse((await reopened.getCanvasDocument('canvas-a'))!).name).toBe('offline edit')
    remote.setOffline(false)
    await reopened.retry()
    expect(remote.document().name).toBe('offline edit')
    expect((await local.readSyncRecord()).pending).toEqual([])
  })

  it('reuses the operation ID after server success followed by response loss', async () => {
    const local = memorySyncBackend(), remote = server()
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: remote.fetchImpl })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    remote.loseNextResponse()
    await expect(backend.saveCanvas({ ...canvas, name: 'once' }, JSON.stringify(manifest))).rejects.toMatchObject({ savedLocally: true })
    await backend.retry()
    expect(remote.revision()).toBe(2)
    expect(remote.requests[0]?.operationId).toBe(remote.requests[1]?.operationId)
  })

  it('does not adopt a new canvas revision from a manifest refresh while editing an older document', async () => {
    const local = memorySyncBackend(), remote = server()
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: remote.fetchImpl })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    remote.changeRemote()
    await backend.getManifest()
    await expect(backend.saveCanvas({ ...canvas, name: 'local edit' }, JSON.stringify(manifest))).rejects.toMatchObject({ savedLocally: true })
    expect(remote.requests[0]).toMatchObject({ kind: 'save-canvas', expectedRevision: 1 })
    expect(backend.getState().phase).toBe('conflict')
    expect(remote.document().name).toBe('remote edit')
    expect(JSON.parse((await local.getCanvasDocument('canvas-a'))!).name).toBe('local edit')
  })

  it('preserves causal revisions for consecutive offline saves', async () => {
    const local = memorySyncBackend(), remote = server()
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: remote.fetchImpl })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    remote.setOffline(true)
    await expect(backend.saveCanvas({ ...canvas, name: 'first' }, JSON.stringify(manifest))).rejects.toThrow()
    await expect(backend.saveCanvas({ ...canvas, name: 'second' }, JSON.stringify(manifest))).rejects.toThrow()
    remote.setOffline(false)
    await backend.retry()
    expect(remote.document().name).toBe('second')
    expect(remote.revision()).toBe(3)
  })

  it('reports both failures if local storage and the network fail', async () => {
    const local = memorySyncBackend(), remote = server()
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: remote.fetchImpl })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    local.transactSync = async () => { throw new Error('quota exceeded') }
    remote.setOffline(true)
    await expect(backend.saveCanvas(canvas, JSON.stringify(manifest))).rejects.toMatchObject({ savedLocally: false, localCause: expect.any(Error), remoteCause: expect.any(Error) })
    expect(backend.getState().phase).toBe('error')
  })

  it('retains a double failure for retry and recovery export instead of reporting an empty queue as synced', async () => {
    const local = memorySyncBackend(), remote = server()
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: remote.fetchImpl })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    const transact = local.transactSync
    local.transactSync = async () => { throw new Error('quota exceeded') }
    remote.setOffline(true)
    await expect(backend.saveCanvas({ ...canvas, name: 'only in memory' })).rejects.toThrow()
    await backend.retry().catch(() => undefined)
    expect(backend.getState().phase).toBe('error')
    expect(await backend.exportRecovery()).toContain('only in memory')
    local.transactSync = transact
    remote.setOffline(false)
    await backend.retry()
    expect(remote.document().name).toBe('only in memory')
    expect(backend.getState().phase).toBe('synced')
  })

  it.each([false, true])('retires an older failed memory save after a newer save is confirmed (queued offline: %s)', async (queuedOffline) => {
    const local = memorySyncBackend(), remote = server()
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: remote.fetchImpl })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    const transact = local.transactSync
    local.transactSync = async () => { throw new Error('quota exceeded') }
    remote.setOffline(true)
    await expect(backend.saveCanvas({ ...canvas, name: 'older failed edit' })).rejects.toThrow()
    local.transactSync = transact
    if (queuedOffline) {
      await expect(backend.saveCanvas({ ...canvas, name: 'newer confirmed edit' })).rejects.toMatchObject({ savedLocally: true })
      expect(await backend.exportRecovery()).toContain('older failed edit')
    }
    remote.setOffline(false)
    if (queuedOffline) await backend.retry()
    else await backend.saveCanvas({ ...canvas, name: 'newer confirmed edit' })
    expect(remote.document().name).toBe('newer confirmed edit')
    expect(JSON.parse((await backend.getCanvasDocument('canvas-a'))!).name).toBe('newer confirmed edit')
    expect(backend.getState().phase).toBe('synced')
    expect(JSON.parse(await backend.exportRecovery()).unpersisted).toEqual([])
    await backend.retry()
    expect(remote.document().name).toBe('newer confirmed edit')
  })

  it.each(['manifest', 'canvas'] as const)('protects failed memory edits from a late %s GET and further background reads', async (kind) => {
    const local = memorySyncBackend(), remote = server()
    let pause = false, release!: () => void, began!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { began = resolve })
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const response = await remote.fetchImpl(url, init)
      if (pause && !init?.method) { began(); await gate }
      return response
    })
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    remote.changeRemote(); pause = true
    const loading = kind === 'manifest' ? backend.getManifest() : backend.getCanvasDocument('canvas-a')
    await started
    const transact = local.transactSync
    local.transactSync = async () => { throw new Error('quota exceeded') }
    remote.setOffline(true)
    await expect(backend.saveCanvas({ ...canvas, name: 'unsaved memory edit' })).rejects.toThrow()
    local.transactSync = transact
    release()
    const loaded = await loading
    if (kind === 'canvas') expect(JSON.parse(loaded!).name).toBe('unsaved memory edit')
    expect(JSON.parse((await local.getCanvasDocument('canvas-a'))!).name).toBe('original')
    expect((await local.readSyncRecord()).versions.workspaceRevision).toBe(1)
    const requests = fetchImpl.mock.calls.length
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    expect(fetchImpl).toHaveBeenCalledTimes(requests)
    expect(backend.getState().phase).toBe('error')
    expect(await backend.exportRecovery()).toContain('unsaved memory edit')
  })

  it('pairs an old replayed receipt with its own manifest revision even after another tab learned a newer revision', async () => {
    const local = memorySyncBackend(), remote = server()
    let offline = false
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: async (url, init) => {
      if (offline) throw new Error('offline')
      return remote.fetchImpl(url, init)
    } })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    const transact = local.transactSync
    local.transactSync = async () => { throw new Error('quota exceeded') }
    remote.loseNextResponse()
    await expect(backend.saveCanvas({ ...canvas, name: 'accepted response lost' })).rejects.toThrow()
    local.transactSync = transact
    remote.changeRemote()
    // A different tab can refresh the shared cache while this tab retains a failed request.
    await local.transactSync((record) => {
      record.versions.workspaceRevision = record.localVersions.workspaceRevision = 3
      return { manifest: { ...manifest, viewport: { x: 100, y: 0, zoom: 1 } } }
    })
    await backend.retry()
    const cached = await local.readSyncSnapshot()
    expect(JSON.parse(cached.manifest!).viewport.x).toBe(0)
    expect(cached.record.versions.workspaceRevision).toBe(3)
    expect(cached.record.localVersions.workspaceRevision).toBe(2)
    offline = true
    await expect(createWorkspaceRepository(backend).updateViewport({ x: 77, y: 0, zoom: 1 })).rejects.toThrow()
    offline = false
    await expect(backend.retry()).rejects.toThrow()
    expect(remote.requests.at(-1)).toMatchObject({ kind: 'edit-workspace', expectedWorkspaceRevision: 2 })
    expect(remote.revision()).toBe(3)
    expect(backend.getState().phase).toBe('conflict')
  })

  it('keeps newer workspace structure when retrying an old memory canvas save before another workspace edit', async () => {
    const local = memorySyncBackend(), remote = server()
    let pause = false, release!: () => void, began!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { began = resolve })
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: async (url, init) => {
      if (pause && init?.method === 'POST' && JSON.parse(String(init.body)).kind === 'save-canvas') { began(); await gate }
      return remote.fetchImpl(url, init)
    } })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    const transact = local.transactSync
    local.transactSync = async () => { throw new Error('quota exceeded') }
    remote.setOffline(true)
    await expect(backend.saveCanvas({ ...canvas, name: 'failed memory canvas' })).rejects.toThrow()
    local.transactSync = transact
    remote.setOffline(false)
    const project = { projectId: 'project-c', name: 'keep project C', position: { x: 12, y: 34 }, size: { width: 620, height: 380 }, favorite: false, createdAt: 'now', updatedAt: 'now' }
    await backend.commit({ manifest: { ...manifest, projects: [project] } })
    expect(remote.manifest().projects).toEqual([project])
    pause = true
    const retrying = backend.retry()
    await started
    const editing = createWorkspaceRepository(backend).updateViewport({ x: 77, y: 0, zoom: 1 })
    try { await vi.waitFor(async () => expect((await local.readSyncRecord()).pending).toHaveLength(2)) }
    finally { release(); await Promise.all([retrying, editing]) }
    expect(remote.manifest().projects).toEqual([project])
    expect(remote.manifest().viewport.x).toBe(77)
    expect(remote.document().name).toBe('failed memory canvas')
    expect(JSON.parse((await local.getManifest())!).projects).toEqual([project])
  })

  it('persists the exact recovery-copy operation across a lost response and reload', async () => {
    const local = memorySyncBackend(), remote = server()
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: remote.fetchImpl })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    remote.changeRemote()
    await expect(backend.saveCanvas({ ...canvas, name: 'keep this' }, JSON.stringify(manifest))).rejects.toThrow()
    remote.loseNextResponse()
    await expect(backend.resolveConflict('copy')).rejects.toThrow('response lost')
    const reopened = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: remote.fetchImpl })
    await reopened.resolveConflict('copy')
    const copies = remote.requests.filter((input) => input.kind === 'edit-workspace')
    expect(copies).toHaveLength(2)
    expect(copies[0]).toEqual(copies[1])
    expect(remote.revision()).toBe(3)
    expect((await local.readSyncRecord()).pending).toEqual([])
  })

  it('does not label an old cached canvas with a newer manifest revision after reopening offline', async () => {
    const local = memorySyncBackend(), remote = server()
    const initial = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: remote.fetchImpl })
    await initial.getManifest(); await initial.getCanvasDocument('canvas-a')
    remote.changeRemote()
    const reopened = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: async (url, init) => {
      if (String(url).includes('/api/canvases/')) throw new Error('canvas temporarily offline')
      return remote.fetchImpl(url, init)
    } })
    await reopened.getManifest()
    expect(JSON.parse((await reopened.getCanvasDocument('canvas-a'))!).name).toBe('original')
    await expect(reopened.saveCanvas({ ...canvas, name: 'stale cache edited' })).rejects.toMatchObject({ savedLocally: true })
    expect(remote.requests[0]).toMatchObject({ expectedRevision: 1 })
    expect(remote.document().name).toBe('remote edit')
  })

  it('ignores a late manifest response older than an already confirmed save', async () => {
    const local = memorySyncBackend(), remote = server()
    let pause = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const requestStarted = new Promise<void>((resolve) => { started = resolve })
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: async (url, init) => {
      const response = await remote.fetchImpl(url, init)
      if (pause && String(url).endsWith('/manifest')) { started(); await gate }
      return response
    } })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    pause = true
    const loading = backend.getManifest()
    await requestStarted
    await backend.saveCanvas({ ...canvas, name: 'confirmed newer' })
    release(); await loading
    expect(JSON.parse((await local.getManifest())!).canvases[0].name).toBe('confirmed newer')
  })

  it('returns a fresh validated server document when the cache cannot be written', async () => {
    const local = memorySyncBackend(), remote = server()
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: remote.fetchImpl })
    await backend.getManifest(); await backend.getCanvasDocument('canvas-a')
    remote.changeRemote()
    local.transactSync = async () => { throw new Error('quota exceeded') }
    expect(JSON.parse((await backend.getCanvasDocument('canvas-a'))!).name).toBe('remote edit')
    await backend.saveCanvas({ ...canvas, name: 'edited remote' }, JSON.stringify(manifest))
    expect(remote.document().name).toBe('edited remote')
  })

  it('pairs the returned manifest with its atomically read revision during another tab commit', async () => {
    const local = memorySyncBackend(), remote = server()
    const backend = createServerWorkspaceBackend({ fallbackBackend: local, fetchImpl: remote.fetchImpl })
    await backend.getManifest()
    const readManifest = local.getManifest, readSnapshot = local.readSyncSnapshot
    let changed = false, atomicReads = 0
    const anotherTab = async () => {
      if (changed) return
      changed = true; remote.changeRemote()
      await local.transactSync((record) => {
        record.versions.workspaceRevision = record.localVersions.workspaceRevision = 2
        return { manifest: { ...manifest, viewport: { x: 99, y: 0, zoom: 1 } } }
      })
    }
    local.getManifest = async () => { const result = await readManifest(); await anotherTab(); return result }
    local.readSyncSnapshot = async (id) => { const result = await readSnapshot(id); if (++atomicReads === 2) await anotherTab(); return result }
    const loaded = JSON.parse((await backend.getManifest())!) as WorkspaceManifestV1
    expect(changed).toBe(true)
    expect(loaded.viewport.x).toBe(0)
    await expect(backend.commit({ manifest: { ...loaded, viewport: { x: 30, y: 0, zoom: 1 } } })).rejects.toThrow()
    expect(remote.requests[0]).toMatchObject({ expectedWorkspaceRevision: 1 })
  })
})
