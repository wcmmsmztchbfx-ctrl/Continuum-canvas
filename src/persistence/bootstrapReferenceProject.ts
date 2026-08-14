import { referenceProjectSnapshot } from '../fixtures/reference'
import type { ProjectSnapshotV1 } from '../model/project'
import {
  cloneProjectSnapshot,
  defaultProjectRepository,
} from './projectRepository'
import type { ProjectRepository } from './projectRepository'

export async function bootstrapReferenceProject(
  repository: ProjectRepository = defaultProjectRepository,
): Promise<ProjectSnapshotV1> {
  const stored = await repository.loadProject(referenceProjectSnapshot.projectId)
  if (stored) {
    return stored
  }

  const initialProject = cloneProjectSnapshot(referenceProjectSnapshot)
  await repository.saveProject(initialProject)
  return initialProject
}
