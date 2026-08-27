// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  MediaGenerationSettings,
  ProviderCatalog,
  ProviderMetadata,
} from '../../contracts/generation'
import { GatewayClientError } from '../../services/gatewayClient'
import {
  GenerationApprovalProvider,
} from '../providers/GenerationApprovalContext'
import {
  ProviderCatalogProvider,
  type ProviderGateway,
} from '../providers/ProviderCatalogContext'
import { NodeGeneratorPanel } from './NodeGeneratorPanel'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const provider: ProviderMetadata = {
  id: 'aistartlab',
  name: 'AIStartLab',
  adapterType: 'aistartlab-openapi',
  baseUrl: 'https://api.video.aistarslab.com/openapi',
  enabled: true,
  preferred: true,
  secretEnvName: 'API_PROVIDER_AISTARTLAB_KEY',
  secretConfigured: true,
  maskedSecret: 'sk-••••1234',
  available: true,
  lastSyncedAt: new Date().toISOString(),
}

const catalog: ProviderCatalog = {
  providerId: 'aistartlab',
  version: 'catalog-v7',
  fetchedAt: new Date().toISOString(),
  stale: false,
  models: [
    {
      mediaType: 'image',
      channel: 46,
      channelTitle: 'AIStartLab Image',
      model: 'gpt-image-2',
      title: 'GPT Image 2 Low',
      qualityOptions: [
        {
          value: '1K',
          label: '1K',
          pricing: { type: 'fixed_total', credits: 5 },
        },
      ],
      aspectRatios: ['16:9', '1:1'],
      countOptions: [1, 2],
      durationOptions: [],
      modes: ['text2image', 'image2image'],
      inputLimits: { images: 2, videos: 0, audios: 0 },
      raw: {},
    },
    {
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
      aspectRatios: ['16:9'],
      countOptions: [1],
      durationOptions: [6, 10],
      modes: ['text2video', 'image2video', 'first_last_frame'],
      inputLimits: { images: 3, videos: 0, audios: 0 },
      raw: {},
    },
  ],
}

function gateway(overrides: Partial<ProviderGateway> = {}): ProviderGateway {
  return {
    listProviders: vi.fn().mockResolvedValue([provider]),
    getCatalog: vi.fn().mockResolvedValue(catalog),
    syncProvider: vi.fn().mockResolvedValue({ ...catalog, stale: false }),
    testProvider: vi.fn().mockResolvedValue(provider),
    updateProvider: vi.fn().mockResolvedValue(provider),
    setProviderSecret: vi.fn().mockResolvedValue(provider),
    clearProviderSecret: vi.fn().mockResolvedValue(provider),
    ...overrides,
  }
}

function renderPanel(
  panel: React.ReactElement,
  providerGateway = gateway(),
) {
  return render(
    <ProviderCatalogProvider gateway={providerGateway}>
      <GenerationApprovalProvider>{panel}</GenerationApprovalProvider>
    </ProviderCatalogProvider>,
  )
}

describe('NodeGeneratorPanel usable generation UI', () => {
  it('requires one sustained settings lease before prompt writes and releases on leave', async () => {
    const onInteractionStart = vi.fn(() => true)
    const onInteractionEnd = vi.fn()
    const onPromptChange = vi.fn()
    renderPanel(
      <NodeGeneratorPanel
        kind="image"
        nodeId="image-locked-settings"
        onInteractionEnd={onInteractionEnd}
        onInteractionStart={onInteractionStart}
        onPromptChange={onPromptChange}
      />,
    )
    const editor = await screen.findByRole('combobox', { name: '图片生成描述' })
    fireEvent.pointerDown(editor)
    fireEvent.change(editor, { target: { value: '持锁编辑' } })
    expect(onInteractionStart).toHaveBeenCalledWith('image-locked-settings', 'settings')
    expect(onPromptChange).toHaveBeenCalledWith('image-locked-settings', '持锁编辑')

    fireEvent.pointerLeave(editor.closest('.canvas-node-generator-anchor')!)
    expect(onInteractionEnd).toHaveBeenCalledWith('image-locked-settings', 'settings')
  })
  it('temporarily releases settings while awaiting a reference mutation then reacquires', async () => {
    const order: string[] = []
    const onInteractionStart = vi.fn(() => { order.push('start'); return true })
    const onInteractionEnd = vi.fn(() => { order.push('end') })
    const onRemoveReference = vi.fn(async () => { order.push('detach') })
    const user = userEvent.setup()
    renderPanel(<NodeGeneratorPanel
      kind="image" nodeId="image-reference-lock"
      onInteractionEnd={onInteractionEnd}
      onInteractionStart={onInteractionStart}
      onRemoveReference={onRemoveReference}
      references={[{
        id: 'ref-a', referenceAlias: 1, name: '参考', kind: 'image', url: '/asset.png',
      }]}
    />)

    await user.click(await screen.findByRole('button', { name: '移除参考 @1' }))
    await waitFor(() => expect(onRemoveReference).toHaveBeenCalledOnce())
    expect(order).toEqual(['start', 'end', 'detach', 'start'])
  })
  it('opens a real expanded editor dialog and restores focus after closing', async () => {
    const user = userEvent.setup()
    renderPanel(
      <NodeGeneratorPanel
        kind="image"
        nodeId="image-expanded"
        projectId="project-expanded"
        onSettingsChange={vi.fn()}
        settings={{
          kind: 'image',
          quality: '1K',
          resolution: '1K',
          aspectRatio: '16:9',
          count: 1,
        }}
      />,
    )
    const expand = await screen.findByRole('button', { name: '展开节点编辑器' })
    await user.click(expand)

    const dialog = screen.getByRole('dialog', { name: '节点编辑器' })
    expect(dialog).toBeVisible()
    expect(within(dialog).getByRole('combobox', { name: '图片生成描述' })).toBeVisible()
    const modelTrigger = within(dialog).getByRole('button', { name: '选择图片模型' })
    await user.click(modelTrigger)
    const modelMenu = screen.getByRole('menu', { name: '图片模型' })
    expect(dialog).toContainElement(modelMenu)
    fireEvent.keyDown(modelMenu, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: '图片模型' })).toBeNull()
    expect(dialog).toBeVisible()
    expect(modelTrigger).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: '收起节点编辑器' }))
    expect(screen.queryByRole('dialog', { name: '节点编辑器' })).toBeNull()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '展开节点编辑器' })).toHaveFocus()
    })
  })

  it('shows an unknown reference limit and disables catalog-dependent actions', async () => {
    const noCatalogGateway = gateway({
      listProviders: vi.fn().mockResolvedValue([
        {
          ...provider,
          secretConfigured: false,
          maskedSecret: undefined,
          available: false,
          lastSyncedAt: undefined,
        },
      ]),
      getCatalog: vi
        .fn()
        .mockRejectedValue(
          new GatewayClientError(404, 'not_found', 'Resource not found'),
        ),
      syncProvider: vi.fn().mockRejectedValue(new Error('Sync failed')),
    })

    renderPanel(
      <NodeGeneratorPanel
        kind="image"
        nodeId="image-no-catalog"
        referenceCandidates={[]}
        references={[
          {
            id: 'image-ref',
            referenceAlias: 1,
            name: '人物近景',
            kind: 'image',
            url: '/api/assets/11111111-1111-4111-8111-111111111111',
          },
        ]}
      />,
      noCatalogGateway,
    )

    expect(await screen.findByLabelText('参考素材 1/—')).toBeVisible()
    expect(screen.getByRole('button', { name: '添加参考' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '开始生成' })).toBeDisabled()
    expect(screen.queryByText('Resource not found')).toBeNull()
  })

  it('renders independent numbered reference previews and controls canvas picking/removal', async () => {
    const onReferencePickerChange = vi.fn()
    const onRemoveReference = vi.fn()
    const user = userEvent.setup()
    renderPanel(
      <NodeGeneratorPanel
        kind="image"
        nodeId="image-target"
        onReferencePickerChange={onReferencePickerChange}
        onRemoveReference={onRemoveReference}
        referenceCandidates={[]}
        references={[
          {
            id: 'image-ref',
            referenceAlias: 1,
            name: '人物近景',
            kind: 'image',
            url: '/api/assets/11111111-1111-4111-8111-111111111111',
          },
        ]}
      />,
    )

    await waitFor(() => expect(screen.getByText('GPT Image 2 Low')).toBeVisible())
    const strip = screen.getByLabelText('参考素材 1/2')
    const item = within(strip).getByLabelText('参考 @1：人物近景')
    expect(item).toHaveAttribute('data-reference-alias', '1')
    expect(item).toHaveClass('canvas-reference-card')

    await user.click(screen.getByRole('button', { name: '移除参考 @1' }))
    expect(onRemoveReference).toHaveBeenCalledWith('image-target', 'image-ref')
    await user.click(screen.getByRole('button', { name: '添加参考' }))
    expect(onReferencePickerChange).toHaveBeenCalledWith('image-target', true)
  })

  it('auto-attaches @ references, blocks invalid tokens, and confirms exact cost before submit', async () => {
    const onAttachReference = vi.fn().mockReturnValue(2)
    const onGenerate = vi.fn()
    const user = userEvent.setup()
    renderPanel(
      <NodeGeneratorPanel
        kind="image"
        nodeId="image-target"
        onAttachReference={onAttachReference}
        onGenerate={onGenerate}
        referenceCandidates={[
          {
            id: 'image-2',
            name: '薄雾院落',
            kind: 'image',
            url: '/api/assets/22222222-2222-4222-8222-222222222222',
          },
        ]}
        references={[]}
      />,
    )

    await waitFor(() => expect(screen.getByText('GPT Image 2 Low')).toBeVisible())
    const editor = screen.getByRole('combobox', { name: '图片生成描述' })
    await user.type(editor, '让 @薄')
    await user.click(screen.getByRole('option', { name: /薄雾院落/ }))
    expect(onAttachReference).toHaveBeenCalledWith('image-target', 'image-2')

    await user.clear(editor)
    await user.type(editor, '让 @3 走进院落')
    expect(screen.getByText('@3 已失效')).toBeVisible()
    expect(screen.getByRole('button', { name: '开始生成' })).toBeDisabled()

    await user.clear(editor)
    await user.type(editor, '电影感人物近景')
    await user.click(screen.getByRole('button', { name: '开始生成' }))
    expect(screen.queryByRole('dialog', { name: '确认生成任务' })).toBeNull()
    expect(onGenerate).toHaveBeenCalledWith(
      'image-target',
      expect.objectContaining({
        providerId: 'aistartlab',
        channel: 46,
        model: 'gpt-image-2',
        prompt: '电影感人物近景',
      }),
    )
  })

  it('uses only catalog video modes and options and enforces their reference rules', async () => {
    const user = userEvent.setup()
    renderPanel(
      <NodeGeneratorPanel
        kind="video"
        nodeId="video-target"
        referenceCandidates={[]}
        references={[]}
      />,
    )

    await waitFor(() => expect(screen.getByText('Grok 1.0')).toBeVisible())
    await user.click(screen.getByRole('button', { name: /生成详情/ }))
    const settings = screen.getByRole('dialog', { name: '视频生成设置' })
    expect(within(settings).getByRole('button', { name: '文生视频' })).toBeVisible()
    expect(within(settings).getByRole('button', { name: '全能参考' })).toBeVisible()
    expect(within(settings).getByRole('button', { name: '首尾帧' })).toBeVisible()

    await user.click(within(settings).getByRole('button', { name: '全能参考' }))
    expect(screen.getByText('全能参考至少需要 1 张图片')).toBeVisible()
    expect(screen.getByRole('button', { name: '开始生成' })).toBeDisabled()

    expect(within(settings).getByRole('button', { name: '720P' })).toBeVisible()
    expect(within(settings).queryByRole('button', { name: '1080P' })).toBeNull()
    expect(within(settings).getByRole('button', { name: '6秒' })).toBeVisible()
    expect(within(settings).getByRole('button', { name: '10秒' })).toBeVisible()
  })

  it('supports arrow, Home, End, and Escape semantics in model and mode menus', async () => {
    const user = userEvent.setup()
    renderPanel(
      <NodeGeneratorPanel
        kind="video"
        nodeId="video-keyboard"
        referenceCandidates={[]}
        references={[]}
      />,
    )

    const modelTrigger = await screen.findByRole('button', { name: /选择视频模型/ })
    modelTrigger.focus()
    await user.keyboard('{ArrowDown}')
    const modelMenu = screen.getByRole('menu', { name: '视频模型' })
    expect(modelMenu.parentElement).toBe(document.body)
    expect(modelMenu).toHaveStyle({ position: 'fixed' })
    expect(within(modelMenu).getAllByRole('menuitem')[0]).toHaveFocus()
    await user.keyboard('{End}')
    expect(within(modelMenu).getAllByRole('menuitem').at(-1)).toHaveFocus()
    await user.keyboard('{Home}')
    expect(within(modelMenu).getAllByRole('menuitem')[0]).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(modelTrigger).toHaveFocus()
    expect(screen.queryByRole('menu', { name: '视频模型' })).toBeNull()
  })

  it('shows catalog staleness and generation phase/progress with recovery controls', async () => {
    const staleGateway = gateway({
      getCatalog: vi.fn().mockResolvedValue({ ...catalog, stale: true }),
    })
    renderPanel(
      <NodeGeneratorPanel
        error={{ code: 'poll_timeout', message: '轮询超时，可安全恢复' }}
        generation={{
          prompt: '继续镜头',
          status: 'generating',
          phase: 'running',
          progress: 42,
        }}
        kind="video"
        nodeId="video-running"
        pending
        referenceCandidates={[]}
        references={[]}
      />,
      staleGateway,
    )

    await waitFor(() => expect(staleGateway.syncProvider).toHaveBeenCalledTimes(1))
    expect(screen.getByText('生成中 42%')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('轮询超时，可安全恢复')
  })

  it('offers the idempotent recovery action for a failed persisted request even after it is no longer active', async () => {
    const onRetry = vi.fn()
    renderPanel(
      <NodeGeneratorPanel
        error={{ code: 'poll_timeout', message: '状态查询超时' }}
        generation={{
          prompt: '恢复同一请求',
          status: 'error',
          phase: 'failed',
          progress: 42,
        }}
        kind="image"
        nodeId="image-failed"
        onRetry={onRetry}
        referenceCandidates={[]}
        references={[]}
      />,
    )

    const user = userEvent.setup()
    const recover = await screen.findByRole('button', { name: '恢复生成' })
    expect(recover).toBeEnabled()
    await user.click(recover)
    expect(onRetry).toHaveBeenCalledWith('image-failed', '恢复同一请求')
  })

  it('allows immediate recovery while the previous submit guard is still active', async () => {
    const providerGateway = gateway()
    const onGenerate = vi.fn()
    const onRetry = vi.fn()
    const renderWithProviders = (panel: React.ReactElement) => (
      <ProviderCatalogProvider gateway={providerGateway}>
        <GenerationApprovalProvider>{panel}</GenerationApprovalProvider>
      </ProviderCatalogProvider>
    )
    const view = render(renderWithProviders(
      <NodeGeneratorPanel
        kind="image"
        nodeId="image-immediate-recovery"
        onGenerate={onGenerate}
        onRetry={onRetry}
        referenceCandidates={[]}
        references={[]}
      />,
    ))
    const user = userEvent.setup()
    const prompt = await screen.findByRole('combobox', { name: '图片生成描述' })
    await user.type(prompt, '立即恢复同一请求')
    await user.click(screen.getByRole('button', { name: '开始生成' }))
    expect(onGenerate).toHaveBeenCalledOnce()

    view.rerender(renderWithProviders(
      <NodeGeneratorPanel
        error={{
          code: 'manual_recovery_required',
          message: '请求结果未知，请立即恢复',
        }}
        generation={{
          prompt: '立即恢复同一请求',
          status: 'failed',
          phase: 'failed',
        }}
        kind="image"
        nodeId="image-immediate-recovery"
        onGenerate={onGenerate}
        onRetry={onRetry}
        referenceCandidates={[]}
        references={[]}
      />,
    ))

    await user.click(screen.getByRole('button', { name: '恢复生成' }))
    expect(onRetry).toHaveBeenCalledWith(
      'image-immediate-recovery',
      '立即恢复同一请求',
    )
  })

  it('refreshes the catalog before submission and blocks a removed route', async () => {
    const freshCatalog: ProviderCatalog = {
      ...catalog,
      version: 'catalog-v8',
      fetchedAt: new Date().toISOString(),
      models: catalog.models.map((model) =>
        model.mediaType === 'image'
          ? {
              ...model,
              channel: 50,
              channelTitle: 'AIStartLab Image New Route',
            }
          : model,
      ),
    }
    const syncProvider = vi.fn().mockResolvedValue(freshCatalog)
    const onGenerate = vi.fn()
    const onSettingsChange = vi.fn()
    renderPanel(
      <NodeGeneratorPanel
        kind="image"
        nodeId="removed-route-node"
        onGenerate={onGenerate}
        onSettingsChange={onSettingsChange}
        promptDraft="使用有效线路生成"
        references={[]}
        settings={{
          kind: 'image', providerId: 'aistartlab', catalogVersion: 'catalog-v7',
          channel: 46, model: 'gpt-image-2', mode: 'text2image', quality: '1K',
          resolution: '1K', aspectRatio: '16:9', count: 1,
        }}
      />,
      gateway({ syncProvider }),
    )

    await userEvent.setup().click(await screen.findByRole('button', { name: '开始生成' }))

    await waitFor(() => expect(syncProvider).toHaveBeenCalledTimes(1))
    expect(onGenerate).not.toHaveBeenCalled()
    expect(onSettingsChange).toHaveBeenCalledWith(
      'removed-route-node',
      expect.objectContaining({ channel: 50, catalogVersion: 'catalog-v8' }),
    )
    expect(screen.getByRole('status')).toHaveTextContent('线路已更新')
    expect(screen.getByRole('status')).toHaveTextContent('未提交任务')
  })

  it('blocks submission when the mandatory catalog refresh fails', async () => {
    const syncProvider = vi.fn().mockRejectedValue(new Error('Sync failed'))
    const onGenerate = vi.fn()
    renderPanel(
      <NodeGeneratorPanel
        kind="image"
        nodeId="catalog-sync-failed-node"
        onGenerate={onGenerate}
        promptDraft="同步失败时不要提交"
        references={[]}
      />,
      gateway({ syncProvider }),
    )

    await userEvent.setup().click(await screen.findByRole('button', { name: '开始生成' }))

    await waitFor(() => expect(syncProvider).toHaveBeenCalledTimes(1))
    expect(onGenerate).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('目录同步失败，未提交任务')
  })

  it('automatically refreshes a rejected catalog and shows an inline diff before resubmission', async () => {
    const user = userEvent.setup()
    const freshCatalog: ProviderCatalog = {
      ...catalog,
      version: 'catalog-v8',
      models: catalog.models.map((model) =>
        model.mediaType === 'image'
          ? {
              ...model,
              qualityOptions: [
                {
                  value: '2K',
                  label: '2K',
                  pricing: { type: 'fixed_total' as const, credits: 8 },
                },
              ],
            }
          : model,
      ),
    }
    const syncProvider = vi.fn().mockResolvedValue(freshCatalog)
    const onGenerate = vi.fn()
    const onSettingsChange = vi.fn()
    renderPanel(
      <NodeGeneratorPanel
        error={{ code: 'catalog_changed', message: '目录版本已变化' }}
        generation={{
          prompt: '使用新目录生成',
          status: 'failed',
          phase: 'failed',
          clientRequestId: 'catalog-rejected-v7',
        }}
        kind="image"
        nodeId="image-catalog-rejected"
        onGenerate={onGenerate}
        onSettingsChange={onSettingsChange}
        promptDraft="使用新目录生成"
        referenceCandidates={[]}
        references={[]}
        settings={{
          kind: 'image',
          providerId: 'aistartlab',
          catalogVersion: 'catalog-v7',
          channel: 46,
          model: 'gpt-image-2',
          mode: 'text2image',
          quality: '1K',
          resolution: '1K',
          aspectRatio: '16:9',
          count: 1,
        }}
      />,
      gateway({ syncProvider }),
    )

    await waitFor(() => expect(onSettingsChange).toHaveBeenCalledWith(
      'image-catalog-rejected',
      expect.objectContaining({
        catalogVersion: 'catalog-v8',
        quality: '2K',
        resolution: '2K',
      }),
      { resolveCatalogChanged: true },
    ))
    expect(screen.getByText(/目录已更新/)).toBeVisible()
    const submit = screen.getByRole('button', { name: '开始生成' })
    expect(submit).toBeEnabled()
    expect(onGenerate).not.toHaveBeenCalled()

    await user.click(submit)
    expect(screen.queryByRole('dialog', { name: '确认生成任务' })).toBeNull()
    expect(onGenerate).toHaveBeenCalledTimes(1)
    expect(onGenerate).toHaveBeenCalledWith(
      'image-catalog-rejected',
      expect.objectContaining({ catalogVersion: 'catalog-v8', quality: '2K' }),
    )
  })

  it('keeps catalog rejection locked when refresh fails', async () => {
    const syncProvider = vi.fn()
      .mockRejectedValueOnce(new GatewayClientError(
        503,
        'upstream_unavailable',
        'Catalog refresh failed',
      ))
    const onGenerate = vi.fn()
    const onSettingsChange = vi.fn()
    renderPanel(
      <NodeGeneratorPanel
        error={{ code: 'catalog_changed', message: '目录版本已变化' }}
        generation={{
          prompt: '保留拒绝状态',
          status: 'failed',
          phase: 'failed',
          clientRequestId: 'catalog-rejected-failed-refresh',
        }}
        kind="image"
        nodeId="image-catalog-refresh-failed"
        onGenerate={onGenerate}
        onSettingsChange={onSettingsChange}
        promptDraft="保留拒绝状态"
        referenceCandidates={[]}
        references={[]}
        settings={{
          kind: 'image',
          providerId: 'aistartlab',
          catalogVersion: 'catalog-v7',
          channel: 46,
          model: 'gpt-image-2',
          mode: 'text2image',
          quality: '1K',
          resolution: '1K',
          aspectRatio: '16:9',
          count: 1,
        }}
      />,
      gateway({ syncProvider }),
    )

    const submit = await screen.findByRole('button', { name: '开始生成' })
    await waitFor(() => expect(syncProvider).toHaveBeenCalledTimes(1))

    expect(screen.getByRole('alert')).toHaveTextContent('目录版本已变化')
    expect(submit).toBeDisabled()
    expect(onSettingsChange).not.toHaveBeenCalled()
    expect(onGenerate).not.toHaveBeenCalled()
  })

  it('retries catalog recovery after an exception and an empty catalog result', async () => {
    const freshCatalog = { ...catalog, version: 'catalog-v8' }
    const syncProvider = vi.fn()
      .mockRejectedValueOnce(new Error('temporary catalog failure'))
      .mockResolvedValueOnce({ ...freshCatalog, models: [] })
      .mockResolvedValueOnce(freshCatalog)
    const onGenerate = vi.fn()

    renderPanel(
      <NodeGeneratorPanel
        error={{ code: 'catalog_changed', message: '目录版本已变化' }}
        generation={{
          prompt: '恢复目录后继续',
          status: 'failed',
          phase: 'failed',
          clientRequestId: 'catalog-retry-after-failure',
        }}
        kind="image"
        nodeId="catalog-retry-node"
        onGenerate={onGenerate}
        promptDraft="恢复目录后继续"
        referenceCandidates={[]}
        references={[]}
        settings={{
          kind: 'image',
          providerId: 'aistartlab',
          catalogVersion: 'catalog-v7',
          channel: 46,
          model: 'gpt-image-2',
          mode: 'text2image',
          quality: '1K',
          resolution: '1K',
          aspectRatio: '16:9',
          count: 1,
        }}
      />,
      gateway({ syncProvider }),
    )

    await waitFor(() => expect(syncProvider).toHaveBeenCalledTimes(3), {
      timeout: 3_000,
    })
    await waitFor(() => expect(onGenerate).toHaveBeenCalledWith(
      'catalog-retry-node',
      expect.objectContaining({
        catalogVersion: 'catalog-v8',
        clientRequestId: 'catalog-retry-after-failure',
      }),
    ))
    expect(onGenerate).toHaveBeenCalledTimes(1)
  })

  it('automatically retries the same catalog-changed intent with its original idempotency key', async () => {
    const freshCatalog = { ...catalog, version: 'catalog-v8' }
    const onGenerate = vi.fn()
    const onSettingsChange = vi.fn()
    renderPanel(
      <NodeGeneratorPanel
        error={{ code: 'catalog_changed', message: '目录版本已变化' }}
        generation={{
          prompt: '同一意图', status: 'failed', phase: 'failed',
          clientRequestId: 'same-intent-key',
        }}
        kind="image"
        nodeId="same-intent-node"
        onGenerate={onGenerate}
        onSettingsChange={onSettingsChange}
        promptDraft="同一意图"
        references={[]}
        settings={{
          kind: 'image', providerId: 'aistartlab', catalogVersion: 'catalog-v7',
          channel: 46, model: 'gpt-image-2', mode: 'text2image', quality: '1K',
          resolution: '1K', aspectRatio: '16:9', count: 1,
        }}
      />,
      gateway({ syncProvider: vi.fn().mockResolvedValue(freshCatalog) }),
    )

    await waitFor(() => expect(onGenerate).toHaveBeenCalledWith(
      'same-intent-node',
      expect.objectContaining({
        catalogVersion: 'catalog-v8', clientRequestId: 'same-intent-key',
      }),
    ))
    expect(onGenerate).toHaveBeenCalledTimes(1)
  })

  it('allows a completed node to generate again without waiting for status cleanup', async () => {
    const onGenerate = vi.fn()
    renderPanel(
      <NodeGeneratorPanel
        generation={{ prompt: '再次生成', status: 'complete', phase: 'complete' }}
        kind="image"
        nodeId="completed-node"
        onGenerate={onGenerate}
        promptDraft="再次生成"
        references={[]}
      />,
    )
    const submit = await screen.findByRole('button', { name: '开始生成' })
    expect(submit).toBeEnabled()
    await userEvent.setup().click(submit)
    expect(onGenerate).toHaveBeenCalledTimes(1)
  })
})

describe('NodeGeneratorPanel provider switching', () => {
  const openaiProvider: ProviderMetadata = {
    id: 'openai',
    name: 'OpenAI 官方',
    adapterType: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    preferred: false,
    secretEnvName: 'API_PROVIDER_OPENAI_KEY',
    secretConfigured: true,
    maskedSecret: 'sk-••••abcd',
    available: true,
    lastSyncedAt: new Date().toISOString(),
  }
  const openaiCatalog: ProviderCatalog = {
    providerId: 'openai',
    version: 'openai-catalog-v1',
    fetchedAt: new Date().toISOString(),
    stale: false,
    models: [{
      mediaType: 'image',
      channel: 'image',
      channelTitle: '图片生成',
      model: 'gpt-image-1',
      title: 'GPT Image 1',
      qualityOptions: [{
        value: 'standard',
        label: '标准',
        pricing: { type: 'fixed_total', credits: 1 },
      }],
      aspectRatios: ['1:1'],
      countOptions: [1],
      durationOptions: [],
      modes: ['text2image', 'image2image'],
      inputLimits: { images: 4, videos: 0, audios: 0 },
      raw: {},
    }],
  }
  const emptyProvider: ProviderMetadata = {
    id: 'empty',
    name: '未配置平台',
    adapterType: 'openai-compatible',
    baseUrl: 'https://empty.example/v1',
    enabled: true,
    preferred: false,
    secretEnvName: 'API_PROVIDER_EMPTY_KEY',
    secretConfigured: false,
    maskedSecret: undefined,
    available: false,
  }
  const emptyCatalog: ProviderCatalog = {
    providerId: 'empty',
    version: 'empty-catalog-v1',
    fetchedAt: new Date().toISOString(),
    stale: false,
    models: [],
  }
  const multiGateway = gateway({
    listProviders: vi.fn().mockResolvedValue([provider, openaiProvider, emptyProvider]),
    getCatalog: vi.fn().mockImplementation(async (providerId: string) => {
      if (providerId === 'openai') return openaiCatalog
      if (providerId === 'empty') return emptyCatalog
      return catalog
    }),
  })

  it('switches provider, reloads its catalog, and rewrites generation settings', async () => {
    const user = userEvent.setup()
    const onSettingsChange = vi.fn()
    renderPanel(
      <NodeGeneratorPanel
        kind="image"
        nodeId="image-switch-provider"
        onSettingsChange={onSettingsChange}
      />,
      multiGateway,
    )

    await screen.findByRole('button', { name: '选择图片模型' })
    const providerButton = await screen.findByRole('button', { name: '选择生成平台' })
    expect(providerButton).toBeVisible()
    await user.click(providerButton)
    await user.click(await screen.findByRole('menuitem', { name: /OpenAI 官方/ }))

    await waitFor(() => expect(onSettingsChange).toHaveBeenCalled())
    const last = onSettingsChange.mock.calls.at(-1)?.[1] as MediaGenerationSettings
    expect(last.providerId).toBe('openai')
    expect(last.catalogVersion).toBe('openai-catalog-v1')
    expect(last.model).toBe('gpt-image-1')
    expect(screen.getByRole('button', { name: '选择图片模型' })).toHaveTextContent('GPT Image 1')
  })

  it('shows an unavailable state when the chosen provider has an empty catalog', async () => {
    const user = userEvent.setup()
    renderPanel(
      <NodeGeneratorPanel kind="image" nodeId="image-switch-empty" />,
      multiGateway,
    )

    const providerButton = await screen.findByRole('button', { name: '选择生成平台' })
    await user.click(providerButton)
    await user.click(await screen.findByRole('menuitem', { name: /未配置平台/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: '开始生成' })).toBeDisabled())
  })
})
