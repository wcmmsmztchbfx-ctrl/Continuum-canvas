import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  GenerationHistoryEntry,
  GenerationHistoryMediaType,
  GenerationHistoryPage,
  GenerationJob,
} from '../src/contracts/generation.ts'
import type { AssetRecord } from './asset-store.ts'
import { atomicWriteJson } from './atomic-json.ts'

type WriteHistory = (filePath: string, value: unknown) => Promise<void>

interface HistoryCursor {
  version: 1
  projectId: string
  mediaType?: GenerationHistoryMediaType
  completedAt: string
  id: string
}

interface ProjectHistoryShard {
  version: 1
  projectId: string
  entries: GenerationHistoryEntry[]
}

export interface ReassignCanvasHistoryInput {
  operationId: string
  canvasId: string
  fromProjectId: string
  toProjectId: string
}

export interface ReassignCanvasHistoryResult {
  moved: number
  bound: number
}

interface PersistedReassignment extends ReassignCanvasHistoryInput {
  result: ReassignCanvasHistoryResult
}

const ENTRY_ID = /^[a-f0-9]{64}$/
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isNonEmptyString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch)) return undefined
  return new Date(epoch).toISOString()
}

function isMediaType(value: unknown): value is GenerationHistoryMediaType {
  return value === 'image' || value === 'video' || value === 'audio'
}

function parseAsset(value: unknown): GenerationHistoryEntry['asset'] | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'filename', 'contentType', 'size', 'url', 'createdAt'])) {
    return undefined
  }
  if (!isNonEmptyString(value.id, 128) || !ASSET_ID.test(value.id)) return undefined
  if (!isNonEmptyString(value.filename, 255) || !isNonEmptyString(value.contentType, 256)) return undefined
  if (!Number.isSafeInteger(value.size) || (value.size as number) <= 0) return undefined
  const createdAt = normalizeTimestamp(value.createdAt)
  if (value.url !== `/api/assets/${value.id}` || !createdAt) return undefined
  return {
    id: value.id,
    filename: value.filename,
    contentType: value.contentType,
    size: value.size as number,
    url: value.url,
    createdAt,
  }
}

function parseSettings(value: unknown): GenerationHistoryEntry['settings'] | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['quality', 'aspectRatio', 'count', 'duration', 'mode'])) return undefined
  for (const key of ['quality', 'aspectRatio', 'mode'] as const) {
    if (value[key] !== undefined && !isNonEmptyString(value[key], 256)) return undefined
  }
  if (value.count !== undefined && (!Number.isInteger(value.count) || (value.count as number) <= 0)) return undefined
  if (value.duration !== undefined && (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration <= 0)) {
    return undefined
  }
  return {
    ...(typeof value.quality === 'string' ? { quality: value.quality } : {}),
    ...(typeof value.aspectRatio === 'string' ? { aspectRatio: value.aspectRatio } : {}),
    ...(typeof value.count === 'number' ? { count: value.count } : {}),
    ...(typeof value.duration === 'number' ? { duration: value.duration } : {}),
    ...(typeof value.mode === 'string' ? { mode: value.mode } : {}),
  }
}

function parseReferences(value: unknown): GenerationHistoryEntry['references'] | undefined {
  if (!Array.isArray(value)) return undefined
  const references: GenerationHistoryEntry['references'] = []
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, ['alias', 'assetId', 'mediaType'])) return undefined
    if (!Number.isInteger(item.alias) || (item.alias as number) <= 0 || !isMediaType(item.mediaType)) return undefined
    if (item.assetId !== undefined && (!isNonEmptyString(item.assetId, 128) || !ASSET_ID.test(item.assetId))) return undefined
    references.push({
      alias: item.alias as number,
      ...(typeof item.assetId === 'string' ? { assetId: item.assetId } : {}),
      mediaType: item.mediaType,
    })
  }
  if (new Set(references.map((reference) => reference.alias)).size !== references.length) return undefined
  return references
}

function entryId(jobId: string, outputIndex: number): string {
  return createHash('sha256').update(`${jobId}\0${outputIndex}`).digest('hex')
}

function parseEntry(value: unknown): GenerationHistoryEntry | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'projectId', 'canvasId', 'jobId', 'outputIndex', 'mediaType', 'asset', 'prompt', 'providerId',
    'channel', 'model', 'settings', 'references', 'completedAt',
  ])) return undefined
  if (!isNonEmptyString(value.id, 64) || !ENTRY_ID.test(value.id)) return undefined
  if (!isNonEmptyString(value.projectId, 256) || !isNonEmptyString(value.jobId, 128) || !SAFE_JOB_ID.test(value.jobId)) {
    return undefined
  }
  if (value.canvasId !== undefined && !isNonEmptyString(value.canvasId, 256)) return undefined
  if (!Number.isInteger(value.outputIndex) || (value.outputIndex as number) < 0) return undefined
  if (value.id !== entryId(value.jobId, value.outputIndex as number)) return undefined
  if (!isMediaType(value.mediaType) || !isNonEmptyString(value.prompt, 100_000)) return undefined
  if (!isNonEmptyString(value.providerId, 64) || !isNonEmptyString(value.model, 512)) return undefined
  if (!((typeof value.channel === 'string' && value.channel.length > 0 && value.channel.length <= 256) ||
    (typeof value.channel === 'number' && Number.isFinite(value.channel)))) return undefined
  const asset = parseAsset(value.asset)
  const settings = parseSettings(value.settings)
  const references = parseReferences(value.references)
  const completedAt = normalizeTimestamp(value.completedAt)
  if (!asset || !settings || !references || !completedAt) return undefined
  return {
    id: value.id,
    projectId: value.projectId,
    ...(typeof value.canvasId === 'string' ? { canvasId: value.canvasId } : {}),
    jobId: value.jobId,
    outputIndex: value.outputIndex as number,
    mediaType: value.mediaType,
    asset,
    prompt: value.prompt,
    providerId: value.providerId,
    channel: value.channel as string | number,
    model: value.model,
    settings,
    references,
    completedAt,
  }
}

function parseEntries(value: unknown): GenerationHistoryEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries = value.map(parseEntry)
  if (entries.some((entry) => entry === undefined)) return undefined
  const parsed = entries as GenerationHistoryEntry[]
  if (new Set(parsed.map((entry) => entry.id)).size !== parsed.length ||
    new Set(parsed.map((entry) => `${entry.jobId}\0${entry.outputIndex}`)).size !== parsed.length) return undefined
  return parsed
}

function parseShard(value: unknown): ProjectHistoryShard | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'projectId', 'entries'])) return undefined
  if (value.version !== 1 || !isNonEmptyString(value.projectId, 256)) return undefined
  const entries = parseEntries(value.entries)
  if (!entries || entries.some((entry) => entry.projectId !== value.projectId)) return undefined
  return { version: 1, projectId: value.projectId, entries }
}

function newestFirst(
  left: Pick<GenerationHistoryEntry, 'completedAt' | 'id'>,
  right: Pick<GenerationHistoryEntry, 'completedAt' | 'id'>,
): number {
  const byTime = Date.parse(right.completedAt) - Date.parse(left.completedAt)
  return byTime || right.id.localeCompare(left.id)
}

function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(value: string): HistoryCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidGenerationHistoryCursorError()
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ['version', 'projectId', 'mediaType', 'completedAt', 'id'])) {
    throw new InvalidGenerationHistoryCursorError()
  }
  const completedAt = normalizeTimestamp(parsed.completedAt)
  if (parsed.version !== 1 || !isNonEmptyString(parsed.projectId, 256) || !completedAt) {
    throw new InvalidGenerationHistoryCursorError()
  }
  if (!isNonEmptyString(parsed.id, 64) || !ENTRY_ID.test(parsed.id)) throw new InvalidGenerationHistoryCursorError()
  if (parsed.mediaType !== undefined && !isMediaType(parsed.mediaType)) throw new InvalidGenerationHistoryCursorError()
  return {
    version: 1,
    projectId: parsed.projectId,
    ...(parsed.mediaType ? { mediaType: parsed.mediaType } : {}),
    completedAt,
    id: parsed.id,
  }
}

function projectIdFromJob(job: GenerationJob): string | undefined {
  return 'projectId' in job.request && isNonEmptyString(job.request.projectId, 256)
    ? job.request.projectId
    : undefined
}

function canvasIdFromJob(job: GenerationJob): string | undefined {
  return 'canvasId' in job.request && isNonEmptyString(job.request.canvasId, 256)
    ? job.request.canvasId
    : undefined
}

function parseReassignments(value: unknown): PersistedReassignment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed: PersistedReassignment[] = []
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, [
      'operationId', 'canvasId', 'fromProjectId', 'toProjectId', 'result',
    ])) return undefined
    if (!isNonEmptyString(item.operationId, 256) || !isNonEmptyString(item.canvasId, 256) ||
      !isNonEmptyString(item.fromProjectId, 256) || !isNonEmptyString(item.toProjectId, 256) ||
      !isRecord(item.result) || !hasOnlyKeys(item.result, ['moved', 'bound']) ||
      !Number.isInteger(item.result.moved) || (item.result.moved as number) < 0 ||
      !Number.isInteger(item.result.bound) || (item.result.bound as number) < 0) return undefined
    parsed.push({
      operationId: item.operationId,
      canvasId: item.canvasId,
      fromProjectId: item.fromProjectId,
      toProjectId: item.toProjectId,
      result: { moved: item.result.moved as number, bound: item.result.bound as number },
    })
  }
  if (new Set(parsed.map((item) => item.operationId)).size !== parsed.length) return undefined
  return parsed
}

function shardName(projectId: string): string {
  return `${createHash('sha256').update(projectId).digest('hex')}.json`
}

function outputKey(jobId: string, outputIndex: number): string {
  return `${jobId}\0${outputIndex}`
}

function sameEntry(left: GenerationHistoryEntry, right: GenerationHistoryEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function quarantine(filePath: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await rename(filePath, `${filePath}.corrupt.${stamp}.${randomUUID()}`)
}

export class InvalidGenerationHistoryCursorError extends Error {
  readonly code = 'invalid_history_cursor'

  constructor() {
    super('Generation history cursor is invalid')
  }
}

export class GenerationHistoryConflictError extends Error {
  readonly code = 'history_conflict'

  constructor() {
    super('Generation history output conflicts with an existing entry')
  }
}

export class GenerationHistoryStore {
  private readonly historyRoot: string
  private readonly reassignmentsPath: string
  private readonly entriesByProject: Map<string, GenerationHistoryEntry[]>
  private readonly reassignments: Map<string, PersistedReassignment>
  private readonly writeHistory: WriteHistory
  private mutationTail: Promise<void> = Promise.resolve()

  private constructor(
    historyRoot: string,
    reassignmentsPath: string,
    entriesByProject: Map<string, GenerationHistoryEntry[]>,
    reassignments: Map<string, PersistedReassignment>,
    writeHistory: WriteHistory,
  ) {
    this.historyRoot = historyRoot
    this.reassignmentsPath = reassignmentsPath
    this.entriesByProject = entriesByProject
    this.reassignments = reassignments
    this.writeHistory = writeHistory
  }

  static async open(options: { dataDir: string; writeHistory?: WriteHistory }): Promise<GenerationHistoryStore> {
    await mkdir(options.dataDir, { recursive: true })
    const historyRoot = join(options.dataDir, 'generation-history')
    const reassignmentsPath = join(options.dataDir, 'generation-history-reassignments.json')
    await mkdir(historyRoot, { recursive: true })
    const writeHistory = options.writeHistory ?? atomicWriteJson
    await GenerationHistoryStore.migrateLegacy(options.dataDir, historyRoot, writeHistory)

    const entriesByProject = new Map<string, GenerationHistoryEntry[]>()
    const seenKeys = new Set<string>()
    const names = (await readdir(historyRoot)).filter((name) => name.endsWith('.json')).sort()
    for (const name of names) {
      const filePath = join(historyRoot, name)
      try {
        const shard = parseShard(JSON.parse(await readFile(filePath, 'utf8')))
        if (!shard || name !== shardName(shard.projectId) || entriesByProject.has(shard.projectId)) {
          throw new Error('Persisted generation history shard is invalid')
        }
        for (const entry of shard.entries) {
          const key = outputKey(entry.jobId, entry.outputIndex)
          if (seenKeys.has(key)) throw new Error('Persisted generation history contains duplicate entries')
          seenKeys.add(key)
        }
        entriesByProject.set(shard.projectId, shard.entries)
      } catch {
        await quarantine(filePath)
      }
    }
    let reassignments: PersistedReassignment[] = []
    try {
      const parsed = parseReassignments(JSON.parse(await readFile(reassignmentsPath, 'utf8')))
      if (!parsed) throw new Error('Persisted generation history reassignments are invalid')
      reassignments = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await quarantine(reassignmentsPath)
    }
    return new GenerationHistoryStore(
      historyRoot,
      reassignmentsPath,
      entriesByProject,
      new Map(reassignments.map((item) => [item.operationId, item])),
      writeHistory,
    )
  }

  private static async migrateLegacy(
    dataDir: string,
    historyRoot: string,
    writeHistory: WriteHistory,
  ): Promise<void> {
    const legacyPath = join(dataDir, 'generation-history.json')
    let serialized: string
    try {
      serialized = await readFile(legacyPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    let legacyEntries: GenerationHistoryEntry[]
    try {
      const parsed = parseEntries(JSON.parse(serialized))
      if (!parsed) throw new Error('Persisted generation history is invalid')
      legacyEntries = parsed
    } catch {
      await quarantine(legacyPath)
      return
    }

    const grouped = new Map<string, GenerationHistoryEntry[]>()
    for (const entry of legacyEntries) {
      grouped.set(entry.projectId, [...(grouped.get(entry.projectId) ?? []), entry])
    }
    for (const projectId of [...grouped.keys()].sort()) {
      const filePath = join(historyRoot, shardName(projectId))
      let existing: GenerationHistoryEntry[] = []
      try {
        const shard = parseShard(JSON.parse(await readFile(filePath, 'utf8')))
        if (!shard || shard.projectId !== projectId) throw new Error('Persisted generation history shard is invalid')
        existing = shard.entries
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await quarantine(filePath)
      }
      const byKey = new Map(existing.map((entry) => [outputKey(entry.jobId, entry.outputIndex), entry]))
      let changed = existing.length === 0
      for (const entry of grouped.get(projectId) ?? []) {
        const key = outputKey(entry.jobId, entry.outputIndex)
        const current = byKey.get(key)
        if (current && !sameEntry(current, entry)) throw new GenerationHistoryConflictError()
        if (!current) {
          byKey.set(key, entry)
          changed = true
        }
      }
      if (changed) {
        await writeHistory(filePath, {
          version: 1,
          projectId,
          entries: [...byKey.values()],
        } satisfies ProjectHistoryShard)
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await rename(legacyPath, `${legacyPath}.migrated.${stamp}.${randomUUID()}`)
  }

  async recordOutput(input: {
    job: GenerationJob
    outputIndex: number
    asset: AssetRecord
    projectId?: string
    completedAt?: string
  }): Promise<GenerationHistoryEntry | undefined> {
    const [entry] = await this.recordOutputs([input])
    return entry
  }

  async recordOutputs(inputs: Array<{
    job: GenerationJob
    outputIndex: number
    asset: AssetRecord
    projectId?: string
    completedAt?: string
  }>): Promise<Array<GenerationHistoryEntry | undefined>> {
    return this.runMutation(async () => {
      const candidates = new Map<string, GenerationHistoryEntry[]>()
      const existingByKey = new Map<string, GenerationHistoryEntry>()
      for (const entries of this.entriesByProject.values()) {
        for (const entry of entries) existingByKey.set(outputKey(entry.jobId, entry.outputIndex), entry)
      }
      const results: Array<GenerationHistoryEntry | undefined> = []
      const changedProjects = new Set<string>()

      for (const input of inputs) {
        const projectId = input.projectId ?? projectIdFromJob(input.job)
        if (!projectId) {
          results.push(undefined)
          continue
        }
        if (!isNonEmptyString(projectId, 256)) throw new Error('History projectId is invalid')
        const jobProjectId = projectIdFromJob(input.job)
        if (jobProjectId && jobProjectId !== projectId) throw new GenerationHistoryConflictError()
        if (!Number.isInteger(input.outputIndex) || input.outputIndex < 0) throw new Error('History output index is invalid')
        const output = input.job.outputs[input.outputIndex]
        const persistedAsset = parseAsset(input.asset)
        if (!output || !persistedAsset || output.assetId !== input.asset.id || output.url !== input.asset.url ||
          output.contentType !== input.asset.contentType || output.size !== input.asset.size) {
          throw new Error('History asset does not match the completed job output')
        }
        const key = outputKey(input.job.id, input.outputIndex)
        const existing = existingByKey.get(key)
        if (existing) {
          if (existing.projectId !== projectId || existing.asset.id !== input.asset.id) {
            throw new GenerationHistoryConflictError()
          }
          results.push(structuredClone(existing))
          continue
        }
        const completedAt = normalizeTimestamp(input.completedAt ?? input.job.updatedAt)
        if (!completedAt) throw new Error('History completion timestamp is invalid')
        const request = input.job.request
        const canvasId = canvasIdFromJob(input.job)
        const entry: GenerationHistoryEntry = {
          id: entryId(input.job.id, input.outputIndex), projectId, jobId: input.job.id,
          ...(canvasId ? { canvasId } : {}),
          outputIndex: input.outputIndex, mediaType: request.mediaType,
          asset: persistedAsset, prompt: request.prompt, providerId: request.providerId,
          channel: request.channel, model: request.model,
          settings: {
            ...(request.quality ? { quality: request.quality } : {}),
            ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
            ...(request.n !== undefined ? { count: request.n } : {}),
            ...(request.duration !== undefined ? { duration: request.duration } : {}),
            ...(request.mode ? { mode: request.mode } : {}),
          },
          references: [...request.references]
            .sort((left, right) => left.alias - right.alias)
            .map(({ alias, assetId, mediaType }) => ({ alias, ...(assetId ? { assetId } : {}), mediaType })),
          completedAt,
        }
        const projectEntries = candidates.get(projectId) ?? [...(this.entriesByProject.get(projectId) ?? [])]
        projectEntries.push(entry)
        candidates.set(projectId, projectEntries)
        existingByKey.set(key, entry)
        changedProjects.add(projectId)
        results.push(structuredClone(entry))
      }

      for (const projectId of [...changedProjects].sort()) {
        await this.writeHistory(join(this.historyRoot, shardName(projectId)), {
          version: 1,
          projectId,
          entries: candidates.get(projectId) ?? [],
        } satisfies ProjectHistoryShard)
      }
      for (const projectId of changedProjects) {
        this.entriesByProject.set(projectId, candidates.get(projectId) ?? [])
      }
      return results
    })
  }

  async reassignCanvas(
    input: ReassignCanvasHistoryInput,
  ): Promise<ReassignCanvasHistoryResult> {
    return this.runMutation(async () => {
      for (const value of [input.operationId, input.canvasId, input.fromProjectId, input.toProjectId]) {
        if (!isNonEmptyString(value, 256)) throw new Error('History reassignment input is invalid')
      }
      const existingOperation = this.reassignments.get(input.operationId)
      if (existingOperation) {
        if (
          existingOperation.canvasId !== input.canvasId ||
          existingOperation.fromProjectId !== input.fromProjectId ||
          existingOperation.toProjectId !== input.toProjectId
        ) throw new GenerationHistoryConflictError()
        return structuredClone(existingOperation.result)
      }

      const source = [...(this.entriesByProject.get(input.fromProjectId) ?? [])]
      let result: ReassignCanvasHistoryResult
      const nextProjects = new Map<string, GenerationHistoryEntry[]>()
      if (input.fromProjectId === input.toProjectId) {
        const assigned = source.filter((entry) => entry.canvasId !== undefined)
        if (assigned.some((entry) => entry.canvasId !== input.canvasId)) {
          throw new GenerationHistoryConflictError()
        }
        const bound = source.filter((entry) => entry.canvasId === undefined).length
        nextProjects.set(input.fromProjectId, source.map((entry) => (
          entry.canvasId === undefined ? { ...entry, canvasId: input.canvasId } : entry
        )))
        result = { moved: 0, bound }
      } else {
        const moving = source.filter((entry) => entry.canvasId === input.canvasId)
        const target = [...(this.entriesByProject.get(input.toProjectId) ?? [])]
        const targetByKey = new Map(target.map((entry) => [outputKey(entry.jobId, entry.outputIndex), entry]))
        for (const entry of moving) {
          const moved = { ...entry, projectId: input.toProjectId }
          const current = targetByKey.get(outputKey(entry.jobId, entry.outputIndex))
          if (current && !sameEntry(current, moved)) throw new GenerationHistoryConflictError()
          if (!current) target.push(moved)
        }
        nextProjects.set(
          input.fromProjectId,
          source.filter((entry) => entry.canvasId !== input.canvasId),
        )
        nextProjects.set(input.toProjectId, target)
        result = { moved: moving.length, bound: 0 }
      }

      for (const [projectId, entries] of nextProjects) {
        await this.writeHistory(join(this.historyRoot, shardName(projectId)), {
          version: 1,
          projectId,
          entries,
        } satisfies ProjectHistoryShard)
      }
      const operation: PersistedReassignment = { ...input, result }
      const reassignments = [...this.reassignments.values(), operation]
      await this.writeHistory(this.reassignmentsPath, reassignments)
      for (const [projectId, entries] of nextProjects) this.entriesByProject.set(projectId, entries)
      this.reassignments.set(input.operationId, operation)
      return structuredClone(result)
    })
  }

  referencedAssetIds(): Set<string> {
    const ids = new Set<string>()
    for (const entries of this.entriesByProject.values()) {
      for (const entry of entries) {
        ids.add(entry.asset.id)
        for (const reference of entry.references) {
          if (reference.assetId) ids.add(reference.assetId)
        }
      }
    }
    return ids
  }

  list(options: {
    projectId: string
    mediaType?: GenerationHistoryMediaType
    cursor?: string
    limit: number
  }): GenerationHistoryPage {
    if (!isNonEmptyString(options.projectId, 256)) throw new Error('History projectId is invalid')
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) {
      throw new Error('History page limit is invalid')
    }
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined
    if (cursor && (cursor.projectId !== options.projectId || cursor.mediaType !== options.mediaType)) {
      throw new InvalidGenerationHistoryCursorError()
    }
    const filtered = [...(this.entriesByProject.get(options.projectId) ?? [])]
      .filter((entry) => !options.mediaType || entry.mediaType === options.mediaType)
      .sort(newestFirst)
      .filter((entry) => !cursor || newestFirst(entry, cursor) > 0)
    const entries = filtered.slice(0, options.limit)
    const hasMore = filtered.length > entries.length
    const last = entries.at(-1)
    return {
      entries: structuredClone(entries),
      ...(hasMore && last ? {
        nextCursor: encodeCursor({
          version: 1,
          projectId: options.projectId,
          ...(options.mediaType ? { mediaType: options.mediaType } : {}),
          completedAt: last.completedAt,
          id: last.id,
        }),
      } : {}),
    }
  }

  async remove(projectId: string, entryIdValue: string): Promise<boolean> {
    return this.runMutation(async () => {
      if (!isNonEmptyString(projectId, 256)) throw new Error('History projectId is invalid')
      const entries = this.entriesByProject.get(projectId) ?? []
      const index = entries.findIndex((entry) => entry.id === entryIdValue)
      if (index === -1) return false
      const candidate = [...entries.slice(0, index), ...entries.slice(index + 1)]
      await this.writeHistory(join(this.historyRoot, shardName(projectId)), {
        version: 1, projectId, entries: candidate,
      } satisfies ProjectHistoryShard)
      this.entriesByProject.set(projectId, candidate)
      return true
    })
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }
}
