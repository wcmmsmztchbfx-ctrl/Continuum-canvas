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

function repositoryWithIds(...ids: string[]) {
  const backend = new MemoryWorkspaceBackend()
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
})
