import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultInitialCanvas } from './canvas-storage.ts'
import { createCollaborativeCanvasDocument, exportCollaborativeCanvasSnapshot } from '../src/collaboration/document.ts'
import { atomicWriteJson } from './atomic-json.ts'
import { defaultWorkspaceManifest, WorkspaceService } from './workspace-service.ts'

async function fixture(run: (service: WorkspaceService, dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'workspace-mutation-'))
  try {
    await run(new WorkspaceService({ dataDir }), dataDir)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
}

describe('versioned workspace mutations', () => {
  it('accepts a stale camera-only snapshot only when every content field still matches', async () => fixture(async service => {
    const canvas = defaultInitialCanvas('canvas-a')
    await service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'view-a', kind: 'save-canvas', expectedRevision: 0, canvas })
    await expect(service.applyWorkspaceMutation({
      protocolVersion: 1, operationId: 'view-b', kind: 'save-canvas', expectedRevision: 0,
      canvas: { ...canvas, viewport: { x: 100, y: 100, zoom: .2 } },
    })).resolves.toMatchObject({ canvasRevisions: { 'canvas-a': 2 } })
    await expect(service.applyWorkspaceMutation({
      protocolVersion: 1, operationId: 'real-conflict', kind: 'save-canvas', expectedRevision: 0,
      canvas: { ...canvas, name: 'changed' },
    })).rejects.toMatchObject({ code: 'workspace_conflict' })
  }))

  it('persists an empty canvas with its revision and does not overwrite another canvas', async () => fixture(async (service, dataDir) => {
    const first = defaultInitialCanvas('canvas-a')
    const second = defaultInitialCanvas('canvas-b')
    const savedFirst = await service.applyWorkspaceMutation({
      protocolVersion: 1, operationId: 'save-a-1', kind: 'save-canvas', expectedRevision: 0,
      canvas: { ...first, nodes: [] },
    })
    const savedSecond = await service.applyWorkspaceMutation({
      protocolVersion: 1, operationId: 'save-b-1', kind: 'save-canvas', expectedRevision: 0,
      canvas: second,
    })
    expect(savedFirst.canvasRevisions['canvas-a']).toBe(1)
    expect(savedSecond.canvasRevisions).toMatchObject({ 'canvas-a': 1, 'canvas-b': 1 })
    expect(savedSecond.workspaceRevision).toBe(2)
    const restarted = new WorkspaceService({ dataDir })
    expect(JSON.parse((await restarted.getCanvasDocument('canvas-a'))!).nodes).toEqual([])
    expect((await restarted.getVersionState()).canvasRevisions).toMatchObject({ 'canvas-a': 1, 'canvas-b': 1 })
  }))

  it('rejects a stale canvas revision without changing the accepted version', async () => fixture(async (service) => {
    const canvas = defaultInitialCanvas('canvas-a')
    await service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'first', kind: 'save-canvas', expectedRevision: 0, canvas })
    await expect(service.applyWorkspaceMutation({
      protocolVersion: 1, operationId: 'stale', kind: 'save-canvas', expectedRevision: 0,
      canvas: { ...canvas, name: '旧数据' },
    })).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect((await service.getVersionState()).canvasRevisions['canvas-a']).toBe(1)
  }))

  it('returns the same receipt for an operation retry and rejects reuse with changed content', async () => fixture(async (service, dataDir) => {
    const mutation = { protocolVersion: 1 as const, operationId: 'retry-id', kind: 'save-canvas' as const,
      expectedRevision: 0, canvas: defaultInitialCanvas('canvas-a') }
    const receipt = await service.applyWorkspaceMutation(mutation)
    expect(await new WorkspaceService({ dataDir }).applyWorkspaceMutation(mutation)).toEqual(receipt)
    await expect(service.applyWorkspaceMutation({ ...mutation, canvas: { ...mutation.canvas, name: '另一内容' } }))
      .rejects.toMatchObject({ code: 'operation_id_conflict' })
  }))

  it('rejects a stale workspace edit and preserves an unrelated newer canvas save', async () => fixture(async (service) => {
    const canvas = defaultInitialCanvas('canvas-a')
    await service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'save-first', kind: 'save-canvas', expectedRevision: 0, canvas })
    await expect(service.applyWorkspaceMutation({
      protocolVersion: 1, operationId: 'stale-edit', kind: 'edit-workspace',
      expectedWorkspaceRevision: 0, expectedCanvasRevisions: { 'canvas-a': 1 },
      commit: { manifest: await service.getManifest() },
    })).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect((await service.getVersionState()).workspaceRevision).toBe(1)
  }))

  it('keeps a permanent delete tombstone across restart and blocks an old save', async () => fixture(async (service, dataDir) => {
    const canvas = defaultInitialCanvas('canvas-a')
    await service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'save-first', kind: 'save-canvas', expectedRevision: 0, canvas })
    const manifest = await service.getManifest()
    const receipt = await service.applyWorkspaceMutation({
      protocolVersion: 1, operationId: 'delete-first', kind: 'edit-workspace',
      expectedWorkspaceRevision: 1, expectedCanvasRevisions: { 'canvas-a': 1 },
      commit: { manifest: { ...manifest, canvases: [] }, deleteCanvasIds: ['canvas-a'] },
    })
    expect(receipt.canvasRevisions['canvas-a']).toBe(2)
    const restarted = new WorkspaceService({ dataDir })
    expect(await restarted.getCanvasDocument('canvas-a')).toBeUndefined()
    await expect(restarted.applyWorkspaceMutation({
      protocolVersion: 1, operationId: 'old-save', kind: 'save-canvas', expectedRevision: 1, canvas,
    })).rejects.toMatchObject({ code: 'workspace_conflict' })
  }))

  it('replays a durable pending operation before serving a partially applied state', async () => fixture(async (service, dataDir) => {
    const original = await service.getManifest()
    const canvas = defaultInitialCanvas('canvas-a')
    const receipt = await service.applyWorkspaceMutation({
      protocolVersion: 1, operationId: 'recover-save', kind: 'save-canvas', expectedRevision: 0, canvas,
    })
    const journalPath = join(dataDir, 'workspace', 'operations', 'recover-save.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    expect(journal.mutation).toMatchObject({ operationId: 'recover-save', expectedRevision: 0 })
    await writeFile(journalPath, JSON.stringify({ ...journal, status: 'pending' }), 'utf8')
    await writeFile(join(dataDir, 'workspace', 'manifest.json'), JSON.stringify(original), 'utf8')
    await writeFile(join(dataDir, 'workspace', 'revision-state.json'),
      JSON.stringify({ workspaceRevision: 0, canvasRevisions: {} }), 'utf8')
    await rm(join(dataDir, 'workspace', 'records', 'canvas-a.json'))

    const restarted = new WorkspaceService({ dataDir })
    expect(await restarted.getVersionState()).toMatchObject({ workspaceRevision: 1, canvasRevisions: { 'canvas-a': 1 } })
    expect(JSON.parse((await restarted.getCanvasDocument('canvas-a'))!)).toMatchObject({ canvasId: 'canvas-a' })
    expect(await restarted.applyWorkspaceMutation({
      protocolVersion: 1, operationId: 'recover-save', kind: 'save-canvas', expectedRevision: 0, canvas,
    })).toEqual(receipt)
  }))

  it('requires a document revision for a changed card and a tombstone for permanent removal', async () => fixture(async (service) => {
    const canvas = defaultInitialCanvas('canvas-a')
    await service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'create-card-doc',
      kind: 'save-canvas', expectedRevision: 0, canvas })
    const current = await service.getManifest()
    current.canvases.push({ canvasId: 'canvas-a', projectId: 'canvas-a', name: 'Canvas',
      position: { x: 0, y: 0 }, nodeCount: 0, favorite: false,
      createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z' })
    await expect(service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'missing-card-revision',
      kind: 'edit-workspace', expectedWorkspaceRevision: 1, expectedCanvasRevisions: {},
      commit: { manifest: current } })).rejects.toMatchObject({ code: 'workspace_precondition_required' })

    await service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'add-card',
      kind: 'edit-workspace', expectedWorkspaceRevision: 1, expectedCanvasRevisions: { 'canvas-a': 1 },
      commit: { manifest: current } })
    expect((await service.getVersionState()).canvasRevisions['canvas-a']).toBe(2)
    await expect(service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'remove-card-without-tombstone',
      kind: 'edit-workspace', expectedWorkspaceRevision: 2, expectedCanvasRevisions: { 'canvas-a': 2 },
      commit: { manifest: { ...current, canvases: [] } } })).rejects.toMatchObject({ code: 'workspace_invalid_input' })
  }))

  it('accepts checkpoints only from the bound room and does not bump content revision for duplicates', async () => fixture(async (service) => {
    const canvas = defaultInitialCanvas('canvas-a')
    await service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'normal-save',
      kind: 'save-canvas', expectedRevision: 0, canvas })
    const checkpoint = { snapshot: canvas, roomId: 'room-a', epoch: 'epoch-a', sourceRevision: 'source-a', initial: true }
    expect(await service.applyCollaborationCheckpoint(checkpoint)).toBe(true)
    expect((await service.getVersionState()).canvasRevisions['canvas-a']).toBe(1)
    expect(await service.applyCollaborationCheckpoint(checkpoint)).toBe(true)
    expect((await service.getVersionState()).canvasRevisions['canvas-a']).toBe(1)

    const changed = { ...canvas, name: '协作更新' }
    expect(await service.applyCollaborationCheckpoint({ ...checkpoint, snapshot: changed, sourceRevision: 'source-b', initial: false })).toBe(true)
    expect((await service.getVersionState()).canvasRevisions['canvas-a']).toBe(2)
    await service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'new-normal-save',
      kind: 'save-canvas', expectedRevision: 2, canvas: { ...canvas, name: '普通新版' } })
    expect(await service.applyCollaborationCheckpoint({ ...checkpoint, snapshot: changed, sourceRevision: 'source-c', initial: false })).toBe(false)
    expect(JSON.parse((await service.getCanvasDocument('canvas-a'))!).name).toBe('普通新版')
  }))

  it('binds an initial room for a saved text canvas after collaboration serialization', async () => fixture(async (service) => {
    const { canvasId, ...base } = defaultInitialCanvas('independent-a', 'independent-a', '未命名画布')
    const canvas = { ...base, nodes: [{
      id: 'text-a', type: 'text' as const, name: '文本', position: { x: 420, y: 300 },
      size: { width: 128, height: 79 }, data: { text: '开启协作前', nodeKind: 'text',
        presentation: 'plain', autoWidth: true, fontFamily: 'Noto Sans SC', fontSize: 24,
        fontWeight: 500, color: '#f4f4f4', textAlign: 'left', lineHeight: 1.4 },
    }], canvasId }
    await service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'saved-text-before-room',
      kind: 'save-canvas', expectedRevision: 0, canvas })
    const document = createCollaborativeCanvasDocument(canvas)
    const checkpoint = exportCollaborativeCanvasSnapshot(document)
    expect(await service.applyCollaborationCheckpoint({ snapshot: checkpoint,
      roomId: 'text-room', epoch: 'text-epoch', sourceRevision: 'initial', initial: true })).toBe(true)
    expect(await service.getCanvasRecord(canvas.canvasId)).toMatchObject({ roomId: 'text-room', epoch: 'text-epoch' })
  }))

  it('keeps the active room bound across a metadata-only card edit', async () => fixture(async (service) => {
    const canvas = defaultInitialCanvas('canvas-a')
    await service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'metadata-save',
      kind: 'save-canvas', expectedRevision: 0, canvas })
    const manifest = await service.getManifest()
    manifest.canvases.push({ canvasId: 'canvas-a', projectId: canvas.projectId, name: canvas.name,
      position: { x: 0, y: 0 }, nodeCount: canvas.nodes.length, favorite: false,
      createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z' })
    await service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'metadata-card',
      kind: 'edit-workspace', expectedWorkspaceRevision: 1, expectedCanvasRevisions: { 'canvas-a': 1 },
      commit: { manifest } })
    const room = { roomId: 'room-a', epoch: 'epoch-a', sourceRevision: 'initial', initial: true }
    expect(await service.applyCollaborationCheckpoint({ ...room, snapshot: canvas })).toBe(true)
    const edited = await service.getManifest()
    edited.canvases[0].favorite = true
    await service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'metadata-favorite',
      kind: 'edit-workspace', expectedWorkspaceRevision: 3, expectedCanvasRevisions: { 'canvas-a': 2 },
      commit: { manifest: edited } })
    expect(await service.getCanvasRecord('canvas-a')).toMatchObject({ roomId: room.roomId, epoch: room.epoch,
      revision: 3 })
    expect(await service.applyCollaborationCheckpoint({ ...room, initial: false,
      sourceRevision: 'changed', snapshot: { ...canvas, name: 'Shared edit' } })).toBe(true)
    expect((await service.getVersionState()).canvasRevisions['canvas-a']).toBe(4)
  }))

  it.each(['records', 'manifest.json', 'revision-state.json', 'operations'])('recovers a commit interrupted while writing %s', async (boundary) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'workspace-fault-'))
    let armed = false
    let failed = false
    try {
      const service = new WorkspaceService({ dataDir, writeJson: async (path, value) => {
        if (armed && !failed && (boundary === 'records'
          ? path.includes(join('workspace', 'records', 'canvas-a.json'))
          : path.includes(boundary)) &&
          (boundary !== 'operations' || (value as { status?: string }).status === 'complete')) {
          failed = true
          throw new Error('injected write failure')
        }
        await atomicWriteJson(path, value)
      } })
      await service.getManifest()
      armed = true
      await expect(service.applyWorkspaceMutation({ protocolVersion: 1, operationId: `fault-${boundary.replaceAll('.', '-')}`,
        kind: 'save-canvas', expectedRevision: 0, canvas: defaultInitialCanvas('canvas-a') }))
        .rejects.toThrow('injected write failure')
      const restarted = new WorkspaceService({ dataDir })
      expect((await restarted.getVersionState()).canvasRevisions['canvas-a']).toBe(1)
      expect(JSON.parse((await restarted.getCanvasDocument('canvas-a'))!).canvasId).toBe('canvas-a')
    } finally { await rm(dataDir, { recursive: true, force: true }) }
  })

  it('keeps reads behind a commit until its record and manifest agree', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'workspace-barrier-'))
    let releaseWrite = () => {}
    let reportBlocked = () => {}
    const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve })
    const blocked = new Promise<void>((resolve) => { reportBlocked = resolve })
    let armed = false
    let saving: Promise<unknown> | undefined
    try {
      const service = new WorkspaceService({ dataDir, writeJson: async (path, value) => {
        if (armed && path.endsWith('manifest.json')) {
          armed = false
          reportBlocked()
          await writeReleased
        }
        await atomicWriteJson(path, value)
      } })
      await service.getManifest()
      armed = true
      saving = service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'barrier-save',
        kind: 'save-canvas', expectedRevision: 0, canvas: defaultInitialCanvas('canvas-a') })
      await blocked
      const reading = Promise.all([service.getWorkspaceState(), service.readCanvasState('canvas-a')])
      expect(await Promise.race([reading.then(() => 'read'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 20))])).toBe('blocked')
      releaseWrite()
      await saving
      const [state, canvas] = await reading
      expect(state.workspaceRevision).toBe(1)
      expect(state.canvasRevisions['canvas-a']).toBe(1)
      expect(canvas?.revision).toBe(1)
      expect(canvas?.workspaceRevision).toBe(1)
      expect(JSON.parse(canvas!.serialized!).canvasId).toBe('canvas-a')
    } finally {
      releaseWrite()
      await saving?.catch(() => {})
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('migrates a legacy canvas at startup without deleting its source file', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'workspace-legacy-'))
    try {
      const canvas = defaultInitialCanvas('legacy-a')
      const legacyPath = join(dataDir, 'canvases', 'legacy-a', 'snapshot.json')
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(dataDir, 'canvases', 'legacy-a'), { recursive: true })
      await writeFile(legacyPath, JSON.stringify(canvas), 'utf8')
      const service = new WorkspaceService({ dataDir })
      await service.getManifest()
      expect(await service.getCanvasRecord('legacy-a')).toMatchObject({
        recordVersion: 1, revision: 0, snapshot: { canvasId: 'legacy-a' },
      })
      expect(await readFile(legacyPath, 'utf8')).toBe(JSON.stringify(canvas))
    } finally { await rm(dataDir, { recursive: true, force: true }) }
  })

  it('repairs stale legacy card metadata from its document at startup, including a previously migrated record', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'workspace-legacy-mismatch-'))
    try {
      const canvas = { ...defaultInitialCanvas('legacy-a', 'project-a', '权威正文'), nodes: [{
        id: 'text-a', type: 'text' as const, name: 'Text',
        position: { x: 0, y: 0 }, size: { width: 100, height: 80 }, data: { text: 'Saved content' },
      }] }
      const manifest = defaultWorkspaceManifest()
      manifest.projects.push({ projectId: 'project-a', name: 'Project A',
        position: { x: 0, y: 0 }, size: { width: 620, height: 380 }, favorite: false,
        createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' })
      manifest.canvases.push({ canvasId: 'legacy-a', projectId: 'project-a', name: '旧空白卡片',
        position: { x: 4, y: 8 }, nodeCount: 0, favorite: true,
        createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' })
      await mkdir(join(dataDir, 'workspace', 'documents'), { recursive: true })
      const legacyPath = join(dataDir, 'workspace', 'documents', 'legacy-a.json')
      await writeFile(legacyPath, JSON.stringify(canvas), 'utf8')
      const manifestPath = join(dataDir, 'workspace', 'manifest.json')
      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')

      const first = new WorkspaceService({ dataDir })
      expect((await first.getManifest()).canvases[0]).toMatchObject({ name: '权威正文', nodeCount: 1,
        favorite: true, position: { x: 4, y: 8 } })
      expect(await first.getCanvasRecord('legacy-a')).toMatchObject({ revision: 0 })
      expect(await readFile(legacyPath, 'utf8')).toBe(JSON.stringify(canvas))

      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
      const restarted = new WorkspaceService({ dataDir })
      expect((await restarted.getManifest()).canvases[0]).toMatchObject({ name: '权威正文', nodeCount: 1 })
      expect((await restarted.getVersionState()).canvasRevisions['legacy-a']).toBe(0)
    } finally { await rm(dataDir, { recursive: true, force: true }) }
  })

  it('does not fall back to stale legacy data when a revisioned record is corrupt', async () => fixture(async (service, dataDir) => {
    const canvas = defaultInitialCanvas('canvas-a')
    await service.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'save-before-corruption',
      kind: 'save-canvas', expectedRevision: 0, canvas })
    const recordPath = join(dataDir, 'workspace', 'records', 'canvas-a.json')
    await writeFile(recordPath, '{broken', 'utf8')
    const legacyDir = join(dataDir, 'canvases', 'canvas-a')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(join(legacyDir, 'snapshot.json'), JSON.stringify({ ...canvas, name: '旧内容' }), 'utf8')
    await expect(service.getCanvasDocument('canvas-a')).rejects.toThrow()
  }))
})
