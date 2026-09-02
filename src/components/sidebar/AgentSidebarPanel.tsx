import {
  AlertTriangle,
  Bot,
  Brain,
  Briefcase,
  Check,
  ChevronDown,
  ChevronUp,
  Layers,
  Link2,
  Loader2,
  Lock,
  MoreHorizontal,
  Palette,
  Play,
  Plus,
  RotateCcw,
  Send,
  ServerCog,
  Sparkles,
  Square,
  Undo2,
  Wand2,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StoreApi } from 'zustand/vanilla'

import { canvasStore } from '../../store/canvas-store'
import type { CanvasStoreState } from '../../store/types'
import { useOptionalProviderCatalog } from '../providers/ProviderCatalogContext'
import { AgentChatClient } from '../../services/agent/agentChatClient'
import type { AgentChatMessage, CanvasAgentAction } from '../../services/agent/agentTypes'
import { CanvasAgentHarness } from '../../services/agent/canvasAgentHarness'
import { createBrowserUuid } from '../../utils/id'

export interface AgentSidebarPanelProps {
  onNotify?: (message: string, tone?: 'info' | 'success' | 'error') => void
  store?: StoreApi<CanvasStoreState>
  onOpenProviderDrawer?: () => void
  readOnly?: boolean
  canvasId?: string
}

interface QuickActionGroup {
  id: string
  title: string
  icon: typeof Wand2
  items: {
    label: string
    prompt: string
  }[]
}

const QUICK_ACTION_GROUPS: QuickActionGroup[] = [
  {
    id: 'tidy',
    title: '排版与优化',
    icon: Palette,
    items: [
      {
        label: '📐 水平分镜故事流排版',
        prompt: '帮我把画布上的所有节点按照从左到右的水平分镜故事流重新自动排版对齐。',
      },
      {
        label: '🔲 紧凑网格整齐排列',
        prompt: '帮我将画布上的节点整齐排列成网格矩阵布局。',
      },
      {
        label: '🔍 扫描空间碰撞并自愈避让',
        prompt: '扫描当前画布上的所有节点，检测是否有空间重叠压盖，并自动调整坐标完成避让对齐。',
      },
    ],
  },
  {
    id: 'story',
    title: '生成设计与分镜',
    icon: Wand2,
    items: [
      {
        label: '🎬 扩展 3 组分镜故事流',
        prompt: '基于画布上已有的画面风格，帮我向右扩展 3 组连续的特写与中景分镜，并自动连线。',
      },
      {
        label: '✨ 批量润色画面提示词',
        prompt: '帮我分析当前选中的节点，将生图提示词补充光影细节、镜头视角与渲染质感。',
      },
      {
        label: '🔗 建立全图镜头因果连线',
        prompt: '帮我为画布上的前后镜头节点建立顺畅的故事演化流连线。',
      },
    ],
  },
  {
    id: 'workflow',
    title: '工作流与模板',
    icon: Briefcase,
    items: [
      {
        label: '🚀 创建电商产品展示分镜流',
        prompt: '帮我创建一个包含产品主图、场景图、细节特写与动态展示的电商故事分镜。',
      },
      {
        label: '🎞️ 建立短视频分镜链路',
        prompt: '帮我创建一个从故事文案到画面生图、再到动态视频演化的完整流程节点组。',
      },
    ],
  },
]

export function AgentSidebarPanel({
  onNotify,
  store = canvasStore,
  onOpenProviderDrawer,
  readOnly = false,
  canvasId,
}: AgentSidebarPanelProps) {
  const [messages, setMessages] = useState<AgentChatMessage[]>([])
  const [inputPrompt, setInputPrompt] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [openGroupId, setOpenGroupId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [hasConfiguredLlm, setHasConfiguredLlm] = useState<boolean | null>(null)
  const [agentModelInfo, setAgentModelInfo] = useState<{ providerName?: string; model?: string }>()
  const [openThoughtsMap, setOpenThoughtsMap] = useState<Record<string, boolean>>({})

  const providerCatalog = useOptionalProviderCatalog()
  const chatContainerRef = useRef<HTMLDivElement | null>(null)

  const harness = useMemo(() => new CanvasAgentHarness(store), [store])
  const chatClient = useMemo(() => new AgentChatClient(), [])

  // 跨画布/刷新自动加载对话历史
  useEffect(() => {
    let active = true
    const loadHistory = async () => {
      if (canvasId) {
        try {
          const res = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/agent-chat`)
          if (res.ok) {
            const data = await res.json()
            if (active && Array.isArray(data.messages)) {
              setMessages(data.messages)
              return
            }
          }
        } catch {
          // fallback to localStorage
        }
      }

      // localStorage 容灾同步
      const storageKey = canvasId ? `continuum_agent_chat_${canvasId}` : 'continuum_agent_chat_default'
      try {
        const cached = localStorage.getItem(storageKey)
        if (cached && active) {
          const parsed = JSON.parse(cached)
          if (Array.isArray(parsed)) {
            setMessages(parsed)
            return
          }
        }
      } catch {}

      if (active) setMessages([])
    }

    void loadHistory()
    return () => {
      active = false
    }
  }, [canvasId])

  // 静默持久化消息至服务端与本地
  const persistMessages = useCallback(
    (msgs: AgentChatMessage[]) => {
      const storageKey = canvasId ? `continuum_agent_chat_${canvasId}` : 'continuum_agent_chat_default'
      try {
        localStorage.setItem(storageKey, JSON.stringify(msgs))
      } catch {}

      if (canvasId) {
        fetch(`/api/canvases/${encodeURIComponent(canvasId)}/agent-chat`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: msgs }),
        }).catch(() => {})
      }
    },
    [canvasId],
  )

  // 检查是否接入了大模型
  useEffect(() => {
    let active = true
    const check = async () => {
      const status = await chatClient.checkAgentStatus()
      if (active) {
        setHasConfiguredLlm(Boolean(status.configured))
        if (status.configured) {
          setAgentModelInfo({
            providerName: status.providerName,
            model: status.model,
          })
        } else {
          setAgentModelInfo(undefined)
        }
      }
    }
    void check()
    window.addEventListener('focus', check)
    window.addEventListener('agent-providers-changed', check)
    return () => {
      active = false
      window.removeEventListener('focus', check)
      window.removeEventListener('agent-providers-changed', check)
    }
  }, [chatClient])

  // 自动滚动到底部
  const scrollToBottom = useCallback(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight
    }
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  const toggleThoughts = (msgId: string) => {
    setOpenThoughtsMap((prev) => ({ ...prev, [msgId]: !prev[msgId] }))
  }

  const handleRollback = (snapshot?: string) => {
    if (!snapshot) return
    const success = harness.rollback(snapshot)
    if (success) {
      onNotify?.('已成功撤销该次 Agent 的全部画布操作', 'info')
      setMessages((prev) => {
        const next = prev.map((m) => (m.rollbackSnapshot === snapshot ? { ...m, canRollback: false } : m))
        persistMessages(next)
        return next
      })
    } else {
      onNotify?.('撤销失败', 'error')
    }
  }

  const handleSendMessage = async (textToSend?: string) => {
    if (readOnly) return
    const text = (textToSend || inputPrompt).trim()
    if (!text || isStreaming) return

    if (hasConfiguredLlm === false) {
      onNotify?.('尚未接入 Agent 对话大模型，请在「管理 API 接入」中配置 API Key', 'error')
      onOpenProviderDrawer?.()
      return
    }

    setInputPrompt('')
    const userMsgId = createBrowserUuid()
    const assistantMsgId = createBrowserUuid()

    const userMessage: AgentChatMessage = {
      id: userMsgId,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      status: 'complete',
    }

    const assistantMessage: AgentChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      actions: [],
    }

    const initialMessages = [...messages, userMessage, assistantMessage]
    setMessages(initialMessages)
    setIsStreaming(true)

    // 智能 10 轮滑动窗口，防止超 Token 限制
    const conversationHistory = messages.slice(-10).map((m) => ({
      role: m.role,
      content: m.content,
    }))

    await harness.runLoop({
      userPrompt: text,
      historyMessages: conversationHistory,
      providerId: providerCatalog?.selectedProviderId,
      events: {
        onPlanCreated: (plan) => {
          setMessages((prev) =>
            prev.map((msg) => (msg.id === assistantMsgId ? { ...msg, plan } : msg)),
          )
        },
        onStepUpdate: (step) => {
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id !== assistantMsgId || !msg.plan) return msg
              const updatedSteps = msg.plan.steps.map((s) => (s.id === step.id ? { ...s, ...step } : s))
              return { ...msg, plan: { ...msg.plan, steps: updatedSteps } }
            }),
          )
        },
        onThinking: (thoughts) => {
          setMessages((prev) =>
            prev.map((msg) => (msg.id === assistantMsgId ? { ...msg, thoughts } : msg)),
          )
        },
        onToken: (token) => {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId ? { ...msg, content: msg.content + token } : msg,
            ),
          )
        },
        onAction: (action) => {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? { ...msg, actions: [...(msg.actions || []), action] }
                : msg,
            ),
          )
          onNotify?.(`Agent：${action.summary}`, 'success')
        },
        onError: (err) => {
          setMessages((prev) => {
            const next = prev.map((msg) =>
              msg.id === assistantMsgId ? { ...msg, status: 'error' as const, error: err } : msg,
            )
            persistMessages(next)
            return next
          })
          onNotify?.(`Agent：${err}`, 'error')
          setIsStreaming(false)
        },
        onComplete: (finalMsg) => {
          setMessages((prev) => {
            const next = prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    ...finalMsg,
                    id: assistantMsgId,
                    status: 'complete' as const,
                  }
                : msg,
            )
            persistMessages(next)
            return next
          })
          setIsStreaming(false)
        },
      },
    })
  }

  const handleStop = () => {
    harness.abort()
    setIsStreaming(false)
    onNotify?.('已停止 Agent 执行', 'info')
  }

  const handleResetChat = () => {
    setMessages([])
    persistMessages([])
    if (canvasId) {
      fetch(`/api/canvases/${encodeURIComponent(canvasId)}/agent-chat`, {
        method: 'DELETE',
      }).catch(() => {})
    }
    setMenuOpen(false)
    onNotify?.('已清空当前画布的 Agent 对话历史', 'info')
  }

  const handleInsertQuickPrompt = () => {
    if (readOnly) return
    setInputPrompt('帮我规划一套完整的分镜故事流，并自动连线和排版。')
  }

  const handleConfirmAction = (action: CanvasAgentAction) => {
    if (action.payload && action.type === 'trigger_generation') {
      onNotify?.(`已启动 ${action.title} 批处理任务`, 'success')
      setMessages((prev) =>
        prev.map((msg) => ({
          ...msg,
          actions: msg.actions?.map((act) =>
            act.id === action.id ? { ...act, status: 'success' } : act,
          ),
        })),
      )
    }
  }

  return (
    <div aria-label="Agent 智能助手" className="sidebar-agent-panel fig-agent-shell">
      {/* Top Header */}
      <div className="fig-agent-header">
        <div className="fig-agent-header__title-group">
          <h2 className="fig-agent-header__title">新对话</h2>
          <span className="fig-agent-header__status">
            {readOnly ? (
              <span style={{ color: 'var(--canvas-text-secondary)' }}>仅房主可用</span>
            ) : hasConfiguredLlm === false ? (
              '未接入大模型'
            ) : agentModelInfo?.providerName ? (
              `${agentModelInfo.providerName} (${agentModelInfo.model || '已就绪'})`
            ) : (
              '已就绪'
            )}
          </span>
        </div>

        <div className="fig-agent-header__actions">
          {readOnly ? (
            <span className="fig-agent-header__badge is-locked" title="多人协作模式下，Agent 仅限房主操作">
              <Lock size={10} style={{ marginRight: '3px' }} />
              已锁定
            </span>
          ) : (
            <span className="fig-agent-header__badge">
              <Sparkles size={11} style={{ marginRight: '3px' }} />
              Agent
            </span>
          )}
          {!readOnly ? (
            <button
              aria-label="更多选项"
              className="fig-agent-header__more-btn"
              onClick={() => setMenuOpen((prev) => !prev)}
              type="button"
            >
              <MoreHorizontal size={16} />
            </button>
          ) : null}

          {menuOpen && !readOnly ? (
            <div className="fig-agent-menu-dropdown">
              <button
                className="fig-agent-menu-item"
                onClick={handleResetChat}
                type="button"
              >
                <RotateCcw size={12} />
                <span>清空对话</span>
              </button>
              {onOpenProviderDrawer ? (
                <button
                  className="fig-agent-menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    onOpenProviderDrawer()
                  }}
                  type="button"
                >
                  <ServerCog size={12} />
                  <span>管理大模型接入</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* Main Body */}
      <div className="fig-agent-body" ref={chatContainerRef}>
        {readOnly ? (
          <div className="agent-collaborator-lock-card">
            <div className="agent-collaborator-lock-icon">
              <Lock size={22} />
            </div>
            <h3>多人协作模式已启用</h3>
            <p>
              为了防止多人同时下达指令引起画布节点冲突，当前 Agent 仅限<strong>房主（房间创建者）</strong>操作调度。
            </p>
            <div className="agent-collaborator-lock-hint">
              💡 房主通过 Agent 生成或重排的所有节点与连线，将实时同步至你的画布。
            </div>
          </div>
        ) : hasConfiguredLlm === false && messages.length === 0 ? (
          <div className="fig-agent-unconfigured-card">
            <div className="fig-agent-unconfigured-icon">
              <AlertTriangle size={24} style={{ color: 'var(--canvas-status-warning)' }} />
            </div>
            <h3>尚未接入 Agent 大模型</h3>
            <p>请在 API 管理中配置 DeepSeek、OpenAI 或其他兼容大模型的 API Key，即可开启自然语言对话与画布自主操控。</p>
            {onOpenProviderDrawer ? (
              <button
                className="fig-agent-config-btn"
                onClick={onOpenProviderDrawer}
                type="button"
              >
                <ServerCog size={14} />
                前往配置 API
              </button>
            ) : null}
          </div>
        ) : messages.length === 0 ? (
          /* Empty State: Matching Figure 1 */
          <div className="fig-agent-empty-state">
            <div className="fig-agent-logo-emblem">
              <Bot size={22} />
            </div>

            <h1 className="fig-agent-main-title">下一步做什么？</h1>

            <div className="fig-agent-capsule-list">
              {QUICK_ACTION_GROUPS.map((group) => {
                const Icon = group.icon
                const isOpen = openGroupId === group.id

                return (
                  <div
                    className={`fig-agent-capsule-group ${isOpen ? 'is-open' : ''}`}
                    key={group.id}
                  >
                    <button
                      aria-expanded={isOpen}
                      className="fig-agent-capsule-btn"
                      onClick={() => setOpenGroupId(isOpen ? null : group.id)}
                      type="button"
                    >
                      <div className="fig-agent-capsule-label">
                        <Icon className="fig-agent-capsule-icon" size={16} />
                        <span>{group.title}</span>
                      </div>
                      {isOpen ? (
                        <ChevronUp className="fig-agent-capsule-arrow" size={16} />
                      ) : (
                        <ChevronDown className="fig-agent-capsule-arrow" size={16} />
                      )}
                    </button>

                    {isOpen ? (
                      <div className="fig-agent-capsule-sublist">
                        {group.items.map((subItem) => (
                          <button
                            className="fig-agent-capsule-subitem"
                            key={subItem.label}
                            onClick={() => handleSendMessage(subItem.prompt)}
                            type="button"
                          >
                            <span>{subItem.label}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          /* Active Chat Message Stream */
          <div className="sidebar-agent-panel__messages-list">
            {messages.map((msg) => (
              <div
                className={`sidebar-agent-panel__message is-${msg.role}`}
                key={msg.id}
              >
                <div className="sidebar-agent-panel__message-bubble">
                  {/* Thought Chain (Only rendered if model produced real reasoning tokens) */}
                  {msg.thoughts && msg.thoughts.trim().length > 0 ? (
                    <div className="agent-thought-accordion">
                      <button
                        className="agent-thought-header"
                        onClick={() => toggleThoughts(msg.id)}
                        type="button"
                      >
                        <span className="agent-thought-header__left">
                          <Brain size={12} className="agent-thought-icon" />
                          <span>思考过程</span>
                        </span>
                        {openThoughtsMap[msg.id] ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      </button>
                      {openThoughtsMap[msg.id] ? (
                        <div className="agent-thought-content">
                          {msg.thoughts}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Real LLM Dynamic Plan Tracker (Only rendered if model produced <plan> steps) */}
                  {msg.plan && msg.plan.steps && msg.plan.steps.length > 0 ? (
                    <div className="agent-plan-card">
                      <div className="agent-plan-header">
                        <div className="agent-plan-title">
                          <Zap size={12} />
                          <span>任务规划与进度</span>
                        </div>
                        <span className="agent-plan-badge">
                          {msg.plan.steps.filter((s) => s.status === 'completed').length}/{msg.plan.steps.length}
                        </span>
                      </div>
                      <div className="agent-plan-steps">
                        {msg.plan.steps.map((step) => (
                          <div className={`agent-plan-step is-${step.status}`} key={step.id}>
                            <div className="agent-plan-step__indicator">
                              {step.status === 'completed' && <Check size={11} />}
                              {step.status === 'running' && <Loader2 size={11} className="spin" />}
                              {step.status === 'pending' && <span className="dot" />}
                            </div>
                            <span className="agent-plan-step__text">{step.title}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* Message Content */}
                  {msg.content ? (
                    <div className="sidebar-agent-panel__message-text">
                      {msg.content}
                    </div>
                  ) : null}

                  {/* Actions List (Linear Sleek Minimal Micro-Activity) */}
                  {msg.actions && msg.actions.length > 0 ? (
                    <div className="agent-action-stream">
                      {msg.actions.map((act) => (
                        <div className="agent-action-item" key={act.id}>
                          <div className="agent-action-item__content">
                            <span className="agent-action-item__icon">
                              {act.type === 'create_nodes' && <Layers size={11} />}
                              {act.type === 'connect_nodes' && <Link2 size={11} />}
                              {act.type === 'update_node_prompts' && <Wand2 size={11} />}
                              {act.type === 'auto_layout' && <Palette size={11} />}
                              {act.type === 'trigger_generation' && <Play size={11} />}
                            </span>
                            <span className="agent-action-item__summary">{act.summary}</span>
                          </div>

                          {act.requiresConfirmation && act.status === 'requires_confirmation' ? (
                            <div className="agent-action-confirm-wrapper">
                              <button
                                className="agent-sleek-confirm-btn"
                                onClick={() => handleConfirmAction(act)}
                                type="button"
                              >
                                <Play size={10} fill="currentColor" />
                                <span>立即开始生图</span>
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* Rollback Button */}
                  {msg.canRollback && msg.rollbackSnapshot && msg.status === 'complete' ? (
                    <div className="agent-message-footer">
                      <button
                        className="agent-rollback-btn"
                        onClick={() => handleRollback(msg.rollbackSnapshot)}
                        title="撤销本次 Agent 对画布的全部改动"
                        type="button"
                      >
                        <Undo2 size={12} />
                        <span>撤销本次操作</span>
                      </button>
                    </div>
                  ) : null}

                  {msg.status === 'streaming' && !msg.content && (!msg.actions || msg.actions.length === 0) ? (
                    <div className="sidebar-agent-panel__typing">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom Floating Card Input Box */}
      <div className={`fig-agent-input-card ${readOnly ? 'is-disabled' : ''}`}>
        <textarea
          aria-label="Agent 指令输入框"
          className="fig-agent-input-textarea"
          disabled={readOnly || isStreaming}
          onChange={(e) => setInputPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (!readOnly) handleSendMessage()
            }
          }}
          placeholder={
            readOnly
              ? '多人协作中仅房主可使用 Agent 发送指令...'
              : hasConfiguredLlm === false
                ? '尚未接入 Agent 大模型，请先配置 API Key...'
                : '描述你的想法...'
          }
          rows={2}
          value={inputPrompt}
        />
        <div className="fig-agent-input-toolbar">
          <button
            aria-label="快捷插入提示词"
            className="fig-agent-tool-btn"
            disabled={readOnly}
            onClick={handleInsertQuickPrompt}
            title={readOnly ? '多人协作中仅房主可用' : '快捷插入指令'}
            type="button"
          >
            <Plus size={16} />
          </button>

          {isStreaming ? (
            <button
              aria-label="停止生成"
              className="fig-agent-submit-btn is-stop"
              onClick={handleStop}
              title="停止响应"
              type="button"
            >
              <Square size={13} />
            </button>
          ) : (
            <button
              aria-label="发送"
              className="fig-agent-submit-btn"
              disabled={readOnly || !inputPrompt.trim() || hasConfiguredLlm === false}
              onClick={() => handleSendMessage()}
              title={readOnly ? '多人协作中仅房主可发送指令' : '发送指令'}
              type="button"
            >
              <Send size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
