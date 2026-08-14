import { describe, expect, it } from 'vitest'
import type { GenerationRequest, ProviderCatalog } from '../src/contracts/generation.ts'
import { CatalogChangedError, GenerationValidationError, validateGenerationRequest } from './generation-validation.ts'

const catalog: ProviderCatalog = {
  providerId: 'aistartlab', version: 'catalog-v1', fetchedAt: new Date().toISOString(), stale: false,
  models: [{
    mediaType: 'video', channel: 13, channelTitle: 'Video', channelLabel: 'Video',
    model: 'seedance', title: 'Seedance', label: 'Seedance',
    qualityOptions: [{
      value: '720P', label: '720P',
      pricing: { type: 'per_second', credits: 30, inputVideoMultiplier: 1.5 },
    }],
    aspectRatios: ['16:9'], countOptions: [], durationOptions: [4, 5, 6],
    durationRange: { min: 4, max: 6, options: [4, 5, 6] },
    modes: ['text2video', 'image2video', 'frames2video'],
    inputLimits: { images: 2, videos: 1, audios: 1 },
    raw: {},
  }],
}

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    clientRequestId: 'client-1', providerId: 'aistartlab', catalogVersion: 'catalog-v1',
    mediaType: 'video', channel: 13, model: 'seedance', prompt: 'move slowly',
    quality: '720P', aspectRatio: '16:9', duration: 5, mode: 'image2video',
    references: [{ alias: 1, assetId: 'asset-1', mediaType: 'image' }],
    ...overrides,
  }
}

describe('validateGenerationRequest', () => {
  it('accepts a request matching the exact current catalog capability', () => {
    expect(validateGenerationRequest(request(), catalog)).toEqual(catalog.models[0])
  })

  it('throws typed catalog_changed for stale or version-mismatched catalogs', () => {
    for (const candidate of [{ ...catalog, stale: true }, catalog]) {
      const input = candidate.stale ? request() : request({ catalogVersion: 'old-version' })
      try {
        validateGenerationRequest(input, candidate)
        throw new Error('expected validation to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(CatalogChangedError)
        expect((error as CatalogChangedError).code).toBe('catalog_changed')
        expect((error as CatalogChangedError).catalogVersion).toBe('catalog-v1')
      }
    }
  })

  it('rejects an expired catalog even when persisted stale=false and version matches', () => {
    expect(() => validateGenerationRequest(request(), catalog, {
      now: () => new Date(Date.parse(catalog.fetchedAt) + 48 * 60 * 60 * 1_000),
    })).toThrow(CatalogChangedError)
  })

  it.each([
    ['provider', { providerId: 'other' }],
    ['channel', { channel: 99 }],
    ['model', { model: 'missing' }],
    ['quality', { quality: '4K' }],
    ['aspect ratio', { aspectRatio: '1:1' }],
    ['duration range', { duration: 7 }],
    ['duration step', { duration: 4.5 }],
    ['mode', { mode: 'unsupported' }],
  ])('rejects an invalid %s', (_label, overrides) => {
    expect(() => validateGenerationRequest(request(overrides), catalog)).toThrow(GenerationValidationError)
  })

  it('enforces reference limits and mode-specific reference counts', () => {
    expect(() => validateGenerationRequest(request({ mode: 'text2video' }), catalog)).toThrow('does not accept references')
    expect(() => validateGenerationRequest(request({ mode: 'image2video', references: [] }), catalog)).toThrow('requires at least one image')
    expect(() => validateGenerationRequest(request({
      mode: 'frames2video',
      references: [{ alias: 1, assetId: 'a', mediaType: 'image' }],
    }), catalog)).toThrow('exactly two images')
    expect(() => validateGenerationRequest(request({
      references: [
        { alias: 1, assetId: 'a', mediaType: 'image' },
        { alias: 2, assetId: 'b', mediaType: 'image' },
        { alias: 3, assetId: 'c', mediaType: 'image' },
      ],
    }), catalog)).toThrow('image reference limit')
  })

  it.each([
    'ftp://public.example/reference.png',
    'https://user:password@public.example/reference.png',
    'not-a-url',
  ])('rejects a non-public HTTP(S) reference URL: %s', (url) => {
    expect(() => validateGenerationRequest(request({
      references: [{ alias: 1, url, mediaType: 'image' }],
    }), catalog)).toThrow('public HTTP(S)')
  })
})
