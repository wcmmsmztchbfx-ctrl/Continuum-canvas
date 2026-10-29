import type { CanvasSnapshotV2 } from '../model/project.ts'
import type { WorkspaceCommit, WorkspaceManifestV1 } from './model.ts'

export const WORKSPACE_PROTOCOL_VERSION = 1 as const

export interface WorkspaceVersionState {
  workspaceRevision: number
  canvasRevisions: Record<string, number>
}

interface MutationIdentity {
  protocolVersion: typeof WORKSPACE_PROTOCOL_VERSION
  operationId: string
}

export interface SaveCanvasMutation extends MutationIdentity {
  kind: 'save-canvas'
  expectedRevision: number
  canvas: CanvasSnapshotV2
}

export interface EditWorkspaceMutation extends MutationIdentity {
  kind: 'edit-workspace'
  expectedWorkspaceRevision: number
  expectedCanvasRevisions: Record<string, number>
  commit: WorkspaceCommit
}

export type WorkspaceMutation = SaveCanvasMutation | EditWorkspaceMutation

export interface WorkspaceMutationReceipt extends WorkspaceVersionState, MutationIdentity {
  manifest: WorkspaceManifestV1
}

export interface WorkspaceManifestResponse extends WorkspaceVersionState {
  manifest: WorkspaceManifestV1
}

export interface CanvasDocumentResponse {
  canvas: CanvasSnapshotV2
  revision: number
  workspaceRevision: number
}

export interface PersistedCanvasRecord {
  recordVersion: 1
  canvasId: string
  projectId: string
  revision: number
  snapshot?: CanvasSnapshotV2
  deleted?: boolean
  roomId?: string
  epoch?: string
}
