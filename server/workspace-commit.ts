import { createHash } from 'node:crypto'
import { parseCanvasSnapshot, type CanvasSnapshotV2 } from '../src/model/project.ts'
import { parseWorkspaceManifest, type WorkspaceManifestV1 } from '../src/workspace/model.ts'
import type { WorkspaceMutation } from '../src/workspace/persistenceProtocol.ts'

export class WorkspaceConflictError extends Error {
  readonly code = 'workspace_conflict'
  constructor(message = 'Workspace revision conflict') { super(message) }
}

export class WorkspacePreconditionError extends Error {
  readonly code = 'workspace_precondition_required'
  constructor(message = 'Workspace mutation requires a revision precondition') { super(message) }
}

export class WorkspaceInputError extends Error {
  readonly code = 'workspace_invalid_input'
  constructor(message = 'Invalid workspace mutation') { super(message) }
}

export class WorkspaceOperationIdConflictError extends Error {
  readonly code = 'operation_id_conflict'
  constructor() { super('Operation ID was already used for different content') }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const isSafeId = (value: string): boolean => SAFE_ID.test(value) &&
  value !== '__proto__' && value !== 'constructor' && value !== 'prototype'
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

export function parseWorkspaceMutation(value: unknown): WorkspaceMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceInputError()
  const input = value as Record<string, unknown>
  if (input.protocolVersion === undefined || input.operationId === undefined || input.kind === undefined) {
    throw new WorkspacePreconditionError()
  }
  if (input.protocolVersion !== 1 || typeof input.operationId !== 'string' || !isSafeId(input.operationId)) {
    throw new WorkspaceInputError()
  }
  if (input.kind === 'save-canvas') {
    if (input.expectedRevision === undefined) throw new WorkspacePreconditionError()
    if (!isRevision(input.expectedRevision)) throw new WorkspaceInputError()
    let canvas: CanvasSnapshotV2
    try { canvas = parseCanvasSnapshot(JSON.stringify(input.canvas)) } catch { throw new WorkspaceInputError('Invalid canvas snapshot') }
    if (!isSafeId(canvas.canvasId) || !isSafeId(canvas.projectId)) throw new WorkspaceInputError()
    return { protocolVersion: 1, operationId: input.operationId, kind: 'save-canvas',
      expectedRevision: input.expectedRevision, canvas }
  }
  if (input.kind === 'edit-workspace') {
    if (input.expectedWorkspaceRevision === undefined || input.expectedCanvasRevisions === undefined) {
      throw new WorkspacePreconditionError()
    }
    if (!isRevision(input.expectedWorkspaceRevision) || !input.expectedCanvasRevisions ||
      typeof input.expectedCanvasRevisions !== 'object' || Array.isArray(input.expectedCanvasRevisions)) throw new WorkspaceInputError()
    const expectedCanvasRevisions = input.expectedCanvasRevisions as Record<string, unknown>
    if (Object.entries(expectedCanvasRevisions).some(([id, revision]) => !isSafeId(id) || !isRevision(revision))) {
      throw new WorkspaceInputError()
    }
    if (!input.commit || typeof input.commit !== 'object' || Array.isArray(input.commit)) throw new WorkspaceInputError()
    const commit = input.commit as Record<string, unknown>
    let manifest: WorkspaceManifestV1
    try { manifest = parseWorkspaceManifest(typeof commit.manifest === 'string' ? commit.manifest : JSON.stringify(commit.manifest)) }
    catch { throw new WorkspaceInputError('Invalid workspace manifest') }
    if (commit.putDocuments !== undefined && !Array.isArray(commit.putDocuments)) throw new WorkspaceInputError()
    if (commit.deleteCanvasIds !== undefined && !Array.isArray(commit.deleteCanvasIds)) throw new WorkspaceInputError()
    const putDocuments = (commit.putDocuments ?? []) as unknown[]
    const deleteCanvasIds = (commit.deleteCanvasIds ?? []) as unknown[]
    if (putDocuments.some((item) => !item || typeof item !== 'object' ||
      typeof (item as Record<string, unknown>).canvasId !== 'string' ||
      typeof (item as Record<string, unknown>).serialized !== 'string') ||
      deleteCanvasIds.some((id) => typeof id !== 'string' || !isSafeId(id)) ||
      new Set(deleteCanvasIds).size !== deleteCanvasIds.length) throw new WorkspaceInputError()
    for (const item of putDocuments as Array<{ canvasId: string; serialized: string }>) {
      try {
        const snapshot = parseCanvasSnapshot(item.serialized)
        if (!isSafeId(item.canvasId) || snapshot.canvasId !== item.canvasId ||
          !manifest.canvases.some((canvas) => canvas.canvasId === item.canvasId && canvas.projectId === snapshot.projectId)) {
          throw new WorkspaceInputError('Canvas identity does not match workspace manifest')
        }
      } catch { throw new WorkspaceInputError('Invalid workspace canvas document') }
    }
    if (deleteCanvasIds.some((id) => manifest.canvases.some((canvas) => canvas.canvasId === id))) {
      throw new WorkspaceInputError('Deleted canvas remains in manifest')
    }
    for (const id of [...putDocuments.map((doc) => (doc as { canvasId: string }).canvasId), ...deleteCanvasIds] as string[]) {
      if (!Object.hasOwn(expectedCanvasRevisions, id)) throw new WorkspacePreconditionError(`Missing canvas revision for ${id}`)
    }
    return { protocolVersion: 1, operationId: input.operationId, kind: 'edit-workspace',
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
      expectedCanvasRevisions: expectedCanvasRevisions as Record<string, number>,
      commit: { manifest, putDocuments: putDocuments as Array<{ canvasId: string; serialized: string }>,
        deleteCanvasIds: deleteCanvasIds as string[] } }
  }
  throw new WorkspaceInputError()
}

export function workspaceMutationDigest(mutation: WorkspaceMutation): string {
  return createHash('sha256').update(JSON.stringify(mutation)).digest('hex')
}
