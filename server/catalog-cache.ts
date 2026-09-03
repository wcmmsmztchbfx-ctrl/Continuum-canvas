import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderCatalog } from '../src/contracts/generation.ts'
import {
  CATALOG_TTL_MS,
  deriveCatalogStale,
  isProviderCatalog,
  isProviderCatalogFresh,
} from '../src/contracts/catalog.ts'
import { atomicWriteJson } from './atomic-json.ts'

export class CatalogCache {
  private readonly filePath: string
  private readonly writeJson: typeof atomicWriteJson
  private catalogs: Record<string, ProviderCatalog>
  private readonly now: () => Date
  private readonly ttlMs: number

  private constructor(
    filePath: string,
    catalogs: Record<string, ProviderCatalog>,
    writeJson: typeof atomicWriteJson,
    now: () => Date,
    ttlMs: number,
  ) {
    this.filePath = filePath
    this.catalogs = catalogs
    this.writeJson = writeJson
    this.now = now
    this.ttlMs = ttlMs
  }

  static async open(options: {
    dataDir: string
    writeJson?: typeof atomicWriteJson
    now?: () => Date
    ttlMs?: number
    seed?: Record<string, ProviderCatalog>
  }) {
    await mkdir(options.dataDir, { recursive: true })
    const filePath = join(options.dataDir, 'catalog-cache.json')
    let catalogs: Record<string, ProviderCatalog> = {}
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        catalogs = Object.fromEntries(Object.entries(parsed).flatMap(([providerId, candidate]) =>
          isProviderCatalog(candidate) && candidate.providerId === providerId
            ? [[providerId, structuredClone(candidate)]]
            : [],
        ))
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (Object.keys(catalogs).length === 0 && options.seed) {
      catalogs = Object.fromEntries(Object.entries(options.seed).flatMap(([providerId, candidate]) =>
        isProviderCatalog(candidate) && candidate.providerId === providerId
          ? [[providerId, structuredClone(candidate)]]
          : [],
      ))
    }
    return new CatalogCache(
      filePath,
      catalogs,
      options.writeJson ?? atomicWriteJson,
      options.now ?? (() => new Date()),
      options.ttlMs ?? CATALOG_TTL_MS,
    )
  }

  get(providerId: string): ProviderCatalog | undefined {
    const catalog = this.catalogs[providerId]
    return catalog
      ? deriveCatalogStale(catalog, this.now().getTime(), this.ttlMs)
      : undefined
  }

  /** Snapshot used to seed a newly isolated canvas scope. */
  snapshot(): Record<string, ProviderCatalog> {
    return structuredClone(this.catalogs)
  }

  async delete(providerId: string): Promise<void> {
    if (!(providerId in this.catalogs)) return
    const next = { ...this.catalogs }
    delete next[providerId]
    this.catalogs = next
    await this.persist(next)
  }

  async sync(providerId: string, loader: () => Promise<ProviderCatalog>): Promise<ProviderCatalog> {
    const cached = this.catalogs[providerId]
    let catalog: ProviderCatalog
    try {
      const loaded = { ...await loader(), providerId, stale: false }
      if (!isProviderCatalog(loaded) || !isProviderCatalogFresh(
        loaded,
        this.now().getTime(),
        this.ttlMs,
      )) {
        throw new Error('Provider returned an invalid or expired catalog')
      }
      catalog = loaded
    } catch (error) {
      if (!cached) throw new Error('Provider catalog is unavailable', { cause: error })
      return { ...structuredClone(cached), stale: true }
    }
    const next = { ...this.catalogs, [providerId]: structuredClone(catalog) }
    try {
      await this.persist(next)
    } catch {
      if (!cached) throw new Error('Provider catalog is unavailable')
      return { ...structuredClone(cached), stale: true }
    }
    this.catalogs = next
    return catalog
  }

  private async persist(catalogs: Record<string, ProviderCatalog>): Promise<void> {
    await this.writeJson(this.filePath, catalogs)
  }
}
