import { lookup as dnsLookup } from 'node:dns/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { atomicWriteJson } from './atomic-json.ts'
import { resolveAssetImportTimeoutMs } from './config.ts'
import {
  resolvePinnedPublicAddress,
  type AddressLookup,
  type PinnedRemoteFetcher,
} from './pinned-http.ts'

export interface AssetRecord {
  id: string
  filename: string
  contentType: string
  size: number
  url: string
  createdAt: string
}

interface StoredAsset extends AssetRecord {
  storageName: string
}

const MIME_ALIASES: Record<string, string> = {
  'audio/mp3': 'audio/mpeg',
  'audio/wave': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'video/avi': 'video/x-msvideo',
}

const MIME_LIMITS: Record<string, number> = {
  'image/jpeg': 20 * 1024 * 1024,
  'image/png': 20 * 1024 * 1024,
  'image/gif': 20 * 1024 * 1024,
  'image/bmp': 20 * 1024 * 1024,
  'image/webp': 20 * 1024 * 1024,
  'audio/mpeg': 20 * 1024 * 1024,
  'audio/wav': 20 * 1024 * 1024,
  'video/mp4': 100 * 1024 * 1024,
  'video/quicktime': 100 * 1024 * 1024,
  'video/webm': 100 * 1024 * 1024,
  'video/x-matroska': 100 * 1024 * 1024,
  'video/x-msvideo': 100 * 1024 * 1024,
  'video/x-ms-wmv': 100 * 1024 * 1024,
  'video/x-flv': 100 * 1024 * 1024,
  'video/3gpp': 100 * 1024 * 1024,
  'video/3gpp2': 100 * 1024 * 1024,
  'video/mpeg': 100 * 1024 * 1024,
  'video/ogg': 100 * 1024 * 1024,
  'video/x-m4v': 100 * 1024 * 1024,
}

const EXTENSION_MIME: Record<string, string[]> = {
  '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.png': ['image/png'], '.gif': ['image/gif'],
  '.bmp': ['image/bmp'], '.webp': ['image/webp'], '.mp3': ['audio/mpeg'], '.wav': ['audio/wav'],
  '.mp4': ['video/mp4'], '.mov': ['video/quicktime'], '.avi': ['video/x-msvideo'],
  '.wmv': ['video/x-ms-wmv'], '.flv': ['video/x-flv'], '.mkv': ['video/x-matroska'],
  '.webm': ['video/webm'], '.3gp': ['video/3gpp', 'video/3gpp2'],
  '.mpeg': ['video/mpeg'], '.mpg': ['video/mpeg'], '.ogv': ['video/ogg'], '.m4v': ['video/x-m4v'],
}

const ORPHAN_UPLOAD = /^\.asset-upload-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i
const STORED_ASSET_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/i
const INFERABLE_REMOTE_MIME_TYPES = new Set(['application/octet-stream', 'text/plain'])

class AssetValidationError extends Error {}

export class RemoteAssetValidationError extends Error {
  readonly code = 'invalid_remote_asset'
}

export class RemoteAssetTimeoutError extends Error {
  readonly code = 'asset_import_timeout'

  constructor() {
    super('Remote asset import timed out')
    this.name = 'RemoteAssetTimeoutError'
  }
}

function isRemoteAssetTimeout(
  error: unknown,
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): boolean {
  if (callerSignal?.aborted && !timeoutSignal.aborted) return false
  return timeoutSignal.aborted || (error instanceof DOMException && error.name === 'TimeoutError')
}

function normalizedMime(value: string): string {
  const mime = value.split(';', 1)[0].trim().toLowerCase()
  return MIME_ALIASES[mime] ?? mime
}

function hasPrefix(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  return prefix.every((value, index) => bytes[offset + index] === value)
}

function hasValidSignature(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === 'image/png') return hasPrefix(bytes, [137, 80, 78, 71, 13, 10, 26, 10])
  if (contentType === 'image/jpeg') return hasPrefix(bytes, [255, 216, 255])
  if (contentType === 'image/gif') return hasPrefix(bytes, [71, 73, 70, 56])
  if (contentType === 'image/bmp') return hasPrefix(bytes, [66, 77])
  if (contentType === 'image/webp') return hasPrefix(bytes, [82, 73, 70, 70]) && hasPrefix(bytes, [87, 69, 66, 80], 8)
  if (contentType === 'audio/mpeg') return hasPrefix(bytes, [73, 68, 51]) || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0)
  if (contentType === 'audio/wav') return hasPrefix(bytes, [82, 73, 70, 70]) && hasPrefix(bytes, [87, 65, 86, 69], 8)
  if (contentType === 'video/mp4') return hasPrefix(bytes, [102, 116, 121, 112], 4)
  if (contentType === 'video/quicktime') return hasPrefix(bytes, [102, 116, 121, 112], 4) && hasPrefix(bytes, [113, 116, 32, 32], 8)
  if (contentType === 'video/x-m4v') return hasPrefix(bytes, [102, 116, 121, 112], 4) && hasPrefix(bytes, [77, 52, 86, 32], 8)
  if (contentType === 'video/3gpp' || contentType === 'video/3gpp2') {
    return hasPrefix(bytes, [102, 116, 121, 112], 4) && Buffer.from(bytes.slice(8, 12)).toString('ascii').toLowerCase().startsWith('3g')
  }
  if (contentType === 'video/webm' || contentType === 'video/x-matroska') {
    if (!hasPrefix(bytes, [26, 69, 223, 163])) return false
    const header = Buffer.from(bytes.slice(0, 4_096)).toString('latin1').toLowerCase()
    return contentType === 'video/webm' ? header.includes('webm') : header.includes('matroska')
  }
  if (contentType === 'video/x-msvideo') return hasPrefix(bytes, [82, 73, 70, 70]) && hasPrefix(bytes, [65, 86, 73, 32], 8)
  if (contentType === 'video/x-ms-wmv') return hasPrefix(bytes, [48, 38, 178, 117, 142, 102, 207, 17, 166, 217, 0, 170, 0, 98, 206, 108])
  if (contentType === 'video/x-flv') return hasPrefix(bytes, [70, 76, 86])
  if (contentType === 'video/mpeg') return hasPrefix(bytes, [0, 0, 1, 186]) || hasPrefix(bytes, [0, 0, 1, 179])
  if (contentType === 'video/ogg') return hasPrefix(bytes, [79, 103, 103, 83])
  return false
}

function extensionMatches(filename: string, contentType: string): boolean {
  const extension = extname(filename).toLowerCase()
  if (!extension) return true
  const allowed = EXTENSION_MIME[extension]
  return Array.isArray(allowed) && allowed.includes(contentType)
}

function uniqueMimeFromExtension(filename: string): string | undefined {
  const allowed = EXTENSION_MIME[extname(filename).toLowerCase()]
  return allowed?.length === 1 ? allowed[0] : undefined
}

function parseStoredAsset(value: unknown): StoredAsset | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id)) return undefined
  if (typeof record.storageName !== 'string' || record.storageName !== `${record.id}.bin`) return undefined
  if (typeof record.filename !== 'string' || !record.filename || basename(record.filename) !== record.filename) return undefined
  if (typeof record.contentType !== 'string' || MIME_LIMITS[record.contentType] === undefined) return undefined
  if (typeof record.size !== 'number' || !Number.isInteger(record.size) || record.size <= 0 || record.size > MIME_LIMITS[record.contentType]) return undefined
  if (record.url !== `/api/assets/${record.id}`) return undefined
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) return undefined
  return {
    id: record.id,
    filename: record.filename,
    contentType: record.contentType,
    size: record.size,
    url: record.url,
    createdAt: record.createdAt,
    storageName: record.storageName,
  }
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

function responseBodyStream(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader()
  let completed = false
  return Readable.from((async function* () {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          completed = true
          return
        }
        yield value
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  })())
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) throw new RangeError('Invalid byte range')
  let start = match[1] ? Number(match[1]) : NaN
  let end = match[2] ? Number(match[2]) : NaN
  if (Number.isNaN(start)) {
    if (Number.isNaN(end) || end <= 0) throw new RangeError('Invalid byte range')
    start = Math.max(0, size - end)
    end = size - 1
  } else if (Number.isNaN(end)) {
    end = size - 1
  }
  if (start < 0 || start >= size || end < start) throw new RangeError('Unsatisfiable byte range')
  return { start, end: Math.min(end, size - 1) }
}

export class AssetStore {
  private filesRoot: string
  private indexPath: string
  private assets: StoredAsset[]
  private pinnedFetcher: PinnedRemoteFetcher | undefined
  private lookup: AddressLookup
  private assetImportTimeoutMs: number
  private mutationTail: Promise<unknown> = Promise.resolve()

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.catch(() => undefined).then(operation)
    this.mutationTail = next.catch(() => undefined)
    return next
  }

  private constructor(
    filesRoot: string,
    indexPath: string,
    assets: StoredAsset[],
    pinnedFetcher: PinnedRemoteFetcher | undefined,
    lookup: AddressLookup,
    assetImportTimeoutMs: number,
  ) {
    this.filesRoot = filesRoot
    this.indexPath = indexPath
    this.assets = assets
    this.pinnedFetcher = pinnedFetcher
    this.lookup = lookup
    this.assetImportTimeoutMs = assetImportTimeoutMs
  }

  static async open(options: {
    dataDir: string
    assetImportTimeoutMs?: number
    pinnedFetcher?: PinnedRemoteFetcher
    lookup?: AddressLookup
  }) {
    const root = join(options.dataDir, 'assets')
    const files = join(root, 'files')
    const indexPath = join(root, 'index.json')
    await mkdir(files, { recursive: true })
    const entries = await readdir(files, { withFileTypes: true })
    await Promise.all(entries.flatMap((entry) =>
      entry.isFile() && ORPHAN_UPLOAD.test(entry.name)
        ? [rm(join(files, entry.name), { force: true })]
        : []))
    let assets: StoredAsset[] = []
    try {
      const parsed: unknown = JSON.parse(await readFile(indexPath, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('invalid asset index')
      const validated = parsed.map(parseStoredAsset)
      if (validated.some((asset) => asset === undefined)) throw new Error('invalid asset index')
      assets = validated as StoredAsset[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const committedFiles = new Set(assets.map((asset) => asset.storageName))
    const storedEntries = await readdir(files, { withFileTypes: true })
    await Promise.all(storedEntries.flatMap((entry) =>
      entry.isFile() && STORED_ASSET_FILE.test(entry.name) && !committedFiles.has(entry.name)
        ? [rm(join(files, entry.name), { force: true })]
        : []))
    return new AssetStore(
      files,
      indexPath,
      assets,
      options.pinnedFetcher,
      options.lookup ?? (async (hostname) => dnsLookup(hostname, { all: true, verbatim: true })),
      resolveAssetImportTimeoutMs(options.assetImportTimeoutMs),
    )
  }

  get(id: string): AssetRecord | undefined {
    const asset = this.assets.find((candidate) => candidate.id === id)
    return asset ? this.publicRecord(asset) : undefined
  }

  canImportRemote(): boolean {
    return this.pinnedFetcher !== undefined
  }

  async save(input: { filename: string; contentType: string; bytes: Uint8Array }): Promise<AssetRecord> {
    return this.saveStream({
      filename: input.filename,
      contentType: input.contentType,
      expectedSize: input.bytes.byteLength,
      stream: Readable.from([input.bytes]),
    })
  }

  async saveStream(input: {
    filename: string
    contentType: string
    stream: Readable
    expectedSize?: number
    maxSize?: number
    signal?: AbortSignal
  }): Promise<AssetRecord> {
    const contentType = normalizedMime(input.contentType)
    const mimeLimit = MIME_LIMITS[contentType]
    if (!mimeLimit) throw new AssetValidationError('Unsupported asset MIME type')
    if (!extensionMatches(input.filename, contentType)) {
      throw new AssetValidationError('Asset filename extension does not match its MIME type')
    }
    const limit = Math.min(mimeLimit, input.maxSize ?? mimeLimit)
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Asset size limit is invalid')
    if (input.expectedSize !== undefined &&
      (!Number.isSafeInteger(input.expectedSize) || input.expectedSize <= 0 || input.expectedSize > limit)) {
      throw new Error('Asset size exceeds the allowed limit')
    }
    const id = randomUUID()
    const storageName = `${id}.bin`
    const finalPath = this.assetPath({ storageName })
    const temporaryPath = join(this.filesRoot, `.asset-upload-${id}.tmp`)
    const signatureChunks: Buffer[] = []
    let signatureSize = 0
    let size = 0
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.from(chunk)
        size += bytes.byteLength
        if (size > limit) {
          callback(new Error('Asset size exceeds the allowed limit'))
          return
        }
        if (signatureSize < 4_096) {
          const head = bytes.subarray(0, Math.min(bytes.byteLength, 4_096 - signatureSize))
          signatureChunks.push(head)
          signatureSize += head.byteLength
        }
        callback(null, bytes)
      },
    })
    try {
      await pipeline(
        input.stream,
        limiter,
        createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
        ...(input.signal ? [{ signal: input.signal }] : []),
      )
      if (size === 0 || (input.expectedSize !== undefined && size !== input.expectedSize)) {
        throw new Error('Asset size does not match its declared length')
      }
      const signature = Buffer.concat(signatureChunks, signatureSize)
      if (!hasValidSignature(contentType, signature)) {
        throw new AssetValidationError('Asset signature does not match its MIME type')
      }
      await rename(temporaryPath, finalPath)
    } catch (error) {
      if (!input.stream.destroyed) input.stream.destroy(error as Error)
      await rm(temporaryPath, { force: true }).catch(() => {})
      await rm(finalPath, { force: true }).catch(() => {})
      throw error
    }
    const stored: StoredAsset = {
      id,
      filename: basename(input.filename) || 'asset',
      contentType,
      size,
      url: `/api/assets/${id}`,
      createdAt: new Date().toISOString(),
      storageName,
    }
    await this.mutate(async () => {
      this.assets.push(stored)
      try {
        await this.persist()
      } catch (error) {
        this.assets = this.assets.filter((asset) => asset.id !== id)
        await rm(finalPath, { force: true }).catch(() => {})
        throw error
      }
    })
    return this.publicRecord(stored)
  }

  async deleteUnreferenced(
    candidateIds: Iterable<string>,
    referencedIds: ReadonlySet<string>,
  ): Promise<string[]> {
    return this.mutate(async () => {
      const candidates = new Set(candidateIds)
      const removable = this.assets.filter(
        (asset) => candidates.has(asset.id) && !referencedIds.has(asset.id),
      )
      if (removable.length === 0) return []
      const removableIds = new Set(removable.map((asset) => asset.id))
      const retained = this.assets.filter((asset) => !removableIds.has(asset.id))
      this.assets = retained
      await atomicWriteJson(this.indexPath, retained)
      await Promise.all(removable.map((asset) => rm(this.assetPath(asset), { force: true })))
      return removable.map((asset) => asset.id)
    })
  }

  async readBytes(id: string): Promise<Uint8Array> {
    const asset = this.requireAsset(id)
    return new Uint8Array(await readFile(this.assetPath(asset)))
  }

  openReadStream(id: string, signal?: AbortSignal): Readable {
    const asset = this.requireAsset(id)
    return createReadStream(this.assetPath(asset), signal ? { signal } : undefined)
  }

  async openResponse(id: string, rangeHeader?: string): Promise<{
    status: number
    headers: Record<string, string>
    stream: Readable
  }> {
    const asset = this.requireAsset(id)
    const range = parseRange(rangeHeader, asset.size)
    const headers: Record<string, string> = {
      'accept-ranges': 'bytes',
      'content-type': asset.contentType,
      'content-length': String(range ? range.end - range.start + 1 : asset.size),
      'cache-control': 'private, max-age=31536000, immutable',
    }
    if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${asset.size}`
    return {
      status: range ? 206 : 200,
      headers,
      stream: createReadStream(this.assetPath(asset), range),
    }
  }

  async importRemote(input: string, filename?: string, signal?: AbortSignal): Promise<AssetRecord> {
    if (input.startsWith('data:')) return this.importDataUrl(input, filename, signal)
    if (!this.pinnedFetcher) throw new Error('Remote asset import is disabled without a secure pinned fetch implementation')
    let current = new URL(input)
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      signal?.throwIfAborted()
      const timeoutSignal = AbortSignal.timeout(this.assetImportTimeoutMs)
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal
      try {
        const pinnedAddress = await resolvePinnedPublicAddress(current, this.lookup, requestSignal)
        const response = await this.pinnedFetcher(
          current.href,
          { redirect: 'manual', signal: requestSignal },
          pinnedAddress,
        )
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          await cancelBody(response)
          if (!location || redirectCount === 3) throw new Error('Remote asset used an unsafe redirect')
          current = new URL(location, current)
          continue
        }
        if (!response.ok) {
          await cancelBody(response)
          throw new Error(`Remote asset request failed (${response.status})`)
        }
        const remoteFilename = filename ?? (basename(current.pathname) || 'remote-asset')
        const declaredContentType = normalizedMime(response.headers.get('content-type') ?? '')
        const contentType = INFERABLE_REMOTE_MIME_TYPES.has(declaredContentType)
          ? uniqueMimeFromExtension(remoteFilename) ?? ''
          : declaredContentType
        const limit = MIME_LIMITS[contentType]
        if (!limit) {
          await cancelBody(response)
          throw new RemoteAssetValidationError('Unsupported remote asset MIME type')
        }
        if (!extensionMatches(remoteFilename, contentType)) {
          await cancelBody(response)
          throw new RemoteAssetValidationError('Asset filename extension does not match its MIME type')
        }
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > limit) {
          await cancelBody(response)
          throw new Error('Remote asset exceeds the allowed limit')
        }
        if (!response.body) throw new Error('Remote asset response did not contain a body')
        const stream = responseBodyStream(response.body)
        try {
          return await this.saveStream({
            filename: remoteFilename,
            contentType,
            stream,
            maxSize: limit,
            ...(Number.isSafeInteger(declared) && declared > 0 ? { expectedSize: declared } : {}),
            signal: requestSignal,
          })
        } catch (error) {
          if (!stream.destroyed) stream.destroy()
          if (error instanceof AssetValidationError) {
            throw new RemoteAssetValidationError(error.message)
          }
          throw error
        }
      } catch (error) {
        if (isRemoteAssetTimeout(error, timeoutSignal, signal)) throw new RemoteAssetTimeoutError()
        throw error
      }
    }
    throw new Error('Remote asset used an unsafe redirect')
  }

  private async importDataUrl(
    input: string,
    filename: string | undefined,
    signal?: AbortSignal,
  ): Promise<AssetRecord> {
    const comma = input.indexOf(',')
    if (comma === -1) throw new RemoteAssetValidationError('Unsupported data URL')
    const meta = input.slice(5, comma)
    const payload = input.slice(comma + 1)
    const parts = meta.split(';')
    const contentType = normalizedMime(parts[0] ?? '')
    const limit = MIME_LIMITS[contentType]
    if (!limit || !contentType.startsWith('image/')) {
      throw new RemoteAssetValidationError('Unsupported remote asset MIME type')
    }
    if (!parts.some((part) => part.trim().toLowerCase() === 'base64')) {
      throw new RemoteAssetValidationError('Unsupported data URL encoding')
    }
    // base64 inflates by 4/3; a rough length check prevents OOM before decoding.
    if (payload.length > limit * 4 / 3 + 8) {
      throw new RemoteAssetValidationError('Asset exceeds the allowed limit')
    }
    let bytes: Buffer
    try {
      bytes = Buffer.from(payload, 'base64')
    } catch {
      throw new RemoteAssetValidationError('Invalid data URL payload')
    }
    if (bytes.length > limit) throw new RemoteAssetValidationError('Asset exceeds the allowed limit')
    const extension = Object.entries(EXTENSION_MIME).find(
      ([, mimes]) => mimes.includes(contentType),
    )?.[0] ?? ''
    const remoteFilename = filename ?? (extension ? `output${extension}` : 'remote-asset')
    const stream = Readable.from(bytes)
    try {
      return await this.saveStream({
        filename: remoteFilename,
        contentType,
        stream,
        maxSize: limit,
        expectedSize: bytes.length,
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      if (!stream.destroyed) stream.destroy()
      if (error instanceof AssetValidationError) {
        throw new RemoteAssetValidationError(error.message)
      }
      throw error
    }
  }

  private requireAsset(id: string): StoredAsset {
    const asset = this.assets.find((candidate) => candidate.id === id)
    if (!asset) throw new Error('Asset not found')
    return asset
  }

  private assetPath(asset: Pick<StoredAsset, 'storageName'>): string {
    const target = resolve(this.filesRoot, asset.storageName)
    const pathFromRoot = relative(this.filesRoot, target)
    if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
      throw new Error('Asset storage path is invalid')
    }
    return target
  }

  private publicRecord(asset: StoredAsset): AssetRecord {
    const { storageName: _storageName, ...record } = asset
    return record
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.indexPath, this.assets)
  }
}
