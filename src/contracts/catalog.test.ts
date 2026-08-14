import { describe, expect, it } from 'vitest'

import type { CatalogModel, ProviderCatalog } from './generation'
import {
  CATALOG_TTL_MS,
  estimateCatalogCredits,
  isProviderCatalog,
  isProviderCatalogFresh,
  selectCatalogModel,
} from './catalog'

const model: CatalogModel = {
  mediaType: 'video',
  channel: 13,
  model: 'same-name',
  qualityOptions: [{
    value: '720P',
    label: '720P',
    pricing: { type: 'per_second', credits: 20 },
  }],
  aspectRatios: ['16:9'],
  countOptions: [1],
  durationOptions: [6],
  modes: ['image2video'],
  inputLimits: { images: 2, videos: 0, audios: 0 },
  raw: {},
}

const catalog: ProviderCatalog = {
  providerId: 'aistartlab',
  version: 'catalog-v1',
  fetchedAt: '2026-07-17T00:00:00.000Z',
  stale: false,
  models: [model],
}

describe('shared catalog contract', () => {
  it('calculates all documented pricing types exactly', () => {
    expect(estimateCatalogCredits(
      { type: 'per_second', credits: 20 },
      { duration: 6, count: 4, inputVideos: 0 },
    )).toBe(120)
    expect(estimateCatalogCredits(
      { type: 'fixed_total', credits: 5 },
      { duration: 6, count: 4, inputVideos: 0 },
    )).toBe(5)
    expect(estimateCatalogCredits(
      { type: 'per_item', credits: 5, inputVideoMultiplier: 1.5 },
      { count: 4, inputVideos: 1 },
    )).toBe(30)
  })

  it('rejects malformed or negative pricing inputs', () => {
    expect(estimateCatalogCredits(
      { type: 'per_second', credits: 20 },
      { duration: Number.NaN, count: 1, inputVideos: 0 },
    )).toBeUndefined()
    expect(isProviderCatalog({
      ...catalog,
      models: [{
        ...model,
        qualityOptions: [{ value: '720P', label: '720P', pricing: { type: 'fixed', credits: 5 } }],
      }],
    })).toBe(false)
    expect(isProviderCatalog({
      ...catalog,
      models: [{
        ...model,
        qualityOptions: [{ value: '720P', label: '720P', pricing: { type: 'fixed_total', credits: -1 } }],
      }],
    })).toBe(false)
  })

  it('derives freshness from fetchedAt and rejects invalid dates', () => {
    const fetchedAt = Date.parse(catalog.fetchedAt)
    expect(isProviderCatalogFresh(catalog, fetchedAt + CATALOG_TTL_MS - 1)).toBe(true)
    expect(isProviderCatalogFresh(catalog, fetchedAt + CATALOG_TTL_MS)).toBe(false)
    expect(isProviderCatalog({ ...catalog, fetchedAt: 'not-a-date' })).toBe(false)
  })

  it('selects a model by provider, channel, and model together', () => {
    expect(selectCatalogModel(catalog, {
      providerId: 'aistartlab', channel: 13, model: 'same-name', mediaType: 'video',
    })).toBe(model)
    expect(selectCatalogModel(catalog, {
      providerId: 'other', channel: 13, model: 'same-name', mediaType: 'video',
    })).toBeUndefined()
    expect(selectCatalogModel(catalog, {
      providerId: 'aistartlab', channel: 99, model: 'same-name', mediaType: 'video',
    })).toBeUndefined()
  })
})
