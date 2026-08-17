import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseWorkspaceManifest,
  type WorkspaceCommit,
  type WorkspaceManifestV1,
} from '../src/workspace/model.ts'
import { atomicWriteJson } from './atomic-json.ts'

export interface WorkspaceServiceOptions {
  dataDir: string
  now?: () => string
}

export function defaultWorkspaceManifest(now = new Date().toISOString()): WorkspaceManifestV1 {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    projects: [
      {
        projectId: 'default-project',
        name: '未命名项目',
        position: { x: 0, y: 0 },
        size: { width: 620, height: 380 },
        favorite: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    canvases: [
      {
        canvasId: 'default-project',
        projectId: 'default-project',
        name: '画布 1',
        position: { x: 0, y: 0 },
        nodeCount: 0,
        favorite: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    pendingOperations: [],
  }
}

export class WorkspaceService {
  readonly #filePath: string
  readonly #workspaceDir: string
  readonly #now: () => string
  #manifest?: WorkspaceManifestV1
  #writeLock: Promise<void> = Promise.resolve()

  constructor(options: WorkspaceServiceOptions) {
    this.#workspaceDir = join(options.dataDir, 'workspace')
    this.#filePath = join(this.#workspaceDir, 'manifest.json')
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async getManifest(): Promise<WorkspaceManifestV1> {
    if (this.#manifest) return structuredClone(this.#manifest)
    try {
      const content = await readFile(this.#filePath, 'utf8')
      this.#manifest = parseWorkspaceManifest(content)
      return structuredClone(this.#manifest)
    } catch {
      const initial = defaultWorkspaceManifest(this.#now())
      await this.#saveManifest(initial)
      this.#manifest = initial
      return structuredClone(initial)
    }
  }

  async commit(commit: WorkspaceCommit): Promise<WorkspaceManifestV1> {
    const nextManifest = typeof commit.manifest === 'string'
      ? parseWorkspaceManifest(commit.manifest)
      : commit.manifest
    await this.#saveManifest(nextManifest)
    this.#manifest = structuredClone(nextManifest)
    return structuredClone(this.#manifest)
  }

  async #saveManifest(manifest: WorkspaceManifestV1): Promise<void> {
    const current = this.#writeLock
    let release!: () => void
    this.#writeLock = new Promise<void>((resolve) => { release = resolve })
    try {
      await current
      await mkdir(this.#workspaceDir, { recursive: true })
      await atomicWriteJson(this.#filePath, manifest)
    } finally {
      release()
    }
  }
}
