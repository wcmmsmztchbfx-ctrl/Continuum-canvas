import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Brush,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  MessageSquare,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  TestTube2,
  Trash2,
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

export interface ProviderDrawerProps {
  onClose: () => void
  onNotify?: (message: string, tone?: 'info' | 'success' | 'error') => void
  open: boolean
  readOnly?: boolean
  initialTab?: 'media' | 'agent'
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

export interface AgentProviderItem {
  id: string
  name: string
  baseUrl: string
  model: string
  enabled: boolean
  preferred: boolean
  secretConfigured: boolean
  maskedSecret?: string
}

export const AGENT_LLM_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { id: 'siliconflow', name: '硅基流动 (SiliconFlow)', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { id: 'kimi', name: '月之暗面 (Kimi)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'zhipu', name: '智谱 AI (GLM)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'qwen', name: '通义千问 (Qwen)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'qianfan', name: '百度千帆 (文心一言)', baseUrl: 'https://qianfan.baidubce.com/v2', model: 'ernie-4.0-8k-latest' },
  { id: 'lingyi', name: '零一万物 (01.AI)', baseUrl: 'https://api.lingyiwanwu.com/v1', model: 'yi-lightning' },
  { id: 'baichuan', name: '百川智能 (Baichuan)', baseUrl: 'https://api.baichuan-ai.com/v1', model: 'Baichuan4' },
  { id: 'minimax', name: 'MiniMax (海螺 AI)', baseUrl: 'https://api.minimax.chat/v1', model: 'abab6.5s-chat' },
  { id: 'groq', name: 'Groq (极速推理)', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-1.5-flash' },
  { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
  { id: 'custom', name: '自定义兼容大模型', baseUrl: 'https://api.example.com/v1', model: 'custom-model' },
] as const

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
  initialTab = 'media',
}: ProviderDrawerProps) {
  const state = useProviderCatalog()
  const { setApiManagementAllowed } = state
  const [activeTab, setActiveTab] = useState<'media' | 'agent'>(initialTab)

  // Media providers state
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

  // Agent LLM Multi-Provider state
  const [agentProviders, setAgentProviders] = useState<AgentProviderItem[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string>('deepseek')
  const [agentAdding, setAgentAdding] = useState(false)
  const [agentDraft, setAgentDraft] = useState({
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    enabled: true,
    preferred: true,
    secret: '',
  })
  const [agentShowSecret, setAgentShowSecret] = useState(false)
  const [agentTesting, setAgentTesting] = useState(false)
  const [agentSaving, setAgentSaving] = useState(false)
  const [agentFeedback, setAgentFeedback] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  const surfaceRef = useRef<HTMLElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  useEscapeClose(open, onClose)

  useLayoutEffect(() => {
    setApiManagementAllowed(!readOnly)
  }, [readOnly, setApiManagementAllowed])

  // Load Agent LLM Providers
  const loadAgentProviders = async () => {
    try {
      const res = await fetch('/api/agent/providers')
      if (res.ok) {
        const data = await res.json()
        const providers: AgentProviderItem[] = Array.isArray(data.providers) ? data.providers : []
        setAgentProviders(providers)
        if (providers.length > 0) {
          const currentId = selectedAgentId
          const matched = providers.find((p) => p.id === currentId) ||
            providers.find((p) => p.preferred) ||
            providers[0]
          if (matched && (!selectedAgentId || !agentAdding)) {
            setSelectedAgentId(matched.id)
            setAgentDraft({
              id: matched.id,
              name: matched.name,
              baseUrl: matched.baseUrl,
              model: matched.model,
              enabled: matched.enabled,
              preferred: matched.preferred,
              secret: '',
            })
          }
        } else {
          setSelectedAgentId('')
          setAgentAdding(true)
          setAgentDraft({
            id: 'deepseek',
            name: 'DeepSeek',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat',
            enabled: true,
            preferred: true,
            secret: '',
          })
        }
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (open) {
      if (initialTab) setActiveTab(initialTab)
      void loadAgentProviders()
    }
  }, [open, initialTab])

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
    if (!open || adding) return
    if (!selectedId) {
      const initial = state.preferredProvider ?? state.providers[0]
      if (initial) {
        setSelectedId(initial.id)
        setDraft(providerDraft(initial))
      }
    }
  }, [adding, open, selectedId, state.preferredProvider, state.providers])

  useEffect(() => {
    if (!open || !selectedId || !selected?.secretConfigured) {
      if (!selected?.secretConfigured) setSecret('')
      return
    }
    let active = true
    void state.getProviderSecret(selectedId).then((key) => {
      if (active && key) {
        setSecret(key)
      }
    })
    return () => {
      active = false
    }
  }, [open, selectedId, selected?.secretConfigured, state.getProviderSecret])

  // Auto-fetch plaintext secret for selected Agent Provider
  useEffect(() => {
    if (!open || !selectedAgentId || activeTab !== 'agent') return
    const found = agentProviders.find((p) => p.id === selectedAgentId)
    if (!found?.secretConfigured) {
      if (!agentAdding) {
        setAgentDraft((prev) => (prev.id === selectedAgentId ? { ...prev, secret: '' } : prev))
      }
      return
    }
    let active = true
    void fetch(`/api/agent/providers/${encodeURIComponent(selectedAgentId)}/secret`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data && typeof data.secret === 'string') {
          setAgentDraft((prev) => (prev.id === selectedAgentId ? { ...prev, secret: data.secret } : prev))
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [open, selectedAgentId, activeTab, agentProviders, agentAdding])

  useEffect(() => {
    if (!open) {
      setTestFeedback(null)
      setAgentFeedback(null)
      window.dispatchEvent(new CustomEvent('agent-providers-changed'))
      return
    }
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const surface = surfaceRef.current
    if (!surface) return
    const elements = focusableElements(surface)
    elements[0]?.focus()
    return () => {
      previousFocusRef.current?.focus?.()
    }
  }, [open])

  const chooseProvider = (provider: ProviderMetadata) => {
    setAdding(false)
    setSelectedId(provider.id)
    setDraft(providerDraft(provider))
    setCreateStage(undefined)
    setTestFeedback(null)
  }

  const unsupported = !GENERATION_ADAPTER_TYPES.has(draft.adapterType)

  const saveMetadata = async () => {
    const trimmedId = draft.id.trim()
    const trimmedName = draft.name.trim()
    const trimmedUrl = draft.baseUrl.trim()
    if (!trimmedId || !trimmedName || !trimmedUrl) {
      onNotify?.('请完整填写供应商 ID、名称与接口地址', 'error')
      return false
    }

    try {
      const saved = await state.saveProvider(trimmedId, {
        name: trimmedName,
        adapterType: draft.adapterType,
        baseUrl: trimmedUrl,
        enabled: draft.enabled,
        preferred: draft.preferred,
        imageRequestMode: draft.imageRequestMode,
      })

      if (!saved) return false

      if (secret.trim()) {
        await state.setProviderSecret(trimmedId, secret.trim())
      }

      onNotify?.('供应商配置已保存', 'success')
      setAdding(false)
      setSelectedId(saved.id)
      return true
    } catch (error) {
      onNotify?.(`保存供应商失败: ${error instanceof Error ? error.message : '未知错误'}`, 'error')
      return false
    }
  }

  const saveAndVerify = async () => {
    setTestFeedback(null)
    const success = await saveMetadata()
    if (!success) return

    const targetId = draft.id.trim()
    if (!targetId || unsupported) return

    setCreateStage('正在测试连接...')
    try {
      await state.testProvider(targetId)
      setTestFeedback({ type: 'success', message: '连接测试成功' })
      setCreateStage('正在同步可用模型...')
      await state.syncProvider(targetId)
      setCreateStage(undefined)
      onNotify?.('供应商测试与目录同步已完成', 'success')
    } catch (err: unknown) {
      setCreateStage(undefined)
      setTestFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : '测试或同步失败',
      })
      onNotify?.(`验证失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error')
    }
  }

  const handleTestConnection = async () => {
    if (readOnly || !selectedId || unsupported) return
    setTestFeedback(null)
    const id = draft.id.trim()
    if (secret.trim()) {
      await state.setProviderSecret(id, secret.trim())
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
    try {
      await state.testProvider(id)
      setTestFeedback({ type: 'success', message: '连接测试成功' })
      onNotify?.('连接测试成功', 'success')
    } catch (err: unknown) {
      setTestFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : '连接测试失败',
      })
    }
  }

  const handleSyncCatalog = async () => {
    if (readOnly || !selectedId || unsupported) return
    setTestFeedback(null)
    const id = draft.id.trim()
    if (secret.trim()) {
      await state.setProviderSecret(id, secret.trim())
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
    try {
      await state.syncProvider(id)
      onNotify?.('目录同步成功', 'success')
    } catch (err: unknown) {
      setTestFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : '同步失败',
      })
    }
  }

  const handleClearSecret = async () => {
    if (!selectedId) return
    if (!window.confirm('确定要清空该供应商已配置的 API Key 吗？')) return
    try {
      await state.clearProviderSecret(selectedId)
      setSecret('')
      onNotify?.('API Key 已清空', 'info')
    } catch (err: unknown) {
      onNotify?.(`清空失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error')
    }
  }

  // Agent LLM Save, Test, Clear & Delete
  const selectedAgent = useMemo(
    () => agentProviders.find((p) => p.id === selectedAgentId),
    [selectedAgentId, agentProviders],
  )

  const handleSelectAgent = (item: AgentProviderItem) => {
    setAgentAdding(false)
    setSelectedAgentId(item.id)
    setAgentDraft({
      id: item.id,
      name: item.name,
      baseUrl: item.baseUrl,
      model: item.model,
      enabled: item.enabled,
      preferred: item.preferred,
      secret: '',
    })
    setAgentFeedback(null)
    setAgentShowSecret(false)
  }

  const handleStartAddAgent = () => {
    setAgentAdding(true)
    setSelectedAgentId('')
    setAgentDraft({
      id: '',
      name: '',
      baseUrl: '',
      model: '',
      enabled: true,
      preferred: false,
      secret: '',
    })
    setAgentFeedback(null)
    setAgentShowSecret(false)
  }

  const handleSaveAgentConfig = async () => {
    const trimmedId = agentDraft.id.trim().toLowerCase()
    const trimmedName = agentDraft.name.trim()
    const trimmedUrl = agentDraft.baseUrl.trim()
    const trimmedModel = agentDraft.model.trim()

    if (!trimmedId || !trimmedName || !trimmedUrl || !trimmedModel) {
      onNotify?.('请完整填写供应商 ID、名称、接口地址与模型名称', 'error')
      setAgentFeedback({ type: 'error', message: '请完整填写供应商 ID、名称、接口地址与模型名称' })
      return
    }

    setAgentSaving(true)
    setAgentFeedback(null)
    try {
      const res = await fetch('/api/agent/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: trimmedId,
          name: trimmedName,
          baseUrl: trimmedUrl,
          model: trimmedModel,
          enabled: agentDraft.enabled,
          preferred: agentDraft.preferred,
          secret: agentDraft.secret.trim() || undefined,
        }),
      })

      if (res.ok) {
        setAgentFeedback({ type: 'success', message: `${trimmedName} 配置保存成功！` })
        onNotify?.(`Agent 大模型 [${trimmedName}] 配置已保存`, 'success')
        setAgentAdding(false)
        setSelectedAgentId(trimmedId)
        await loadAgentProviders()
        window.dispatchEvent(new CustomEvent('agent-providers-changed'))
      } else {
        const err = await res.json().catch(() => ({}))
        setAgentFeedback({ type: 'error', message: err.error?.message || '保存失败' })
        onNotify?.(`保存失败: ${err.error?.message || '未知错误'}`, 'error')
      }
    } catch (err: unknown) {
      setAgentFeedback({ type: 'error', message: err instanceof Error ? err.message : '网络请求失败' })
    } finally {
      setAgentSaving(false)
    }
  }

  const handleTestAgentConnection = async () => {
    const trimmedUrl = agentDraft.baseUrl.trim()
    const trimmedModel = agentDraft.model.trim()
    if (!trimmedUrl || !trimmedModel) {
      setAgentFeedback({ type: 'error', message: '请填写接口地址与模型名称' })
      return
    }

    setAgentTesting(true)
    setAgentFeedback(null)
    try {
      const res = await fetch('/api/agent/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: agentDraft.id || selectedAgentId,
          baseUrl: trimmedUrl,
          model: trimmedModel,
          secret: agentDraft.secret.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setAgentFeedback({ type: 'success', message: data.message || '连接成功！大模型正常响应。' })
        onNotify?.('Agent 大模型连接测试成功', 'success')
      } else {
        setAgentFeedback({ type: 'error', message: data.message || '连接失败' })
        onNotify?.(`Agent 连接测试失败：${data.message}`, 'error')
      }
    } catch (err: unknown) {
      setAgentFeedback({ type: 'error', message: err instanceof Error ? err.message : '网络请求失败' })
    } finally {
      setAgentTesting(false)
    }
  }

  const handleClearAgentSecret = async () => {
    const targetId = agentDraft.id || selectedAgentId
    if (!targetId) return
    if (!window.confirm('确定要清空该大模型已配置的 API Key 吗？')) return
    try {
      const res = await fetch(`/api/agent/providers/${encodeURIComponent(targetId)}/secret`, { method: 'DELETE' })
      if (res.ok) {
        setAgentDraft((prev) => ({ ...prev, secret: '' }))
        setAgentFeedback({ type: 'success', message: '已清空 API Key' })
        onNotify?.('Agent API Key 已清空', 'info')
        await loadAgentProviders()
        window.dispatchEvent(new CustomEvent('agent-providers-changed'))
      }
    } catch (err: unknown) {
      onNotify?.(`清空失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error')
    }
  }

  const handleDeleteAgentProvider = async () => {
    const targetId = agentDraft.id || selectedAgentId
    if (!targetId) return
    if (!window.confirm(`确定要删除大模型配置 [${agentDraft.name || targetId}] 吗？`)) return
    try {
      const res = await fetch(`/api/agent/providers/${encodeURIComponent(targetId)}`, { method: 'DELETE' })
      if (res.ok) {
        onNotify?.('大模型配置已删除', 'info')
        setSelectedAgentId('')
        await loadAgentProviders()
        window.dispatchEvent(new CustomEvent('agent-providers-changed'))
      }
    } catch (err: unknown) {
      onNotify?.(`删除失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error')
    }
  }

  if (!open) return null

  return (
    <div
      aria-label="管理 API 接入背景遮罩"
      className="provider-drawer-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        aria-label="管理 API 接入"
        aria-modal="true"
        className="overlay-surface provider-drawer"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const surface = surfaceRef.current
          if (!surface) return
          const elements = focusableElements(surface)
          if (elements.length === 0) return
          const first = elements[0]!
          const last = elements[elements.length - 1]!
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
        ref={surfaceRef}
        role="dialog"
      >
        {/* Top Header */}
        <header className="provider-drawer__header">
          <div>
            <ServerCog aria-hidden="true" />
            <div>
              <strong>管理 API 接入</strong>
              <small>配置生图/视频模型与 Agent 对话大模型凭证</small>
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

        {/* Top Tabs */}
        <div className="provider-drawer__tabs">
          <button
            aria-label="生图与视频模型"
            className={`provider-drawer__tab-btn ${activeTab === 'media' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('media')}
            type="button"
          >
            <Brush size={16} />
            <span>生图与视频模型</span>
          </button>
          <button
            aria-label="Agent 对话大模型"
            className={`provider-drawer__tab-btn ${activeTab === 'agent' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('agent')}
            type="button"
          >
            <MessageSquare size={16} />
            <span>Agent 对话大模型</span>
          </button>
        </div>

        {/* Tab 1: Media Generation Providers */}
        {activeTab === 'media' ? (
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <small>{provider.available ? '可生成' : provider.secretConfigured ? '已配密钥' : '未配置'}</small>
                    </div>
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
                <label className="integration-field">
                  <span>适配器</span>
                  <select
                    aria-label="适配器"
                    disabled={readOnly}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        adapterType: event.target.value,
                        baseUrl:
                          event.target.value === 'aistartlab-openapi'
                            ? OFFICIAL_AISTARTLAB_BASE_URL
                            : current.baseUrl,
                      }))
                    }
                    value={draft.adapterType}
                  >
                    <option value="aistartlab-openapi">AIStartLab 官方 OpenAPI</option>
                    <option value="openai-compatible">OpenAI 兼容</option>
                    <option value="custom-compatible">自定义（暂不支持）</option>
                  </select>
                </label>

                {draft.adapterType === 'openai-compatible' ? (
                  <label className="integration-field">
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
                  </label>
                ) : null}

                {!unsupported ? (
                  <label className="integration-field provider-form-grid__wide">
                    <span>API Key</span>
                    <div className="integration-field__input-wrapper">
                      <input
                        aria-label="API Key"
                        autoComplete="off"
                        disabled={readOnly}
                        onChange={(event) => setSecret(event.target.value)}
                        placeholder={
                          selected?.maskedSecret
                            ? `已配置 (${selected.maskedSecret})，留空保持不变`
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
                      {selected?.secretConfigured && !readOnly && !adding ? (
                        <button
                          aria-label="清空密钥"
                          className="integration-field__toggle-visibility"
                          onClick={handleClearSecret}
                          tabIndex={-1}
                          title="清空已配置的密钥"
                          type="button"
                        >
                          <Trash2 size={14} />
                        </button>
                      ) : null}
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
                    disabled={readOnly || !draft.enabled}
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
                    <Check aria-hidden="true" />
                    保存并验证
                  </button>
                ) : null}
                <button
                  className={adding ? 'overlay-text-button' : 'overlay-primary-button'}
                  disabled={readOnly || state.busyAction === `save:${draft.id}` || (!adding && !isDraftDirty && !secret.trim())}
                  onClick={() => void saveMetadata()}
                  type="button"
                >
                  <Save aria-hidden="true" />
                  保存供应商
                </button>
                {!adding && selected && !unsupported ? (
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
        ) : (
          /* Tab 2: Dedicated Master-Detail Multi-Provider Layout */
          <div className="provider-drawer__layout">
            <aside className="provider-drawer__list">
              <button
                className="provider-drawer__add"
                disabled={readOnly}
                onClick={handleStartAddAgent}
                type="button"
              >
                <Plus aria-hidden="true" />
                新增大模型
              </button>

              {agentProviders.map((item) => (
                <button
                  aria-current={!agentAdding && selectedAgentId === item.id ? 'true' : undefined}
                  className="provider-list-item"
                  key={item.id}
                  onClick={() => handleSelectAgent(item)}
                  type="button"
                >
                  <span>{item.name.slice(0, 1)}</span>
                  <div>
                    <strong>{item.name}</strong>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <small style={{ color: item.secretConfigured ? '#34d399' : '#7e7e7e' }}>
                        {item.secretConfigured ? '已配置密钥' : '未配置'}
                      </small>
                    </div>
                  </div>
                  {item.preferred ? <Check aria-label="首选大模型" /> : null}
                </button>
              ))}
            </aside>

            <main className="provider-drawer__content">
              <div className="provider-drawer__section-heading">
                <div>
                  <strong>{agentAdding ? '新增 Agent 大模型' : agentDraft.name || '大模型配置'}</strong>
                  <small>{agentAdding ? '建立新的 Agent 对话大模型端点' : agentDraft.id}</small>
                </div>
                {!agentAdding && selectedAgent ? (
                  <span data-available={selectedAgent.secretConfigured || undefined}>
                    {selectedAgent.secretConfigured ? '已配置密钥' : '未配置密钥'}
                  </span>
                ) : null}
              </div>

              {/* Fast Presets Selector when adding */}
              {agentAdding ? (
                <label className="integration-field" style={{ marginBottom: '12px' }}>
                  <span>快速选择厂家预设（一键填入常用配置）</span>
                  <select
                    aria-label="快速选择预设"
                    disabled={readOnly}
                    onChange={(e) => {
                      const found = AGENT_LLM_PRESETS.find((p) => p.id === e.target.value)
                      if (found) {
                        setAgentDraft((prev) => ({
                          ...prev,
                          id: found.id === 'custom' ? `custom-${Date.now().toString(36).slice(-4)}` : found.id,
                          name: found.name,
                          baseUrl: found.baseUrl,
                          model: found.model,
                        }))
                      }
                    }}
                    value={AGENT_LLM_PRESETS.some((p) => p.id === agentDraft.id) ? agentDraft.id : 'custom'}
                  >
                    {AGENT_LLM_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.model})
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <div className="provider-form-grid">
                <label className="integration-field">
                  <span>供应商 ID</span>
                  <input
                    aria-label="供应商 ID"
                    autoComplete="off"
                    disabled={!agentAdding || readOnly}
                    onChange={(event) =>
                      setAgentDraft((prev) => ({ ...prev, id: event.target.value }))
                    }
                    placeholder="deepseek / openai / custom"
                    value={agentDraft.id}
                  />
                </label>

                <label className="integration-field">
                  <span>供应商名称</span>
                  <input
                    aria-label="供应商名称"
                    autoComplete="off"
                    disabled={readOnly}
                    onChange={(event) =>
                      setAgentDraft((prev) => ({ ...prev, name: event.target.value }))
                    }
                    placeholder="例如：DeepSeek、硅基流动、通义千问"
                    value={agentDraft.name}
                  />
                </label>

                <label className="integration-field provider-form-grid__wide">
                  <span>接口地址</span>
                  <input
                    aria-label="接口地址"
                    autoComplete="off"
                    disabled={readOnly}
                    onChange={(event) =>
                      setAgentDraft((prev) => ({ ...prev, baseUrl: event.target.value }))
                    }
                    placeholder="https://api.deepseek.com/v1"
                    spellCheck={false}
                    value={agentDraft.baseUrl}
                  />
                </label>

                <label className="integration-field provider-form-grid__wide">
                  <span>模型名称</span>
                  <input
                    aria-label="模型名称"
                    autoComplete="off"
                    disabled={readOnly}
                    onChange={(event) =>
                      setAgentDraft((prev) => ({ ...prev, model: event.target.value }))
                    }
                    placeholder="例如：deepseek-chat、gpt-4o、qwen-plus"
                    value={agentDraft.model}
                  />
                </label>

                <label className="integration-field provider-form-grid__wide">
                  <span>API Key</span>
                  <div className="integration-field__input-wrapper">
                    <input
                      aria-label="API Key"
                      autoComplete="off"
                      disabled={readOnly}
                      onChange={(event) =>
                        setAgentDraft((prev) => ({ ...prev, secret: event.target.value }))
                      }
                      placeholder={
                        selectedAgent?.maskedSecret
                          ? `已配置 (${selectedAgent.maskedSecret})，留空保持不变`
                          : '输入供应商 API Key'
                      }
                      spellCheck={false}
                      type={agentShowSecret ? 'text' : 'password'}
                      value={agentDraft.secret}
                    />
                    <button
                      aria-label={agentShowSecret ? '隐藏密钥' : '显示明文'}
                      className="integration-field__toggle-visibility"
                      onClick={() => setAgentShowSecret((prev) => !prev)}
                      tabIndex={-1}
                      title={agentShowSecret ? '隐藏密钥' : '显示明文'}
                      type="button"
                    >
                      {agentShowSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    {selectedAgent?.secretConfigured && !readOnly && !agentAdding ? (
                      <button
                        aria-label="清空密钥"
                        className="integration-field__toggle-visibility"
                        onClick={handleClearAgentSecret}
                        tabIndex={-1}
                        title="清空已配置的密钥"
                        type="button"
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </div>
                </label>
              </div>

              <div className="provider-toggle-row">
                <label>
                  <input
                    checked={agentDraft.enabled}
                    disabled={readOnly}
                    onChange={(event) =>
                      setAgentDraft((prev) => ({ ...prev, enabled: event.target.checked }))
                    }
                    type="checkbox"
                  />
                  启用供应商
                </label>
                <label>
                  <input
                    checked={agentDraft.preferred}
                    disabled={readOnly || !agentDraft.enabled}
                    onChange={(event) =>
                      setAgentDraft((prev) => ({ ...prev, preferred: event.target.checked }))
                    }
                    type="checkbox"
                  />
                  设为首选
                </label>
              </div>

              <div className="provider-drawer__metadata-actions">
                <button
                  className="overlay-primary-button"
                  disabled={readOnly || agentSaving}
                  onClick={handleSaveAgentConfig}
                  type="button"
                >
                  <Save size={14} />
                  保存供应商
                </button>

                <button
                  className="overlay-text-button"
                  disabled={readOnly || agentTesting || !agentDraft.baseUrl.trim() || !agentDraft.model.trim()}
                  onClick={handleTestAgentConnection}
                  type="button"
                >
                  <TestTube2 size={14} />
                  {agentTesting ? '正在测试...' : '测试连接'}
                </button>

                {!agentAdding && selectedAgent ? (
                  <button
                    className="overlay-text-button"
                    disabled={readOnly}
                    onClick={handleDeleteAgentProvider}
                    style={{ color: '#ef4444' }}
                    type="button"
                  >
                    <Trash2 size={14} />
                    删除供应商
                  </button>
                ) : null}
              </div>

              {agentFeedback ? (
                <div
                  className={`provider-drawer__test-feedback is-${agentFeedback.type}`}
                  role="status"
                >
                  {agentFeedback.type === 'success' ? <CheckCircle2 size={14} /> : <X size={14} />}
                  <span>{agentFeedback.message}</span>
                </div>
              ) : null}
            </main>
          </div>
        )}
      </section>
    </div>
  )
}
