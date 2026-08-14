import {
  deterministicLegacyCanvasId,
  upgradeProjectSnapshot,
} from '../model/project'
import type {
  CanvasSnapshotV2,
  ProjectSnapshotV1,
} from '../model/project'
import {
  MAX_WORKSPACE_NAME_LENGTH,
  WORKSPACE_MANIFEST_VERSION,
} from './model'
import type {
  WorkspaceCanvas,
  WorkspaceManifestV1,
  WorkspaceProject,
} from './model'

export interface WorkspaceMigrationOptions {
  now: string
  seedProject: ProjectSnapshotV1
}

export interface WorkspaceMigrationResult {
  manifest: WorkspaceManifestV1
  documents: CanvasSnapshotV2[]
}

function legacyName(name: string): string {
  const normalized = name.trim() || '未命名项目'
  return Array.from(normalized).slice(0, MAX_WORKSPACE_NAME_LENGTH).join('')
}

export function migrateLegacyProjects(
  legacyProjects: readonly ProjectSnapshotV1[],
  options: WorkspaceMigrationOptions,
): WorkspaceMigrationResult {
  const sourceProjects = legacyProjects.length > 0
    ? [...legacyProjects]
    : [options.seedProject]
  sourceProjects.sort((left, right) => left.projectId.localeCompare(right.projectId))

  const projects: WorkspaceProject[] = []
  const canvases: WorkspaceCanvas[] = []
  const documents: CanvasSnapshotV2[] = []

  for (const [index, legacy] of sourceProjects.entries()) {
    const canvasId = deterministicLegacyCanvasId(legacy.projectId)
    const column = index % 3
    const row = Math.floor(index / 3)
    projects.push({
      projectId: legacy.projectId,
      name: legacyName(legacy.name),
      position: { x: column * 700, y: row * 460 },
      size: { width: 620, height: 380 },
      favorite: false,
      createdAt: options.now,
      updatedAt: options.now,
    })
    canvases.push({
      canvasId,
      projectId: legacy.projectId,
      name: '画布 1',
      position: { x: 32, y: 80 },
      nodeCount: legacy.nodes.length,
      favorite: false,
      createdAt: options.now,
      updatedAt: options.now,
    })
    documents.push(upgradeProjectSnapshot(legacy, canvasId))
  }

  return {
    manifest: {
      version: WORKSPACE_MANIFEST_VERSION,
      viewport: { x: 0, y: 0, zoom: 1 },
      projects,
      canvases,
      pendingOperations: [],
    },
    documents,
  }
}
