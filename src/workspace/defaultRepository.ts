import { createServerWorkspaceBackend } from '../persistence/serverWorkspaceBackend'
import { createWorkspaceRepository } from './repository'

export const defaultWorkspaceBackend = createServerWorkspaceBackend()
export const defaultWorkspaceRepository = createWorkspaceRepository(defaultWorkspaceBackend)

