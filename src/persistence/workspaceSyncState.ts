import type { EditWorkspaceMutation, WorkspaceMutation, WorkspaceMutationReceipt, WorkspaceVersionState } from '../workspace/persistenceProtocol'
import type { WorkspaceCommit } from '../workspace/model'
import type { WorkspaceStorageBackend } from '../workspace/repository'

export type WorkspaceSyncPhase = 'saving' | 'synced' | 'pending' | 'conflict' | 'error'

export interface WorkspaceSyncState {
  phase: WorkspaceSyncPhase
  pendingCount: number
  message?: string
}

export interface PendingWorkspaceMutation {
  operationId: string
  sequence: number
  mutation: WorkspaceMutation
  status: 'pending' | 'conflict' | 'error'
  message?: string
}

export interface WorkspaceSyncRecord {
  id: 'workspace'
  nextSequence: number
  versions: WorkspaceVersionState
  localVersions: WorkspaceVersionState
  cachedCanvasRevisions: Record<string, number>
  pending: PendingWorkspaceMutation[]
  recovery?: { sourceOperationIds: string[]; mutation: EditWorkspaceMutation }
}

export type WorkspaceCacheChange = Partial<WorkspaceCommit>

export interface WorkspaceSyncStorageBackend extends WorkspaceStorageBackend {
  readSyncRecord(): Promise<WorkspaceSyncRecord>
  readSyncSnapshot(canvasId?: string): Promise<{ record: WorkspaceSyncRecord; manifest?: string; document?: string }>
  // The record and returned document changes are committed in one transaction.
  transactSync(update: (record: WorkspaceSyncRecord, manifest: string | undefined) => WorkspaceCacheChange | undefined): Promise<void>
}

export function emptyWorkspaceSyncRecord(): WorkspaceSyncRecord {
  return { id: 'workspace', nextSequence: 1, versions: { workspaceRevision: 0, canvasRevisions: {} }, localVersions: { workspaceRevision: 0, canvasRevisions: {} }, cachedCanvasRevisions: {}, pending: [] }
}

export interface WorkspaceSyncService {
  subscribe(listener: () => void): () => void
  getState(): WorkspaceSyncState
  start(): () => void
  retry(): Promise<void>
  exportRecovery(): Promise<string>
  resolveConflict(choice: 'copy' | 'reload'): Promise<void>
}

export function mergeWorkspaceVersions(target: WorkspaceVersionState, source: WorkspaceVersionState): void {
  target.workspaceRevision = Math.max(target.workspaceRevision, source.workspaceRevision)
  for (const [id, revision] of Object.entries(source.canvasRevisions)) {
    target.canvasRevisions[id] = Math.max(target.canvasRevisions[id] ?? 0, revision)
  }
}

export function assertWorkspaceReceipt(value: unknown, operationId: string): asserts value is WorkspaceMutationReceipt {
  const receipt = value as WorkspaceMutationReceipt | undefined
  if (!receipt || receipt.protocolVersion !== 1 || receipt.operationId !== operationId ||
      !Number.isSafeInteger(receipt.workspaceRevision) || receipt.workspaceRevision < 0 ||
      !receipt.canvasRevisions || typeof receipt.canvasRevisions !== 'object' ||
      Object.values(receipt.canvasRevisions).some((revision) => !Number.isSafeInteger(revision) || revision < 0) ||
      !receipt.manifest || receipt.manifest.version !== 1) {
    throw new Error('服务器未确认本次保存，将保留本地修改并重试')
  }
}
