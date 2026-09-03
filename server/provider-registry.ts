import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderMetadata } from '../src/contracts/generation.ts'
import {
  GENERATION_ADAPTER_TYPES,
  IMAGE_REQUEST_MODES,
  OFFICIAL_AISTARTLAB_BASE_URL,
  type ImageRequestMode,
} from '../src/contracts/catalog.ts'
import { atomicUpdateText, atomicWriteJson } from './atomic-json.ts'

export interface ProviderRecord {
  id: string
  name: string
  adapterType: string
  baseUrl: string
  enabled: boolean
  preferred: boolean
  lastSyncedAt?: string
  imageRequestMode?: ImageRequestMode
}

const PRESETS: ProviderRecord[] = [
  {
    id: 'aistartlab',
    name: 'AIStartLab',
    adapterType: 'aistartlab-openapi',
    baseUrl: OFFICIAL_AISTARTLAB_BASE_URL,
    enabled: true,
    preferred: true,
  },
  {
    id: 'openai',
    name: 'OpenAI 官方',
    adapterType: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    enabled: false,
    preferred: false,
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    adapterType: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    enabled: false,
    preferred: false,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    adapterType: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    enabled: false,
    preferred: false,
  },
]

const SUPPORTED_ADAPTERS = GENERATION_ADAPTER_TYPES
const PROVIDER_FIELDS = new Set(['id', 'name', 'adapterType', 'baseUrl', 'enabled', 'preferred', 'lastSyncedAt', 'imageRequestMode'])

function deriveSecretEnvName(id: string): string {
  return `API_PROVIDER_${id.replaceAll('-', '_').toUpperCase()}_KEY`
}

function parseProviderRecord(value: unknown, rejectUnknown: boolean): ProviderRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !PROVIDER_FIELDS.has(key))
  if (unknown && rejectUnknown) throw new Error(`unknown provider field: ${unknown}`)
  if (typeof record.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(record.id)) return undefined
  if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 80) return undefined
  if (typeof record.adapterType !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(record.adapterType)) return undefined
  if (typeof record.baseUrl !== 'string' || typeof record.enabled !== 'boolean' || typeof record.preferred !== 'boolean') return undefined
  let parsedUrl: URL
  try {
    parsedUrl = new URL(record.baseUrl)
  } catch {
    return undefined
  }
  const isLocalHttp = parsedUrl.protocol === 'http:' && (
    parsedUrl.hostname === '127.0.0.1' ||
    parsedUrl.hostname === 'localhost' ||
    parsedUrl.hostname.startsWith('192.168.') ||
    parsedUrl.hostname.startsWith('10.')
  )
  if ((parsedUrl.protocol !== 'https:' && !isLocalHttp) || parsedUrl.username || parsedUrl.password) return undefined
  const normalizedBaseUrl = parsedUrl.href.replace(/\/$/, '')
  if (
    record.adapterType === 'aistartlab-openapi' &&
    normalizedBaseUrl !== OFFICIAL_AISTARTLAB_BASE_URL
  ) {
    if (rejectUnknown) throw new Error('AIStartLab OpenAPI must use the official AIStartLab endpoint')
    return undefined
  }
  if (record.lastSyncedAt !== undefined && typeof record.lastSyncedAt !== 'string') return undefined
  if (
    record.imageRequestMode !== undefined &&
    !IMAGE_REQUEST_MODES.includes(record.imageRequestMode as ImageRequestMode)
  ) {
    return undefined
  }
  return {
    id: record.id,
    name: record.name.trim(),
    adapterType: record.adapterType,
    baseUrl: normalizedBaseUrl,
    enabled: record.enabled,
    preferred: record.preferred,
    ...(typeof record.lastSyncedAt === 'string' ? { lastSyncedAt: record.lastSyncedAt } : {}),
    ...(typeof record.imageRequestMode === 'string'
      ? { imageRequestMode: record.imageRequestMode as ImageRequestMode }
      : {}),
  }
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return '*'.repeat(secret.length)
  return `${secret.slice(0, 3)}${'*'.repeat(Math.min(8, secret.length - 7))}${secret.slice(-4)}`
}

export class ProviderRegistry {
  private readonly filePath: string
  private readonly env: Record<string, string | undefined>
  private records: ProviderRecord[]
  private readonly envFile?: string
  private readonly secretFile?: string
  private secrets: Record<string, string>

  private constructor(
    filePath: string,
    env: Record<string, string | undefined>,
    records: ProviderRecord[],
    envFile?: string,
    secretFile?: string,
    secrets: Record<string, string> = {},
  ) {
    this.filePath = filePath
    this.env = env
    this.records = records
    this.envFile = envFile
    this.secretFile = secretFile
    this.secrets = secrets
  }

  static async open(options: {
    dataDir: string
    env?: Record<string, string | undefined>
    envFile?: string
    /**
     * Optional sidecar for canvas-scoped secrets. When present, secrets are
     * deliberately kept out of the process-wide environment file so each
     * canvas can carry an independent provider configuration.
     */
    secretFile?: string
    seed?: {
      records: ProviderRecord[]
      secrets?: Record<string, string>
    }
  }) {
    await mkdir(options.dataDir, { recursive: true })
    const filePath = join(options.dataDir, 'providers.json')
    let records: ProviderRecord[]
    let fileExists = true
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'))
      records = Array.isArray(parsed)
        ? parsed.flatMap((candidate) => {
            const record = parseProviderRecord(candidate, false)
            return record ? [record] : []
          })
        : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      records = []
      fileExists = false
    }
    if (!fileExists && records.length === 0) {
      const seeded = options.seed?.records ?? PRESETS
      for (const preset of seeded) records.push({ ...preset })
    }
    let secrets: Record<string, string> = {}
    if (options.secretFile) {
      let secretFileExists = true
      try {
        const parsed: unknown = JSON.parse(await readFile(options.secretFile, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          secrets = Object.fromEntries(Object.entries(parsed).filter(([id, value]) =>
            /^[a-z][a-z0-9-]{0,47}$/.test(id) && typeof value === 'string' && value.length > 0,
          ))
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') secretFileExists = false
        else throw error
      }
      if (!secretFileExists && options.seed?.secrets) {
        secrets = Object.fromEntries(Object.entries(options.seed.secrets).filter(([id, value]) =>
          /^[a-z][a-z0-9-]{0,47}$/.test(id) && typeof value === 'string' && value.length > 0,
        ))
      }
    }
    const registry = new ProviderRegistry(
      filePath,
      options.env ?? process.env,
      records,
      options.envFile,
      options.secretFile,
      secrets,
    )
    await registry.persist()
    if (options.secretFile) await registry.persistSecrets()
    return registry
  }

  listPublic(): ProviderMetadata[] {
    return this.records.map((record) => this.toPublic(record))
  }

  /** A sanitized internal seed used when a new canvas scope is created. */
  listRecords(): ProviderRecord[] {
    return this.records.map((record) => ({ ...record }))
  }

  /** Returns configured secrets for internal scope seeding; callers never expose this map. */
  listSecrets(): Record<string, string> {
    return Object.fromEntries(this.records.flatMap((record) => {
      const secret = this.getSecret(record.id)
      return secret ? [[record.id, secret]] : []
    }))
  }

  getPublic(id: string): ProviderMetadata | undefined {
    const record = this.records.find((candidate) => candidate.id === id)
    return record ? this.toPublic(record) : undefined
  }

  getSecret(id: string): string | undefined {
    const record = this.records.find((candidate) => candidate.id === id)
    return record && SUPPORTED_ADAPTERS.has(record.adapterType)
      ? (this.secretFile ? this.secrets[record.id] : this.env[deriveSecretEnvName(record.id)])
      : undefined
  }

  async upsert(input: ProviderRecord): Promise<void> {
    const record = parseProviderRecord(input, true)
    if (!record) throw new Error('Invalid provider record')
    if (record.preferred) {
      this.records = this.records.map((candidate) => ({ ...candidate, preferred: false }))
    }
    const index = this.records.findIndex((candidate) => candidate.id === record.id)
    if (index === -1) this.records.push({ ...record })
    else this.records[index] = { ...record }
    await this.persist()
  }

  async delete(id: string): Promise<boolean> {
    const index = this.records.findIndex((candidate) => candidate.id === id)
    if (index === -1) return false
    const [removed] = this.records.splice(index, 1)
    if (removed) {
      const secretEnvName = deriveSecretEnvName(removed.id)
      if (this.secretFile) {
        delete this.secrets[removed.id]
        await this.persistSecrets()
      } else {
        delete this.env[secretEnvName]
        await this.persistEnvSecret(secretEnvName)
      }
      if (removed.preferred && this.records.length > 0) {
        this.records[0]!.preferred = true
      }
    }
    await this.persist()
    return true
  }

  async setSecret(id: string, secret: string): Promise<void> {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record) throw new Error('Provider not found')
    if (!SUPPORTED_ADAPTERS.has(record.adapterType)) {
      throw new Error('Unsupported provider adapter does not accept API keys')
    }
    const normalized = secret.trim()
    if (!normalized) throw new Error('Provider secret cannot be empty')
    const secretEnvName = deriveSecretEnvName(record.id)
    if (this.secretFile) {
      this.secrets[record.id] = normalized
      await this.persistSecrets()
    } else {
      this.env[secretEnvName] = normalized
      await this.persistEnvSecret(secretEnvName, normalized)
    }
  }

  async deleteSecret(id: string): Promise<void> {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record) throw new Error('Provider not found')
    const secretEnvName = deriveSecretEnvName(record.id)
    if (this.secretFile) {
      delete this.secrets[record.id]
      await this.persistSecrets()
    } else {
      delete this.env[secretEnvName]
      await this.persistEnvSecret(secretEnvName)
    }
  }

  private toPublic(record: ProviderRecord): ProviderMetadata {
    const secretEnvName = deriveSecretEnvName(record.id)
    const supported = SUPPORTED_ADAPTERS.has(record.adapterType)
    const secret = supported
      ? (this.secretFile ? this.secrets[record.id] : this.env[secretEnvName])
      : undefined
    const secretConfigured = typeof secret === 'string' && secret.length > 0
    return {
      id: record.id,
      name: record.name,
      adapterType: record.adapterType,
      baseUrl: record.baseUrl,
      enabled: record.enabled,
      preferred: record.preferred,
      secretEnvName,
      secretConfigured,
      maskedSecret: secretConfigured ? maskSecret(secret) : undefined,
      available: record.enabled && supported && secretConfigured,
      ...(record.lastSyncedAt ? { lastSyncedAt: record.lastSyncedAt } : {}),
      imageRequestMode: record.imageRequestMode ?? 'auto',
    }
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.filePath, this.records)
  }

  private async persistEnvSecret(name: string, value?: string): Promise<void> {
    if (!this.envFile) return
    await atomicUpdateText(this.envFile, (source) => {
      const newline = source.includes('\r\n') ? '\r\n' : '\n'
      const assignment = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`)
      const lines = source.split(/\r?\n/)
      while (lines.at(-1) === '') lines.pop()
      const updated = lines.filter((line) => !assignment.test(line))
      if (value !== undefined) updated.push(`${name}=${JSON.stringify(value)}`)
      return updated.length > 0 ? `${updated.join(newline)}${newline}` : ''
    })
  }

  private async persistSecrets(): Promise<void> {
    if (!this.secretFile) return
    await atomicWriteJson(this.secretFile, this.secrets)
  }
}
