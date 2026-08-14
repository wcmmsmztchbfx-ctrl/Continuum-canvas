import { describe, expect, it } from 'vitest'

import { referenceProjectSnapshot } from '../fixtures/reference'
import { parseProjectSnapshot } from '../model/project'
import { bootstrapReferenceProject } from './bootstrapReferenceProject'
import {
  createProjectRepository,
  type ProjectStorageBackend,
} from './projectRepository'

class MemoryProjectBackend implements ProjectStorageBackend {
  private readonly records = new Map<string, string>()

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

describe('bootstrapReferenceProject', () => {
  it('initializes the reference fixture when no local project exists', async () => {
    const repository = createProjectRepository(new MemoryProjectBackend())

    const project = await bootstrapReferenceProject(repository)

    expect(project).toEqual(
      parseProjectSnapshot(JSON.stringify(referenceProjectSnapshot)),
    )
    expect(project).not.toBe(referenceProjectSnapshot)
    expect(
      await repository.loadProject(referenceProjectSnapshot.projectId),
    ).toEqual(parseProjectSnapshot(JSON.stringify(referenceProjectSnapshot)))
  })

  it('restores the local snapshot without overwriting it', async () => {
    const repository = createProjectRepository(new MemoryProjectBackend())
    const locallyRenamed = {
      ...referenceProjectSnapshot,
      name: '本地恢复名称',
    }
    await repository.saveProject(locallyRenamed)

    const project = await bootstrapReferenceProject(repository)

    expect(project.name).toBe('本地恢复名称')
  })
})
