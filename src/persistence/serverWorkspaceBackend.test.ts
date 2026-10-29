import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServerWorkspaceBackend } from './serverWorkspaceBackend'
import { emptyWorkspaceSyncRecord, type WorkspaceSyncStorageBackend } from './workspaceSyncState'
import type { WorkspaceCommit, WorkspaceManifestV1 } from '../workspace/model'

afterEach(() => { vi.unstubAllGlobals() })
const manifest: WorkspaceManifestV1 = { version: 1, projects: [], canvases: [], pendingOperations: [], viewport: { x: 0, y: 0, zoom: 1 } }
const commit: WorkspaceCommit = { manifest: JSON.stringify(manifest) }

function fallback(fail?: Error): WorkspaceSyncStorageBackend {
  let record = emptyWorkspaceSyncRecord()
  let serialized = JSON.stringify(manifest)
  return {
    initializeFromLegacy: async () => {}, getManifest: async () => serialized,
    getCanvasDocument: async () => undefined, commit: async () => {},
    readSyncRecord: async () => structuredClone(record),
    readSyncSnapshot: async () => ({ record: structuredClone(record), manifest: serialized }),
    transactSync: async (update) => {
      if (fail) throw fail
      const next = structuredClone(record)
      const change = update(next, serialized)
      if (change?.manifest) serialized = typeof change.manifest === 'string' ? change.manifest : JSON.stringify(change.manifest)
      record = next
    },
  }
}

function mockFetch(remoteError?: Error, status = 200) {
  const mock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json({ manifest, workspaceRevision: 0, canvasRevisions: {} })
    if (remoteError) throw remoteError
    if (status !== 200) return Response.json({}, { status })
    const mutation = JSON.parse(String(init.body))
    return Response.json({ protocolVersion: 1, operationId: mutation.operationId, manifest, workspaceRevision: 1, canvasRevisions: {} })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('createServerWorkspaceBackend', () => {
  it('reads the server manifest and caches its version with the document', async () => {
    mockFetch()
    const local = fallback()
    const backend = createServerWorkspaceBackend({ fallbackBackend: local })
    expect(await backend.getManifest()).toBe(JSON.stringify(manifest))
    expect(await local.getManifest()).toBe(JSON.stringify(manifest))
    expect((await local.readSyncRecord()).versions.workspaceRevision).toBe(0)
  })

  it('falls back to the existing local manifest on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await createServerWorkspaceBackend({ fallbackBackend: fallback() }).getManifest()).toBe(JSON.stringify(manifest))
  })

  it('resolves when both destinations succeed and sends a versioned body to the configured URL', async () => {
    const remote = mockFetch()
    const local = fallback()
    await expect(createServerWorkspaceBackend({ baseUrl: 'https://workspace.example', fallbackBackend: local }).commit(commit)).resolves.toBeUndefined()
    const [url, init] = remote.mock.calls.find(([, options]) => options?.method === 'POST')!
    expect(url).toBe('https://workspace.example/api/workspace/commit')
    expect(JSON.parse(String(init!.body))).toMatchObject({ protocolVersion: 1, operationId: expect.any(String), kind: 'edit-workspace', expectedWorkspaceRevision: 0, expectedCanvasRevisions: {}, commit })
    expect((await local.readSyncRecord()).pending).toEqual([])
  })

  it('resolves when local persistence fails but the server confirms the save', async () => {
    const remote = mockFetch()
    await expect(createServerWorkspaceBackend({ fallbackBackend: fallback(new Error('quota')) }).commit(commit)).resolves.toBeUndefined()
    expect(remote.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  })

  it('reports a local-only save when the server fails', async () => {
    const remoteCause = new Error('offline')
    mockFetch(remoteCause)
    const local = fallback()
    await expect(createServerWorkspaceBackend({ fallbackBackend: local }).commit(commit)).rejects.toMatchObject({ name: 'WorkspaceCommitError', savedLocally: true, remoteCause, message: expect.stringMatching(/本地.*保存.*服务器.*失败/) })
    expect((await local.readSyncRecord()).pending).toHaveLength(1)
  })

  it('reports both causes when neither destination saves', async () => {
    const localCause = new Error('quota'), remoteCause = new Error('offline')
    mockFetch(remoteCause)
    await expect(createServerWorkspaceBackend({ fallbackBackend: fallback(localCause) }).commit(commit)).rejects.toMatchObject({ name: 'WorkspaceCommitError', savedLocally: false, localCause, remoteCause })
  })

  it('treats non-success HTTP status as a server failure and retains the operation', async () => {
    mockFetch(undefined, 503)
    await expect(createServerWorkspaceBackend({ fallbackBackend: fallback() }).commit(commit)).rejects.toMatchObject({ savedLocally: true, remoteCause: expect.objectContaining({ status: 503 }) })
  })
})
