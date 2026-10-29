import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { CanvasDocumentResponse, WorkspaceManifestResponse, WorkspaceMutation } from '../../../src/workspace/persistenceProtocol'
import { expect, test } from '../../fixtures/e2e-env'

async function openStorageHarness(page: Page) {
  await page.route('**/__storage-durability__', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Isolated storage checks</title>',
  }))
  await page.goto('/__storage-durability__')
}

test.describe('22 - Storage durability', () => {
  test('upgrades a real version 3 database while preserving all four existing stores', async ({ page }) => {
    await openStorageHarness(page)
    const result = await page.evaluate(async (databaseName) => {
      const requestValue = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const done = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
        transaction.onerror = () => reject(transaction.error)
      })
      const legacyOpen = indexedDB.open(databaseName, 3)
      legacyOpen.onupgradeneeded = () => {
        for (const [name, keyPath] of [['projects', 'projectId'], ['workspace-manifests', 'id'], ['canvas-documents', 'canvasId'], ['canvas-thumbnails', 'canvasId']]) {
          legacyOpen.result.createObjectStore(name!, { keyPath })
        }
      }
      const legacy = await requestValue(legacyOpen)
      const serializedProject = JSON.stringify({ version: 1, projectId: 'legacy-project', name: 'legacy project', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })
      const serializedManifest = JSON.stringify({ version: 1, projects: [], canvases: [], pendingOperations: [], viewport: { x: 12, y: 8, zoom: 1 } })
      const serializedCanvas = JSON.stringify({ version: 3, canvasId: 'legacy-canvas', projectId: 'legacy-project', name: 'legacy canvas', nodes: [], edges: [], viewport: { x: 4, y: 9, zoom: 1 } })
      const seed = legacy.transaction(['projects', 'workspace-manifests', 'canvas-documents', 'canvas-thumbnails'], 'readwrite')
      const seeded = done(seed)
      seed.objectStore('projects').put({ projectId: 'legacy-project', serialized: serializedProject })
      seed.objectStore('workspace-manifests').put({ id: 'workspace', serialized: serializedManifest })
      seed.objectStore('canvas-documents').put({ canvasId: 'legacy-canvas', serialized: serializedCanvas })
      seed.objectStore('canvas-thumbnails').put({ canvasId: 'legacy-canvas', blob: new Blob(['retained thumbnail'], { type: 'image/png' }), width: 64, height: 32, contentHash: 'old-hash', updatedAt: 'before-upgrade' })
      await seeded
      legacy.close()

      const modulePath = '/src/persistence/projectRepository.ts'
      const { createIndexedDbWorkspaceBackend } = await import(modulePath) as typeof import('../../../src/persistence/projectRepository')
      const backend = createIndexedDbWorkspaceBackend({ databaseName })
      const snapshot = await backend.readSyncSnapshot('legacy-canvas')
      const upgraded = await requestValue(indexedDB.open(databaseName))
      const storeNames = [...upgraded.objectStoreNames]
      const version = upgraded.version
      const read = upgraded.transaction(['projects', 'canvas-thumbnails'], 'readonly')
      const finished = done(read)
      const [project, thumbnail] = await Promise.all([
        requestValue(read.objectStore('projects').get('legacy-project')),
        requestValue(read.objectStore('canvas-thumbnails').get('legacy-canvas')),
      ])
      await finished
      upgraded.close()
      return { version, storeNames, project, snapshot, thumbnail: { ...thumbnail, blob: await (thumbnail.blob as Blob).text(), type: thumbnail.blob.type }, serializedProject, serializedManifest, serializedCanvas }
    }, `e2e-upgrade-${randomUUID()}`)

    expect(result.version).toBe(4)
    expect(result.storeNames.sort()).toEqual(['canvas-documents', 'canvas-thumbnails', 'projects', 'workspace-manifests', 'workspace-sync'])
    expect(result.project.serialized).toBe(result.serializedProject)
    expect(result.snapshot.manifest).toBe(result.serializedManifest)
    expect(result.snapshot.document).toBe(result.serializedCanvas)
    expect(result.snapshot.record.pending).toEqual([])
    expect(result.thumbnail).toMatchObject({ canvasId: 'legacy-canvas', blob: 'retained thumbnail', type: 'image/png', width: 64, height: 32, contentHash: 'old-hash', updatedAt: 'before-upgrade' })
  })

  test('rolls back manifest, sync record and document together when the document write exceeds quota', async ({ page }) => {
    await openStorageHarness(page)
    const result = await page.evaluate(async (databaseName) => {
      const modulePath = '/src/persistence/projectRepository.ts'
      const { createIndexedDbWorkspaceBackend, CANVAS_DOCUMENT_STORE_NAME } = await import(modulePath) as typeof import('../../../src/persistence/projectRepository')
      const backend = createIndexedDbWorkspaceBackend({ databaseName })
      const canvas = { version: 3 as const, canvasId: 'quota-canvas', projectId: 'quota-canvas', name: 'before', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }
      const manifest = { version: 1 as const, projects: [], pendingOperations: [], viewport: { x: 0, y: 0, zoom: 1 }, canvases: [{ canvasId: canvas.canvasId, projectId: canvas.projectId, name: canvas.name, nodeCount: 0, position: { x: 0, y: 0 }, favorite: false, createdAt: 'now', updatedAt: 'now' }] }
      await backend.transactSync((record) => {
        record.versions = { workspaceRevision: 1, canvasRevisions: { [canvas.canvasId]: 1 } }
        record.localVersions = structuredClone(record.versions)
        record.cachedCanvasRevisions[canvas.canvasId] = 1
        return { manifest, putDocuments: [{ canvasId: canvas.canvasId, serialized: JSON.stringify(canvas) }] }
      })
      const before = await backend.readSyncSnapshot(canvas.canvasId)
      const originalPut = IDBObjectStore.prototype.put
      let injected = false
      let failure: string | undefined
      try {
        IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
          if (this.name === CANVAS_DOCUMENT_STORE_NAME) {
            injected = true
            throw new DOMException('injected document quota failure', 'QuotaExceededError')
          }
          return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key)
        }
        const changedCanvas = { ...canvas, name: 'must roll back' }
        await backend.transactSync((record) => {
          record.nextSequence++
          record.localVersions.workspaceRevision = 2
          record.localVersions.canvasRevisions[canvas.canvasId] = 2
          record.cachedCanvasRevisions[canvas.canvasId] = 2
          record.pending.push({ operationId: 'quota-operation', sequence: 1, status: 'pending', mutation: { protocolVersion: 1, operationId: 'quota-operation', kind: 'save-canvas', expectedRevision: 1, canvas: changedCanvas } })
          return { manifest: { ...manifest, viewport: { x: 99, y: 0, zoom: 1 } }, putDocuments: [{ canvasId: canvas.canvasId, serialized: JSON.stringify(changedCanvas) }] }
        })
      } catch (error) {
        failure = error instanceof DOMException ? error.name : String(error)
      } finally {
        IDBObjectStore.prototype.put = originalPut
      }
      const reopened = createIndexedDbWorkspaceBackend({ databaseName })
      return { injected, failure, restoredPrototype: IDBObjectStore.prototype.put === originalPut, before, after: await reopened.readSyncSnapshot(canvas.canvasId) }
    }, `e2e-quota-${randomUUID()}`)

    expect(result.injected).toBe(true)
    expect(result.failure).toBe('QuotaExceededError')
    expect(result.restoredPrototype).toBe(true)
    expect(result.after).toEqual(result.before)
  })

  test('two pages sharing one outbox retry the same operation with one server revision increase', async ({ page, request }) => {
    const peer = await page.context().newPage()
    await Promise.all([openStorageHarness(page), openStorageHarness(peer)])
    const canvasId = 'e2e-reference-canvas'
    const beforeResponse = await request.get(`/api/canvases/${canvasId}`)
    const manifestResponse = await request.get('/api/workspace/manifest')
    expect(beforeResponse.ok()).toBe(true)
    expect(manifestResponse.ok()).toBe(true)
    const before = await beforeResponse.json() as CanvasDocumentResponse
    const versions = await manifestResponse.json() as WorkspaceManifestResponse
    const canvas = { ...before.canvas, name: '同一待同步操作只保存一次' }
    const manifest = structuredClone(versions.manifest)
    manifest.canvases.find((card) => card.canvasId === canvasId)!.name = canvas.name
    const operationId = randomUUID()
    const mutation: WorkspaceMutation = { protocolVersion: 1, operationId, kind: 'save-canvas', expectedRevision: before.revision, canvas }
    const databaseName = `e2e-two-tabs-${randomUUID()}`
    await page.evaluate(async ({ databaseName, mutation, manifest, versions, before }) => {
      const backendPath = '/src/persistence/projectRepository.ts', queuePath = '/src/persistence/workspaceSyncQueue.ts'
      const { createIndexedDbWorkspaceBackend } = await import(backendPath) as typeof import('../../../src/persistence/projectRepository')
      const { WorkspaceSyncQueue } = await import(queuePath) as typeof import('../../../src/persistence/workspaceSyncQueue')
      const backend = createIndexedDbWorkspaceBackend({ databaseName })
      await backend.transactSync((record) => {
        record.versions = { workspaceRevision: versions.workspaceRevision, canvasRevisions: versions.canvasRevisions }
        record.localVersions = structuredClone(record.versions)
        record.cachedCanvasRevisions[before.canvas.canvasId] = before.revision
        return { manifest: versions.manifest, putDocuments: [{ canvasId: before.canvas.canvasId, serialized: JSON.stringify(before.canvas) }] }
      })
      const queue = new WorkspaceSyncQueue(backend, async () => { throw new Error('enqueue must not send a request') })
      await queue.enqueue({ manifest, putDocuments: [{ canvasId: mutation.canvas.canvasId, serialized: JSON.stringify(mutation.canvas) }] }, mutation)
    }, { databaseName, mutation, manifest, versions, before })

    let release!: () => void
    const bothRequests = new Promise<void>((resolve) => { release = resolve })
    const operationIds: string[] = []
    await page.context().route('**/api/workspace/commit', async (route) => {
      const submitted = route.request().postDataJSON() as WorkspaceMutation
      if (submitted.operationId !== operationId) { await route.continue(); return }
      operationIds.push(submitted.operationId)
      if (operationIds.length === 2) release()
      await bothRequests
      await route.continue()
    })
    const drain = (target: Page) => target.evaluate(async (databaseName) => {
      const backendPath = '/src/persistence/projectRepository.ts', queuePath = '/src/persistence/workspaceSyncQueue.ts'
      const { createIndexedDbWorkspaceBackend } = await import(backendPath) as typeof import('../../../src/persistence/projectRepository')
      const { WorkspaceSyncQueue } = await import(queuePath) as typeof import('../../../src/persistence/workspaceSyncQueue')
      const backend = createIndexedDbWorkspaceBackend({ databaseName })
      const queue = new WorkspaceSyncQueue(backend, async (mutation) => {
        const response = await fetch('/api/workspace/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mutation) })
        if (!response.ok) throw new Error(`commit failed: ${response.status}`)
        return response.json()
      })
      await queue.drain()
      return (await backend.readSyncRecord()).pending.length
    }, databaseName)
    try {
      expect(await Promise.all([drain(page), drain(peer)])).toEqual([0, 0])
      expect(operationIds).toEqual([operationId, operationId])
      const afterResponse = await request.get(`/api/canvases/${canvasId}`)
      expect(afterResponse.ok()).toBe(true)
      const after = await afterResponse.json() as CanvasDocumentResponse
      expect(after.revision).toBe(before.revision + 1)
      expect(after.canvas.name).toBe(canvas.name)
    } finally {
      release()
      await peer.close()
    }
  })
})
