import {
  CANVAS_SNAPSHOT_VERSION,
  parseCanvasSnapshot,
  parseProjectSnapshot,
} from '../model/project'
import type {
  CanvasNode,
  CanvasSnapshotV2,
  Point,
  ProjectSnapshotV1,
  Viewport,
} from '../model/project'
import { migrateLegacyProjects } from './migration'
import {
  normalizeWorkspaceName,
  parseWorkspaceManifest,
} from './model'
import { createBrowserUuid } from '../utils/id'
import type {
  StoredCanvasDocument,
  WorkspaceCanvas,
  WorkspaceCommit,
  WorkspaceManifestV1,
  WorkspacePendingOperation,
  WorkspaceProject,
} from './model'

export type { StoredCanvasDocument, WorkspaceCommit }

export interface WorkspaceInitialization {
  manifest: string
  documents: StoredCanvasDocument[]
}

export interface WorkspaceStorageBackend {
  initializeFromLegacy(
    create: (legacyProjects: readonly string[]) => WorkspaceInitialization,
  ): Promise<void>
  getManifest(): Promise<string | undefined>
  getCanvasDocument(canvasId: string): Promise<string | undefined>
  commit(commit: WorkspaceCommit): Promise<void>
}

export interface WorkspaceRepositoryOptions {
  now?: () => string
  createId?: () => string
  seedProject?: ProjectSnapshotV1
}

export interface CreateCanvasOptions {
  projectId?: string
  position?: Point
  template?: CanvasSnapshotV2
}

export interface MoveCanvasOptions {
  position: Point
  projectId?: string
}

export interface DuplicatedProject {
  project: WorkspaceProject
  canvases: WorkspaceCanvas[]
}

export interface WorkspaceRepository {
  getManifest(): Promise<WorkspaceManifestV1>
  loadCanvas(canvasId: string): Promise<CanvasSnapshotV2 | undefined>
  ensureInvitedCanvas?(projectId: string, canvasId: string): Promise<void>
  saveCanvas(snapshot: CanvasSnapshotV2): Promise<void>
  createProject(name: string, position?: Point): Promise<WorkspaceProject>
  createCanvas(name: string, options?: CreateCanvasOptions): Promise<WorkspaceCanvas>
  renameProject(projectId: string, name: string): Promise<WorkspaceProject>
  renameCanvas(canvasId: string, name: string): Promise<WorkspaceCanvas>
  duplicateProject(projectId: string): Promise<DuplicatedProject>
  duplicateCanvas(canvasId: string): Promise<WorkspaceCanvas>
  moveProject(projectId: string, position: Point): Promise<WorkspaceProject>
  resizeProject(projectId: string, size: { width: number; height: number }): Promise<WorkspaceProject>
  setProjectFavorite(projectId: string, favorite: boolean): Promise<WorkspaceProject>
  setCanvasFavorite(canvasId: string, favorite: boolean): Promise<WorkspaceCanvas>
  moveCanvas(canvasId: string, options: MoveCanvasOptions): Promise<WorkspaceCanvas>
  beginCanvasMove(
    canvasId: string,
    toProjectId: string,
    operationId?: string,
    position?: Point,
  ): Promise<WorkspacePendingOperation>
  completeCanvasMove(
    operationId: string,
    options: MoveCanvasOptions,
  ): Promise<WorkspaceCanvas>
  cancelCanvasMove(operationId: string): Promise<void>
  trashProject(projectId: string): Promise<void>
  trashCanvas(canvasId: string): Promise<void>
  restoreProject(projectId: string): Promise<void>
  restoreCanvas(canvasId: string): Promise<void>
  permanentlyDeleteProject(projectId: string): Promise<void>
  permanentlyDeleteCanvas(canvasId: string): Promise<void>
  updateViewport(viewport: Viewport): Promise<void>
}

function serializeManifest(manifest: WorkspaceManifestV1): string {
  const serialized = JSON.stringify(manifest)
  parseWorkspaceManifest(serialized)
  return serialized
}

function serializeCanvas(snapshot: CanvasSnapshotV2): string {
  const serialized = JSON.stringify(snapshot)
  parseCanvasSnapshot(serialized)
  return serialized
}

function copiedName(name: string): string {
  const suffix = ' 副本'
  const available = 60 - Array.from(suffix).length
  return `${Array.from(name).slice(0, available).join('')}${suffix}`
}

function hasActiveGeneration(snapshot: CanvasSnapshotV2): boolean {
  return snapshot.nodes.some(
    (node) =>
      (node.type === 'image' || node.type === 'video') &&
      node.data.generation?.status === 'generating',
  )
}

function clearedCopyNode(node: CanvasNode): CanvasNode {
  if (node.type !== 'image' && node.type !== 'video') {
    return structuredClone(node)
  }
  const cloned = structuredClone(node)
  if (
    cloned.data.generation?.status === 'generating' ||
    cloned.data.generation?.pendingRequest
  ) {
    delete cloned.data.generation
  }
  return cloned
}

const EMPTY_WORKSPACE_SEED_PROJECT: ProjectSnapshotV1 = {
  version: 1,
  projectId: 'default-project',
  name: '画布 1',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
}

export function createWorkspaceRepository(
  backend: WorkspaceStorageBackend,
  options: WorkspaceRepositoryOptions = {},
): WorkspaceRepository {
  const now = options.now ?? (() => new Date().toISOString())
  const createId = options.createId ?? createBrowserUuid
  const seedProject = options.seedProject ?? EMPTY_WORKSPACE_SEED_PROJECT

  const initialize = () =>
    backend.initializeFromLegacy((serializedProjects) => {
      const legacyProjects = serializedProjects.map((serialized) =>
        parseProjectSnapshot(serialized),
      )
      const migration = migrateLegacyProjects(legacyProjects, {
        now: now(),
        seedProject,
      })
      return {
        manifest: serializeManifest(migration.manifest),
        documents: migration.documents.map((document) => ({
          canvasId: document.canvasId,
          serialized: serializeCanvas(document),
        })),
      }
    })

  const readManifest = async () => {
    await initialize()
    const serialized = await backend.getManifest()
    if (!serialized) throw new Error('工作区清单不存在')
    return parseWorkspaceManifest(serialized)
  }

  const readCanvas = async (canvasId: string) => {
    await initialize()
    const serialized = await backend.getCanvasDocument(canvasId)
    return serialized === undefined ? undefined : parseCanvasSnapshot(serialized)
  }

  const commit = (
    manifest: WorkspaceManifestV1,
    changes: Omit<WorkspaceCommit, 'manifest'> = {},
  ) => backend.commit({ ...changes, manifest: serializeManifest(manifest) })

  const nextUniqueId = (manifest: WorkspaceManifestV1): string => {
    const used = new Set([
      ...manifest.projects.map((project) => project.projectId),
      ...manifest.canvases.map((canvas) => canvas.canvasId),
    ])
    const id = createId()
    if (!id || used.has(id)) throw new Error('无法创建唯一 ID')
    return id
  }

  const requireProject = (
    manifest: WorkspaceManifestV1,
    projectId: string,
  ) => {
    const project = manifest.projects.find((item) => item.projectId === projectId)
    if (!project) throw new Error(`项目“${projectId}”不存在`)
    return project
  }

  const requireCanvas = (
    manifest: WorkspaceManifestV1,
    canvasId: string,
  ) => {
    const canvas = manifest.canvases.find((item) => item.canvasId === canvasId)
    if (!canvas) throw new Error(`画布“${canvasId}”不存在`)
    return canvas
  }

  const assertCanUseProject = (
    manifest: WorkspaceManifestV1,
    projectId: string,
  ) => {
    const project = requireProject(manifest, projectId)
    if (project.deletedAt) throw new Error('不能使用回收站中的项目')
  }

  return {
    getManifest: readManifest,

    loadCanvas: readCanvas,

    async ensureInvitedCanvas(projectId, canvasId) {
      const manifest = await readManifest()
      const existing = manifest.canvases.find((item) => item.canvasId === canvasId)
      if (existing) {
        if (existing.projectId !== projectId) throw new Error('协作画布归属不一致')
        return
      }
      const timestamp = now()
      if (
        projectId !== canvasId &&
        !manifest.projects.some((project) => project.projectId === projectId)
      ) {
        manifest.projects.push({
          projectId,
          name: '协作项目',
          position: { x: 0, y: 0 },
          size: { width: 620, height: 380 },
          favorite: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      }
      const document: CanvasSnapshotV2 = {
        version: CANVAS_SNAPSHOT_VERSION,
        canvasId,
        projectId,
        name: '协作画布',
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [],
        edges: [],
      }
      manifest.canvases.push({
        canvasId,
        projectId,
        name: document.name,
        position: { x: 0, y: 0 },
        nodeCount: 0,
        favorite: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      await commit(manifest, {
        putDocuments: [{ canvasId, serialized: serializeCanvas(document) }],
      })
    },

    async saveCanvas(snapshot) {
      const serialized = serializeCanvas(snapshot)
      const parsed = parseCanvasSnapshot(serialized)
      const manifest = await readManifest()
      const canvas = requireCanvas(manifest, parsed.canvasId)
      if (canvas.projectId !== parsed.projectId) {
        throw new Error('画布文档与工作区归属不一致')
      }
      canvas.name = normalizeWorkspaceName(parsed.name)
      canvas.nodeCount = parsed.nodes.length
      canvas.updatedAt = now()
      await commit(manifest, {
        putDocuments: [
          { canvasId: parsed.canvasId, serialized },
        ],
      })
    },

    async createProject(name, position = { x: 0, y: 0 }) {
      const manifest = await readManifest()
      const timestamp = now()
      const normalizedName = normalizeWorkspaceName(name)
      const project: WorkspaceProject = {
        projectId: nextUniqueId(manifest),
        name: normalizedName,
        position: structuredClone(position),
        size: { width: 620, height: 380 },
        favorite: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      manifest.projects.push(project)
      await commit(manifest)
      return structuredClone(project)
    },

    async createCanvas(name, createOptions = {}) {
      const manifest = await readManifest()
      const normalizedName = normalizeWorkspaceName(name)
      const canvasId = nextUniqueId(manifest)
      const projectId = createOptions.projectId ?? canvasId
      if (projectId !== canvasId) assertCanUseProject(manifest, projectId)
      const timestamp = now()
      const source = createOptions.template
      const document: CanvasSnapshotV2 = source
        ? {
            ...structuredClone(source),
            version: CANVAS_SNAPSHOT_VERSION,
            canvasId,
            projectId,
            name: normalizedName,
            nodes: source.nodes.map(clearedCopyNode),
          }
        : {
            version: CANVAS_SNAPSHOT_VERSION,
            canvasId,
            projectId,
            name: normalizedName,
            viewport: { x: 0, y: 0, zoom: 1 },
            nodes: [],
            edges: [],
          }
      const canvas: WorkspaceCanvas = {
        canvasId,
        projectId,
        name: normalizedName,
        position: structuredClone(createOptions.position ?? { x: 0, y: 0 }),
        nodeCount: document.nodes.length,
        favorite: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      manifest.canvases.push(canvas)
      await commit(manifest, {
        putDocuments: [{ canvasId, serialized: serializeCanvas(document) }],
      })
      return structuredClone(canvas)
    },

    async renameProject(projectId, name) {
      const manifest = await readManifest()
      const project = requireProject(manifest, projectId)
      project.name = normalizeWorkspaceName(name)
      project.updatedAt = now()
      await commit(manifest)
      return structuredClone(project)
    },

    async renameCanvas(canvasId, name) {
      const manifest = await readManifest()
      const canvas = requireCanvas(manifest, canvasId)
      const document = await readCanvas(canvasId)
      if (!document) throw new Error(`画布“${canvasId}”文档不存在`)
      const normalizedName = normalizeWorkspaceName(name)
      canvas.name = normalizedName
      canvas.updatedAt = now()
      document.name = normalizedName
      await commit(manifest, {
        putDocuments: [{ canvasId, serialized: serializeCanvas(document) }],
      })
      return structuredClone(canvas)
    },

    async duplicateCanvas(canvasId) {
      const manifest = await readManifest()
      const sourceCanvas = requireCanvas(manifest, canvasId)
      if (sourceCanvas.deletedAt) throw new Error('不能复制回收站中的画布')
      const source = await readCanvas(canvasId)
      if (!source) throw new Error(`画布“${canvasId}”文档不存在`)
      const newCanvasId = nextUniqueId(manifest)
      const projectId = sourceCanvas.projectId === sourceCanvas.canvasId
        ? newCanvasId
        : sourceCanvas.projectId
      const timestamp = now()
      const name = copiedName(sourceCanvas.name)
      const document: CanvasSnapshotV2 = {
        ...structuredClone(source),
        canvasId: newCanvasId,
        projectId,
        name,
        nodes: source.nodes.map(clearedCopyNode),
      }
      const canvas: WorkspaceCanvas = {
        ...structuredClone(sourceCanvas),
        canvasId: newCanvasId,
        projectId,
        name,
        position: {
          x: sourceCanvas.position.x + 32,
          y: sourceCanvas.position.y + 32,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      delete canvas.deletedAt
      delete canvas.trashedByProjectId
      manifest.canvases.push(canvas)
      await commit(manifest, {
        putDocuments: [
          { canvasId: newCanvasId, serialized: serializeCanvas(document) },
        ],
      })
      return structuredClone(canvas)
    },

    async duplicateProject(projectId) {
      const manifest = await readManifest()
      const sourceProject = requireProject(manifest, projectId)
      if (sourceProject.deletedAt) throw new Error('不能复制回收站中的项目')
      const timestamp = now()
      const newProjectId = nextUniqueId(manifest)
      const project: WorkspaceProject = {
        ...structuredClone(sourceProject),
        projectId: newProjectId,
        name: copiedName(sourceProject.name),
        position: {
          x: sourceProject.position.x + 48,
          y: sourceProject.position.y + 48,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      delete project.deletedAt
      const canvases: WorkspaceCanvas[] = []
      const putDocuments: StoredCanvasDocument[] = []
      for (const sourceCanvas of manifest.canvases.filter(
        (canvas) => canvas.projectId === projectId && !canvas.deletedAt,
      )) {
        const source = await readCanvas(sourceCanvas.canvasId)
        if (!source) throw new Error(`画布“${sourceCanvas.canvasId}”文档不存在`)
        const newCanvasId = nextUniqueId({
          ...manifest,
          projects: [...manifest.projects, project],
          canvases: [...manifest.canvases, ...canvases],
        })
        const canvas: WorkspaceCanvas = {
          ...structuredClone(sourceCanvas),
          canvasId: newCanvasId,
          projectId: newProjectId,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        canvases.push(canvas)
        putDocuments.push({
          canvasId: newCanvasId,
          serialized: serializeCanvas({
            ...structuredClone(source),
            canvasId: newCanvasId,
            projectId: newProjectId,
            nodes: source.nodes.map(clearedCopyNode),
          }),
        })
      }
      manifest.projects.push(project)
      manifest.canvases.push(...canvases)
      await commit(manifest, { putDocuments })
      return { project: structuredClone(project), canvases: structuredClone(canvases) }
    },

    async moveProject(projectId, position) {
      const manifest = await readManifest()
      const project = requireProject(manifest, projectId)
      project.position = structuredClone(position)
      project.updatedAt = now()
      await commit(manifest)
      return structuredClone(project)
    },

    async resizeProject(projectId, size) {
      const manifest = await readManifest()
      const project = requireProject(manifest, projectId)
      const children = manifest.canvases.filter(
        (canvas) => canvas.projectId === projectId && !canvas.deletedAt,
      )
      const minimumWidth = Math.max(
        360,
        ...children.map((canvas) => canvas.position.x + 240 + 24),
      )
      const minimumHeight = Math.max(
        240,
        ...children.map((canvas) => canvas.position.y + 112 + 24),
      )
      project.size = {
        width: Math.max(minimumWidth, size.width),
        height: Math.max(minimumHeight, size.height),
      }
      project.updatedAt = now()
      await commit(manifest)
      return structuredClone(project)
    },

    async setProjectFavorite(projectId, favorite) {
      const manifest = await readManifest()
      const project = requireProject(manifest, projectId)
      project.favorite = favorite
      project.updatedAt = now()
      await commit(manifest)
      return structuredClone(project)
    },

    async setCanvasFavorite(canvasId, favorite) {
      const manifest = await readManifest()
      const canvas = requireCanvas(manifest, canvasId)
      canvas.favorite = favorite
      canvas.updatedAt = now()
      await commit(manifest)
      return structuredClone(canvas)
    },

    async moveCanvas(canvasId, moveOptions) {
      const manifest = await readManifest()
      const canvas = requireCanvas(manifest, canvasId)
      const document = await readCanvas(canvasId)
      if (!document) throw new Error(`画布“${canvasId}”文档不存在`)
      const projectId = moveOptions.projectId ?? canvas.projectId
      if (projectId !== canvasId) assertCanUseProject(manifest, projectId)
      if (projectId !== canvas.projectId && hasActiveGeneration(document)) {
        throw new Error('生成任务进行中，不能移动画布归属')
      }
      canvas.position = structuredClone(moveOptions.position)
      canvas.projectId = projectId
      canvas.updatedAt = now()
      document.projectId = projectId
      await commit(manifest, {
        putDocuments: [{ canvasId, serialized: serializeCanvas(document) }],
      })
      return structuredClone(canvas)
    },

    async beginCanvasMove(
      canvasId,
      toProjectId,
      operationId = createId(),
      position,
    ) {
      const manifest = await readManifest()
      const existing = manifest.pendingOperations.find(
        (operation) => operation.operationId === operationId,
      )
      if (existing) {
        if (
          existing.canvasId !== canvasId ||
          existing.toProjectId !== toProjectId
        ) {
          throw new Error('迁移操作 ID 已被其他操作使用')
        }
        return structuredClone(existing)
      }
      const canvas = requireCanvas(manifest, canvasId)
      const document = await readCanvas(canvasId)
      if (!document) throw new Error(`画布“${canvasId}”文档不存在`)
      if (hasActiveGeneration(document)) {
        throw new Error('生成任务进行中，不能移动画布归属')
      }
      if (toProjectId !== canvasId) assertCanUseProject(manifest, toProjectId)
      const operation: WorkspacePendingOperation = {
        operationId,
        kind: 'move-canvas',
        canvasId,
        fromProjectId: canvas.projectId,
        toProjectId,
        ...(position ? { position: structuredClone(position) } : {}),
        createdAt: now(),
      }
      manifest.pendingOperations.push(operation)
      await commit(manifest)
      return structuredClone(operation)
    },

    async completeCanvasMove(operationId, moveOptions) {
      const manifest = await readManifest()
      const operation = manifest.pendingOperations.find(
        (candidate) => candidate.operationId === operationId,
      )
      if (!operation) throw new Error('迁移操作不存在或已经完成')
      const canvas = requireCanvas(manifest, operation.canvasId)
      const document = await readCanvas(canvas.canvasId)
      if (!document) throw new Error(`画布“${canvas.canvasId}”文档不存在`)
      const projectId = moveOptions.projectId ?? operation.toProjectId
      if (projectId !== operation.toProjectId) {
        throw new Error('迁移目标与已记录操作不一致')
      }
      if (projectId !== canvas.canvasId) assertCanUseProject(manifest, projectId)
      canvas.position = structuredClone(
        moveOptions.position ?? operation.position ?? canvas.position,
      )
      canvas.projectId = projectId
      canvas.updatedAt = now()
      document.projectId = projectId
      manifest.pendingOperations = manifest.pendingOperations.filter(
        (candidate) => candidate.operationId !== operationId,
      )
      await commit(manifest, {
        putDocuments: [
          { canvasId: canvas.canvasId, serialized: serializeCanvas(document) },
        ],
      })
      return structuredClone(canvas)
    },

    async cancelCanvasMove(operationId) {
      const manifest = await readManifest()
      const next = manifest.pendingOperations.filter(
        (operation) => operation.operationId !== operationId,
      )
      if (next.length === manifest.pendingOperations.length) return
      manifest.pendingOperations = next
      await commit(manifest)
    },

    async trashProject(projectId) {
      const manifest = await readManifest()
      const project = requireProject(manifest, projectId)
      const timestamp = now()
      for (const canvas of manifest.canvases.filter(
        (item) => item.projectId === projectId && !item.deletedAt,
      )) {
        const document = await readCanvas(canvas.canvasId)
        if (document && hasActiveGeneration(document)) {
          throw new Error('生成任务进行中，不能移入回收站')
        }
        canvas.deletedAt = timestamp
        canvas.trashedByProjectId = projectId
        canvas.updatedAt = timestamp
      }
      project.deletedAt = timestamp
      project.updatedAt = timestamp
      await commit(manifest)
    },

    async trashCanvas(canvasId) {
      const manifest = await readManifest()
      const canvas = requireCanvas(manifest, canvasId)
      const document = await readCanvas(canvasId)
      if (document && hasActiveGeneration(document)) {
        throw new Error('生成任务进行中，不能移入回收站')
      }
      canvas.deletedAt = now()
      canvas.updatedAt = canvas.deletedAt
      delete canvas.trashedByProjectId
      await commit(manifest)
    },

    async restoreProject(projectId) {
      const manifest = await readManifest()
      const project = requireProject(manifest, projectId)
      delete project.deletedAt
      project.updatedAt = now()
      for (const canvas of manifest.canvases) {
        if (canvas.trashedByProjectId !== projectId) continue
        delete canvas.deletedAt
        delete canvas.trashedByProjectId
        canvas.updatedAt = project.updatedAt
      }
      await commit(manifest)
    },

    async restoreCanvas(canvasId) {
      const manifest = await readManifest()
      const canvas = requireCanvas(manifest, canvasId)
      if (canvas.projectId !== canvas.canvasId) {
        assertCanUseProject(manifest, canvas.projectId)
      }
      delete canvas.deletedAt
      delete canvas.trashedByProjectId
      canvas.updatedAt = now()
      await commit(manifest)
    },

    async permanentlyDeleteProject(projectId) {
      const manifest = await readManifest()
      const project = requireProject(manifest, projectId)
      if (!project.deletedAt) throw new Error('项目必须先移入回收站')
      const childIds = manifest.canvases
        .filter((canvas) => canvas.projectId === projectId)
        .map((canvas) => canvas.canvasId)
      manifest.projects = manifest.projects.filter(
        (item) => item.projectId !== projectId,
      )
      manifest.canvases = manifest.canvases.filter(
        (canvas) => canvas.projectId !== projectId,
      )
      await commit(manifest, { deleteCanvasIds: childIds })
    },

    async permanentlyDeleteCanvas(canvasId) {
      const manifest = await readManifest()
      const canvas = requireCanvas(manifest, canvasId)
      if (!canvas.deletedAt) throw new Error('画布必须先移入回收站')
      manifest.canvases = manifest.canvases.filter(
        (item) => item.canvasId !== canvasId,
      )
      await commit(manifest, { deleteCanvasIds: [canvasId] })
    },

    async updateViewport(viewport) {
      const manifest = await readManifest()
      manifest.viewport = structuredClone(viewport)
      await commit(manifest)
    },
  }
}
