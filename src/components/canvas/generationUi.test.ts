import { describe, expect, it } from 'vitest'

import type { CatalogModel } from '../../contracts/generation'
import type { MediaGenerationSettings } from '../../model/project'
import {
  canEditReferencesWithCatalog,
  estimateGenerationCredits,
  findInvalidMentionAliases,
  normalizeSettingsForModel,
  resolveVideoMode,
  validateGenerationUi,
} from './generationUi'

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    mediaType: 'video',
    channel: 27,
    channelTitle: 'AIStartLab Video',
    model: 'grok-video-1',
    title: 'Grok 1.0',
    qualityOptions: [
      {
        value: '720P',
        label: '720P',
        pricing: { type: 'fixed_total', credits: 120 },
      },
    ],
    aspectRatios: ['16:9', '9:16'],
    countOptions: [1],
    durationOptions: [6, 10],
    modes: ['text2video', 'image2video', 'first_last_frame'],
    inputLimits: { images: 3, videos: 0, audios: 0 },
    raw: {},
    ...overrides,
  }
}

describe('generation UI catalog rules', () => {
  it('allows reference editing from a stale cached catalog', () => {
    expect(canEditReferencesWithCatalog({
      providerId: 'aistartlab',
      version: 'cached',
      fetchedAt: '2026-07-20T00:00:00.000Z',
      stale: true,
      models: [model()],
    })).toBe(true)
  })

  it('normalizes persisted settings to options exposed by the selected model', () => {
    const stale: MediaGenerationSettings = {
      kind: 'video',
      providerId: 'aistartlab',
      catalogVersion: 'old',
      channel: 999,
      model: 'removed',
      mode: 'removed-mode',
      resolution: '4K',
      aspectRatio: '1:1',
      durationSec: 5,
      generateAudio: true,
      count: 4,
    }

    expect(
      normalizeSettingsForModel(stale, model(), 'catalog-v2'),
    ).toEqual({
      kind: 'video',
      providerId: 'aistartlab',
      catalogVersion: 'catalog-v2',
      channel: 27,
      model: 'grok-video-1',
      mode: 'text2video',
      resolution: '720P',
      aspectRatio: '16:9',
      durationSec: 6,
      generateAudio: true,
      count: 1,
    })
  })

  it('derives only supported localized video modes from the catalog', () => {
    expect(model().modes.map(resolveVideoMode)).toEqual([
      { value: 'text2video', label: '文生视频', referenceRule: 'none' },
      { value: 'image2video', label: '全能参考', referenceRule: 'at-least-one' },
      { value: 'first_last_frame', label: '首尾帧', referenceRule: 'exactly-two' },
    ])
  })

  it('validates reference counts, limits, and invalid mentions for each mode', () => {
    const settings = normalizeSettingsForModel(
      {
        kind: 'video',
        resolution: '',
        aspectRatio: '',
        durationSec: 0,
        generateAudio: true,
        count: 1,
      },
      model(),
      'catalog-v2',
    )

    expect(
      validateGenerationUi({
        settings: { ...settings, mode: 'text2video' },
        model: model(),
        referenceAliases: [1],
        invalidMentionAliases: [],
      }),
    ).toEqual({ valid: false, message: '文生视频不能添加参考素材' })

    expect(
      validateGenerationUi({
        settings: { ...settings, mode: 'image2video' },
        model: model(),
        referenceAliases: [],
        invalidMentionAliases: [],
      }),
    ).toEqual({ valid: false, message: '全能参考至少需要 1 张图片' })

    expect(
      validateGenerationUi({
        settings: { ...settings, mode: 'first_last_frame' },
        model: model(),
        referenceAliases: [1],
        invalidMentionAliases: [],
      }),
    ).toEqual({ valid: false, message: '首尾帧需要恰好 2 张图片' })

    expect(
      validateGenerationUi({
        settings: { ...settings, mode: 'image2video' },
        model: model({ inputLimits: { images: 1, videos: 0, audios: 0 } }),
        referenceAliases: [1, 2],
        invalidMentionAliases: [3],
      }),
    ).toEqual({ valid: false, message: '当前模型最多支持 1 张图片参考' })

    expect(
      validateGenerationUi({
        settings: { ...settings, mode: 'image2video' },
        model: model({ inputLimits: { images: 2, videos: 0, audios: 0 } }),
        referenceAliases: [1, 2, 3],
        references: [
          { alias: 1, mediaType: 'image' },
          { alias: 2, mediaType: 'video' },
          { alias: 3, mediaType: 'video' },
        ],
        invalidMentionAliases: [],
      }),
    ).toEqual({ valid: false, message: '当前模型不支持视频参考' })
  })

  it('finds unresolved @N tokens and estimates credits from the active quality', () => {
    expect(findInvalidMentionAliases('让 @1 走进 @3，@3 保持光线', [1, 2])).toEqual([3])
    expect(findInvalidMentionAliases('foo@9 保留 @1，拒绝 @0', [1, 9])).toEqual([0])
    expect(
      estimateGenerationCredits(
        model({
          qualityOptions: [
            {
              value: '720P',
              label: '720P',
              pricing: { type: 'fixed_total', credits: 120 },
            },
            {
              value: '1080P',
              label: '1080P',
              pricing: { type: 'fixed_total', credits: 200 },
            },
          ],
          countOptions: [1, 2],
        }),
        {
          kind: 'video',
          resolution: '720P',
          aspectRatio: '16:9',
          durationSec: 6,
          generateAudio: true,
          count: 2,
        },
      ),
    ).toBe(120)
    expect(
      estimateGenerationCredits(
        model({
          qualityOptions: [{
            value: '720P', label: '720P',
            pricing: { type: 'per_second', credits: 20 },
          }],
        }),
        {
          kind: 'video', resolution: '720P', aspectRatio: '16:9',
          durationSec: 6, generateAudio: true, count: 4,
        },
      ),
    ).toBe(120)
  })
})
