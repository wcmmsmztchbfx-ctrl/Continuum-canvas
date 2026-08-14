import type { ProjectSnapshotV1 } from '../model/project'
import {
  defaultProjectRepository,
  type ProjectRepository,
} from './projectRepository'

export class ProjectPersistenceQueue {
  private tail: Promise<void> = Promise.resolve()
  private readonly repository: ProjectRepository

  constructor(repository: ProjectRepository) {
    this.repository = repository
  }

  enqueue(project: ProjectSnapshotV1): Promise<void> {
    const operation = this.tail
      .catch(() => undefined)
      .then(() => this.repository.saveProject(project))
    this.tail = operation
    return operation
  }

  persistBarrier(project: ProjectSnapshotV1): Promise<void> {
    return this.enqueue(project)
  }
}

export const defaultProjectPersistenceQueue = new ProjectPersistenceQueue(
  defaultProjectRepository,
)
