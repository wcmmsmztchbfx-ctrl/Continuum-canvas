import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from './atomic-json.ts'

export const LOCAL_ADMIN_COOKIE = 'canvas_local_admin'

interface LocalAdminMetadataV1 {
  version: 1
  tokenDigest: string
  createdAt: string
}

export class LocalAdminAuthorizationError extends Error {
  readonly code = 'local_admin_unauthorized'
}

export class CorruptLocalAdminMetadataError extends Error {
  readonly code = 'local_admin_corrupt'
}

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function equalDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseMetadata(value: unknown): LocalAdminMetadataV1 {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).some((key) => !['version', 'tokenDigest', 'createdAt'].includes(key))
  ) throw new CorruptLocalAdminMetadataError('Local administrator metadata is invalid')
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 || typeof record.tokenDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.tokenDigest) || typeof record.createdAt !== 'string' ||
    Number.isNaN(Date.parse(record.createdAt))
  ) throw new CorruptLocalAdminMetadataError('Local administrator metadata is invalid')
  return record as unknown as LocalAdminMetadataV1
}

export class LocalAdminService {
  private metadata?: LocalAdminMetadataV1
  private queue: Promise<unknown> = Promise.resolve()
  private readonly filePath: string
  private readonly writeJson: (path: string, value: unknown) => Promise<void>
  private readonly createToken: () => string

  private constructor(
    filePath: string,
    writeJson: (path: string, value: unknown) => Promise<void>,
    createToken: () => string,
  ) {
    this.filePath = filePath
    this.writeJson = writeJson
    this.createToken = createToken
  }

  static async open(options: {
    dataDir: string
    writeJson?: (path: string, value: unknown) => Promise<void>
    createToken?: () => string
  }): Promise<LocalAdminService> {
    const service = new LocalAdminService(
      join(options.dataDir, 'local-admin.json'),
      options.writeJson ?? atomicWriteJson,
      options.createToken ?? (() => randomBytes(32).toString('base64url')),
    )
    try {
      service.metadata = parseMetadata(JSON.parse(await readFile(service.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return service
  }

  authorize(token: string): void {
    if (!this.metadata || !token || !equalDigest(this.metadata.tokenDigest, digest(token))) {
      throw new LocalAdminAuthorizationError('Local administrator session is required')
    }
  }

  registerOrResume(
    token = '',
    options: { allowRecovery?: boolean } = {},
  ): Promise<{ created: boolean; token?: string }> {
    return this.serial(async () => {
      if (this.metadata) {
        try {
          this.authorize(token)
          return { created: false }
        } catch (error) {
          if (!options.allowRecovery || !(error instanceof LocalAdminAuthorizationError)) throw error
        }
      }
      const created = !this.metadata
      const nextToken = this.createToken()
      if (Buffer.byteLength(nextToken, 'utf8') < 32) throw new Error('Local administrator token is too short')
      const metadata: LocalAdminMetadataV1 = {
        version: 1,
        tokenDigest: digest(nextToken),
        createdAt: new Date().toISOString(),
      }
      await this.writeJson(this.filePath, metadata)
      this.metadata = metadata
      return { created, token: nextToken }
    })
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.queue.catch(() => undefined).then(operation)
    this.queue = current
    return current
  }
}

export function localAdminTokenFromCookie(header: string | undefined): string {
  if (!header) return ''
  for (const item of header.split(';')) {
    const separator = item.indexOf('=')
    if (separator > 0 && item.slice(0, separator).trim() === LOCAL_ADMIN_COOKIE) {
      return item.slice(separator + 1).trim()
    }
  }
  return ''
}
