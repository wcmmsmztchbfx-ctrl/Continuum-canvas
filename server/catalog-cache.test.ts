import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderCatalog } from '../src/contracts/generation.ts'
import { CatalogCache } from './catalog-cache.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'libtv-catalog-'))
}

const catalog: ProviderCatalog = {
  providerId: 'aistartlab',
  version: 'catalog-v1',
  fetchedAt: new Date().toISOString(),
  stale: false,
  models: [],
}

describe('CatalogCache', () => {
  it('persists the last successful catalog and marks fallback data stale', async () => {
    const dataDir = await tempDirectory()
    const cache = await CatalogCache.open({ dataDir })
    expect(await cache.sync('aistartlab', async () => catalog)).toEqual(catalog)

    const reopened = await CatalogCache.open({ dataDir })
    const fallback = await reopened.sync('aistartlab', async () => { throw new TypeError('offline') })

    expect(fallback).toEqual({ ...catalog, stale: true })
  })

  it('does not invent a catalog when no successful cache exists', async () => {
    const cache = await CatalogCache.open({ dataDir: await tempDirectory() })
    await expect(cache.sync('missing', async () => { throw new TypeError('offline') }))
      .rejects.toThrow('catalog is unavailable')
  })

  it('keeps the true old cache in memory when persisting a replacement fails', async () => {
    const dataDir = await tempDirectory()
    const initial = await CatalogCache.open({ dataDir })
    await initial.sync('aistartlab', async () => catalog)
    const writeJson = vi.fn().mockRejectedValue(new Error('disk full'))
    const cache = await CatalogCache.open({ dataDir, writeJson } as never)
    const replacement = { ...catalog, version: 'catalog-v2', fetchedAt: new Date().toISOString() }

    const fallback = await cache.sync('aistartlab', async () => replacement)

    expect(fallback).toEqual({ ...catalog, stale: true })
    expect(cache.get('aistartlab')).toEqual(catalog)
    expect(writeJson).toHaveBeenCalledTimes(1)
  })

  it('errors when the first successful load cannot be persisted', async () => {
    const cache = await CatalogCache.open({
      dataDir: await tempDirectory(),
      writeJson: vi.fn().mockRejectedValue(new Error('disk full')),
    } as never)

    await expect(cache.sync('aistartlab', async () => catalog)).rejects.toThrow('catalog is unavailable')
    expect(cache.get('aistartlab')).toBeUndefined()
  })

  it('derives stale from fetchedAt on disk with an injectable clock', async () => {
    const dataDir = await tempDirectory()
    await writeFile(join(dataDir, 'catalog-cache.json'), JSON.stringify({ aistartlab: catalog }))
    const now = () => new Date(Date.parse(catalog.fetchedAt) + 48 * 60 * 60 * 1_000)
    const cache = await CatalogCache.open({ dataDir, now })

    expect(cache.get('aistartlab')).toEqual({ ...catalog, stale: true })
  })

  it('rejects malformed disk catalogs instead of trusting stale=false', async () => {
    const dataDir = await tempDirectory()
    await writeFile(join(dataDir, 'catalog-cache.json'), JSON.stringify({
      aistartlab: { ...catalog, fetchedAt: 'not-a-date' },
      missingDate: { ...catalog, providerId: 'missingDate', fetchedAt: undefined },
    }))
    const cache = await CatalogCache.open({ dataDir })

    expect(cache.get('aistartlab')).toBeUndefined()
    expect(cache.get('missingDate')).toBeUndefined()
  })
})
