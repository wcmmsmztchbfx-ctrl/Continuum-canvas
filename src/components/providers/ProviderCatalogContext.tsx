/* eslint-disable react-refresh/only-export-components */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type {
  ProviderCatalog,
  ProviderMetadata,
} from '../../contracts/generation'
import { isProviderCatalogFresh } from '../../contracts/catalog'
import {
  gatewayClient,
  isMissingCatalogError,
  type GatewayRequestOptions,
  type CanvasApiScope,
  type ProviderUpdate,
} from '../../services/gatewayClient'

export interface ProviderGateway {
  setCanvasApiScope?: (scope?: CanvasApiScope) => void
  listProviders: (
    options?: GatewayRequestOptions,
  ) => Promise<ProviderMetadata[]>
  getCatalog: (
    providerId: string,
    options?: GatewayRequestOptions,
  ) => Promise<ProviderCatalog>
  syncProvider: (
    providerId: string,
    options?: GatewayRequestOptions,
  ) => Promise<ProviderCatalog>
  testProvider: (
    providerId: string,
    options?: GatewayRequestOptions,
  ) => Promise<ProviderMetadata>
  updateProvider: (
    providerId: string,
    update: ProviderUpdate,
    options?: GatewayRequestOptions,
  ) => Promise<ProviderMetadata>
  getProviderSecret: (
    providerId: string,
    options?: GatewayRequestOptions,
  ) => Promise<string>
  setProviderSecret: (
    providerId: string,
    apiKey: string,
    options?: GatewayRequestOptions,
  ) => Promise<ProviderMetadata>
  clearProviderSecret: (
    providerId: string,
    options?: GatewayRequestOptions,
  ) => Promise<ProviderMetadata>
  deleteProvider: (
    providerId: string,
    options?: GatewayRequestOptions,
  ) => Promise<{ ok: boolean }>
}

export interface ProviderCatalogState {
  providers: ProviderMetadata[]
  preferredProvider?: ProviderMetadata
  selectedProvider?: ProviderMetadata
  selectedProviderId?: string
  catalog?: ProviderCatalog
  catalogs: Record<string, ProviderCatalog>
  catalogSyncing: boolean
  loading: boolean
  busyAction?: string
  error?: string
  setApiManagementAllowed: (allowed: boolean) => void
  selectProvider: (providerId: string) => Promise<void>
  refreshProviders: () => Promise<void>
  refreshCatalog: (providerId?: string) => Promise<ProviderCatalog | undefined>
  syncProvider: (
    providerId: string,
    options?: { force?: boolean },
  ) => Promise<ProviderCatalog | undefined>
  testProvider: (providerId: string) => Promise<ProviderMetadata | undefined>
  saveProvider: (
    providerId: string,
    update: ProviderUpdate,
  ) => Promise<ProviderMetadata | undefined>
  deleteProvider: (providerId: string) => Promise<boolean>
  getProviderSecret: (providerId: string) => Promise<string | undefined>
  setProviderSecret: (
    providerId: string,
    secret: string,
  ) => Promise<ProviderMetadata | undefined>
  clearProviderSecret: (
    providerId: string,
  ) => Promise<ProviderMetadata | undefined>
}

const ProviderCatalogContext = createContext<ProviderCatalogState | null>(null)

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    const msg = error.message
    if (
      msg.includes('invalid api key') ||
      msg.includes('invalid_api_key') ||
      msg.includes('401')
    ) {
      return 'API Key 无效或未授权（401 Unauthorized），请核对填写的密钥'
    }
    if (
      msg.includes('could not be accepted') ||
      msg.includes('not configured') ||
      msg.includes('provider_unavailable') ||
      msg.includes('Provider is not configured')
    ) {
      return '当前服务商尚未配置有效 API Key 或不可用，请先在上方填入密钥并保存测试'
    }
    if (msg.includes('Local administrator') || msg.includes('local_admin')) {
      return '本地服务会话未就绪，请刷新页面后重试'
    }
    if (msg.includes('timed out') || msg.includes('timeout')) {
      return '服务商响应超时，请检查网络连接或接口地址'
    }
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('network_error')) {
      return '无法连接到本地网关服务，请确认本地服务已启动'
    }
    if (msg.startsWith('Provider rejected the request: ')) {
      return `服务商拒绝请求：${msg.replace('Provider rejected the request: ', '')}`
    }
    return msg
  }
  return '本地 API 网关暂不可用'
}

function replaceProvider(
  providers: ProviderMetadata[],
  provider: ProviderMetadata,
): ProviderMetadata[] {
  const exists = providers.some((candidate) => candidate.id === provider.id)
  return exists
    ? providers.map((candidate) =>
        candidate.id === provider.id ? provider : candidate,
      )
    : [...providers, provider]
}

export function ProviderCatalogProvider({
  children,
  gateway = gatewayClient,
  canvasScope,
}: {
  children: ReactNode
  gateway?: ProviderGateway
  canvasScope?: CanvasApiScope
}) {
  const [providers, setProviders] = useState<ProviderMetadata[]>([])
  const providersRef = useRef<ProviderMetadata[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<string>()
  const [catalogs, setCatalogs] = useState<Record<string, ProviderCatalog>>({})
  const catalogsRef = useRef<Record<string, ProviderCatalog>>({})
  const syncInFlightRef = useRef(new Map<string, Promise<ProviderCatalog | undefined>>())
  const automaticSyncCompletedAtRef = useRef(new Map<string, number>())
  const catalogLoadErrorsRef = useRef(new Set<string>())
  const apiManagementAllowedRef = useRef(true)
  const [syncingProviderIds, setSyncingProviderIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<string>()
  const [error, setError] = useState<string>()
  const lifecycleRef = useRef(new AbortController())

  const rememberCatalog = useCallback((providerId: string, next: ProviderCatalog) => {
    const updated = { ...catalogsRef.current, [providerId]: next }
    catalogsRef.current = updated
    setCatalogs(updated)
  }, [])

  const setApiManagementAllowed = useCallback((allowed: boolean) => {
    apiManagementAllowedRef.current = allowed
  }, [])

  const rememberProvider = useCallback((provider: ProviderMetadata) => {
    setProviders((current) => {
      const updated = replaceProvider(current, provider)
      providersRef.current = updated
      return updated
    })
  }, [])

  const withAction = useCallback(
    async <T,>(key: string, operation: (signal: AbortSignal) => Promise<T>) => {
      setBusyAction(key)
      setError(undefined)
      try {
        return await operation(lifecycleRef.current.signal)
      } catch (caught) {
        if (!lifecycleRef.current.signal.aborted) setError(errorMessage(caught))
        return undefined
      } finally {
        setBusyAction((current) => (current === key ? undefined : current))
      }
    },
    [],
  )

  const loadCatalog = useCallback(
    async (providerId: string) => {
      try {
        const next = await gateway.getCatalog(providerId, {
          signal: lifecycleRef.current.signal,
        })
        catalogLoadErrorsRef.current.delete(providerId)
        rememberCatalog(providerId, next)
        setError(undefined)
        return next
      } catch (caught) {
        if (isMissingCatalogError(caught)) {
          catalogLoadErrorsRef.current.delete(providerId)
          return catalogsRef.current[providerId]
        }
        catalogLoadErrorsRef.current.add(providerId)
        if (!lifecycleRef.current.signal.aborted) setError(errorMessage(caught))
        return catalogsRef.current[providerId]
      }
    },
    [gateway, rememberCatalog],
  )

  const runProviderSync = useCallback((
    providerId: string,
    source: 'automatic' | 'manual',
    force = false,
  ) => {
    if (!apiManagementAllowedRef.current) {
      return loadCatalog(providerId)
    }
    const existing = syncInFlightRef.current.get(providerId)
    if (existing) return existing

    const automaticSyncCompletedAt = automaticSyncCompletedAtRef.current.get(providerId)
    if (
      source === 'manual' &&
      !force &&
      !catalogLoadErrorsRef.current.has(providerId) &&
      automaticSyncCompletedAt !== undefined &&
      Date.now() - automaticSyncCompletedAt < 2_500
    ) {
      return Promise.resolve(catalogsRef.current[providerId])
    }

    const operation = (async (): Promise<ProviderCatalog | undefined> => {
      setSyncingProviderIds((current) => new Set(current).add(providerId))
      setBusyAction(`sync:${providerId}`)
      if (
        !catalogsRef.current[providerId] &&
        !catalogLoadErrorsRef.current.has(providerId)
      ) setError(undefined)
      try {
        const next = await gateway.syncProvider(providerId, {
          signal: lifecycleRef.current.signal,
        })
        if (!next) throw new Error('模型目录同步未返回可用数据')
        rememberCatalog(providerId, next)
        setProviders((current) => {
          const updated = current.map((provider) =>
            provider.id === providerId
              ? { ...provider, lastSyncedAt: next.fetchedAt }
              : provider)
          providersRef.current = updated
          return updated
        })
        if (source === 'automatic') {
          automaticSyncCompletedAtRef.current.set(providerId, Date.now())
        } else {
          catalogLoadErrorsRef.current.delete(providerId)
        }
        if (source === 'manual' || !catalogLoadErrorsRef.current.has(providerId)) {
          setError(undefined)
        }
        return next
      } catch (caught) {
        if (!lifecycleRef.current.signal.aborted) {
          setError(errorMessage(caught))
        }
        return undefined
      } finally {
        syncInFlightRef.current.delete(providerId)
        setSyncingProviderIds((current) => {
          const next = new Set(current)
          next.delete(providerId)
          return next
        })
        setBusyAction((current) => current === `sync:${providerId}` ? undefined : current)
      }
    })()
    syncInFlightRef.current.set(providerId, operation)
    return operation
  }, [gateway, loadCatalog, rememberCatalog])

  const syncProvider = useCallback(
    (providerId: string, options?: { force?: boolean }) =>
      runProviderSync(providerId, 'manual', options?.force),
    [runProviderSync],
  )

  const ensureCatalog = useCallback(async (
    providerId: string,
    providerMetadata?: ProviderMetadata,
  ) => {
    const cached = await loadCatalog(providerId)
    const provider = providerMetadata ?? providersRef.current.find(
      (candidate) => candidate.id === providerId,
    )
    const canSynchronize =
      apiManagementAllowedRef.current &&
      provider?.enabled === true &&
      (provider.secretConfigured || provider.available)
    if (
      canSynchronize &&
      (!cached || cached.stale || !isProviderCatalogFresh(cached))
    ) {
      void runProviderSync(providerId, 'automatic')
    }
    return cached
  }, [loadCatalog, runProviderSync])

  const refreshProviders = useCallback(async () => {
    setLoading(true)
    const next = await withAction('providers', (signal) =>
      gateway.listProviders({ signal }),
    )
    if (!next) {
      setLoading(false)
      return
    }
    providersRef.current = next
    setProviders(next)
    const preferred = next.find((provider) => provider.preferred) ?? next[0]
    setSelectedProviderId((current) =>
      current && next.some((provider) => provider.id === current)
        ? current
        : preferred?.id,
    )
    setLoading(false)
    if (preferred) await ensureCatalog(preferred.id, preferred)
  }, [ensureCatalog, gateway, withAction])

  useEffect(() => {
    const controller = new AbortController()
    lifecycleRef.current = controller
    gateway.setCanvasApiScope?.(canvasScope)
    providersRef.current = []
    catalogsRef.current = {}
    catalogLoadErrorsRef.current.clear()
    automaticSyncCompletedAtRef.current.clear()
    syncInFlightRef.current.clear()
    setProviders([])
    setCatalogs({})
    setSelectedProviderId(undefined)
    setError(undefined)
    setLoading(true)
    void refreshProviders()
    return () => controller.abort()
  }, [canvasScope?.canvasId, canvasScope?.projectId, gateway, refreshProviders])

  const selectProvider = useCallback(
    async (providerId: string) => {
      setSelectedProviderId(providerId)
      await ensureCatalog(
        providerId,
        providersRef.current.find((provider) => provider.id === providerId),
      )
    },
    [ensureCatalog],
  )

  const testProvider = useCallback(
    async (providerId: string) => {
      if (!apiManagementAllowedRef.current) return undefined
      const next = await withAction(`test:${providerId}`, (signal) =>
        gateway.testProvider(providerId, { signal }),
      )
      if (next) rememberProvider(next)
      return next
    },
    [gateway, rememberProvider, withAction],
  )

  const saveProvider = useCallback(
    async (providerId: string, update: ProviderUpdate) => {
      if (!apiManagementAllowedRef.current) return undefined
      const next = await withAction(`save:${providerId}`, (signal) =>
        gateway.updateProvider(providerId, update, { signal }),
      )
      if (next) {
        rememberProvider(next)
        if (next.preferred) setSelectedProviderId(next.id)
      }
      return next
    },
    [gateway, rememberProvider, withAction],
  )

  const setProviderSecret = useCallback(
    async (providerId: string, secret: string) => {
      if (!apiManagementAllowedRef.current) return undefined
      const next = await withAction(`secret:${providerId}`, (signal) =>
        gateway.setProviderSecret(providerId, secret, { signal }),
      )
      if (next) rememberProvider(next)
      return next
    },
    [gateway, rememberProvider, withAction],
  )

  const getProviderSecret = useCallback(
    async (providerId: string) => {
      if (!apiManagementAllowedRef.current) return undefined
      return withAction(`secret:${providerId}`, (signal) =>
        gateway.getProviderSecret(providerId, { signal }),
      )
    },
    [gateway, withAction],
  )

  const clearProviderSecret = useCallback(
    async (providerId: string) => {
      if (!apiManagementAllowedRef.current) return undefined
      const next = await withAction(`secret:${providerId}`, (signal) =>
        gateway.clearProviderSecret(providerId, { signal }),
      )
      if (next) rememberProvider(next)
      return next
    },
    [gateway, rememberProvider, withAction],
  )

  const deleteProvider = useCallback(
    async (providerId: string) => {
      if (!apiManagementAllowedRef.current) return false
      const res = await withAction(`delete:${providerId}`, (signal) =>
        gateway.deleteProvider(providerId, { signal }),
      )
      if (res?.ok) {
        setProviders((current) => current.filter((p) => p.id !== providerId))
        setCatalogs((current) => {
          const next = { ...current }
          delete next[providerId]
          return next
        })
        if (selectedProviderId === providerId) {
          setSelectedProviderId(undefined)
        }
        return true
      }
      return false
    },
    [gateway, selectedProviderId, withAction],
  )

  const preferredProvider = providers.find((provider) => provider.preferred)
  const selectedProvider = providers.find(
    (provider) => provider.id === selectedProviderId,
  )
  const value = useMemo<ProviderCatalogState>(
    () => ({
      providers,
      preferredProvider,
      selectedProvider,
      selectedProviderId,
      catalog: selectedProviderId ? catalogs[selectedProviderId] : undefined,
      catalogs,
      catalogSyncing: selectedProviderId
        ? syncingProviderIds.has(selectedProviderId)
        : false,
      loading,
      busyAction,
      error,
      setApiManagementAllowed,
      selectProvider,
      refreshProviders,
      refreshCatalog: (providerId = selectedProviderId) =>
        providerId ? ensureCatalog(providerId) : Promise.resolve(undefined),
      syncProvider,
      testProvider,
      saveProvider,
      deleteProvider,
      getProviderSecret,
      setProviderSecret,
      clearProviderSecret,
    }),
    [
      providers,
      preferredProvider,
      selectedProvider,
      selectedProviderId,
      catalogs,
      syncingProviderIds,
      loading,
      busyAction,
      error,
      setApiManagementAllowed,
      selectProvider,
      refreshProviders,
      ensureCatalog,
      syncProvider,
      testProvider,
      saveProvider,
      deleteProvider,
      setProviderSecret,
      clearProviderSecret,
    ],
  )

  return (
    <ProviderCatalogContext.Provider value={value}>
      {children}
    </ProviderCatalogContext.Provider>
  )
}

export function useProviderCatalog(): ProviderCatalogState {
  const value = useContext(ProviderCatalogContext)
  if (!value) {
    throw new Error('useProviderCatalog must be used inside ProviderCatalogProvider')
  }
  return value
}

export function useOptionalProviderCatalog(): ProviderCatalogState | undefined {
  return useContext(ProviderCatalogContext) ?? undefined
}
