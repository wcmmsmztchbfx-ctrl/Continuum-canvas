import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from './atomic-json.ts'

interface CanvasAssetReferenceRecord {
  canvasId: string
  projectId: string
  assetIds: string[]
}

interface PersistedCanvasAssetReferences {
  version: 1
  canvases: CanvasAssetReferenceRecord[]
}

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function parseRecords(value: unknown): CanvasAssetReferenceRecord[] | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.canvases)) return undefined
  const records: CanvasAssetReferenceRecord[] = []
  for (const item of value.canvases) {
    if (!isRecord(item) || !isIdentifier(item.canvasId) || !isIdentifier(item.projectId) ||
      !Array.isArray(item.assetIds) || item.assetIds.some((id) => typeof id !== 'string' || !ASSET_ID.test(id)) ||
      Object.keys(item).some((key) => !['canvasId', 'projectId', 'assetIds'].includes(key))) return undefined
    const assetIds = [...new Set(item.assetIds as string[])]
    if (assetIds.length !== item.assetIds.length) return undefined
    records.push({ canvasId: item.canvasId, projectId: item.projectId, assetIds })
  }
  if (new Set(records.map((record) => record.canvasId)).size !== records.length) return undefined
  return records
}

export class CanvasAssetReferenceStore {
  private readonly filePath: string
  private records: Map<string, CanvasAssetReferenceRecord>
  private mutationTail: Promise<void> = Promise.resolve()

  private constructor(filePath: string, records: CanvasAssetReferenceRecord[]) {
    this.filePath = filePath
    this.records = new Map(records.map((record) => [record.canvasId, record]))
  }

  static async open(options: { dataDir: string }): Promise<CanvasAssetReferenceStore> {
    await mkdir(options.dataDir, { recursive: true })
    const filePath = join(options.dataDir, 'canvas-asset-references.json')
    let records: CanvasAssetReferenceRecord[] = []
    try {
      const parsed = parseRecords(JSON.parse(await readFile(filePath, 'utf8')))
      if (!parsed) throw new Error('Persisted canvas asset references are invalid')
      records = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return new CanvasAssetReferenceStore(filePath, records)
  }

  async set(input: {
    canvasId: string
    projectId: string
    assetIds: string[]
  }): Promise<{ canvasId: string; assetCount: number }> {
    return this.runMutation(async () => {
      if (!isIdentifier(input.canvasId) || !isIdentifier(input.projectId) ||
        input.assetIds.some((id) => !ASSET_ID.test(id))) throw new Error('Canvas asset references are invalid')
      const assetIds = [...new Set(input.assetIds)]
      if (assetIds.length !== input.assetIds.length) throw new Error('Canvas asset references are invalid')
      const candidate = new Map(this.records)
      candidate.set(input.canvasId, { canvasId: input.canvasId, projectId: input.projectId, assetIds })
      await this.persist(candidate)
      this.records = candidate
      return { canvasId: input.canvasId, assetCount: assetIds.length }
    })
  }

  async release(input: { canvasId: string; projectId: string }): Promise<string[]> {
    return this.runMutation(async () => {
      const current = this.records.get(input.canvasId)
      if (!current) return []
      if (current.projectId !== input.projectId) throw new Error('Canvas asset references belong to another project')
      const candidate = new Map(this.records)
      candidate.delete(input.canvasId)
      await this.persist(candidate)
      this.records = candidate
      return [...current.assetIds]
    })
  }

  referencedAssetIds(): Set<string> {
    return new Set([...this.records.values()].flatMap((record) => record.assetIds))
  }

  private async persist(records: Map<string, CanvasAssetReferenceRecord>): Promise<void> {
    await atomicWriteJson(this.filePath, {
      version: 1,
      canvases: [...records.values()],
    } satisfies PersistedCanvasAssetReferences)
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }
}
