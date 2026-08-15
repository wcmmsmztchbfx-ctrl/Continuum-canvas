import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ProviderCatalog } from '../src/contracts/generation.ts'
import { estimateCredits, mapAIStartLabCatalog, mapOpenAICompatibleCatalog } from './catalog.ts'

let fixture: unknown

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  fixture = JSON.parse(await readFile(join(here, 'fixtures', 'aistartlab-generation-config.json'), 'utf8'))
})

describe('AIStartLab catalog mapping', () => {
  it('maps the real imageConfig/videoConfig channel shape without inventing capabilities', () => {
    const catalog = mapAIStartLabCatalog('aistartlab', fixture, '2026-07-16T00:00:00.000Z')

    expect(catalog.models).toHaveLength(2)
    expect(catalog.models[0]).toEqual(expect.objectContaining({
      mediaType: 'image',
      channel: 46,
      channelTitle: 'Image Channel',
      channelDescription: 'Sanitized captured image channel',
      channelDefaultOption: { model: 'captured-image-model', quality: '1K' },
      model: 'captured-image-model',
      title: 'Captured Image Model',
      label: 'Captured Image Model',
      qualityOptions: [
        { value: '1K', label: '1K', pricing: { type: 'fixed_total', credits: 6 } },
      ],
      aspectRatios: ['1:1', '16:9'],
      countRange: { min: 1, max: 4, options: null },
      countOptions: [1, 2, 3, 4],
      inputLimits: { images: 6, videos: 0, audios: 0 },
    }))
    expect(catalog.models[1]).toEqual(expect.objectContaining({
      mediaType: 'video',
      channel: 13,
      channelDescription: 'Sanitized captured video channel',
      channelDefaultOption: { model: 'captured-video-model', quality: '720p' },
      model: 'captured-video-model',
      qualityOptions: [{
        value: '720p', label: '720p',
        pricing: { type: 'fixed_total', credits: 350, inputVideoMultiplier: 1.5 },
      }],
      durationRange: { min: null, max: null, options: [6, 10] },
      durationOptions: [6, 10],
      modes: ['text2video', 'image2video'],
      inputLimits: { images: 9, videos: 3, audios: 3 },
    }))
  })

  it('preserves the captured first-model prices and input-video multiplier', () => {
    const catalog = mapAIStartLabCatalog('aistartlab', fixture, '2026-07-16T00:00:00.000Z')
    expect(estimateCredits(catalog.models[0], { quality: '1K', n: 1 })).toBe(6)
    expect(estimateCredits(catalog.models[0], { quality: '1K', n: 4 })).toBe(6)
    expect(estimateCredits(catalog.models[1], { quality: '720p', duration: 6, inputVideos: 0 })).toBe(350)
    expect(estimateCredits(catalog.models[1], { quality: '720p', duration: 6, inputVideos: 1 })).toBe(525)
    expect(catalog.models[1].qualityOptions[0].pricing.inputVideoMultiplier).toBe(1.5)
  })

  it('rejects a config response that yields no compatible models', () => {
    expect(() => mapAIStartLabCatalog('aistartlab', { data: { imageConfig: [], videoConfig: [] } }, 'now'))
      .toThrow('no compatible models')
  })

  it('produces a deterministic catalog version from capability data', () => {
    const first = mapAIStartLabCatalog('aistartlab', fixture, '2026-07-16T00:00:00.000Z')
    const second = mapAIStartLabCatalog('aistartlab', fixture, '2026-07-16T01:00:00.000Z')
    expect((first as ProviderCatalog).version).toMatch(/^[a-f0-9]{64}$/)
    expect(second.version).toBe(first.version)
  })
})

describe('mapOpenAICompatibleCatalog', () => {
  const payload = {
    data: [
      { id: 'gpt-image-1', owned_by: 'openai' },
      { id: 'kling-video-1.6', owned_by: 'kuaishou' },
    ],
  }

  it('maps image and video models with conservative capability defaults', () => {
    const catalog = mapOpenAICompatibleCatalog('openai', payload, '2026-07-16T00:00:00.000Z')
    expect(catalog.providerId).toBe('openai')
    expect(catalog.models).toHaveLength(2)

    const imageModel = catalog.models[0]
    expect(imageModel.mediaType).toBe('image')
    expect(imageModel.channel).toBe('image')
    expect(imageModel.model).toBe('gpt-image-1')
    expect(imageModel.qualityOptions).toEqual([
      { value: 'standard', label: '标准', pricing: { type: 'fixed_total', credits: 1 } },
    ])
    expect(imageModel.aspectRatios).toEqual(['Auto', '1:1', '16:9', '9:16'])
    expect(imageModel.countOptions).toEqual([1])
    expect(imageModel.durationOptions).toEqual([1])
    expect(imageModel.modes).toEqual(['text2image', 'image2image'])
    expect(imageModel.inputLimits).toEqual({ images: 4, videos: 0, audios: 0 })

    const videoModel = catalog.models[1]
    expect(videoModel.mediaType).toBe('video')
    expect(videoModel.channel).toBe('video')
    expect(videoModel.model).toBe('kling-video-1.6')
    expect(videoModel.qualityOptions).toEqual([
      { value: 'standard', label: '标准', pricing: { type: 'fixed_total', credits: 5 } },
    ])
    expect(videoModel.aspectRatios).toEqual(['16:9', '9:16', '1:1', 'Auto'])
    expect(videoModel.countOptions).toEqual([1])
    expect(videoModel.durationOptions).toEqual([5, 10])
    expect(videoModel.modes).toEqual(['text2video', 'image2video'])
    expect(videoModel.inputLimits).toEqual({ images: 2, videos: 1, audios: 1 })
  })

  it('falls back to default models for a payload with no compatible models', () => {
    const catalog = mapOpenAICompatibleCatalog('openai', { data: [{ id: 'text-embedding-3-small' }] }, 'now')
    expect(catalog.models.length).toBeGreaterThan(0)
    expect(catalog.models.some((m) => m.mediaType === 'image')).toBe(true)
    expect(catalog.models.some((m) => m.mediaType === 'video')).toBe(true)
  })

  it('produces a deterministic version independent of fetchedAt', () => {
    const first = mapOpenAICompatibleCatalog('openai', payload, '2026-07-16T00:00:00.000Z')
    const second = mapOpenAICompatibleCatalog('openai', payload, '2026-07-16T01:00:00.000Z')
    expect(first.version).toMatch(/^[a-f0-9]{64}$/)
    expect(second.version).toBe(first.version)
  })
})
