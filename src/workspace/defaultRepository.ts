import { createIndexedDbWorkspaceBackend } from '../persistence/projectRepository'
import { createWorkspaceRepository } from './repository'

export const defaultWorkspaceRepository = createWorkspaceRepository(
  createIndexedDbWorkspaceBackend(),
)
