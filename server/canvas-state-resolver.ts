import { parseCanvasSnapshot, type CanvasSnapshotV2 } from '../src/model/project.ts'
import type { WorkspaceService } from './workspace-service.ts'

export interface ResolvedCanvasState {
  snapshot: CanvasSnapshotV2
  revision: number
  workspaceRevision: number
}

export function createCanvasStateResolver(workspace: WorkspaceService) {
  return async (scope: { canvasId: string; projectId?: string }): Promise<ResolvedCanvasState | undefined> => {
    const state = await workspace.readCanvasState(scope.canvasId)
    if (!state?.serialized) return undefined
    const snapshot = parseCanvasSnapshot(state.serialized)
    if (snapshot.canvasId !== scope.canvasId ||
      (scope.projectId !== undefined && snapshot.projectId !== scope.projectId)) return undefined
    return { snapshot, revision: state.revision, workspaceRevision: state.workspaceRevision }
  }
}
