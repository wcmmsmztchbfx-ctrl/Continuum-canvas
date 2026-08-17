import { createServerWorkspaceBackend } from '../persistence/serverWorkspaceBackend'
import { createWorkspaceRepository } from './repository'

export const defaultWorkspaceRepository = createWorkspaceRepository(
  createServerWorkspaceBackend(),
)

