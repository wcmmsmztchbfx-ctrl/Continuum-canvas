import { describe, expect, it } from 'vitest'

import type { ProjectSnapshotV1 } from '../model/project'
import {
  DATABASE_VERSION,
  PROJECT_STORE_NAME,
  WORKSPACE_MANIFEST_STORE_NAME,
  CANVAS_DOCUMENT_STORE_NAME,
  CANVAS_THUMBNAIL_STORE_NAME,
  WORKSPACE_SYNC_STORE_NAME,
  createProjectRepository,
  deleteProject,
  listProjects,
  loadCanvasThumbnail,
  deleteCanvasThumbnail,
  loadProject,
  saveCanvasThumbnail,
  saveProject,
  serializeProjectSnapshot,
  upgradeProjectDatabase,
} from './projectRepository'
import type {
  CanvasThumbnailRecord,
  CanvasThumbnailStorageBackend,
  ProjectStorageBackend,
} from './projectRepository'

class MemoryProjectBackend implements ProjectStorageBackend {
  readonly records = new Map<string, string>()

  async put(projectId: string, serialized: string): Promise<void> {
    this.records.set(projectId, serialized)
  }

  async get(projectId: string): Promise<string | undefined> {
    return this.records.get(projectId)
  }

  async getAll(): Promise<string[]> {
    return [...this.records.values()]
  }

  async delete(projectId: string): Promise<void> {
    this.records.delete(projectId)
  }
}

class MemoryCanvasThumbnailBackend implements CanvasThumbnailStorageBackend {
  readonly records = new Map<string, CanvasThumbnailRecord>()

  async put(record: CanvasThumbnailRecord): Promise<void> {
    this.records.set(record.canvasId, record)
  }

  async get(canvasId: string): Promise<CanvasThumbnailRecord | undefined> {
    return this.records.get(canvasId)
  }

  async delete(canvasId: string): Promise<void> {
    this.records.delete(canvasId)
  }
}

function makeProject(
  projectId: string,
  name = `项目 ${projectId}`,
): ProjectSnapshotV1 {
  return {
    version: 1,
    projectId,
    name,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  }
}

describe('project repository', () => {
  it('upgrades IndexedDB by adding workspace and thumbnail stores while retaining projects', () => {
    const stores = new Set([PROJECT_STORE_NAME])
    const createObjectStore = (name: string) => stores.add(name)

    upgradeProjectDatabase({
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore,
    })

    expect(DATABASE_VERSION).toBe(4)
    expect([...stores].sort()).toEqual(
      [
        PROJECT_STORE_NAME,
        WORKSPACE_MANIFEST_STORE_NAME,
        CANVAS_DOCUMENT_STORE_NAME,
        CANVAS_THUMBNAIL_STORE_NAME,
        WORKSPACE_SYNC_STORE_NAME,
      ].sort(),
    )
  })

  it('round-trips canvas thumbnail blobs and rendering metadata', async () => {
    const backend = new MemoryCanvasThumbnailBackend()
    const thumbnail: CanvasThumbnailRecord = {
      canvasId: 'canvas-thumbnail',
      blob: new Blob(['thumbnail bytes'], { type: 'image/webp' }),
      width: 640,
      height: 360,
      contentHash: 'sha256:fixture',
      updatedAt: '2026-08-13T10:00:00.000Z',
    }

    await saveCanvasThumbnail(thumbnail, backend)
    const loaded = await loadCanvasThumbnail(thumbnail.canvasId, backend)

    expect(loaded).toMatchObject({
      canvasId: thumbnail.canvasId,
      width: 640,
      height: 360,
      contentHash: 'sha256:fixture',
      updatedAt: thumbnail.updatedAt,
    })
    expect(loaded?.blob).toBeInstanceOf(Blob)
    expect(loaded?.blob.type).toBe('image/webp')
    expect(await loaded?.blob.text()).toBe('thumbnail bytes')

    await deleteCanvasThumbnail(thumbnail.canvasId, backend)
    expect(await loadCanvasThumbnail(thumbnail.canvasId, backend)).toBeUndefined()
  })

  it('saves, loads, lists and deletes snapshots through an injected backend', async () => {
    const backend = new MemoryProjectBackend()

    await saveProject(makeProject('project-b'), backend)
    await saveProject(makeProject('project-a'), backend)

    expect(await loadProject('project-a', backend)).toEqual(
      makeProject('project-a'),
    )
    expect((await listProjects(backend)).map((project) => project.projectId)).toEqual([
      'project-a',
      'project-b',
    ])

    await deleteProject('project-a', backend)
    expect(await loadProject('project-a', backend)).toBeUndefined()
  })

  it('offers a repository object without requiring IndexedDB in jsdom', async () => {
    const repository = createProjectRepository(new MemoryProjectBackend())

    await repository.saveProject(makeProject('project-1'))

    expect(await repository.loadProject('project-1')).toEqual(
      makeProject('project-1'),
    )
  })

  it('serializes equivalent snapshots to the same canonical JSON', () => {
    const regular = makeProject('project-1')
    const reordered = {
      edges: [],
      nodes: [],
      viewport: { zoom: 1, y: 0, x: 0 },
      name: regular.name,
      projectId: regular.projectId,
      version: 1,
    } as ProjectSnapshotV1

    expect(serializeProjectSnapshot(reordered)).toBe(
      serializeProjectSnapshot(regular),
    )
  })

  it('reports damaged persisted data with a readable Chinese error', async () => {
    const backend = new MemoryProjectBackend()
    backend.records.set('project-1', '{broken-json')

    await expect(loadProject('project-1', backend)).rejects.toThrow(
      '读取项目“project-1”失败：本地项目数据已损坏',
    )
  })
})
