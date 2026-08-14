// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ProviderCatalog,
  ProviderMetadata,
} from '../../contracts/generation'
import { GatewayClientError } from '../../services/gatewayClient'
import {
  ProviderCatalogProvider,
  useProviderCatalog,
  type ProviderGateway,
} from './ProviderCatalogContext'

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
  maskedSecret: 'sk-••••1234',
  available: true,
  lastSyncedAt: new Date().toISOString(),
}

const catalog: ProviderCatalog = {
  providerId: 'aistartlab',
  version: 'catalog-v1',
  fetchedAt: '2026-07-17T00:00:00.000Z',
  stale: true,
  models: [],
}

function Probe() {
  const state = useProviderCatalog()
  return (
    <div>
      <span>{state.loading ? 'loading' : 'ready'}</span>
      <span>{state.preferredProvider?.name ?? 'none'}</span>
      <span>{state.catalog?.version ?? 'no-catalog'}</span>
      <span>{state.catalog?.stale ? '需要同步' : '已同步'}</span>
      <span>{state.error ?? 'no-error'}</span>
      <span>{state.catalogSyncing ? 'syncing' : 'idle'}</span>
      <button onClick={() => void state.syncProvider('aistartlab')} type="button">
        同步
      </button>
      <button onClick={() => void state.syncProvider('aistartlab', { force: true })} type="button">
        强制同步
      </button>
    </div>
  )
}

describe('ProviderCatalogProvider', () => {
  it('treats a missing catalog as an empty state instead of a global error', async () => {
    const recovered = { ...catalog, stale: false }
    const gateway: ProviderGateway = {
      listProviders: vi.fn().mockResolvedValue([
        { ...provider, secretConfigured: false, maskedSecret: undefined },
      ]),
      getCatalog: vi
        .fn()
        .mockRejectedValue(
          new GatewayClientError(404, 'not_found', 'Resource not found'),
        ),
      syncProvider: vi.fn().mockResolvedValue(recovered),
      testProvider: vi.fn(),
      updateProvider: vi.fn(),
      setProviderSecret: vi.fn(),
      clearProviderSecret: vi.fn(),
    }

    render(
      <ProviderCatalogProvider gateway={gateway}>
        <Probe />
      </ProviderCatalogProvider>,
    )

    await waitFor(() => expect(screen.getByText('catalog-v1')).toBeVisible())
    expect(screen.getByText('no-error')).toBeVisible()
    expect(screen.queryByText('Resource not found')).toBeNull()
    expect(gateway.syncProvider).toHaveBeenCalledTimes(1)
  })

  it('shows a connection error only when neither cache nor sync is usable', async () => {
    const gateway: ProviderGateway = {
      listProviders: vi.fn().mockResolvedValue([provider]),
      getCatalog: vi
        .fn()
        .mockRejectedValue(
          new GatewayClientError(500, 'server_error', 'Catalog exploded'),
        ),
      syncProvider: vi.fn().mockRejectedValue(new Error('Sync failed')),
      testProvider: vi.fn(),
      updateProvider: vi.fn(),
      setProviderSecret: vi.fn(),
      clearProviderSecret: vi.fn(),
    }

    render(
      <ProviderCatalogProvider gateway={gateway}>
        <Probe />
      </ProviderCatalogProvider>,
    )

    expect(await screen.findByText('Sync failed')).toBeVisible()
  })

  it('keeps a stale cached catalog usable while automatically syncing it', async () => {
    const freshCatalog = { ...catalog, version: 'catalog-v2', stale: false }
    let resolveSync!: (value: ProviderCatalog) => void
    const gateway: ProviderGateway = {
      listProviders: vi.fn().mockResolvedValue([provider]),
      getCatalog: vi.fn().mockResolvedValue(catalog),
      syncProvider: vi.fn(() => new Promise<ProviderCatalog>((resolve) => {
        resolveSync = resolve
      })),
      testProvider: vi.fn(),
      updateProvider: vi.fn(),
      setProviderSecret: vi.fn(),
      clearProviderSecret: vi.fn(),
    }

    render(
      <ProviderCatalogProvider gateway={gateway}>
        <Probe />
      </ProviderCatalogProvider>,
    )

    await waitFor(() => expect(screen.getByText('AIStartLab')).toBeVisible())
    expect(screen.getByText('catalog-v1')).toBeVisible()
    expect(screen.getByText('需要同步')).toBeVisible()
    expect(screen.getByText('syncing')).toBeVisible()

    resolveSync(freshCatalog)
    await waitFor(() => expect(screen.getByText('catalog-v2')).toBeVisible())
    expect(screen.getByText('已同步')).toBeVisible()
    expect(gateway.syncProvider).toHaveBeenCalledWith(
      'aistartlab',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('deduplicates concurrent provider sync requests', async () => {
    let resolveSync!: (value: ProviderCatalog) => void
    const syncProvider = vi.fn(() => new Promise<ProviderCatalog>((resolve) => {
      resolveSync = resolve
    }))
    const gateway: ProviderGateway = {
      listProviders: vi.fn().mockResolvedValue([provider]),
      getCatalog: vi.fn().mockResolvedValue(catalog),
      syncProvider,
      testProvider: vi.fn(), updateProvider: vi.fn(),
      setProviderSecret: vi.fn(), clearProviderSecret: vi.fn(),
    }
    render(<ProviderCatalogProvider gateway={gateway}><Probe /></ProviderCatalogProvider>)
    await waitFor(() => expect(screen.getByText('syncing')).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: '同步' }))
    fireEvent.click(screen.getByRole('button', { name: '同步' }))
    expect(syncProvider).toHaveBeenCalledTimes(1)
    resolveSync({ ...catalog, stale: false })
    await waitFor(() => expect(screen.getByText('idle')).toBeVisible())
  })

  it('does not reuse the recent automatic result for a forced sync', async () => {
    const freshCatalog = { ...catalog, version: 'catalog-v2', stale: false }
    const syncProvider = vi.fn().mockResolvedValue(freshCatalog)
    const gateway: ProviderGateway = {
      listProviders: vi.fn().mockResolvedValue([provider]),
      getCatalog: vi.fn().mockResolvedValue(catalog),
      syncProvider,
      testProvider: vi.fn(), updateProvider: vi.fn(),
      setProviderSecret: vi.fn(), clearProviderSecret: vi.fn(),
    }
    render(<ProviderCatalogProvider gateway={gateway}><Probe /></ProviderCatalogProvider>)
    await waitFor(() => expect(screen.getByText('catalog-v2')).toBeVisible())
    expect(syncProvider).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '强制同步' }))

    await waitFor(() => expect(syncProvider).toHaveBeenCalledTimes(2))
  })

  it('aborts in-flight catalog loading when the provider unmounts', async () => {
    let signal: AbortSignal | undefined
    const gateway: ProviderGateway = {
      listProviders: vi.fn().mockResolvedValue([provider]),
      getCatalog: vi.fn((_id, options) => {
        signal = options?.signal
        return new Promise(() => {})
      }),
      syncProvider: vi.fn(),
      testProvider: vi.fn(),
      updateProvider: vi.fn(),
      setProviderSecret: vi.fn(),
      clearProviderSecret: vi.fn(),
    }

    const view = render(
      <ProviderCatalogProvider gateway={gateway}>
        <Probe />
      </ProviderCatalogProvider>,
    )
    await waitFor(() => expect(gateway.getCatalog).toHaveBeenCalled())
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })
})
