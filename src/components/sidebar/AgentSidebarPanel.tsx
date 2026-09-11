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
  X,
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
import { GenerationController } from '../../services/generationController'
import { createBrowserUuid } from '../../utils/id'

export interface AgentSidebarPanelProps {
  onNotify?: (message: string, tone?: 'info' | 'success' | 'error') => void
  store?: StoreApi<CanvasStoreState>
  onOpenProviderDrawer?: () => void
  readOnly?: boolean
  canvasId?: string
  referencedNodeIds?: string[]
  onReferencedNodeIdsChange?: (nodeIds: string[]) => void
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
  referencedNodeIds: propReferencedNodeIds,
  onReferencedNodeIdsChange,
}: AgentSidebarPanelProps) {
  const [messages, setMessages] = useState<AgentChatMessage[]>([])
  const [inputPrompt, setInputPrompt] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [openGroupId, setOpenGroupId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [hasConfiguredLlm, setHasConfiguredLlm] = useState<boolean | null>(null)
  const [agentModelInfo, setAgentModelInfo] = useState<{ providerName?: string; model?: string }>()
  const [openThoughtsMap, setOpenThoughtsMap] = useState<Record<string, boolean>>({})
  const [selectedPlanOptions, setSelectedPlanOptions] = useState<Record<string, string[]>>({})

  const [internalReferencedNodeIds, setInternalReferencedNodeIds] = useState<string[]>([])
  const referencedNodeIds = propReferencedNodeIds ?? internalReferencedNodeIds

  const updateReferencedNodeIds = useCallback(
    (next: string[] | ((prev: string[]) => string[])) => {
      const resolved = typeof next === 'function' ? next(referencedNodeIds) : next
      onReferencedNodeIdsChange?.(resolved)
      setInternalReferencedNodeIds(resolved)
    },
    [onReferencedNodeIdsChange, referencedNodeIds],
  )

  const providerCatalog = useOptionalProviderCatalog()
  const chatContainerRef = useRef<HTMLDivElement | null>(null)

  const harness = useMemo(() => new CanvasAgentHarness(store), [store])
  const chatClient = useMemo(() => new AgentChatClient(), [])

  // 监听来自画布右键等位置的「引用到对话」事件
  useEffect(() => {
    const handleAddReferencedNodes = (e: Event) => {
      const customEvent = e as CustomEvent<{ nodeIds?: string[] }>
      const newIds = customEvent.detail?.nodeIds
      if (Array.isArray(newIds) && newIds.length > 0) {
        updateReferencedNodeIds((prev) => {
          const combined = [...prev]
          for (const id of newIds) {
            if (!combined.includes(id)) {
              combined.push(id)
            }
          }
          return combined
        })
      }
    }
    window.addEventListener('continuum-agent-reference-nodes', handleAddReferencedNodes)
    return () => {
      window.removeEventListener('continuum-agent-reference-nodes', handleAddReferencedNodes)
    }
  }, [updateReferencedNodeIds])

  const referencedNodes = useMemo(() => {
    const nodes = store.getState().snapshot.nodes
    return referencedNodeIds
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => Boolean(n))
  }, [referencedNodeIds, store])

  const handleRemoveReferencedNode = (nodeId: string) => {
    updateReferencedNodeIds((prev) => prev.filter((id) => id !== nodeId))
  }

  const handleClearAllReferencedNodes = () => {
    updateReferencedNodeIds([])
  }

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

    const currentReferencedIds = [...referencedNodeIds]
    const referencedSnapshot = referencedNodes.map((n) => {
      const data = n.data as unknown as Record<string, unknown>
      const mediaUrl = typeof data.url === 'string' ? data.url : typeof data.poster === 'string' ? data.poster : undefined
      const prompt =
        n.type === 'image' || n.type === 'video'
          ? (n.data.promptDraft || n.data.generation?.prompt)
          : n.type === 'text'
            ? n.data.text
            : undefined
      const isSkill = n.type === 'text' && data.nodeKind === 'skill'
      return {
        id: n.id,
        name: n.name,
        type: isSkill ? 'skill' : n.type,
        url: mediaUrl,
        prompt,
      }
    })

    // 发送后立即清空输入框上方的引用胶囊条
    updateReferencedNodeIds([])

    const userMessage: AgentChatMessage = {
      id: userMsgId,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      status: 'complete',
      referencedNodes: referencedSnapshot.length > 0 ? referencedSnapshot : undefined,
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
      referencedNodeIds: currentReferencedIds,
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

  const handleConfirmAction = (action: CanvasAgentAction, selectedOptions?: string[]) => {
    // 1. Mark action as confirmed in chat stream
    setMessages((prev) => {
      const next = prev.map((msg) => ({
        ...msg,
        actions: msg.actions?.map((act) =>
          act.id === action.id
            ? {
                ...act,
                status: 'success' as const,
                selectedOptions: selectedOptions ?? act.selectedOptions,
              }
            : act,
        ),
      }))
      persistMessages(next)
      return next
    })

    onNotify?.(`已确认方案，正在向画布提交渲染任务...`, 'success')

    // 2. Real video/image generation execution on target nodes
    try {
      const controller = new GenerationController({ store })
      const snapshot = store.getState().snapshot
      const rawTargetIds = (
        action.payload?.targetNodeIds ||
        action.payload?.nodeIds ||
        action.details?.targetNodeIds ||
        []
      ) as string[]

      const targetIds = rawTargetIds.length > 0
        ? rawTargetIds
        : snapshot.nodes
            .filter((n) => (n.type === 'image' || n.type === 'video') && !n.data.url)
            .map((n) => n.id)

      for (const targetId of targetIds) {
        const node = snapshot.nodes.find((n) => n.id === targetId)
        if (!node) continue

        if (node.type === 'image' || node.type === 'video') {
          const promptText = (node.data as { promptDraft?: string; prompt?: string }).promptDraft || (node.data as { prompt?: string }).prompt || node.name

          // Immediately display generating visual state on canvas
          store.getState().patchNode(targetId, {
            data: {
              generation: {
                status: 'generating',
                progress: 15,
                prompt: promptText,
              },
            },
          })

          controller.start({
            canvasId,
            projectId: snapshot.projectId,
            sourceNodeId: node.id,
            targetNodeIds: [node.id],
            prompt: promptText,
            settings: (node.data as { generationSettings?: never }).generationSettings,
          }).catch((err) => {
            console.error('Generation execution failed:', err)
          })
        } else if (node.type === 'group' && ((node.data as { nodeKind?: string }).nodeKind === 'director' || node.name.includes('导演'))) {
          // If a director node is targeted, create deliverable video node on canvas and run generation
          const promptText = (node.data as { promptDraft?: string }).promptDraft || '电影级分镜成片'
          const deliverId = `video-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
          store.getState().addNode({
            id: deliverId,
            type: 'video',
            name: `交付成片：${promptText.slice(0, 10)}`,
            position: { x: node.position.x + node.size.width + 60, y: node.position.y + 20 },
            size: { width: 480, height: 270 },
            data: {
              url: '',
              generation: {
                status: 'generating',
                progress: 15,
                prompt: promptText,
              },
            },
          })
          store.getState().addEdge({
            id: `edge-${Date.now().toString(36)}`,
            source: node.id,
            target: deliverId,
            relation: 'flow',
          })

          controller.start({
            canvasId,
            projectId: snapshot.projectId,
            sourceNodeId: deliverId,
            targetNodeIds: [deliverId],
            prompt: promptText,
          }).catch((err) => {
            console.error('Director job execution failed:', err)
          })
        }
      }
    } catch (err) {
      console.error('Failed to trigger generation:', err)
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
              <span style={{ color: '#a1a1aa' }}>仅房主可用</span>
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
              <AlertTriangle size={24} style={{ color: '#ff9f0a' }} />
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

                  {/* Referenced Nodes Tag Strip */}
                  {msg.referencedNodes && msg.referencedNodes.length > 0 ? (
                    <div className="agent-msg-referenced-pills">
                      <span className="agent-msg-referenced-label">
                        <Link2 size={11} className="text-purple-400" />
                        <span>引用节点:</span>
                      </span>
                      {msg.referencedNodes.map((ref) => (
                        <button
                          key={ref.id}
                          className="agent-msg-ref-pill"
                          onClick={() => {
                            const canvasState = store.getState()
                            canvasState.selectNode(ref.id)
                            const node = canvasState.snapshot.nodes.find((n) => n.id === ref.id)
                            if (node) {
                              const zoom = canvasState.snapshot.viewport.zoom
                              canvasState.setViewport({
                                x: window.innerWidth / 2 - (node.position.x + node.size.width / 2) * zoom,
                                y: window.innerHeight / 2 - (node.position.y + node.size.height / 2) * zoom,
                                zoom,
                              })
                            }
                          }}
                          title={`在画布上定位「${ref.name}」`}
                          type="button"
                        >
                          {ref.url ? (
                            <img alt="" className="agent-msg-ref-pill__thumb" src={ref.url} />
                          ) : (
                            <span className="agent-msg-ref-pill__type">
                              {ref.type === 'skill' ? 'Skill' : ref.type}
                            </span>
                          )}
                          <span className="agent-msg-ref-pill__name">{ref.name}</span>
                        </button>
                      ))}
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
                          {act.type === 'request_plan_confirmation' ? (
                            <div className="agent-plan-confirm-card">
                              <div className="agent-plan-confirm-header">
                                <div className="agent-plan-confirm-title">
                                  <Sparkles size={13} className="text-purple-400" />
                                  <span>{act.title || '制片方案确认'}</span>
                                </div>
                                <span className={`agent-plan-confirm-badge ${act.status === 'success' ? 'is-success' : 'is-pending'}`}>
                                  {act.status === 'success' ? '已确认执行' : '等待用户确认'}
                                </span>
                              </div>

                              {act.summary ? (
                                <p className="agent-plan-confirm-desc">{act.summary}</p>
                              ) : null}

                              {act.planOptions && act.planOptions.length > 0 ? (
                                <div className="agent-plan-confirm-options">
                                  <span className="agent-plan-options-label">推荐配置选项 (可调整)：</span>
                                  <div className="agent-plan-options-grid">
                                    {act.planOptions.map((opt) => {
                                      const isChecked = (selectedPlanOptions[act.id] ?? act.planOptions?.filter((o) => o.defaultSelected !== false).map((o) => o.id) ?? []).includes(opt.id)
                                      const isInteractive = act.status === 'requires_confirmation'
                                      return (
                                        <button
                                          key={opt.id}
                                          type="button"
                                          className={`agent-plan-option-chip ${isChecked ? 'is-active' : ''}`}
                                          disabled={!isInteractive}
                                          onClick={() => {
                                            if (!isInteractive) return
                                            setSelectedPlanOptions((prev) => {
                                              const current = prev[act.id] ?? act.planOptions?.filter((o) => o.defaultSelected !== false).map((o) => o.id) ?? []
                                              const next = isChecked
                                                ? current.filter((id) => id !== opt.id)
                                                : [...current, opt.id]
                                              return { ...prev, [act.id]: next }
                                            })
                                          }}
                                        >
                                          <span className="agent-plan-option-check">
                                            {isChecked ? <Check size={10} /> : null}
                                          </span>
                                          <span className="agent-plan-option-name">{opt.label}</span>
                                        </button>
                                      )
                                    })}
                                  </div>
                                </div>
                              ) : null}

                              <div className="agent-plan-confirm-footer">
                                {act.details?.estimatedCost ? (
                                  <span className="agent-plan-cost-tag">
                                    <Zap size={10} />
                                    {String(act.details.estimatedCost)}
                                  </span>
                                ) : <span />}

                                {act.status === 'requires_confirmation' ? (
                                  <button
                                    className="agent-plan-exec-btn"
                                    type="button"
                                    onClick={() => {
                                      const currentSelected = selectedPlanOptions[act.id] ?? act.planOptions?.filter((o) => o.defaultSelected !== false).map((o) => o.id) ?? []
                                      handleConfirmAction(act, currentSelected)
                                    }}
                                  >
                                    <Play size={11} fill="currentColor" />
                                    <span>确认执行</span>
                                  </button>
                                ) : (
                                  <span className="agent-plan-done-tag">
                                    <Check size={11} />
                                    <span>已向画布提交渲染</span>
                                  </span>
                                )}
                              </div>
                            </div>
                          ) : (
                            <>
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
                            </>
                          )}
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
        {referencedNodes.length > 0 ? (
          <div className="fig-agent-referenced-bar">
            <div className="fig-agent-referenced-bar__header">
              <span className="fig-agent-referenced-bar__title">
                <Link2 size={12} className="text-purple-400" />
                <span>已引用画布节点 ({referencedNodes.length})</span>
              </span>
              {referencedNodes.length > 1 ? (
                <button
                  className="fig-agent-referenced-bar__clear-btn"
                  onClick={handleClearAllReferencedNodes}
                  title="清空全部引用"
                  type="button"
                >
                  全部清除
                </button>
              ) : null}
            </div>
            <div className="fig-agent-referenced-chips">
              {referencedNodes.map((node) => {
                const nodeData = node.data as unknown as Record<string, unknown>
                const thumbUrl = typeof nodeData.url === 'string' ? nodeData.url : typeof nodeData.poster === 'string' ? nodeData.poster : undefined
                const isSkill = node.type === 'text' && nodeData.nodeKind === 'skill'
                return (
                  <div className="fig-agent-ref-chip" key={node.id}>
                    {thumbUrl ? (
                      <img
                        alt=""
                        className="fig-agent-ref-chip__thumb"
                        src={thumbUrl}
                      />
                    ) : (
                      <span className="fig-agent-ref-chip__type">
                        {isSkill ? 'Skill' : node.type}
                      </span>
                    )}
                    <span className="fig-agent-ref-chip__name" title={node.name}>
                      {node.name}
                    </span>
                    <button
                      aria-label={`移除「${node.name}」`}
                      className="fig-agent-ref-chip__remove"
                      onClick={() => handleRemoveReferencedNode(node.id)}
                      title={`移除引用「${node.name}」`}
                      type="button"
                    >
                      <X size={10} />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

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
