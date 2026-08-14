// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ProviderCatalog,
  ProviderMetadata,
} from '../../contracts/generation'
import { GatewayClientError } from '../../services/gatewayClient'
import { ApiIntegrationPopover } from '../overlays/ApiIntegrationPopover'
import {
  ProviderCatalogProvider,
  type ProviderGateway,
} from './ProviderCatalogContext'
import { ProviderDrawer } from './ProviderDrawer'

afterEach(() => {
  cleanup()
  localStorage.clear()
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
  maskedSecret: 'sk-********1234',
  available: true,
  lastSyncedAt: '2026-07-17T01:02:03.000Z',
}

const unsupported: ProviderMetadata = {
  ...provider,
  id: 'custom',
  name: '自定义供应商',
  adapterType: 'custom-compatible',
  enabled: false,
  preferred: false,
  secretEnvName: 'API_PROVIDER_CUSTOM_KEY',
  secretConfigured: false,
  maskedSecret: undefined,
  available: false,
  lastSyncedAt: undefined,
}

const openaiCompatible: ProviderMetadata = {
  ...provider,
  id: 'openai',
  name: 'OpenAI 官方',
  adapterType: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  enabled: true,
  preferred: false,
  secretEnvName: 'API_PROVIDER_OPENAI_KEY',
  secretConfigured: true,
  maskedSecret: 'sk-********abcd',
  available: true,
}

const catalog: ProviderCatalog = {
  providerId: provider.id,
  version: 'catalog-v1',
  fetchedAt: provider.lastSyncedAt!,
  stale: false,
  models: [],
}

function gateway(): ProviderGateway {
  return {
    listProviders: vi.fn().mockResolvedValue([provider, openaiCompatible, unsupported]),
    getCatalog: vi.fn().mockResolvedValue(catalog),
    syncProvider: vi.fn().mockResolvedValue(catalog),
    testProvider: vi.fn().mockResolvedValue(provider),
    updateProvider: vi.fn().mockImplementation(async (id, update) => ({
      ...(id === provider.id ? provider : unsupported),
      id,
      ...update,
      available:
        update.enabled &&
        update.adapterType === 'aistartlab-openapi' &&
        (id === provider.id),
    })),
    setProviderSecret: vi.fn().mockResolvedValue({
      ...unsupported,
      secretConfigured: true,
      maskedSecret: 'new-********9999',
    }),
    clearProviderSecret: vi.fn().mockResolvedValue({
      ...provider,
      secretConfigured: false,
      maskedSecret: undefined,
      available: false,
    }),
  }
}

describe('provider management UI', () => {
  it('blocks provider writes when API management capability is read-only', async () => {
    const mockGateway = gateway()
    render(
      <ProviderCatalogProvider gateway={mockGateway}>
        <ProviderDrawer onClose={vi.fn()} open readOnly />
      </ProviderCatalogProvider>,
    )

    expect(await screen.findByText('AIStartLab')).toBeVisible()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /保存供应商/ }))
    await user.click(screen.getByRole('button', { name: /测试连接/ }))
    await user.click(screen.getByRole('button', { name: /同步模型/ }))
    expect(mockGateway.updateProvider).not.toHaveBeenCalled()
    expect(mockGateway.testProvider).not.toHaveBeenCalled()
    expect(mockGateway.syncProvider).not.toHaveBeenCalled()
  })
  it('renders a neutral no-key catalog state in the API popover', async () => {
    const noKeyProvider = {
      ...provider,
      secretConfigured: false,
      maskedSecret: undefined,
      available: false,
      lastSyncedAt: undefined,
    }
    const mockGateway = gateway()
    vi.mocked(mockGateway.listProviders).mockResolvedValue([noKeyProvider])
    vi.mocked(mockGateway.getCatalog).mockRejectedValue(
      new GatewayClientError(404, 'not_found', 'Resource not found'),
    )

    render(
      <ProviderCatalogProvider gateway={mockGateway}>
        <ApiIntegrationPopover onClose={vi.fn()} onManage={vi.fn()} open />
      </ProviderCatalogProvider>,
    )

    expect(await screen.findByText('配置密钥后同步目录')).toBeVisible()
    expect(screen.queryByText('Resource not found')).toBeNull()
  })

  it('renders a neutral missing catalog state in the provider drawer', async () => {
    const noKeyProvider = {
      ...provider,
      secretConfigured: false,
      maskedSecret: undefined,
      available: false,
      lastSyncedAt: undefined,
    }
    const mockGateway = gateway()
    vi.mocked(mockGateway.listProviders).mockResolvedValue([noKeyProvider])
    vi.mocked(mockGateway.getCatalog).mockRejectedValue(
      new GatewayClientError(404, 'not_found', 'Resource not found'),
    )

    render(
      <ProviderCatalogProvider gateway={mockGateway}>
        <ProviderDrawer onClose={vi.fn()} open />
      </ProviderCatalogProvider>,
    )

    expect(await screen.findByText('配置密钥后同步目录')).toBeVisible()
    expect(screen.queryByText('Resource not found')).toBeNull()
  })

  it('keeps real catalog failures visible in the API popover', async () => {
    const mockGateway = gateway()
    vi.mocked(mockGateway.getCatalog).mockRejectedValue(
      new GatewayClientError(500, 'server_error', 'Catalog exploded'),
    )

    render(
      <ProviderCatalogProvider gateway={mockGateway}>
        <ApiIntegrationPopover onClose={vi.fn()} onManage={vi.fn()} open />
      </ProviderCatalogProvider>,
    )

    expect(await screen.findByText('Catalog exploded')).toBeVisible()
  })

  it('shows live provider state and delegates test, sync, and manage actions', async () => {
    const mockGateway = gateway()
    const onManage = vi.fn()
    render(
      <ProviderCatalogProvider gateway={mockGateway}>
        <ApiIntegrationPopover
          onClose={vi.fn()}
          onManage={onManage}
          open
        />
      </ProviderCatalogProvider>,
    )

    expect(await screen.findByText('AIStartLab')).toBeVisible()
    expect(screen.getByText('首选')).toBeVisible()
    expect(screen.getByText('已配置密钥')).toBeVisible()
    expect(screen.getByText('sk-********1234')).toBeVisible()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '快速测试' }))
    await user.click(screen.getByRole('button', { name: '同步配置' }))
    await user.click(screen.getByRole('button', { name: '管理接入' }))

    expect(mockGateway.testProvider).toHaveBeenCalledTimes(1)
    expect(mockGateway.syncProvider).toHaveBeenCalledTimes(1)
    expect(onManage).toHaveBeenCalledTimes(1)
  })

  it('keeps a replacement key local until PUT and clears the field afterwards', async () => {
    const mockGateway = gateway()
    render(
      <ProviderCatalogProvider gateway={mockGateway}>
        <ProviderDrawer onClose={vi.fn()} open />
      </ProviderCatalogProvider>,
    )

    await screen.findByRole('dialog', { name: '管理 API 接入' })
    const user = userEvent.setup()
    const secret = await screen.findByLabelText('替换 API Key')
    expect(screen.getByLabelText('接口地址')).toHaveAttribute('readonly')
    await user.type(secret, 'new-secret-value-9999')
    expect(mockGateway.setProviderSecret).not.toHaveBeenCalled()
    expect(JSON.stringify(localStorage)).not.toContain('new-secret-value-9999')

    await user.click(screen.getByRole('button', { name: '保存新密钥' }))
    await waitFor(() =>
      expect(mockGateway.setProviderSecret).toHaveBeenCalledWith(
        'aistartlab',
        'new-secret-value-9999',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    )
    expect(secret).toHaveValue('')
  })

  it('never offers key, test, or sync actions for an unsupported adapter', async () => {
    const mockGateway = gateway()
    render(
      <ProviderCatalogProvider gateway={mockGateway}>
        <ProviderDrawer onClose={vi.fn()} open />
      </ProviderCatalogProvider>,
    )
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '自定义供应商' }))

    expect(screen.getByText('当前适配器不支持生成')).toBeVisible()
    expect(screen.queryByLabelText('替换 API Key')).toBeNull()
    expect(screen.queryByRole('button', { name: /测试连接/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /同步模型/ })).toBeNull()
    expect(mockGateway.setProviderSecret).not.toHaveBeenCalled()
  })

  it('offers key, test, and sync actions for an openai-compatible provider', async () => {
    const mockGateway = gateway()
    render(
      <ProviderCatalogProvider gateway={mockGateway}>
        <ProviderDrawer onClose={vi.fn()} open />
      </ProviderCatalogProvider>,
    )
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'OpenAI 官方' }))

    expect(screen.queryByText('当前适配器不支持生成')).toBeNull()
    expect(screen.getByLabelText('替换 API Key')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /测试连接/ }))
    await user.click(screen.getByRole('button', { name: /同步模型/ }))
    expect(mockGateway.testProvider).toHaveBeenCalledWith('openai', expect.anything())
    expect(mockGateway.syncProvider).toHaveBeenCalledWith('openai', expect.anything())
  })

  it('lets an openai-compatible provider choose its image request mode', async () => {
    const mockGateway = gateway()
    render(
      <ProviderCatalogProvider gateway={mockGateway}>
        <ProviderDrawer onClose={vi.fn()} open />
      </ProviderCatalogProvider>,
    )
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'OpenAI 官方' }))

    const modeSelect = screen.getByLabelText('图片请求模式') as HTMLSelectElement
    expect(Array.from(modeSelect.options).map((option) => option.value)).toEqual([
      'auto',
      'openai',
      'openai-json',
      'openai-responses',
    ])
    await user.selectOptions(modeSelect, 'openai-json')
    await user.click(screen.getByRole('button', { name: /保存供应商/ }))
    expect(mockGateway.updateProvider).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ imageRequestMode: 'openai-json' }),
      expect.anything(),
    )
  })

  it('does not show the image request mode select for the aistartlab adapter', async () => {
    render(
      <ProviderCatalogProvider gateway={gateway()}>
        <ProviderDrawer onClose={vi.fn()} open />
      </ProviderCatalogProvider>,
    )
    await screen.findByRole('button', { name: 'AIStartLab' })
    expect(screen.queryByLabelText('图片请求模式')).toBeNull()
  })

  it('lists the OpenAI-compatible adapter option and lets its base URL be edited', async () => {
    const mockGateway = gateway()
    render(
      <ProviderCatalogProvider gateway={mockGateway}>
        <ProviderDrawer onClose={vi.fn()} open />
      </ProviderCatalogProvider>,
    )
    await screen.findByRole('button', { name: 'AIStartLab' })
    const adapter = screen.getByLabelText('适配器') as HTMLSelectElement
    expect(Array.from(adapter.options).map((option) => option.value)).toEqual([
      'aistartlab-openapi',
      'openai-compatible',
      'custom-compatible',
    ])

    const user = userEvent.setup()
    await user.selectOptions(adapter, 'openai-compatible')
    const baseUrl = screen.getByLabelText('接口地址') as HTMLInputElement
    expect(baseUrl.readOnly).toBe(false)
    await user.clear(baseUrl)
    await user.type(baseUrl, 'https://my-provider.example/v1')
    await user.click(screen.getByRole('button', { name: /保存供应商/ }))
    expect(mockGateway.updateProvider).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ baseUrl: 'https://my-provider.example/v1' }),
      expect.anything(),
    )
  })

  it('traps focus in the provider drawer and restores the trigger on close', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = '打开 API 管理'
    document.body.append(trigger)
    trigger.focus()
    const onClose = vi.fn()
    const { rerender } = render(
      <ProviderCatalogProvider gateway={gateway()}>
        <ProviderDrawer onClose={onClose} open />
      </ProviderCatalogProvider>,
    )
    const dialog = await screen.findByRole('dialog', { name: '管理 API 接入' })
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
    ))
    focusable.at(-1)?.focus()

    await userEvent.setup().tab()
    expect(document.activeElement).toBe(focusable[0])

    rerender(
      <ProviderCatalogProvider gateway={gateway()}>
        <ProviderDrawer onClose={onClose} open={false} />
      </ProviderCatalogProvider>,
    )
    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  it('adds and edits provider metadata without putting secrets in metadata payloads', async () => {
    const mockGateway = gateway()
    render(
      <ProviderCatalogProvider gateway={mockGateway}>
        <ProviderDrawer onClose={vi.fn()} open />
      </ProviderCatalogProvider>,
    )

    await screen.findByText('AIStartLab')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '新增供应商' }))
    expect(screen.getByLabelText('适配器')).toHaveValue('openai-compatible')
    expect(screen.getByLabelText('接口地址')).not.toHaveAttribute('readonly')
    await user.type(screen.getByLabelText('供应商 ID'), 'local-provider')
    await user.type(screen.getByLabelText('供应商名称'), '本地模型服务')
    await user.type(
      screen.getByLabelText('接口地址'),
      'https://provider.example.test/v1',
    )
    await user.click(screen.getByRole('button', { name: '保存供应商' }))

    await waitFor(() => expect(mockGateway.updateProvider).toHaveBeenCalled())
    const [, update] = vi.mocked(mockGateway.updateProvider).mock.calls.at(-1)!
    expect(update).toMatchObject({
      name: '本地模型服务',
      baseUrl: 'https://provider.example.test/v1',
    })
    expect(update).not.toHaveProperty('apiKey')
  })

  it('creates, stores the secret, tests, and synchronizes a provider in one flow', async () => {
    const mockGateway = gateway()
    render(
      <ProviderCatalogProvider gateway={mockGateway}>
        <ProviderDrawer onClose={vi.fn()} open />
      </ProviderCatalogProvider>,
    )
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '新增供应商' }))
    expect(screen.getByLabelText('适配器')).toHaveValue('openai-compatible')
    await user.type(screen.getByLabelText('供应商 ID'), 'topapis')
    await user.type(screen.getByLabelText('供应商名称'), 'TopAPIs')
    await user.type(screen.getByLabelText('接口地址'), 'https://api.topapis.cn/v1')
    await user.type(screen.getByLabelText('API Key'), 'unit-secret')
    await user.click(screen.getByRole('button', { name: '保存并验证' }))

    await waitFor(() => expect(mockGateway.syncProvider).toHaveBeenCalledWith('topapis', expect.anything()))
    expect(mockGateway.updateProvider).toHaveBeenCalledWith('topapis', expect.not.objectContaining({ apiKey: expect.anything() }), expect.anything())
    expect(mockGateway.setProviderSecret).toHaveBeenCalledWith('topapis', 'unit-secret', expect.anything())
    expect(mockGateway.testProvider).toHaveBeenCalledWith('topapis', expect.anything())
  })
})
