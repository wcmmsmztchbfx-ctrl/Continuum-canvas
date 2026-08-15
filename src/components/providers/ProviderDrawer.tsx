import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  TestTube2,
  X,
} from 'lucide-react'

import type { ProviderMetadata } from '../../contracts/generation'
import {
  GENERATION_ADAPTER_TYPES,
  OFFICIAL_AISTARTLAB_BASE_URL,
  type ImageRequestMode,
} from '../../contracts/catalog'
import type { ProviderUpdate } from '../../services/gatewayClient'
import { useEscapeClose } from '../overlays/useEscapeClose'
import { useProviderCatalog } from './ProviderCatalogContext'

interface ProviderDrawerProps {
  onClose: () => void
  onNotify?: (message: string, tone?: 'info' | 'success' | 'error') => void
  open: boolean
  readOnly?: boolean
}

interface ProviderDraft extends ProviderUpdate {
  id: string
}

const emptyDraft: ProviderDraft = {
  id: '',
  name: '',
  adapterType: 'custom-compatible',
  baseUrl: '',
  enabled: true,
  preferred: false,
  imageRequestMode: 'auto',
}

const focusableSelector =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => !element.hasAttribute('hidden'),
  )
}

function providerDraft(provider: ProviderMetadata): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    adapterType: provider.adapterType,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    preferred: provider.preferred,
    imageRequestMode: provider.imageRequestMode ?? 'auto',
  }
}

export function ProviderDrawer({
  onClose,
  onNotify,
  open,
  readOnly = false,
}: ProviderDrawerProps) {
  const state = useProviderCatalog()
  const { setApiManagementAllowed } = state
  const [selectedId, setSelectedId] = useState<string>()
  const [draft, setDraft] = useState<ProviderDraft>(emptyDraft)
  const [adding, setAdding] = useState(false)
  const [secret, setSecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [createStage, setCreateStage] = useState<string>()
  const [testFeedback, setTestFeedback] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)
  const surfaceRef = useRef<HTMLElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  useEscapeClose(open, onClose)

  useLayoutEffect(() => {
    setApiManagementAllowed(!readOnly)
  }, [readOnly, setApiManagementAllowed])

  const selected = useMemo(
    () => state.providers.find((provider) => provider.id === selectedId),
    [selectedId, state.providers],
  )

  const isDraftDirty = useMemo(() => {
    if (!selected) return true
    return (
      draft.name.trim() !== selected.name ||
      draft.baseUrl.trim() !== selected.baseUrl ||
      draft.enabled !== selected.enabled ||
      draft.preferred !== selected.preferred ||
      draft.adapterType !== selected.adapterType ||
      draft.imageRequestMode !== (selected.imageRequestMode ?? 'auto')
    )
  }, [draft, selected])

  useEffect(() => {
    if (!open || adding || selectedId) return
    const initial = state.preferredProvider ?? state.providers[0]
    if (!initial) return
    setSelectedId(initial.id)
    setDraft(providerDraft(initial))
  }, [adding, open, selectedId, state.preferredProvider, state.providers])

  useEffect(() => {
    if (!open || !surfaceRef.current) return
    const surface = surfaceRef.current
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    focusableElements(surface)[0]?.focus()
    const keepFocusInside = (event: FocusEvent) => {
      if (event.target instanceof Node && surface.contains(event.target)) return
      focusableElements(surface)[0]?.focus()
    }
    document.addEventListener('focusin', keepFocusInside)
    return () => {
      document.removeEventListener('focusin', keepFocusInside)
      const previous = previousFocusRef.current
      if (previous?.isConnected) previous.focus()
    }
  }, [open])

  if (!open) return null

  const chooseProvider = (provider: ProviderMetadata) => {
    setAdding(false)
    setSelectedId(provider.id)
    setDraft(providerDraft(provider))
    setSecret('')
    setTestFeedback(null)
    void state.selectProvider(provider.id)
  }

  const saveMetadata = async () => {
    if (readOnly) return
    const id = draft.id.trim().toLowerCase()
    if (!id || !draft.name.trim() || !draft.baseUrl.trim()) {
      onNotify?.('请完整填写供应商 ID、名称和接口地址', 'error')
      return
    }
    const saved = await state.saveProvider(id, {
      name: draft.name.trim(),
      adapterType: draft.adapterType,
      baseUrl: draft.baseUrl.trim(),
      enabled: draft.enabled,
      preferred: draft.preferred,
      imageRequestMode: draft.imageRequestMode,
    })
    if (!saved) return
    if (secret.trim()) {
      await state.setProviderSecret(id, secret.trim())
      setSecret('')
    }
    setAdding(false)
    setSelectedId(saved.id)
    setDraft(providerDraft(saved))
    await state.selectProvider(saved.id)
    onNotify?.('供应商配置已保存', 'success')
  }

  const saveAndVerify = async () => {
    if (readOnly) return
    const id = draft.id.trim().toLowerCase()
    if (!id || !draft.name.trim() || !draft.baseUrl.trim() || !secret.trim()) {
      onNotify?.('请完整填写供应商资料和 API Key', 'error')
      return
    }
    setCreateStage('正在保存供应商资料')
    const saved = await state.saveProvider(id, {
      name: draft.name.trim(), adapterType: draft.adapterType,
      baseUrl: draft.baseUrl.trim(), enabled: draft.enabled,
      preferred: draft.preferred, imageRequestMode: draft.imageRequestMode,
    })
    if (!saved) { setCreateStage('供应商资料保存失败，可直接重试'); return }
    setCreateStage('正在保存 API Key')
    const secured = await state.setProviderSecret(id, secret.trim())
    if (!secured) { setCreateStage('API Key 保存失败，资料已保留'); return }
    setCreateStage('正在测试连接')
    const tested = await state.testProvider(id)
    if (!tested) { setCreateStage('连接测试失败，可直接重试'); return }
    setCreateStage('正在同步模型')
    const catalog = await state.syncProvider(id, { force: true })
    if (!catalog) { setCreateStage('模型同步失败，可直接重试'); return }
    await state.selectProvider(id)
    setAdding(false)
    setSelectedId(id)
    setDraft(providerDraft(secured))
    setSecret('')
    setCreateStage(undefined)
    onNotify?.('供应商已保存、验证并同步', 'success')
  }

  const saveSecret = async () => {
    if (readOnly) return
    if (!selectedId || unsupported || !secret.trim()) return
    const saved = await state.setProviderSecret(selectedId, secret.trim())
    if (!saved) return
    setSecret('')
    onNotify?.('API Key 已更新', 'success')
  }

  const clearSecret = async () => {
    if (readOnly) return
    if (!selectedId) return
    const cleared = await state.clearProviderSecret(selectedId)
    if (cleared) onNotify?.('API Key 已清除', 'info')
  }

  const handleTestConnection = async () => {
    if (readOnly || !selectedId || unsupported) return
    setTestFeedback(null)
    const id = draft.id.trim().toLowerCase()
    if (secret.trim()) {
      await state.setProviderSecret(id, secret.trim())
      setSecret('')
    }
    if (isDraftDirty && draft.name.trim() && draft.baseUrl.trim()) {
      await state.saveProvider(id, {
        name: draft.name.trim(),
        adapterType: draft.adapterType,
        baseUrl: draft.baseUrl.trim(),
        enabled: draft.enabled,
        preferred: draft.preferred,
        imageRequestMode: draft.imageRequestMode,
      })
    }
    const result = await state.testProvider(id)
    if (result) {
      setTestFeedback({
        type: 'success',
        message: '连接测试成功！API Key 有效，服务正常可用',
      })
      onNotify?.('连接测试成功！API Key 有效，服务正常', 'success')
    } else {
      const errMsg = state.error ? `连接测试失败：${state.error}` : '连接测试失败，请检查 API Key 或接口地址'
      setTestFeedback({
        type: 'error',
        message: errMsg,
      })
      onNotify?.(errMsg, 'error')
    }
  }

  const handleSyncCatalog = async () => {
    if (readOnly || !selectedId || unsupported) return
    setTestFeedback(null)
    const id = draft.id.trim().toLowerCase()
    if (secret.trim()) {
      await state.setProviderSecret(id, secret.trim())
      setSecret('')
    }
    if (isDraftDirty && draft.name.trim() && draft.baseUrl.trim()) {
      await state.saveProvider(id, {
        name: draft.name.trim(),
        adapterType: draft.adapterType,
        baseUrl: draft.baseUrl.trim(),
        enabled: draft.enabled,
        preferred: draft.preferred,
        imageRequestMode: draft.imageRequestMode,
      })
    }
    const catalog = await state.syncProvider(id, { force: true })
    if (catalog) {
      setTestFeedback({
        type: 'success',
        message: `模型目录同步成功！已获取 ${catalog.models.length} 个可用模型`,
      })
      onNotify?.(`模型目录同步成功！已获取 ${catalog.models.length} 个可用模型`, 'success')
    } else {
      const errMsg = state.error ? `模型同步失败：${state.error}` : '模型同步失败，请检查 API Key 或服务状态'
      setTestFeedback({
        type: 'error',
        message: errMsg,
      })
      onNotify?.(errMsg, 'error')
    }
  }

  const unsupported = !GENERATION_ADAPTER_TYPES.has(draft.adapterType)

  return (
    <div
      className="provider-drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        aria-label="管理 API 接入"
        aria-modal="true"
        className="overlay-surface provider-drawer"
        onKeyDownCapture={(event) => {
          if (event.key !== 'Tab' || !surfaceRef.current) return
          const items = focusableElements(surfaceRef.current)
          if (items.length === 0) return
          const first = items[0]!
          const last = items.at(-1)!
          const active = document.activeElement
          if (event.shiftKey && (active === first || !surfaceRef.current.contains(active))) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && active === last) {
            event.preventDefault()
            first.focus()
          }
        }}
        ref={surfaceRef}
        role="dialog"
      >
        <header className="provider-drawer__header">
          <div>
            <ServerCog aria-hidden="true" />
            <div>
              <strong>管理 API 接入</strong>
              <small>配置 AI 模型服务商与接口凭证</small>
            </div>
          </div>
          <button
            aria-label="关闭管理 API 接入"
            className="overlay-icon-button"
            onClick={onClose}
            title="关闭"
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="provider-drawer__layout">
          <aside className="provider-drawer__list" aria-label="供应商列表">
            <button
              className="provider-drawer__add"
              disabled={readOnly}
              onClick={() => {
                setAdding(true)
                setSelectedId(undefined)
                setDraft({ ...emptyDraft, adapterType: 'openai-compatible' })
                setSecret('')
                setCreateStage(undefined)
              }}
              type="button"
            >
              <Plus aria-hidden="true" />
              新增供应商
            </button>
            {state.providers.map((provider) => (
              <button
                aria-label={provider.name}
                aria-current={!adding && selectedId === provider.id}
                className="provider-list-item"
                key={provider.id}
                onClick={() => chooseProvider(provider)}
                type="button"
              >
                <span>{provider.name.slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{provider.name}</strong>
                  <small>{provider.available ? '可生成' : provider.secretConfigured ? '已配密钥' : '未配置'}</small>
                </div>
                {provider.preferred ? <Check aria-label="首选供应商" /> : null}
              </button>
            ))}
          </aside>

          <main className="provider-drawer__content">
            <div className="provider-drawer__section-heading">
              <div>
                <strong>{adding ? '新增供应商' : draft.name || '供应商配置'}</strong>
                <small>{adding ? '建立新的本地供应商记录' : draft.id}</small>
              </div>
              {!adding && selected ? (
                <span data-available={selected.available || undefined}>
                  {selected.available ? '可生成' : selected.secretConfigured ? '已配置密钥' : '未配置密钥'}
                </span>
              ) : null}
            </div>

            <div className="provider-form-grid">
              <label className="integration-field">
                <span>供应商 ID</span>
                <input
                  aria-label="供应商 ID"
                  autoComplete="off"
                  disabled={!adding}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, id: event.target.value }))
                  }
                  placeholder="provider-id"
                  value={draft.id}
                />
              </label>
              <label className="integration-field">
                <span>供应商名称</span>
                <input
                  aria-label="供应商名称"
                  autoComplete="off"
                  disabled={readOnly}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  value={draft.name}
                />
              </label>
              <label className="integration-field provider-form-grid__wide">
                <span>接口地址</span>
                <input
                  aria-label="接口地址"
                  autoComplete="off"
                  disabled={readOnly}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, baseUrl: event.target.value }))
                  }
                  readOnly={draft.adapterType === 'aistartlab-openapi'}
                  spellCheck={false}
                  title={draft.adapterType === 'aistartlab-openapi' ? '官方适配器地址已锁定' : undefined}
                  value={draft.baseUrl}
                />
              </label>
              <label className="integration-field provider-form-grid__wide">
                <span>适配器</span>
                <select
                  aria-label="适配器"
                  disabled={readOnly}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      adapterType: event.target.value,
                      baseUrl: event.target.value === 'aistartlab-openapi'
                        ? OFFICIAL_AISTARTLAB_BASE_URL
                        : current.baseUrl,
                      imageRequestMode:
                        event.target.value === 'openai-compatible'
                          ? current.imageRequestMode ?? 'auto'
                          : 'auto',
                    }))
                  }
                  value={draft.adapterType}
                >
                  <option value="aistartlab-openapi">AIStartLab OpenAPI</option>
                  <option value="openai-compatible">OpenAI 兼容</option>
                  <option value="custom-compatible">自定义兼容（未实现）</option>
                </select>
              </label>
              {draft.adapterType === 'openai-compatible' ? (
                <label className="integration-field provider-form-grid__wide">
                  <span>图片请求模式</span>
                  <select
                    aria-label="图片请求模式"
                    disabled={readOnly}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        imageRequestMode: event.target.value as ImageRequestMode,
                      }))
                    }
                    value={draft.imageRequestMode ?? 'auto'}
                  >
                    <option value="auto">自动（标准 OpenAI）</option>
                    <option value="openai">标准 OpenAI</option>
                    <option value="openai-json">JSON 变体</option>
                    <option value="openai-responses">Responses API</option>
                  </select>
                  <small className="provider-form-grid__hint">
                    部分兼容平台用非标准请求结构；不确定时选"自动"。
                  </small>
                </label>
              ) : null}

              {!unsupported ? (
                <label className="integration-field provider-form-grid__wide">
                  <div className="provider-form-grid__label-row">
                    <span>API Key</span>
                    {!adding && selected?.secretConfigured ? (
                      <span className="provider-form-grid__key-status">
                        已配置密钥
                        <button
                          className="provider-form-grid__clear-key-link"
                          disabled={readOnly || state.busyAction === `secret:${selected.id}`}
                          onClick={(e) => {
                            e.preventDefault()
                            void clearSecret()
                          }}
                          type="button"
                        >
                          清除
                        </button>
                      </span>
                    ) : null}
                  </div>
                  <div className="integration-field__input-wrapper">
                    <input
                      aria-label={adding ? 'API Key' : '替换 API Key'}
                      autoComplete="off"
                      disabled={readOnly}
                      onChange={(event) => setSecret(event.target.value)}
                      placeholder={
                        adding
                          ? '输入供应商 API Key'
                          : selected?.secretConfigured
                            ? (selected.maskedSecret ?? '已配置密钥（输入以替换）')
                            : '输入供应商 API Key'
                      }
                      spellCheck={false}
                      type={showSecret ? 'text' : 'password'}
                      value={secret}
                    />
                    <button
                      aria-label={showSecret ? '隐藏密钥' : '显示明文'}
                      className="integration-field__toggle-visibility"
                      onClick={() => setShowSecret((prev) => !prev)}
                      tabIndex={-1}
                      title={showSecret ? '隐藏密钥' : '显示明文'}
                      type="button"
                    >
                      {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  {createStage ? <p aria-live="polite" className="provider-form-grid__stage">{createStage}</p> : null}
                </label>
              ) : null}
            </div>

            <div className="provider-toggle-row">
              <label>
                <input
                  checked={draft.enabled}
                  disabled={readOnly}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, enabled: event.target.checked }))
                  }
                  type="checkbox"
                />
                启用供应商
              </label>
              <label>
                <input
                  checked={draft.preferred}
                  disabled={readOnly}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, preferred: event.target.checked }))
                  }
                  type="checkbox"
                />
                设为首选
              </label>
            </div>

            {unsupported ? (
              <p className="provider-drawer__unsupported">当前适配器不支持生成</p>
            ) : null}

            <div className="provider-drawer__metadata-actions">
              {adding ? (
                <button
                  className="overlay-primary-button"
                  disabled={readOnly || Boolean(state.busyAction)}
                  onClick={() => void saveAndVerify()}
                  type="button"
                >
                  <Check aria-hidden="true" />保存并验证
                </button>
              ) : null}
              <button
                className={adding ? 'overlay-text-button' : 'overlay-primary-button'}
                disabled={readOnly || state.busyAction === `save:${draft.id}`}
                onClick={() => void saveMetadata()}
                type="button"
              >
                <Save aria-hidden="true" />
                保存供应商
              </button>
              {!adding && !unsupported && secret.trim() ? (
                <button
                  className="overlay-primary-button"
                  disabled={readOnly || state.busyAction === `secret:${selected?.id}`}
                  onClick={() => void saveSecret()}
                  type="button"
                >
                  <KeyRound aria-hidden="true" />保存新密钥
                </button>
              ) : null}
              {!adding && !unsupported ? (
                <>
                  <button
                    className="overlay-text-button"
                    disabled={readOnly || state.busyAction === `test:${selectedId}` || state.busyAction === `sync:${selectedId}`}
                    onClick={() => void handleTestConnection()}
                    type="button"
                  >
                    <TestTube2 aria-hidden="true" />
                    {state.busyAction === `test:${selectedId}` ? '正在测试...' : '测试连接'}
                  </button>
                  <button
                    className="overlay-text-button"
                    disabled={readOnly || state.busyAction === `test:${selectedId}` || state.busyAction === `sync:${selectedId}`}
                    onClick={() => void handleSyncCatalog()}
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" />
                    {state.busyAction === `sync:${selectedId}` ? '正在同步...' : '同步模型'}
                  </button>
                </>
              ) : null}
            </div>

            {testFeedback ? (
              <div className={`provider-drawer__test-feedback is-${testFeedback.type}`} role="status">
                {testFeedback.type === 'success' ? <Check size={14} /> : <X size={14} />}
                <span>{testFeedback.message}</span>
              </div>
            ) : null}

            {!adding && selected && !unsupported && state.catalog && state.catalog.models.length > 0 ? (
              <div className="provider-drawer__catalog-preview">
                <div className="provider-drawer__catalog-preview-header">
                  <span>已同步可用模型 ({state.catalog.models.length})</span>
                  <small>
                    {state.catalog.fetchedAt
                      ? `更新于 ${new Date(state.catalog.fetchedAt).toLocaleTimeString()}`
                      : '已同步'}
                  </small>
                </div>
                <div className="provider-drawer__catalog-tags">
                  {state.catalog.models.slice(0, 16).map((m) => (
                    <span
                      key={`${m.mediaType}-${m.channel}-${m.model}`}
                      className="provider-drawer__model-tag"
                      title={`${m.model} (${m.mediaType})`}
                    >
                      {m.label || m.title || m.model}
                    </span>
                  ))}
                  {state.catalog.models.length > 16 ? (
                    <span className="provider-drawer__model-tag-more">
                      +{state.catalog.models.length - 16} 更多
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}

            {!adding && selected && !unsupported && !state.catalog && !state.error && !testFeedback ? (
              <p className="provider-drawer__catalog-empty">
                {selected.secretConfigured
                  ? '目录尚未同步，点击上方「同步模型」获取可用模型'
                  : '配置密钥后同步目录'}
              </p>
            ) : null}
            {state.error && !testFeedback ? (
              <div className="provider-drawer__test-feedback is-error" role="alert">
                <X size={14} />
                <span>{state.error}</span>
              </div>
            ) : null}
          </main>
        </div>
      </section>
    </div>
  )
}
