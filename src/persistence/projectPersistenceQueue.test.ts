import { describe, expect, it, vi } from 'vitest'

import type { ProjectSnapshotV1 } from '../model/project'
import { ProjectPersistenceQueue } from './projectPersistenceQueue'
import type { ProjectRepository } from './projectRepository'

function project(name: string): ProjectSnapshotV1 {
  return {
    version: 1,
    projectId: 'project-1',
    name,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  }
}

function repository(saveProject: ProjectRepository['saveProject']): ProjectRepository {
  return {
    saveProject,
    loadProject: vi.fn(async () => undefined),
    listProjects: vi.fn(async () => []),
    deleteProject: vi.fn(async () => {}),
  }
}

describe('ProjectPersistenceQueue', () => {
  it('serializes autosaves and resolves a barrier only after its exact snapshot is durable', async () => {
    const releases: Array<() => void> = []
    const saved: string[] = []
    const saveProject = vi.fn(
      (snapshot: ProjectSnapshotV1) =>
        new Promise<void>((resolve) => {
          saved.push(snapshot.name)
          releases.push(resolve)
        }),
    )
    const queue = new ProjectPersistenceQueue(repository(saveProject))

    const first = queue.enqueue(project('first'))
    const barrier = queue.persistBarrier(project('pending request'))
    await vi.waitFor(() => expect(saved).toEqual(['first']))

    releases.shift()?.()
    await first
    await vi.waitFor(() =>
      expect(saved).toEqual(['first', 'pending request']),
    )

    let barrierResolved = false
    void barrier.then(() => {
      barrierResolved = true
    })
    await Promise.resolve()
    expect(barrierResolved).toBe(false)
    releases.shift()?.()
    await barrier
    expect(barrierResolved).toBe(true)
  })

  it('surfaces a failed barrier and allows a later save to recover the queue', async () => {
    const saveProject = vi
      .fn<ProjectRepository['saveProject']>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce()
    const queue = new ProjectPersistenceQueue(repository(saveProject))

    await expect(queue.persistBarrier(project('pending'))).rejects.toThrow(
      'disk full',
    )
    await expect(queue.persistBarrier(project('recovered'))).resolves.toBeUndefined()
    expect(saveProject).toHaveBeenCalledTimes(2)
  })
})
