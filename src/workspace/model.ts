import type { NodeSize, Point, Viewport } from '../model/project.ts'

export const WORKSPACE_MANIFEST_VERSION = 1 as const
export const MAX_WORKSPACE_NAME_LENGTH = 60

export interface WorkspaceProject {
  projectId: string
  name: string
  position: Point
  size: NodeSize
  favorite: boolean
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export interface WorkspaceCanvas {
  canvasId: string
  projectId: string
  name: string
  position: Point
  nodeCount: number
  favorite: boolean
  createdAt: string
  updatedAt: string
  deletedAt?: string
  trashedByProjectId?: string
}

export interface WorkspacePendingOperation {
  operationId: string
  kind: 'move-canvas'
  canvasId: string
  fromProjectId: string
  toProjectId: string
  position?: Point
  createdAt: string
}

export interface WorkspaceManifestV1 {
  version: typeof WORKSPACE_MANIFEST_VERSION
  viewport: Viewport
  projects: WorkspaceProject[]
  canvases: WorkspaceCanvas[]
  pendingOperations: WorkspacePendingOperation[]
}

export interface StoredCanvasDocument {
  canvasId: string
  serialized: string
}

export interface WorkspaceCommit {
  manifest: string | WorkspaceManifestV1
  putDocuments?: StoredCanvasDocument[]
  deleteCanvasIds?: string[]
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPoint(value: unknown): value is Point {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    Math.abs(value.x) <= 10_000_000 &&
    Math.abs(value.y) <= 10_000_000
  )
}

function isViewport(value: unknown): value is Viewport {
  return (
    isPoint(value) &&
    isRecord(value) &&
    isFiniteNumber(value.zoom) &&
    value.zoom >= 0.01 &&
    value.zoom <= 8
  )
}

function isName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    Array.from(value).length >= 1 &&
    Array.from(value).length <= MAX_WORKSPACE_NAME_LENGTH
  )
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function hasOptionalTimestamp(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || isTimestamp(record[key])
}

function isWorkspaceProject(value: unknown): value is WorkspaceProject {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    value.projectId.length > 0 &&
    isName(value.name) &&
    isPoint(value.position) &&
    isRecord(value.size) &&
    isFiniteNumber(value.size.width) &&
    isFiniteNumber(value.size.height) &&
    value.size.width > 0 &&
    value.size.height > 0 &&
    typeof value.favorite === 'boolean' &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    hasOptionalTimestamp(value, 'deletedAt')
  )
}

function isWorkspaceCanvas(value: unknown): value is WorkspaceCanvas {
  return (
    isRecord(value) &&
    typeof value.canvasId === 'string' &&
    value.canvasId.length > 0 &&
    typeof value.projectId === 'string' &&
    value.projectId.length > 0 &&
    isName(value.name) &&
    isPoint(value.position) &&
    isFiniteNumber(value.nodeCount) &&
    Number.isInteger(value.nodeCount) &&
    value.nodeCount >= 0 &&
    typeof value.favorite === 'boolean' &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    hasOptionalTimestamp(value, 'deletedAt') &&
    (value.trashedByProjectId === undefined ||
      (typeof value.trashedByProjectId === 'string' &&
        value.trashedByProjectId.length > 0)) &&
    (value.trashedByProjectId === undefined || value.deletedAt !== undefined)
  )
}

function isPendingOperation(value: unknown): value is WorkspacePendingOperation {
  return (
    isRecord(value) &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    value.kind === 'move-canvas' &&
    typeof value.canvasId === 'string' &&
    value.canvasId.length > 0 &&
    typeof value.fromProjectId === 'string' &&
    value.fromProjectId.length > 0 &&
    typeof value.toProjectId === 'string' &&
    value.toProjectId.length > 0 &&
    (value.position === undefined || isPoint(value.position)) &&
    isTimestamp(value.createdAt)
  )
}

export function normalizeWorkspaceName(name: string): string {
  const normalized = name.trim()
  if (normalized.length === 0) {
    throw new Error('名称不能为空')
  }
  if (Array.from(normalized).length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new Error(`名称不能超过 ${MAX_WORKSPACE_NAME_LENGTH} 个字符`)
  }
  return normalized
}

export function parseWorkspaceManifest(serialized: string): WorkspaceManifestV1 {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('Invalid workspace manifest JSON')
  }

  if (
    !isRecord(value) ||
    value.version !== WORKSPACE_MANIFEST_VERSION ||
    !isViewport(value.viewport) ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isWorkspaceProject) ||
    !Array.isArray(value.canvases) ||
    !value.canvases.every(isWorkspaceCanvas) ||
    !Array.isArray(value.pendingOperations) ||
    !value.pendingOperations.every(isPendingOperation)
  ) {
    throw new Error('Invalid workspace manifest')
  }

  const projects = value.projects as WorkspaceProject[]
  const canvases = value.canvases as WorkspaceCanvas[]
  const operations = value.pendingOperations as WorkspacePendingOperation[]
  const projectIds = new Set(projects.map((project) => project.projectId))
  const canvasIds = new Set(canvases.map((canvas) => canvas.canvasId))
  const operationIds = new Set(
    operations.map((operation) => operation.operationId),
  )
  if (
    projectIds.size !== projects.length ||
    canvasIds.size !== canvases.length ||
    operationIds.size !== operations.length ||
    canvases.some(
      (canvas) =>
        canvas.projectId !== canvas.canvasId &&
        !projectIds.has(canvas.projectId),
    ) ||
    canvases.some(
      (canvas) =>
        canvas.trashedByProjectId !== undefined &&
        !projectIds.has(canvas.trashedByProjectId),
    )
  ) {
    throw new Error('Invalid workspace manifest')
  }

  return structuredClone(value) as unknown as WorkspaceManifestV1
}
