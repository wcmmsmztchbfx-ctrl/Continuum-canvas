import { describe, expect, it } from 'vitest'

import type { CanvasSnapshotV2 } from '../model/project'
import type { WorkspaceManifestV1 } from '../workspace/model'
import type { WorkspaceMutation, WorkspaceMutationReceipt } from '../workspace/persistenceProtocol'
import { createServerWorkspaceBackend } from './serverWorkspaceBackend'
import { emptyWorkspaceSyncRecord, type WorkspaceCacheChange, type WorkspaceSyncStorageBackend } from './workspaceSyncState'

const original: CanvasSnapshotV2 = {
  version: 3, canvasId: 'canvas-a', projectId: 'canvas-a', name: 'original',
  viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
}
const initialManifest: WorkspaceManifestV1 = {
  version: 1, projects: [], pendingOperations: [], viewport: { x: 0, y: 0, zoom: 1 },
  canvases: [{ canvasId: 'canvas-a', projectId: 'canvas-a', name: 'original', nodeCount: 0,
    position: { x: 0, y: 0 }, favorite: false, createdAt: 'now', updatedAt: 'now' }],
}

function memoryStorage(): WorkspaceSyncStorageBackend {
  let record = emptyWorkspaceSyncRecord()
  let manifest: string | undefined
  const documents = new Map<string, string>()
  const apply = (change?: WorkspaceCacheChange) => {
    if (change?.manifest !== undefined) manifest = typeof change.manifest === 'string' ? change.manifest : JSON.stringify(change.manifest)
    for (const document of change?.putDocuments ?? []) documents.set(document.canvasId, document.serialized)
    for (const id of change?.deleteCanvasIds ?? []) documents.delete(id)
  }
  return {
    initializeFromLegacy: async () => {}, getManifest: async () => manifest,
    getCanvasDocument: async (id) => documents.get(id), commit: async (change) => apply(change),
    readSyncRecord: async () => structuredClone(record),
    readSyncSnapshot: async (id) => ({ record: structuredClone(record), manifest, document: id ? documents.get(id) : undefined }),
    transactSync: async (update) => { const next = structuredClone(record); const change = update(next, manifest); apply(change); record = next },
  }
}

function server() {
  let workspace = structuredClone(initialManifest)
  let workspaceRevision = 1
  let offline = false
  let loseCopyResponse = false
  const canvasRevisions: Record<string, number> = { 'canvas-a': 1 }
  const documents = new Map<string, CanvasSnapshotV2>([['canvas-a', structuredClone(original)]])
  const requests: WorkspaceMutation[] = []
  const receipts = new Map<string, WorkspaceMutationReceipt>()
  const fetchImpl: typeof fetch = async (input, init) => {
    if (init?.method === 'POST') {
      const mutation = JSON.parse(String(init.body)) as WorkspaceMutation
      requests.push(mutation)
      if (offline) throw new TypeError('offline')
      if (receipts.has(mutation.operationId)) return Response.json(receipts.get(mutation.operationId))
      if (mutation.kind === 'save-canvas') {
        const id = mutation.canvas.canvasId
        if (mutation.expectedRevision !== (canvasRevisions[id] ?? 0)) return Response.json({}, { status: 409 })
        documents.set(id, structuredClone(mutation.canvas))
        workspace.canvases.find((canvas) => canvas.canvasId === id)!.name = mutation.canvas.name
        canvasRevisions[id] = (canvasRevisions[id] ?? 0) + 1
      } else {
        if (mutation.expectedWorkspaceRevision !== workspaceRevision ||
            Object.entries(mutation.expectedCanvasRevisions).some(([id, revision]) => revision !== (canvasRevisions[id] ?? 0))) {
          return Response.json({}, { status: 409 })
        }
        workspace = typeof mutation.commit.manifest === 'string' ? JSON.parse(mutation.commit.manifest) : structuredClone(mutation.commit.manifest)
        for (const document of mutation.commit.putDocuments ?? []) documents.set(document.canvasId, JSON.parse(document.serialized))
        for (const id of Object.keys(mutation.expectedCanvasRevisions)) canvasRevisions[id] = (canvasRevisions[id] ?? 0) + 1
      }
      workspaceRevision++
      const receipt: WorkspaceMutationReceipt = structuredClone({
        protocolVersion: 1, operationId: mutation.operationId, workspaceRevision, canvasRevisions, manifest: workspace,
      })
      receipts.set(mutation.operationId, receipt)
      if (loseCopyResponse && mutation.kind === 'edit-workspace') { loseCopyResponse = false; throw new TypeError('response lost') }
      return Response.json(receipt)
    }
    const url = String(input)
    if (url.endsWith('/manifest')) return Response.json({ manifest: workspace, workspaceRevision, canvasRevisions })
    const id = url.split('/').at(-1)!
    return Response.json({ canvas: documents.get(id), revision: canvasRevisions[id], workspaceRevision })
  }
  return {
    fetchImpl, requests, documents,
    setOffline: (value: boolean) => { offline = value },
    loseNextCopyResponse: () => { loseCopyResponse = true },
  }
}

async function conflictingTabs(duplicateLastSnapshot = false) {
  const local = memoryStorage(), remote = server()
  const options = { fallbackBackend: local, fetchImpl: remote.fetchImpl }
  const firstTab = createServerWorkspaceBackend(options), secondTab = createServerWorkspaceBackend(options)
  for (const tab of [firstTab, secondTab]) { await tab.getManifest(); await tab.getCanvasDocument('canvas-a') }
  remote.setOffline(true)
  for (const [tab, name] of [[firstTab, 'A first'], [secondTab, 'B independent edit'], [firstTab, 'A second']] as const) {
    await expect(tab.saveCanvas({ ...original, name })).rejects.toMatchObject({ savedLocally: true })
  }
  if (duplicateLastSnapshot) await expect(firstTab.saveCanvas({ ...original, name: 'A second' })).rejects.toThrow()
  remote.setOffline(false)
  await expect(firstTab.retry()).rejects.toThrow()
  expect(remote.documents.get('canvas-a')!.name).toBe('A first')
  return { local, remote, options, firstTab }
}

describe('workspace conflict recovery copies', () => {
  it('retains both independent snapshots of one canvas from tabs sharing the local journal', async () => {
    const { local, remote, firstTab } = await conflictingTabs()
    await firstTab.resolveConflict('copy')
    expect([...remote.documents.values()].map((document) => document.name).sort()).toEqual([
      'A first', 'A second 副本', 'B independent edit 副本',
    ])
    expect((await local.readSyncRecord()).pending).toEqual([])
    const localManifest = JSON.parse((await local.getManifest())!) as WorkspaceManifestV1
    for (const copy of localManifest.canvases.filter((canvas) => canvas.canvasId !== 'canvas-a')) {
      expect(JSON.parse((await local.getCanvasDocument(copy.canvasId))!).name).toBe(copy.name)
    }
  })

  it('deduplicates identical pending snapshots without dropping different content for the same canvas', async () => {
    const { remote, firstTab } = await conflictingTabs(true)
    await firstTab.resolveConflict('copy')
    expect([...remote.documents.values()].map((document) => document.name).sort()).toEqual([
      'A first', 'A second 副本', 'B independent edit 副本',
    ])
  })

  it('reuses the complete multi-copy operation after response loss and reopening', async () => {
    const { local, remote, options, firstTab } = await conflictingTabs()
    remote.loseNextCopyResponse()
    await expect(firstTab.resolveConflict('copy')).rejects.toThrow('response lost')
    expect((await local.readSyncRecord()).pending).toHaveLength(2)
    const persistedRecovery = (await local.readSyncRecord()).recovery!
    expect(persistedRecovery.mutation.commit.putDocuments).toHaveLength(2)
    await createServerWorkspaceBackend(options).resolveConflict('copy')
    const copyRequests = remote.requests.filter((mutation) => mutation.kind === 'edit-workspace')
    expect(copyRequests).toEqual([persistedRecovery.mutation, persistedRecovery.mutation])
    expect([...remote.documents.values()].map((document) => document.name).sort()).toEqual([
      'A first', 'A second 副本', 'B independent edit 副本',
    ])
    expect((await local.readSyncRecord()).pending).toEqual([])
    expect((await local.readSyncRecord()).recovery).toBeUndefined()
  })
})
