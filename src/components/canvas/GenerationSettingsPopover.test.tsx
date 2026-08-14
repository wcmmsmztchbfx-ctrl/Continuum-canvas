// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ProviderCatalog,
  ProviderMetadata,
} from '../../contracts/generation'
import {
  ProviderCatalogProvider,
  type ProviderGateway,
} from '../providers/ProviderCatalogContext'
import { NodeGeneratorPanel } from './NodeGeneratorPanel'

afterEach(cleanup)

const provider: ProviderMetadata = {
  id: 'aistartlab',
  name: 'AIStartLab',
  adapterType: 'aistartlab-openapi',
  baseUrl: 'https://api.video.aistarslab.com/openapi',
  enabled: true,
  preferred: true,
  secretEnvName: 'API_PROVIDER_AISTARTLAB_KEY',
  secretConfigured: true,
  maskedSecret: 'sk-********1234',
  available: true,
  lastSyncedAt: new Date().toISOString(),
}

const catalog: ProviderCatalog = {
  providerId: provider.id,
  version: 'catalog-settings-v1',
  fetchedAt: provider.lastSyncedAt!,
  stale: false,
  models: [
    {
      mediaType: 'image',
      channel: 46,
      channelTitle: '图片生成',
      model: 'image-primary',
      title: 'Image Primary',
      qualityOptions: [
        { value: '1K', label: '1K', pricing: { type: 'fixed_total', credits: 5 } },
        { value: '4K', label: '4K', pricing: { type: 'fixed_total', credits: 20 } },
      ],
      aspectRatios: ['16:9', '4:3'],
      countOptions: [1, 4],
      durationOptions: [],
      modes: ['text2image', 'image2image'],
      inputLimits: { images: 2, videos: 0, audios: 0 },
      raw: {},
    },
    {
      mediaType: 'video',
      channel: 27,
      channelTitle: '视频生成',
      model: 'video-primary',
      title: 'Video Primary',
      qualityOptions: [
        { value: '720P', label: '720P', pricing: { type: 'fixed_total', credits: 80 } },
        { value: '1080P', label: '1080P', pricing: { type: 'fixed_total', credits: 120 } },
      ],
      aspectRatios: ['16:9', '21:9'],
      countOptions: [1, 4],
      durationOptions: [6, 12],
      modes: ['text2video', 'image2video', 'first_last_frame'],
      inputLimits: { images: 3, videos: 0, audios: 2 },
      raw: { supportsAudio: false, generateAudio: false },
    },
    {
      mediaType: 'video',
      channel: 28,
      channelTitle: '备用视频线路',
      model: 'video-secondary',
      title: 'Video Secondary',
      qualityOptions: [
        { value: '720P', label: '720P', pricing: { type: 'fixed_total', credits: 90 } },
      ],
      aspectRatios: ['16:9'],
      countOptions: [1],
      durationOptions: [6],
      modes: ['text2video'],
      inputLimits: { images: 0, videos: 0, audios: 0 },
      raw: {},
    },
  ],
}

function gateway(): ProviderGateway {
  return {
    listProviders: vi.fn().mockResolvedValue([provider]),
    getCatalog: vi.fn().mockResolvedValue(catalog),
    syncProvider: vi.fn().mockResolvedValue(catalog),
    testProvider: vi.fn().mockResolvedValue(provider),
    updateProvider: vi.fn().mockResolvedValue(provider),
    setProviderSecret: vi.fn().mockResolvedValue(provider),
    clearProviderSecret: vi.fn().mockResolvedValue(provider),
  }
}

function withProvider(panel: React.ReactElement, providerGateway = gateway()) {
  return (
    <ProviderCatalogProvider gateway={providerGateway}>
      {panel}
    </ProviderCatalogProvider>
  )
}

describe('dynamic generation detail settings', () => {
  it('disables an active source and exposes idempotent recovery without hiding the error', async () => {
    const user = userEvent.setup()
    const onGenerate = vi.fn()
    const onRetry = vi.fn()
    const providerGateway = gateway()
    const panel = (error?: { code: string; message: string }) =>
      withProvider(
        <NodeGeneratorPanel
          error={error}
          generation={{ prompt: '保持同一请求', status: 'generating' }}
          kind="image"
          nodeId="image-pending"
          onGenerate={onGenerate}
          onRetry={onRetry}
          pending
        />,
        providerGateway,
      )
    const view = render(panel())

    await screen.findByText('Image Primary')
    expect(screen.getByText('生成中')).toBeVisible()
    expect(screen.getByRole('button', { name: '生成提交中' })).toBeDisabled()

    view.rerender(
      panel({ code: 'manual_recovery_required', message: '请求结果未知，请手动恢复' }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('请求结果未知，请手动恢复')
    const retry = screen.getByRole('button', { name: '恢复生成' })
    expect(retry).toBeEnabled()
    await user.click(retry)
    expect(onRetry).toHaveBeenCalledWith('image-pending', '保持同一请求')
    expect(onGenerate).not.toHaveBeenCalled()

    view.rerender(
      panel({
        code: 'REFERENCE_STAGING_FAILED',
        message: '参考素材上传失败，可以安全恢复',
      }),
    )
    const stagingRetry = screen.getByRole('button', { name: '恢复生成' })
    expect(stagingRetry).toBeEnabled()
    await user.click(stagingRetry)
    expect(onRetry).toHaveBeenCalledTimes(2)

    view.rerender(
      panel({ code: 'poll_unavailable', message: '本地网关暂不可达，任务可恢复' }),
    )
    expect(screen.getByRole('button', { name: '恢复生成' })).toBeEnabled()

    view.rerender(
      panel({ code: 'network_error', message: '旧版网络错误，任务可恢复' }),
    )
    const legacyRetry = screen.getByRole('button', { name: '恢复生成' })
    expect(legacyRetry).toBeEnabled()
    await user.click(legacyRetry)
    expect(onRetry).toHaveBeenCalledTimes(3)
    expect(onGenerate).not.toHaveBeenCalled()

    view.rerender(
      panel({ code: 'local_persistence_failed', message: '本地保存失败，任务可恢复' }),
    )
    const persistenceRetry = screen.getByRole('button', { name: '恢复生成' })
    expect(persistenceRetry).toBeEnabled()
    await user.click(persistenceRetry)
    expect(onRetry).toHaveBeenCalledTimes(4)
    expect(onGenerate).not.toHaveBeenCalled()
  })

  it('loads model and supported video modes strictly from the catalog', async () => {
    const user = userEvent.setup()
    const onGenerate = vi.fn()
    render(
      withProvider(
        <NodeGeneratorPanel
          kind="video"
          nodeId="video-menu"
          onGenerate={onGenerate}
        />,
      ),
    )

    await screen.findByText('Video Primary')
    await user.click(screen.getByRole('button', { name: '选择视频模型' }))
    const modelMenu = screen.getByRole('menu', { name: '视频模型' })
    expect(within(modelMenu).getByRole('menuitem', { name: /Video Primary/ })).toBeVisible()
    expect(within(modelMenu).getByRole('menuitem', { name: /Video Secondary/ })).toBeVisible()
    await user.click(within(modelMenu).getByRole('menuitem', { name: /Video Secondary/ }))
    expect(screen.getByRole('button', { name: '选择视频模型' })).toHaveTextContent('Video Secondary')

    await user.click(screen.getByRole('button', { name: '视频生成模式：文生视频' }))
    const modeMenu = screen.getByRole('menu', { name: '视频生成模式' })
    expect(within(modeMenu).getAllByRole('menuitem')).toHaveLength(1)
    expect(within(modeMenu).getByRole('menuitem', { name: '文生视频' })).toBeVisible()
    expect(onGenerate).not.toHaveBeenCalled()
  })

  it('uses only catalog image quality, ratio, and count options', async () => {
    const user = userEvent.setup()
    const onSettingsChange = vi.fn()
    render(
      withProvider(
        <NodeGeneratorPanel
          kind="image"
          nodeId="image-1"
          onSettingsChange={onSettingsChange}
        />,
      ),
    )

    const details = await screen.findByRole('button', {
      name: '生成详情：16:9 · 1K · 1张',
    })
    await user.click(details)
    const dialog = screen.getByRole('dialog', { name: '图片生成设置' })
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog).toHaveStyle({ position: 'fixed' })
    expect(within(dialog).getByText('清晰度')).toBeVisible()
    expect(dialog.querySelectorAll('button[data-ratio]')).toHaveLength(2)

    await user.click(within(dialog).getByRole('button', { name: '4K' }))
    await user.click(within(dialog).getByRole('button', { name: '4:3' }))
    await user.click(within(dialog).getByRole('button', { name: '4张' }))

    expect(screen.getByRole('button', { name: '生成详情：4:3 · 4K · 4张' })).toBeVisible()
    expect(onSettingsChange).toHaveBeenLastCalledWith(
      'image-1',
      expect.objectContaining({
        kind: 'image',
        providerId: 'aistartlab',
        catalogVersion: 'catalog-settings-v1',
        channel: 46,
        model: 'image-primary',
        quality: '4K',
        resolution: '4K',
        aspectRatio: '4:3',
        count: 4,
      }),
    )
  })

  it('forces audio off when a model accepts audio references but cannot generate audio', async () => {
    const user = userEvent.setup()
    const onSettingsChange = vi.fn()
    render(
      withProvider(
        <NodeGeneratorPanel
          kind="video"
          nodeId="video-1"
          onSettingsChange={onSettingsChange}
        />,
      ),
    )

    const details = await screen.findByRole('button', {
      name: '生成详情：16:9 · 720P · 6s · 1个，音频关闭',
    })
    await vi.waitFor(() => expect(onSettingsChange).toHaveBeenCalledWith(
      'video-1',
      expect.objectContaining({ generateAudio: false }),
    ))
    await user.click(details)
    const dialog = screen.getByRole('dialog', { name: '视频生成设置' })
    expect(dialog.querySelectorAll('button[data-ratio]')).toHaveLength(2)
    expect(within(dialog).queryByRole('button', { name: '4K' })).toBeNull()
    expect(within(dialog).queryByText('生成音频')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: '开启' })).toBeNull()

    await user.click(within(dialog).getByRole('button', { name: '21:9' }))
    await user.click(within(dialog).getByRole('button', { name: '1080P' }))
    await user.click(within(dialog).getByRole('button', { name: '12秒' }))
    await user.click(within(dialog).getByRole('button', { name: '4个' }))

    expect(
      screen.getByRole('button', {
        name: '生成详情：21:9 · 1080P · 12s · 4个，音频关闭',
      }),
    ).toBeVisible()
    expect(onSettingsChange).toHaveBeenLastCalledWith(
      'video-1',
      expect.objectContaining({
        kind: 'video',
        providerId: 'aistartlab',
        catalogVersion: 'catalog-settings-v1',
        channel: 27,
        model: 'video-primary',
        resolution: '1080P',
        aspectRatio: '21:9',
        durationSec: 12,
        generateAudio: false,
        count: 4,
      }),
    )
  })
})
