import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseWorkspaceManifest,
  type WorkspaceCommit,
  type WorkspaceManifestV1,
} from '../src/workspace/model.ts'
import { atomicWriteJson, atomicWriteText } from './atomic-json.ts'

export interface WorkspaceServiceOptions {
  dataDir: string
  now?: () => string
}

export function defaultWorkspaceManifest(_now = new Date().toISOString()): WorkspaceManifestV1 {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    projects: [],
    canvases: [],
    pendingOperations: [],
  }
}

export class WorkspaceService {
  readonly #dataDir: string
  readonly #filePath: string
  readonly #workspaceDir: string
  readonly #now: () => string
  #manifest?: WorkspaceManifestV1
  #writeLock: Promise<void> = Promise.resolve()

  constructor(options: WorkspaceServiceOptions) {
    this.#dataDir = options.dataDir
    this.#workspaceDir = join(options.dataDir, 'workspace')
    this.#filePath = join(this.#workspaceDir, 'manifest.json')
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async getManifest(): Promise<WorkspaceManifestV1> {
    if (!this.#manifest) {
      try {
        const content = await readFile(this.#filePath, 'utf8')
        this.#manifest = parseWorkspaceManifest(content)
      } catch {
        const initial = defaultWorkspaceManifest(this.#now())
        await this.#saveManifest(initial)
        this.#manifest = initial
      }
    }

    // Reconcile with collaboration snapshots if manifest has outdated metadata
    let dirty = false
    for (const canvas of this.#manifest.canvases) {
      if (canvas.deletedAt) continue
      const collabContent = await this.#findBestCollaborationSnapshot(canvas.canvasId)
      if (collabContent) {
        try {
          const collabSnap = JSON.parse(collabContent)
          const collabNodes = Array.isArray(collabSnap.nodes) ? collabSnap.nodes.length : 0
          if (collabNodes > canvas.nodeCount) {
            canvas.nodeCount = collabNodes
            dirty = true
          }
          if (collabSnap.name && collabSnap.name !== '未命名画布' && canvas.name === '未命名画布') {
            canvas.name = collabSnap.name
            dirty = true
          }
        } catch {}
      }
    }
    if (dirty) {
      await this.#saveManifest(this.#manifest)
    }

    return structuredClone(this.#manifest)
  }

  async reset(): Promise<void> {
    const initial = defaultWorkspaceManifest(this.#now())
    await this.#saveManifest(initial)
    this.#manifest = initial
    const docsDir = join(this.#workspaceDir, 'documents')
    await rm(docsDir, { recursive: true, force: true }).catch(() => {})
  }

  async #findBestCollaborationSnapshot(canvasId: string): Promise<string | undefined> {
    try {
      const collabDir = join(this.#dataDir, 'collaboration')
      const rooms = await readdir(collabDir, { withFileTypes: true })
      let best: { content: string; nodeCount: number; mtime: number } | undefined
      for (const room of rooms) {
        if (!room.isDirectory()) continue
        const snapPath = join(collabDir, room.name, 'canvas.snapshot.json')
        try {
          const content = await readFile(snapPath, 'utf8')
          const snap = JSON.parse(content)
          if (snap.canvasId === canvasId || snap.projectId === canvasId) {
            const fileStat = await stat(snapPath)
            const nodeCount = Array.isArray(snap.nodes) ? snap.nodes.length : 0
            if (!best || nodeCount > best.nodeCount || (nodeCount === best.nodeCount && fileStat.mtimeMs > best.mtime)) {
              best = { content, nodeCount, mtime: fileStat.mtimeMs }
            }
          }
        } catch {}
      }
      return best?.content
    } catch {
      return undefined
    }
  }

  async getCanvasDocument(canvasId: string): Promise<string | undefined> {
    const docPath = join(this.#workspaceDir, 'documents', `${canvasId}.json`)
    let docContent: string | undefined
    try {
      docContent = await readFile(docPath, 'utf8')
    } catch {
      try {
        const legacyPath = join(this.#dataDir, 'canvases', canvasId, 'snapshot.json')
        docContent = await readFile(legacyPath, 'utf8')
      } catch {
        docContent = undefined
      }
    }

    const collabContent = await this.#findBestCollaborationSnapshot(canvasId)
    if (collabContent) {
      if (!docContent) {
        void this.saveCanvasDocument(canvasId, collabContent).catch(() => {})
        return collabContent
      }
      try {
        const docSnap = JSON.parse(docContent)
        const collabSnap = JSON.parse(collabContent)
        const docNodes = Array.isArray(docSnap.nodes) ? docSnap.nodes.length : 0
        const collabNodes = Array.isArray(collabSnap.nodes) ? collabSnap.nodes.length : 0
        if (collabNodes > docNodes) {
          void this.saveCanvasDocument(canvasId, collabContent).catch(() => {})
          return collabContent
        }
      } catch {}
    }

    if (docContent) {
      return docContent
    }
    return undefined
  }

  async saveCanvasDocument(canvasId: string, serialized: string): Promise<void> {
    try {
      const incoming = JSON.parse(serialized)
      if (Array.isArray(incoming.nodes) && incoming.nodes.length === 0) {
        const docPath = join(this.#workspaceDir, 'documents', `${canvasId}.json`)
        try {
          const existing = await readFile(docPath, 'utf8')
          const existingSnap = JSON.parse(existing)
          if (Array.isArray(existingSnap.nodes) && existingSnap.nodes.length > 0) {
            // Guard: do not overwrite a populated canvas with an empty one
            return
          }
        } catch {}
      }
    } catch {}

    const docsDir = join(this.#workspaceDir, 'documents')
    await mkdir(docsDir, { recursive: true })
    const docPath = join(docsDir, `${canvasId}.json`)
    await atomicWriteText(docPath, serialized)
  }

  async commit(commit: WorkspaceCommit): Promise<WorkspaceManifestV1> {
    const nextManifest = typeof commit.manifest === 'string'
      ? parseWorkspaceManifest(commit.manifest)
      : commit.manifest
    await this.#saveManifest(nextManifest)
    if (Array.isArray(commit.putDocuments)) {
      for (const doc of commit.putDocuments) {
        if (doc && typeof doc.canvasId === 'string' && typeof doc.serialized === 'string') {
          await this.saveCanvasDocument(doc.canvasId, doc.serialized)
        }
      }
    }
    this.#manifest = structuredClone(nextManifest)
    return structuredClone(this.#manifest)
  }

  async getReferencedAssetMap(): Promise<Map<string, Array<{ canvasId: string; canvasName: string; nodeId: string; nodeName: string }>>> {
    const references = new Map<string, Array<{ canvasId: string; canvasName: string; nodeId: string; nodeName: string }>>()
    const manifest = await this.getManifest()
    const canvasNameById = new Map(manifest.canvases.map((c) => [c.canvasId, c.name]))

    const allCanvasIds = new Set(manifest.canvases.map((c) => c.canvasId))

    try {
      const docsDir = join(this.#workspaceDir, 'documents')
      const docEntries = await readdir(docsDir)
      for (const entry of docEntries) {
        if (entry.endsWith('.json')) {
          allCanvasIds.add(entry.slice(0, -5))
        }
      }
    } catch {}

    try {
      const canvasesDir = join(this.#dataDir, 'canvases')
      const canvasEntries = await readdir(canvasesDir)
      for (const entry of canvasEntries) {
        allCanvasIds.add(entry)
      }
    } catch {}

    const recordRef = (assetId: string, canvasId: string, canvasName: string, nodeId: string, nodeName: string) => {
      const match = /[0-9a-f-]{36}/i.exec(assetId)
      if (!match) return
      const normalizedId = match[0].toLowerCase()
      const list = references.get(normalizedId) ?? []
      list.push({ canvasId, canvasName, nodeId, nodeName })
      references.set(normalizedId, list)
    }

    for (const canvasId of allCanvasIds) {
      const serialized = await this.getCanvasDocument(canvasId)
      if (!serialized) continue
      try {
        const doc = JSON.parse(serialized) as { name?: string; nodes?: Array<{ id?: string; name?: string; data?: Record<string, unknown> }> }
        const canvasName = canvasNameById.get(canvasId) || doc.name || '未命名画布'
        const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
        for (const node of nodes) {
          const nodeId = node.id || 'unknown'
          const nodeName = node.name || '未命名节点'
          const d = node.data
          if (!d) continue
          if (typeof d.assetId === 'string') recordRef(d.assetId, canvasId, canvasName, nodeId, nodeName)
          if (typeof d.url === 'string' && d.url.includes('/api/assets/')) recordRef(d.url, canvasId, canvasName, nodeId, nodeName)
          if (typeof d.poster === 'string' && d.poster.includes('/api/assets/')) recordRef(d.poster, canvasId, canvasName, nodeId, nodeName)
          if (Array.isArray(d.versions)) {
            for (const v of d.versions as Array<{ assetId?: string; url?: string }>) {
              if (v?.assetId) recordRef(v.assetId, canvasId, canvasName, nodeId, nodeName)
              if (v?.url && typeof v.url === 'string' && v.url.includes('/api/assets/')) recordRef(v.url, canvasId, canvasName, nodeId, nodeName)
            }
          }
          if (Array.isArray(d.references)) {
            for (const r of d.references as Array<{ assetId?: string; url?: string }>) {
              if (r?.assetId) recordRef(r.assetId, canvasId, canvasName, nodeId, nodeName)
              if (r?.url && typeof r.url === 'string' && r.url.includes('/api/assets/')) recordRef(r.url, canvasId, canvasName, nodeId, nodeName)
            }
          }
        }
      } catch {
        // ignore malformed document
      }
    }
    return references
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
