import { canvasContentIdentity } from '../src/model/canvasContentIdentity.ts'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseCanvasSnapshot } from '../src/model/project.ts'
import type { CollaborationCheckpoint } from './collaboration-service.ts'
import {
  parseWorkspaceManifest,
  type WorkspaceManifestV1,
} from '../src/workspace/model.ts'
import type { PersistedCanvasRecord, WorkspaceMutation, WorkspaceMutationReceipt, WorkspaceVersionState } from '../src/workspace/persistenceProtocol.ts'
import { atomicWriteJson } from './atomic-json.ts'
import { defaultInitialCanvas } from './canvas-storage.ts'
import { parseWorkspaceMutation, WorkspaceConflictError, WorkspaceInputError, WorkspaceOperationIdConflictError, WorkspacePreconditionError, workspaceMutationDigest } from './workspace-commit.ts'

export interface WorkspaceServiceOptions {
  dataDir: string
  now?: () => string
  writeJson?: typeof atomicWriteJson
}

interface WorkspaceJournalRecord {
  recordVersion: 1
  status: 'pending' | 'complete'
  operationId: string
  mutation: WorkspaceMutation
  digest: string
  receipt: WorkspaceMutationReceipt
  records: PersistedCanvasRecord[]
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

async function readOptionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export class WorkspaceService {
  readonly #dataDir: string
  readonly #filePath: string
  readonly #workspaceDir: string
  readonly #now: () => string
  readonly #writeJson: typeof atomicWriteJson
  #manifest?: WorkspaceManifestV1
  #versions: WorkspaceVersionState = { workspaceRevision: 0, canvasRevisions: {} }
  #initialized?: Promise<void>
  #writeLock: Promise<void> = Promise.resolve()

  constructor(options: WorkspaceServiceOptions) {
    this.#dataDir = options.dataDir
    this.#workspaceDir = join(options.dataDir, 'workspace')
    this.#filePath = join(this.#workspaceDir, 'manifest.json')
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#writeJson = options.writeJson ?? atomicWriteJson
  }

  async getManifest(): Promise<WorkspaceManifestV1> {
    return (await this.getWorkspaceState()).manifest
  }

  async getWorkspaceState(): Promise<{ manifest: WorkspaceManifestV1 } & WorkspaceVersionState> {
    return this.#withLock(async () => ({
      manifest: structuredClone(this.#manifest!),
      workspaceRevision: this.#versions.workspaceRevision,
      canvasRevisions: structuredClone(this.#versions.canvasRevisions),
    }))
  }

  async reset(): Promise<void> {
    const initial = defaultWorkspaceManifest(this.#now())
    await this.#saveManifest(initial)
    this.#manifest = initial
    const docsDir = join(this.#workspaceDir, 'documents')
    await rm(docsDir, { recursive: true, force: true }).catch(() => {})
    await rm(join(this.#workspaceDir, 'records'), { recursive: true, force: true }).catch(() => {})
    await rm(join(this.#workspaceDir, 'operations'), { recursive: true, force: true }).catch(() => {})
    this.#versions = { workspaceRevision: 0, canvasRevisions: {} }
    await this.#writeJson(join(this.#workspaceDir, 'revision-state.json'), this.#versions)
  }

  async getCanvasDocument(canvasId: string): Promise<string | undefined> {
    return this.#withLock(() => this.#readCanvasDocument(canvasId))
  }

  async readCanvasState(canvasId: string): Promise<{ serialized: string | undefined; revision: number; workspaceRevision: number } | undefined> {
    return this.#withLock(async () => {
      const record = await this.#readCanvasRecord(canvasId)
      if (record?.deleted) return undefined
      return {
        serialized: record?.snapshot ? JSON.stringify(record.snapshot) : await this.#readLegacyCanvasDocument(canvasId),
        revision: record?.revision ?? 0,
        workspaceRevision: this.#versions.workspaceRevision,
      }
    })
  }

  async #readCanvasDocument(canvasId: string): Promise<string | undefined> {
    const record = await this.#readCanvasRecord(canvasId)
    if (record?.deleted) return undefined
    if (record?.snapshot) return JSON.stringify(record.snapshot)
    return this.#readLegacyCanvasDocument(canvasId)
  }

  async #readLegacyCanvasDocument(canvasId: string): Promise<string | undefined> {
    return (await readOptionalText(join(this.#workspaceDir, 'documents', `${canvasId}.json`))) ??
      readOptionalText(join(this.#dataDir, 'canvases', canvasId, 'snapshot.json'))
  }

  async getVersionState(): Promise<WorkspaceVersionState> {
    const { workspaceRevision, canvasRevisions } = await this.getWorkspaceState()
    return { workspaceRevision, canvasRevisions }
  }

  async getCanvasRecord(canvasId: string): Promise<PersistedCanvasRecord | undefined> {
    return this.#withLock(() => this.#readCanvasRecord(canvasId))
  }

  /** Inspect a committed receipt without replaying an uncommitted mutation. */
  async getOperationReceipt(input: WorkspaceMutation): Promise<WorkspaceMutationReceipt | undefined> {
    const mutation = parseWorkspaceMutation(input)
    return this.#withLock(async () => {
      const content = await readOptionalText(join(this.#workspaceDir, 'operations', `${mutation.operationId}.json`))
      if (!content) return undefined
      const journal = this.#parseJournal(content)
      if (journal.digest !== workspaceMutationDigest(mutation)) throw new WorkspaceOperationIdConflictError()
      if (journal.status !== 'complete') throw new Error('Workspace operation recovery is not yet complete')
      return structuredClone(journal.receipt)
    })
  }

  async #withLock<T>(read: () => Promise<T>): Promise<T> {
    const previous = this.#writeLock
    let release!: () => void
    this.#writeLock = new Promise<void>((resolve) => { release = resolve })
    try {
      await previous
      await this.#ensureInitialized()
      return await read()
    } finally { release() }
  }

  async #readCanvasRecord(canvasId: string): Promise<PersistedCanvasRecord | undefined> {
    let content: string
    try { content = await readFile(join(this.#workspaceDir, 'records', `${canvasId}.json`), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const record = JSON.parse(content) as PersistedCanvasRecord
    if (record.recordVersion !== 1 || record.canvasId !== canvasId ||
      !Number.isSafeInteger(record.revision) || record.revision < 0 ||
      typeof record.projectId !== 'string' ||
      (record.deleted !== true && (!record.snapshot || record.snapshot.canvasId !== canvasId ||
        record.snapshot.projectId !== record.projectId))) {
      throw new Error(`Invalid canvas record for ${canvasId}`)
    }
    return record
  }

  async applyCollaborationCheckpoint(checkpoint: CollaborationCheckpoint): Promise<boolean> {
    const { snapshot, roomId, epoch } = checkpoint
    const current = await this.getCanvasRecord(snapshot.canvasId)
    if (current?.deleted || (current && current.projectId !== snapshot.projectId)) return false
    const serialized = await this.getCanvasDocument(snapshot.canvasId)
    const sameContent = serialized !== undefined &&
      isDeepStrictEqual(parseCanvasSnapshot(serialized), parseCanvasSnapshot(JSON.stringify(snapshot)))
    const sameRoom = current?.roomId === roomId && current?.epoch === epoch
    if (checkpoint.restored && current?.roomId && !sameRoom) return false
    if (sameRoom && sameContent) return true
    if (current && !sameRoom && (!checkpoint.initial || !sameContent)) return false
    if (!current && serialized && !sameContent) return false
    const operationId = `collab-${createHash('sha256').update(`${roomId}\0${epoch}\0${checkpoint.sourceRevision}`).digest('hex')}`
    try {
      await this.applyWorkspaceMutation({ protocolVersion: 1, operationId, kind: 'save-canvas',
        expectedRevision: current?.revision ?? 0, canvas: snapshot },
      { roomId, epoch, preserveRevision: sameContent })
      return true
    } catch (error) {
      if (error instanceof WorkspaceConflictError) return false
      throw error
    }
  }

  async applyWorkspaceMutation(
    input: WorkspaceMutation,
    checkpoint?: { roomId: string; epoch: string; preserveRevision: boolean },
  ): Promise<WorkspaceMutationReceipt> {
    const mutation = parseWorkspaceMutation(input)
    const previous = this.#writeLock
    let release!: () => void
    this.#writeLock = new Promise<void>((resolve) => { release = resolve })
    try {
      await previous
      await this.#ensureInitialized()
      const digest = workspaceMutationDigest(mutation)
      const journalPath = join(this.#workspaceDir, 'operations', `${mutation.operationId}.json`)
      let existing: WorkspaceJournalRecord | undefined
      try { existing = this.#parseJournal(await readFile(journalPath, 'utf8')) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (existing) {
        if (existing.digest !== digest) throw new WorkspaceOperationIdConflictError()
        if (existing.status === 'pending') await this.#applyJournal(existing, journalPath)
        return structuredClone(existing.receipt)
      }

      const nextManifest = structuredClone(this.#manifest!)
      const records: PersistedCanvasRecord[] = []
      const revisions = structuredClone(this.#versions.canvasRevisions)
      if (mutation.kind === 'save-canvas') {
        const canvas = mutation.canvas
        const currentRevision = revisions[canvas.canvasId] ?? 0
        const current = await this.#readCanvasRecord(canvas.canvasId)
        const cameraOnly = current?.snapshot && mutation.expectedRevision <= currentRevision &&
          canvasContentIdentity(current.snapshot) === canvasContentIdentity(canvas)
        if ((currentRevision !== mutation.expectedRevision && !cameraOnly) || current?.deleted) {
          throw new WorkspaceConflictError()
        }
        const card = nextManifest.canvases.find((candidate) => candidate.canvasId === canvas.canvasId)
        if (card && card.projectId !== canvas.projectId) throw new WorkspaceInputError('Canvas project mismatch')
        if (card && !checkpoint?.preserveRevision) {
          card.name = canvas.name
          card.nodeCount = canvas.nodes.length
          card.updatedAt = this.#now()
        }
        records.push({ recordVersion: 1, canvasId: canvas.canvasId, projectId: canvas.projectId,
          revision: currentRevision + (checkpoint?.preserveRevision ? 0 : 1), snapshot: canvas,
          ...(checkpoint ? { roomId: checkpoint.roomId, epoch: checkpoint.epoch } : {}) })
        revisions[canvas.canvasId] = currentRevision + (checkpoint?.preserveRevision ? 0 : 1)
      } else {
        if (this.#versions.workspaceRevision !== mutation.expectedWorkspaceRevision) throw new WorkspaceConflictError()
        for (const [id, revision] of Object.entries(mutation.expectedCanvasRevisions)) {
          if ((revisions[id] ?? 0) !== revision) throw new WorkspaceConflictError(`Canvas ${id} revision conflict`)
        }
        const target = typeof mutation.commit.manifest === 'string'
          ? parseWorkspaceManifest(mutation.commit.manifest) : mutation.commit.manifest
        const beforeCards = new Map(nextManifest.canvases.map((card) => [card.canvasId, card]))
        const afterCards = new Map(target.canvases.map((card) => [card.canvasId, card]))
        const deletionIds = new Set(mutation.commit.deleteCanvasIds ?? [])
        const changedCards = new Set<string>()
        for (const canvasId of new Set([...beforeCards.keys(), ...afterCards.keys()])) {
          if (JSON.stringify(beforeCards.get(canvasId)) === JSON.stringify(afterCards.get(canvasId))) continue
          changedCards.add(canvasId)
          if (!Object.hasOwn(mutation.expectedCanvasRevisions, canvasId)) {
            throw new WorkspacePreconditionError(`Missing canvas revision for changed card ${canvasId}`)
          }
          if (beforeCards.has(canvasId) && !afterCards.has(canvasId) && !deletionIds.has(canvasId)) {
            throw new WorkspaceInputError(`Canvas ${canvasId} was removed without a tombstone`)
          }
          if (!beforeCards.has(canvasId) && (await this.#readCanvasRecord(canvasId))?.deleted) {
            throw new WorkspaceConflictError('Canvas was permanently deleted')
          }
        }
        nextManifest.projects = target.projects
        nextManifest.canvases = target.canvases
        nextManifest.pendingOperations = target.pendingOperations
        nextManifest.viewport = target.viewport
        for (const doc of mutation.commit.putDocuments ?? []) {
          const snapshot = parseCanvasSnapshot(doc.serialized)
          if ((await this.#readCanvasRecord(doc.canvasId))?.deleted) throw new WorkspaceConflictError('Canvas was permanently deleted')
          const revision = (revisions[doc.canvasId] ?? 0) + 1
          records.push({ recordVersion: 1, canvasId: doc.canvasId, projectId: snapshot.projectId,
            revision, snapshot })
          revisions[doc.canvasId] = revision
        }
        for (const canvasId of mutation.commit.deleteCanvasIds ?? []) {
          const current = await this.#readCanvasRecord(canvasId)
          const revision = (revisions[canvasId] ?? 0) + 1
          records.push({ recordVersion: 1, canvasId,
            projectId: current?.projectId ?? canvasId, revision, deleted: true })
          revisions[canvasId] = revision
        }
        for (const canvasId of changedCards) {
          if (records.some((record) => record.canvasId === canvasId)) continue
          const card = afterCards.get(canvasId)
          if (!card) continue
          const current = await this.#readCanvasRecord(canvasId)
          const serialized = current?.snapshot ? undefined : await this.#readCanvasDocument(canvasId)
          const snapshot = current?.snapshot ?? (serialized
            ? parseCanvasSnapshot(serialized)
            : defaultInitialCanvas(canvasId, card.projectId, card.name))
          if (snapshot && snapshot.projectId !== card.projectId) {
            throw new WorkspaceInputError('Moved canvas requires an updated document')
          }
          if (snapshot.nodes.length !== card.nodeCount) {
            throw new WorkspaceInputError('Canvas card node count does not match document')
          }
          const revision = (revisions[canvasId] ?? 0) + 1
          const beforeCard = beforeCards.get(canvasId)
          const metadataOnly = beforeCard && beforeCard.name === card.name &&
            beforeCard.projectId === card.projectId && beforeCard.nodeCount === card.nodeCount
          records.push({ recordVersion: 1, canvasId, projectId: card.projectId, revision,
            snapshot: { ...snapshot, name: card.name },
            ...(metadataOnly && current?.roomId && current.epoch
              ? { roomId: current.roomId, epoch: current.epoch } : {}) })
          revisions[canvasId] = revision
        }
      }
      const receipt: WorkspaceMutationReceipt = { protocolVersion: 1, operationId: mutation.operationId,
        workspaceRevision: this.#versions.workspaceRevision + 1, canvasRevisions: revisions,
        manifest: nextManifest }
      const journal: WorkspaceJournalRecord = { recordVersion: 1, status: 'pending',
        operationId: mutation.operationId, mutation, digest, receipt, records }
      await this.#writeJson(journalPath, journal)
      await this.#applyJournal(journal, journalPath)
      return structuredClone(receipt)
    } catch (error) {
      this.#initialized = undefined
      throw error
    } finally { release() }
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
      const recordEntries = await readdir(join(this.#workspaceDir, 'records'))
      for (const entry of recordEntries) {
        if (entry.endsWith('.json')) allCanvasIds.add(entry.slice(0, -5))
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

  async #ensureInitialized(): Promise<void> {
    if (!this.#initialized) {
      this.#initialized = (async () => {
        try { this.#manifest = parseWorkspaceManifest(await readFile(this.#filePath, 'utf8')) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          this.#manifest = defaultWorkspaceManifest(this.#now())
          await this.#writeJson(this.#filePath, this.#manifest)
        }
        try {
          const parsed = JSON.parse(await readFile(join(this.#workspaceDir, 'revision-state.json'), 'utf8')) as WorkspaceVersionState
          if (!Number.isSafeInteger(parsed.workspaceRevision) || parsed.workspaceRevision < 0 ||
            !parsed.canvasRevisions || typeof parsed.canvasRevisions !== 'object') throw new Error('Invalid workspace revision state')
          this.#versions = parsed
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          this.#versions = { workspaceRevision: 0, canvasRevisions: {} }
        }
        const operationDir = join(this.#workspaceDir, 'operations')
        let files: string[] = []
        try { files = await readdir(operationDir) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
          const path = join(operationDir, file)
          const journal = this.#parseJournal(await readFile(path, 'utf8'))
          if (journal.status === 'pending') await this.#applyJournal(journal, path)
        }
        await this.#migrateLegacyRecords()
        await this.#repairLegacyCardMetadata()
      })().catch((error) => { this.#initialized = undefined; throw error })
    }
    await this.#initialized
  }

  #parseJournal(content: string): WorkspaceJournalRecord {
    const journal = JSON.parse(content) as WorkspaceJournalRecord
    if (journal.recordVersion !== 1 || (journal.status !== 'pending' && journal.status !== 'complete') ||
      !Array.isArray(journal.records) || !journal.receipt ||
      journal.operationId !== journal.receipt.operationId ||
      workspaceMutationDigest(parseWorkspaceMutation(journal.mutation)) !== journal.digest ||
      journal.operationId !== journal.mutation.operationId ||
      journal.records.some((record) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.canvasId))) {
      throw new Error('Invalid workspace operation journal')
    }
    parseWorkspaceManifest(JSON.stringify(journal.receipt.manifest))
    return journal
  }

  async #migrateLegacyRecords(): Promise<void> {
    const ids = new Set<string>()
    let revisionStateChanged = false
    try {
      for (const file of await readdir(join(this.#workspaceDir, 'documents'))) {
        if (file.endsWith('.json')) ids.add(file.slice(0, -5))
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      for (const entry of await readdir(join(this.#dataDir, 'canvases'), { withFileTypes: true })) {
        if (entry.isDirectory()) ids.add(entry.name)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const canvasId of ids) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(canvasId) ||
        ['__proto__', 'constructor', 'prototype'].includes(canvasId)) continue
      const existing = await this.#readCanvasRecord(canvasId)
      if (existing) {
        if (existing.revision === 0 && !Object.hasOwn(this.#versions.canvasRevisions, canvasId)) {
          this.#versions.canvasRevisions[canvasId] = 0
          revisionStateChanged = true
        }
        continue
      }
      if ((this.#versions.canvasRevisions[canvasId] ?? 0) > 0) {
        throw new Error(`Missing revisioned canvas record for ${canvasId}`)
      }
      const content = (await readOptionalText(join(this.#workspaceDir, 'documents', `${canvasId}.json`))) ??
        await readOptionalText(join(this.#dataDir, 'canvases', canvasId, 'snapshot.json'))
      if (!content) continue
      let snapshot
      try { snapshot = parseCanvasSnapshot(content) }
      catch { continue /* Keep malformed legacy data untouched for explicit recovery. */ }
      if (snapshot.canvasId !== canvasId) continue
      await this.#writeJson(join(this.#workspaceDir, 'records', `${canvasId}.json`), {
        recordVersion: 1, canvasId, projectId: snapshot.projectId,
        revision: 0, snapshot,
      } satisfies PersistedCanvasRecord)
      this.#versions.canvasRevisions[canvasId] = 0
      revisionStateChanged = true
    }
    if (revisionStateChanged) {
      await this.#writeJson(join(this.#workspaceDir, 'revision-state.json'), this.#versions)
    }
  }

  async #repairLegacyCardMetadata(): Promise<void> {
    const manifest = structuredClone(this.#manifest!)
    let changed = false
    for (const card of manifest.canvases) {
      if ((this.#versions.canvasRevisions[card.canvasId] ?? 0) !== 0) continue
      const record = await this.#readCanvasRecord(card.canvasId)
      if (!record?.snapshot || record.revision !== 0 || record.projectId !== card.projectId) continue
      if (card.name === record.snapshot.name && card.nodeCount === record.snapshot.nodes.length) continue
      card.name = record.snapshot.name
      card.nodeCount = record.snapshot.nodes.length
      changed = true
    }
    if (!changed) return
    await this.#writeJson(this.#filePath, manifest)
    this.#manifest = manifest
  }

  async #applyJournal(journal: WorkspaceJournalRecord, journalPath: string): Promise<void> {
    for (const record of journal.records) {
      await this.#writeJson(join(this.#workspaceDir, 'records', `${record.canvasId}.json`), record)
      if (record.deleted) {
        await rm(join(this.#workspaceDir, 'documents', `${record.canvasId}.json`), { force: true })
        await rm(join(this.#dataDir, 'canvases', record.canvasId), { recursive: true, force: true })
      }
    }
    await this.#writeJson(this.#filePath, journal.receipt.manifest)
    await this.#writeJson(join(this.#workspaceDir, 'revision-state.json'), {
      workspaceRevision: journal.receipt.workspaceRevision,
      canvasRevisions: journal.receipt.canvasRevisions,
    })
    await this.#writeJson(journalPath, { ...journal, status: 'complete' })
    this.#manifest = structuredClone(journal.receipt.manifest)
    this.#versions = { workspaceRevision: journal.receipt.workspaceRevision,
      canvasRevisions: structuredClone(journal.receipt.canvasRevisions) }
  }

  async #saveManifest(manifest: WorkspaceManifestV1): Promise<void> {
    const current = this.#writeLock
    let release!: () => void
    this.#writeLock = new Promise<void>((resolve) => { release = resolve })
    try {
      await current
      await mkdir(this.#workspaceDir, { recursive: true })
      await this.#writeJson(this.#filePath, manifest)
    } finally {
      release()
    }
  }
}
