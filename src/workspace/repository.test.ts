import { describe, expect, it } from 'vitest'

import { referenceProjectSnapshot } from '../fixtures/reference'
import type { CanvasSnapshotV2 } from '../model/project'
import {
  createWorkspaceRepository,
  type WorkspaceCommit,
  type WorkspaceInitialization,
  type WorkspaceStorageBackend,
} from './repository'

class MemoryWorkspaceBackend implements WorkspaceStorageBackend {
  manifest?: string
  readonly documents = new Map<string, string>()
  initializeCalls = 0

  constructor(readonly legacyProjects: string[] = []) {}

  async initializeFromLegacy(
    create: (legacyProjects: readonly string[]) => WorkspaceInitialization,
  ): Promise<void> {
    this.initializeCalls += 1
    if (this.manifest !== undefined) return
    const initialization = create(this.legacyProjects)
    this.manifest = initialization.manifest
    for (const document of initialization.documents) {
      this.documents.set(document.canvasId, document.serialized)
    }
  }

  async getManifest(): Promise<string | undefined> {
    return this.manifest
  }

  async getCanvasDocument(canvasId: string): Promise<string | undefined> {
    return this.documents.get(canvasId)
  }

  async commit(commit: WorkspaceCommit): Promise<void> {
    this.manifest = commit.manifest
    for (const document of commit.putDocuments ?? []) {
      this.documents.set(document.canvasId, document.serialized)
    }
    for (const canvasId of commit.deleteCanvasIds ?? []) {
      this.documents.delete(canvasId)
    }
  }
}

class ControlledWorkspaceBackend extends MemoryWorkspaceBackend {
  beforeNextCommit?: () => Promise<void>

  pauseNextCommit() {
    let release!: () => void
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const paused = new Promise<void>((resolve) => { release = resolve })
    this.beforeNextCommit = async () => {
      signalStarted()
      await paused
    }
    return { started, release }
  }

  override async commit(commit: WorkspaceCommit): Promise<void> {
    const beforeCommit = this.beforeNextCommit
    this.beforeNextCommit = undefined
    await beforeCommit?.()
    await super.commit(commit)
  }
}

function repositoryWithBackend<T extends MemoryWorkspaceBackend>(backend: T, ...ids: string[]) {
  const repository = createWorkspaceRepository(backend, {
    now: () => '2026-07-18T00:00:00.000Z',
    createId: () => {
      const id = ids.shift()
      if (!id) throw new Error('Missing test id')
      return id
    },
    seedProject: referenceProjectSnapshot,
  })
  return { backend, repository }
}

function repositoryWithIds(...ids: string[]) {
  return repositoryWithBackend(new MemoryWorkspaceBackend(), ...ids)
}

function textDocument(canvasId: string, name = '已保存的画布'): CanvasSnapshotV2 {
  return {
    version: 3,
    canvasId,
    projectId: canvasId,
    name,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: 'text-1',
      type: 'text',
      name: '文本',
      position: { x: 10, y: 20 },
      size: { width: 200, height: 100 },
      data: { text: '提交时的内容' },
    }],
    edges: [],
  }
}

describe('workspace repository', () => {
  it('initializes migration only once and persists the workspace viewport', async () => {
    const backend = new MemoryWorkspaceBackend([
      JSON.stringify(referenceProjectSnapshot),
    ])
    const repository = createWorkspaceRepository(backend, {
      now: () => '2026-07-18T00:00:00.000Z',
      createId: () => 'unused',
      seedProject: referenceProjectSnapshot,
    })

    await repository.getManifest()
    await repository.updateViewport({ x: 42, y: -10, zoom: 0.8 })
    expect((await repository.getManifest()).viewport).toEqual({
      x: 42,
      y: -10,
      zoom: 0.8,
    })
    expect(backend.initializeCalls).toBe(3)
    expect(backend.documents).toHaveLength(1)
  })

  it('supports duplicate names, create, rename, move and copy operations', async () => {
    const { repository } = repositoryWithIds(
      'project-a',
      'canvas-a',
      'canvas-copy',
      'project-copy',
      'project-copy-canvas',
    )

    const project = await repository.createProject('同名', { x: 100, y: 120 })
    const canvas = await repository.createCanvas('同名', {
      projectId: project.projectId,
      position: { x: 140, y: 180 },
    })
    await repository.renameProject(project.projectId, '重命名')
    await repository.renameCanvas(canvas.canvasId, '重命名')
    await repository.moveProject(project.projectId, { x: 300, y: 320 })
    await repository.moveCanvas(canvas.canvasId, {
      position: { x: 340, y: 380 },
      projectId: canvas.canvasId,
    })
    const canvasCopy = await repository.duplicateCanvas(canvas.canvasId)
    const projectCopy = await repository.duplicateProject(project.projectId)

    const manifest = await repository.getManifest()
    expect(manifest.projects.find((item) => item.projectId === project.projectId)).toMatchObject({
      name: '重命名',
      position: { x: 300, y: 320 },
    })
    expect(manifest.canvases.find((item) => item.canvasId === canvas.canvasId)).toMatchObject({
      name: '重命名',
      projectId: canvas.canvasId,
      position: { x: 340, y: 380 },
    })
    expect(canvasCopy).toMatchObject({ canvasId: 'canvas-copy', projectId: 'canvas-copy' })
    expect(projectCopy.project).toMatchObject({ projectId: 'project-copy' })
  })

  it('trashes, restores and permanently deletes projects and canvases with their documents', async () => {
    const { backend, repository } = repositoryWithIds('project-a', 'canvas-a')
    const project = await repository.createProject('项目')
    const canvas = await repository.createCanvas('画布', {
      projectId: project.projectId,
    })

    await repository.trashProject(project.projectId)
    expect((await repository.getManifest()).canvases[1]).toMatchObject({
      canvasId: canvas.canvasId,
      trashedByProjectId: project.projectId,
    })
    await repository.restoreProject(project.projectId)
    expect(
      (await repository.getManifest()).canvases.find(
        (item) => item.canvasId === canvas.canvasId,
      )?.deletedAt,
    ).toBeUndefined()

    await repository.trashCanvas(canvas.canvasId)
    await repository.restoreCanvas(canvas.canvasId)
    await repository.trashCanvas(canvas.canvasId)
    await repository.permanentlyDeleteCanvas(canvas.canvasId)
    expect(backend.documents.has(canvas.canvasId)).toBe(false)

    await repository.trashProject(project.projectId)
    await repository.permanentlyDeleteProject(project.projectId)
    expect(
      (await repository.getManifest()).projects.some(
        (item) => item.projectId === project.projectId,
      ),
    ).toBe(false)
  })

  it('persists canvas v2 documents and rejects names over 60 characters', async () => {
    const { repository } = repositoryWithIds('canvas-a')
    const canvas = await repository.createCanvas('独立画布')
    const document = await repository.loadCanvas(canvas.canvasId)

    expect(document).toMatchObject({
      version: 3,
      canvasId: canvas.canvasId,
      projectId: canvas.canvasId,
      name: '独立画布',
    } satisfies Partial<CanvasSnapshotV2>)
    await expect(repository.createProject('项'.repeat(61))).rejects.toThrow(
      '名称不能超过 60 个字符',
    )
  })

  it('persists favorites and keeps project bounds outside child canvases', async () => {
    const { repository } = repositoryWithIds('project-a', 'canvas-a')
    const project = await repository.createProject('项目')
    const canvas = await repository.createCanvas('画布', {
      projectId: project.projectId,
      position: { x: 520, y: 290 },
    })

    await repository.setProjectFavorite(project.projectId, true)
    await repository.setCanvasFavorite(canvas.canvasId, true)
    const resized = await repository.resizeProject(project.projectId, {
      width: 360,
      height: 240,
    })

    expect(resized.size.width).toBeGreaterThanOrEqual(784)
    expect(resized.size.height).toBeGreaterThanOrEqual(426)
    expect((await repository.getManifest()).projects[1]).toMatchObject({
      favorite: true,
    })
    expect((await repository.getManifest()).canvases[1]).toMatchObject({
      favorite: true,
    })
  })

  it('journals cross-project canvas moves until the final commit', async () => {
    const { repository } = repositoryWithIds(
      'project-a',
      'project-b',
      'canvas-a',
    )
    const first = await repository.createProject('项目 A')
    const second = await repository.createProject('项目 B')
    const canvas = await repository.createCanvas('画布', {
      projectId: first.projectId,
    })

    const operation = await repository.beginCanvasMove(
      canvas.canvasId,
      second.projectId,
      'operation-1',
    )
    expect((await repository.getManifest()).pendingOperations).toContainEqual(
      operation,
    )

    await repository.completeCanvasMove('operation-1', {
      position: { x: 40, y: 80 },
      projectId: second.projectId,
    })
    const manifest = await repository.getManifest()
    expect(manifest.pendingOperations).toEqual([])
    expect(
      manifest.canvases.find((item) => item.canvasId === canvas.canvasId),
    ).toMatchObject({ projectId: second.projectId, position: { x: 40, y: 80 } })
  })

  it('preserves both canvas names and documents when renames overlap', async () => {
    const { repository } = repositoryWithIds('canvas-a', 'canvas-b')
    await repository.createCanvas('原画布 A')
    await repository.createCanvas('原画布 B')

    await Promise.all([
      repository.renameCanvas('canvas-a', '新画布 A'),
      repository.renameCanvas('canvas-b', '新画布 B'),
    ])

    const manifest = await repository.getManifest()
    expect(manifest.canvases.find((canvas) => canvas.canvasId === 'canvas-a')?.name).toBe('新画布 A')
    expect(manifest.canvases.find((canvas) => canvas.canvasId === 'canvas-b')?.name).toBe('新画布 B')
    expect((await repository.loadCanvas('canvas-a'))?.name).toBe('新画布 A')
    expect((await repository.loadCanvas('canvas-b'))?.name).toBe('新画布 B')
  })

  it('keeps the last same-canvas edit when an earlier save is delayed, including an empty canvas', async () => {
    const { backend, repository } = repositoryWithBackend(new ControlledWorkspaceBackend(), 'canvas-a')
    await repository.createCanvas('画布 A')
    const paused = backend.pauseNextCommit()
    const first = repository.saveCanvas(textDocument('canvas-a', '第一次编辑'))
    await paused.started
    const last = repository.saveCanvas({ ...textDocument('canvas-a', '最后清空'), nodes: [] })
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    paused.release()
    await Promise.all([first, last])

    expect(await repository.loadCanvas('canvas-a')).toMatchObject({ name: '最后清空', nodes: [] })
    expect((await repository.getManifest()).canvases.find((canvas) => canvas.canvasId === 'canvas-a'))
      .toMatchObject({ name: '最后清空', nodeCount: 0 })
  })

  it('retains a saved document and the later trash operation when they overlap', async () => {
    const { backend, repository } = repositoryWithBackend(new ControlledWorkspaceBackend(), 'canvas-a')
    await repository.createCanvas('画布 A')
    const paused = backend.pauseNextCommit()
    const save = repository.saveCanvas(textDocument('canvas-a'))
    await paused.started
    const trash = repository.trashCanvas('canvas-a')
    paused.release()
    await Promise.all([save, trash])

    expect((await repository.getManifest()).canvases.find((canvas) => canvas.canvasId === 'canvas-a'))
      .toMatchObject({ name: '已保存的画布', nodeCount: 1, deletedAt: '2026-07-18T00:00:00.000Z' })
    expect((await repository.loadCanvas('canvas-a'))?.nodes).toHaveLength(1)
  })

  it('rejects a failed mutation without preventing a later mutation from succeeding', async () => {
    const { backend, repository } = repositoryWithBackend(new ControlledWorkspaceBackend(), 'canvas-a', 'canvas-b')
    await repository.createCanvas('原画布 A')
    await repository.createCanvas('原画布 B')
    backend.beforeNextCommit = async () => { throw new Error('保存失败') }

    const failed = repository.renameCanvas('canvas-a', '失败的名称')
    const failure = expect(failed).rejects.toThrow('保存失败')
    const succeeded = repository.renameCanvas('canvas-b', '成功的名称')
    await failure
    await succeeded

    const manifest = await repository.getManifest()
    expect(manifest.canvases.find((canvas) => canvas.canvasId === 'canvas-a')?.name).toBe('原画布 A')
    expect(manifest.canvases.find((canvas) => canvas.canvasId === 'canvas-b')?.name).toBe('成功的名称')
    expect((await repository.loadCanvas('canvas-b'))?.name).toBe('成功的名称')
  })

  it('captures a save snapshot before it waits for an earlier mutation', async () => {
    const { backend, repository } = repositoryWithBackend(new ControlledWorkspaceBackend(), 'canvas-a')
    await repository.createCanvas('画布 A')
    const paused = backend.pauseNextCommit()
    const earlier = repository.updateViewport({ x: 1, y: 2, zoom: 1 })
    await paused.started
    const snapshot = textDocument('canvas-a', '调用时的名称')
    const save = repository.saveCanvas(snapshot)
    snapshot.name = '调用后的名称'
    snapshot.nodes[0].position.x = 999
    snapshot.nodes = []
    paused.release()
    await Promise.all([earlier, save])

    expect(await repository.loadCanvas('canvas-a')).toMatchObject({
      name: '调用时的名称',
      nodes: [{ position: { x: 10, y: 20 } }],
    })
    expect((await repository.getManifest()).viewport).toEqual({ x: 1, y: 2, zoom: 1 })
  })

  it('captures mutable position, template and viewport arguments at call time', async () => {
    const { backend, repository } = repositoryWithBackend(new ControlledWorkspaceBackend(), 'project-a', 'canvas-a')
    await repository.getManifest()
    const paused = backend.pauseNextCommit()
    const earlier = repository.updateViewport({ x: 1, y: 2, zoom: 1 })
    await paused.started
    const projectPosition = { x: 30, y: 40 }
    const createOptions = { position: { x: 50, y: 60 }, template: textDocument('template') }
    const viewport = { x: 70, y: 80, zoom: 2 }
    const project = repository.createProject('项目', projectPosition)
    const canvas = repository.createCanvas('画布', createOptions)
    const view = repository.updateViewport(viewport)
    projectPosition.x = 999
    createOptions.position.y = 999
    createOptions.template.nodes = []
    viewport.zoom = 5
    paused.release()
    const [, createdProject, createdCanvas] = await Promise.all([earlier, project, canvas, view])

    expect(createdProject.position).toEqual({ x: 30, y: 40 })
    expect(createdCanvas).toMatchObject({ position: { x: 50, y: 60 }, nodeCount: 1 })
    const manifest = await repository.getManifest()
    expect(manifest.projects.find((item) => item.projectId === 'project-a')?.position).toEqual({ x: 30, y: 40 })
    expect(manifest.canvases.find((item) => item.canvasId === 'canvas-a'))
      .toMatchObject({ position: { x: 50, y: 60 }, nodeCount: 1 })
    expect((await repository.loadCanvas('canvas-a'))?.nodes).toHaveLength(1)
    expect(manifest.viewport).toEqual({ x: 70, y: 80, zoom: 2 })
  })

  it('makes reads observe mutations that were queued before them', async () => {
    const { backend, repository } = repositoryWithBackend(new ControlledWorkspaceBackend(), 'canvas-a')
    await repository.createCanvas('画布 A')
    const paused = backend.pauseNextCommit()
    const save = repository.saveCanvas(textDocument('canvas-a'))
    await paused.started
    const document = repository.loadCanvas('canvas-a')
    const manifest = repository.getManifest()
    await Promise.resolve()
    paused.release()
    await save

    expect((await document)?.name).toBe('已保存的画布')
    expect((await manifest).canvases.find((canvas) => canvas.canvasId === 'canvas-a'))
      .toMatchObject({ name: '已保存的画布', nodeCount: 1 })
  })
})
