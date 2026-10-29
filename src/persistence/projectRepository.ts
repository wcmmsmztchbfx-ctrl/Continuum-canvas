import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'

import { parseProjectSnapshot } from '../model/project'
import type { ProjectSnapshotV1 } from '../model/project'
import { emptyWorkspaceSyncRecord, type WorkspaceSyncRecord, type WorkspaceSyncStorageBackend } from './workspaceSyncState'
import type {
  WorkspaceCommit,
  WorkspaceInitialization,
} from '../workspace/repository'

const DEFAULT_DATABASE_NAME = 'libtv-canvas'
export const DATABASE_VERSION = 4
export const PROJECT_STORE_NAME = 'projects'
export const WORKSPACE_MANIFEST_STORE_NAME = 'workspace-manifests'
export const CANVAS_DOCUMENT_STORE_NAME = 'canvas-documents'
export const CANVAS_THUMBNAIL_STORE_NAME = 'canvas-thumbnails'
export const WORKSPACE_SYNC_STORE_NAME = 'workspace-sync'
const WORKSPACE_MANIFEST_KEY = 'workspace'

interface StoredProject {
  projectId: string
  serialized: string
}

interface StoredWorkspaceManifest {
  id: typeof WORKSPACE_MANIFEST_KEY
  serialized: string
}

interface StoredCanvasDocument {
  canvasId: string
  serialized: string
}

export interface CanvasThumbnailRecord {
  canvasId: string
  blob: Blob
  width: number
  height: number
  contentHash: string
  updatedAt: string
}

interface ProjectDatabase extends DBSchema {
  projects: {
    key: string
    value: StoredProject
  }
  'workspace-manifests': {
    key: string
    value: StoredWorkspaceManifest
  }
  'canvas-documents': {
    key: string
    value: StoredCanvasDocument
  }
  'canvas-thumbnails': {
    key: string
    value: CanvasThumbnailRecord
  }
  'workspace-sync': {
    key: string
    value: WorkspaceSyncRecord
  }
}

export interface ProjectStorageBackend {
  put(projectId: string, serialized: string): Promise<void>
  get(projectId: string): Promise<string | undefined>
  getAll(): Promise<string[]>
  delete(projectId: string): Promise<void>
}

export interface CanvasThumbnailStorageBackend {
  put(record: CanvasThumbnailRecord): Promise<void>
  get(canvasId: string): Promise<CanvasThumbnailRecord | undefined>
  delete(canvasId: string): Promise<void>
}

export interface ProjectRepository {
  saveProject(project: ProjectSnapshotV1): Promise<void>
  loadProject(projectId: string): Promise<ProjectSnapshotV1 | undefined>
  listProjects(): Promise<ProjectSnapshotV1[]>
  deleteProject(projectId: string): Promise<void>
}

export interface IndexedDbProjectBackendOptions {
  databaseName?: string
}

interface DatabaseUpgradeTarget {
  objectStoreNames: { contains(name: string): boolean }
  createObjectStore(
    name: string,
    options?: IDBObjectStoreParameters,
  ): unknown
}

export function upgradeProjectDatabase(database: DatabaseUpgradeTarget): void {
  if (!database.objectStoreNames.contains(PROJECT_STORE_NAME)) {
    database.createObjectStore(PROJECT_STORE_NAME, { keyPath: 'projectId' })
  }
  if (!database.objectStoreNames.contains(WORKSPACE_MANIFEST_STORE_NAME)) {
    database.createObjectStore(WORKSPACE_MANIFEST_STORE_NAME, { keyPath: 'id' })
  }
  if (!database.objectStoreNames.contains(CANVAS_DOCUMENT_STORE_NAME)) {
    database.createObjectStore(CANVAS_DOCUMENT_STORE_NAME, { keyPath: 'canvasId' })
  }
  if (!database.objectStoreNames.contains(CANVAS_THUMBNAIL_STORE_NAME)) {
    database.createObjectStore(CANVAS_THUMBNAIL_STORE_NAME, { keyPath: 'canvasId' })
  }
  if (!database.objectStoreNames.contains(WORKSPACE_SYNC_STORE_NAME)) {
    database.createObjectStore(WORKSPACE_SYNC_STORE_NAME, { keyPath: 'id' })
  }
}

function createDatabasePromise(
  databaseName: string,
): Promise<IDBPDatabase<ProjectDatabase>> {
  return openDB<ProjectDatabase>(databaseName, DATABASE_VERSION, {
    upgrade(database) {
      upgradeProjectDatabase({
        objectStoreNames: database.objectStoreNames,
        createObjectStore: (name, options) =>
          database.createObjectStore(
            name as
              | typeof PROJECT_STORE_NAME
              | typeof WORKSPACE_MANIFEST_STORE_NAME
              | typeof CANVAS_DOCUMENT_STORE_NAME
              | typeof CANVAS_THUMBNAIL_STORE_NAME
              | typeof WORKSPACE_SYNC_STORE_NAME,
            options as IDBObjectStoreParameters,
          ),
      })
    },
  })
}

export function createIndexedDbCanvasThumbnailBackend(
  options: IndexedDbProjectBackendOptions = {},
): CanvasThumbnailStorageBackend {
  let databasePromise: Promise<IDBPDatabase<ProjectDatabase>> | undefined
  const getDatabase = () => {
    databasePromise ??= createDatabasePromise(
      options.databaseName ?? DEFAULT_DATABASE_NAME,
    )
    return databasePromise
  }

  return {
    async put(record) {
      const database = await getDatabase()
      await database.put(CANVAS_THUMBNAIL_STORE_NAME, record)
    },
    async get(canvasId) {
      const database = await getDatabase()
      return database.get(CANVAS_THUMBNAIL_STORE_NAME, canvasId)
    },
    async delete(canvasId) {
      const database = await getDatabase()
      await database.delete(CANVAS_THUMBNAIL_STORE_NAME, canvasId)
    },
  }
}

let defaultThumbnailBackend: CanvasThumbnailStorageBackend | undefined

function resolveThumbnailBackend(
  backend?: CanvasThumbnailStorageBackend,
): CanvasThumbnailStorageBackend {
  if (backend) return backend
  defaultThumbnailBackend ??= createIndexedDbCanvasThumbnailBackend()
  return defaultThumbnailBackend
}

export async function saveCanvasThumbnail(
  record: CanvasThumbnailRecord,
  backend?: CanvasThumbnailStorageBackend,
): Promise<void> {
  await resolveThumbnailBackend(backend).put(record)
}

export async function loadCanvasThumbnail(
  canvasId: string,
  backend?: CanvasThumbnailStorageBackend,
): Promise<CanvasThumbnailRecord | undefined> {
  return resolveThumbnailBackend(backend).get(canvasId)
}

export async function deleteCanvasThumbnail(
  canvasId: string,
  backend?: CanvasThumbnailStorageBackend,
): Promise<void> {
  await resolveThumbnailBackend(backend).delete(canvasId)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (typeof value !== 'object' || value === null) {
    return value
  }

  const record = value as Record<string, unknown>
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const item = canonicalize(record[key])
      if (item !== undefined) {
        result[key] = item
      }
      return result
    }, {})
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function compareProjectIds(left: ProjectSnapshotV1, right: ProjectSnapshotV1): number {
  if (left.projectId === right.projectId) {
    return 0
  }
  return left.projectId < right.projectId ? -1 : 1
}

export function serializeProjectSnapshot(project: ProjectSnapshotV1): string {
  const serialized = JSON.stringify(canonicalize(project))
  parseProjectSnapshot(serialized)
  return serialized
}

export function cloneProjectSnapshot(
  project: ProjectSnapshotV1,
): ProjectSnapshotV1 {
  return parseProjectSnapshot(serializeProjectSnapshot(project))
}

export function createIndexedDbProjectBackend(
  options: IndexedDbProjectBackendOptions = {},
): ProjectStorageBackend {
  let databasePromise: Promise<IDBPDatabase<ProjectDatabase>> | undefined

  const getDatabase = () => {
    if (!databasePromise) {
      databasePromise = openDB<ProjectDatabase>(
        options.databaseName ?? DEFAULT_DATABASE_NAME,
        DATABASE_VERSION,
        { upgrade: (database) => upgradeProjectDatabase(database) },
      )
    }
    return databasePromise
  }

  return {
    async put(projectId, serialized) {
      const database = await getDatabase()
      await database.put(PROJECT_STORE_NAME, { projectId, serialized })
    },
    async get(projectId) {
      const database = await getDatabase()
      const record = await database.get(PROJECT_STORE_NAME, projectId)
      return record?.serialized
    },
    async getAll() {
      const database = await getDatabase()
      const records = await database.getAll(PROJECT_STORE_NAME)
      return records.map((record) => record.serialized)
    },
    async delete(projectId) {
      const database = await getDatabase()
      await database.delete(PROJECT_STORE_NAME, projectId)
    },
  }
}

export function createIndexedDbWorkspaceBackend(
  options: IndexedDbProjectBackendOptions = {},
): WorkspaceSyncStorageBackend {
  let databasePromise: Promise<IDBPDatabase<ProjectDatabase>> | undefined
  const getDatabase = () => {
    databasePromise ??= createDatabasePromise(
      options.databaseName ?? DEFAULT_DATABASE_NAME,
    )
    return databasePromise
  }

  return {
    async readSyncRecord() {
      const database = await getDatabase()
      return (await database.get(WORKSPACE_SYNC_STORE_NAME, WORKSPACE_MANIFEST_KEY)) ?? emptyWorkspaceSyncRecord()
    },
    async readSyncSnapshot(canvasId) {
      const database = await getDatabase()
      const transaction = database.transaction([WORKSPACE_MANIFEST_STORE_NAME, CANVAS_DOCUMENT_STORE_NAME, WORKSPACE_SYNC_STORE_NAME], 'readonly')
      const [record, manifest, document] = await Promise.all([
        transaction.objectStore(WORKSPACE_SYNC_STORE_NAME).get(WORKSPACE_MANIFEST_KEY),
        transaction.objectStore(WORKSPACE_MANIFEST_STORE_NAME).get(WORKSPACE_MANIFEST_KEY),
        canvasId ? transaction.objectStore(CANVAS_DOCUMENT_STORE_NAME).get(canvasId) : undefined,
      ])
      await transaction.done
      return { record: record ?? emptyWorkspaceSyncRecord(), manifest: manifest?.serialized, document: document?.serialized }
    },
    async transactSync(update) {
      const database = await getDatabase()
      const transaction = database.transaction(
        [WORKSPACE_MANIFEST_STORE_NAME, CANVAS_DOCUMENT_STORE_NAME, WORKSPACE_SYNC_STORE_NAME], 'readwrite',
      )
      try {
        const syncStore = transaction.objectStore(WORKSPACE_SYNC_STORE_NAME)
        const [storedRecord, manifest] = await Promise.all([
          syncStore.get(WORKSPACE_MANIFEST_KEY),
          transaction.objectStore(WORKSPACE_MANIFEST_STORE_NAME).get(WORKSPACE_MANIFEST_KEY),
        ])
        const record = storedRecord ?? emptyWorkspaceSyncRecord()
        const changes = update(record, manifest?.serialized)
        await syncStore.put(record)
        if (changes?.manifest !== undefined) {
          await transaction.objectStore(WORKSPACE_MANIFEST_STORE_NAME).put({
            id: WORKSPACE_MANIFEST_KEY,
            serialized: typeof changes.manifest === 'string' ? changes.manifest : JSON.stringify(changes.manifest),
          })
        }
        const documents = transaction.objectStore(CANVAS_DOCUMENT_STORE_NAME)
        for (const document of changes?.putDocuments ?? []) await documents.put(document)
        for (const canvasId of changes?.deleteCanvasIds ?? []) await documents.delete(canvasId)
        await transaction.done
      } catch (error) {
        try { transaction.abort() } catch { /* The transaction may already be aborted. */ }
        await transaction.done.catch(() => undefined)
        throw error
      }
    },
    async initializeFromLegacy(create) {
      const database = await getDatabase()
      const transaction = database.transaction(
        [
          PROJECT_STORE_NAME,
          WORKSPACE_MANIFEST_STORE_NAME,
          CANVAS_DOCUMENT_STORE_NAME,
        ],
        'readwrite',
      )
      const manifestStore = transaction.objectStore(WORKSPACE_MANIFEST_STORE_NAME)
      const existing = await manifestStore.get(WORKSPACE_MANIFEST_KEY)
      if (!existing) {
        const legacyRecords = await transaction
          .objectStore(PROJECT_STORE_NAME)
          .getAll()
        const initialization: WorkspaceInitialization = create(
          legacyRecords.map((record) => record.serialized),
        )
        for (const document of initialization.documents) {
          await transaction.objectStore(CANVAS_DOCUMENT_STORE_NAME).put(document)
        }
        await manifestStore.put({
          id: WORKSPACE_MANIFEST_KEY,
          serialized: initialization.manifest,
        })
      }
      await transaction.done
    },
    async getManifest() {
      const database = await getDatabase()
      return (
        await database.get(
          WORKSPACE_MANIFEST_STORE_NAME,
          WORKSPACE_MANIFEST_KEY,
        )
      )?.serialized
    },
    async getCanvasDocument(canvasId) {
      const database = await getDatabase()
      return (
        await database.get(CANVAS_DOCUMENT_STORE_NAME, canvasId)
      )?.serialized
    },
    async commit(commit: WorkspaceCommit) {
      const database = await getDatabase()
      const transaction = database.transaction(
        [WORKSPACE_MANIFEST_STORE_NAME, CANVAS_DOCUMENT_STORE_NAME],
        'readwrite',
      )
      await transaction.objectStore(WORKSPACE_MANIFEST_STORE_NAME).put({
        id: WORKSPACE_MANIFEST_KEY,
        serialized: typeof commit.manifest === 'string' ? commit.manifest : JSON.stringify(commit.manifest),
      })
      const documentStore = transaction.objectStore(CANVAS_DOCUMENT_STORE_NAME)
      for (const document of commit.putDocuments ?? []) {
        await documentStore.put(document)
      }
      for (const canvasId of commit.deleteCanvasIds ?? []) {
        await documentStore.delete(canvasId)
      }
      await transaction.done
    },
  }
}

let defaultBackend: ProjectStorageBackend | undefined

function resolveBackend(backend?: ProjectStorageBackend): ProjectStorageBackend {
  if (backend) {
    return backend
  }
  defaultBackend ??= createIndexedDbProjectBackend()
  return defaultBackend
}

export async function saveProject(
  project: ProjectSnapshotV1,
  backend?: ProjectStorageBackend,
): Promise<void> {
  try {
    const serialized = serializeProjectSnapshot(project)
    await resolveBackend(backend).put(project.projectId, serialized)
  } catch (error) {
    throw new Error(`保存项目“${project.projectId}”失败：${errorMessage(error)}`)
  }
}

export async function loadProject(
  projectId: string,
  backend?: ProjectStorageBackend,
): Promise<ProjectSnapshotV1 | undefined> {
  let serialized: string | undefined
  try {
    serialized = await resolveBackend(backend).get(projectId)
  } catch (error) {
    throw new Error(`读取项目“${projectId}”失败：${errorMessage(error)}`)
  }

  if (serialized === undefined) {
    return undefined
  }

  try {
    const project = parseProjectSnapshot(serialized)
    if (project.projectId !== projectId) {
      throw new Error('Persisted project id does not match its key')
    }
    return project
  } catch {
    throw new Error(`读取项目“${projectId}”失败：本地项目数据已损坏`)
  }
}

export async function listProjects(
  backend?: ProjectStorageBackend,
): Promise<ProjectSnapshotV1[]> {
  let serializedProjects: string[]
  try {
    serializedProjects = await resolveBackend(backend).getAll()
  } catch (error) {
    throw new Error(`列出项目失败：${errorMessage(error)}`)
  }

  try {
    return serializedProjects
      .map((serialized) => parseProjectSnapshot(serialized))
      .sort(compareProjectIds)
  } catch {
    throw new Error('列出项目失败：本地存在损坏的项目数据')
  }
}

export async function deleteProject(
  projectId: string,
  backend?: ProjectStorageBackend,
): Promise<void> {
  try {
    await resolveBackend(backend).delete(projectId)
  } catch (error) {
    throw new Error(`删除项目“${projectId}”失败：${errorMessage(error)}`)
  }
}

export function createProjectRepository(
  backend: ProjectStorageBackend = resolveBackend(),
): ProjectRepository {
  return {
    saveProject: (project) => saveProject(project, backend),
    loadProject: (projectId) => loadProject(projectId, backend),
    listProjects: () => listProjects(backend),
    deleteProject: (projectId) => deleteProject(projectId, backend),
  }
}

export const defaultProjectRepository = createProjectRepository()
