import type { StoreApi } from 'zustand/vanilla'
import type { CanvasStoreState } from '../../store/types'
import { createBrowserUuid } from '../../utils/id'
import type {
  AgentChatMessage,
  AgentPlan,
  AgentPlanStep,
  CanvasAgentAction,
  VerificationResult,
} from './agentTypes'
import { CANVAS_AGENT_TOOLS } from './agentTypes'
import { CanvasAgentExecutor } from './canvasExecutor'
import { buildHealingPrompt, verifyCanvasInvariants } from './canvasInvariants'
import { buildAgentContext } from './contextBuilder'

export interface HarnessEvents {
  onPlanCreated?: (plan: AgentPlan) => void
  onStepUpdate?: (step: AgentPlanStep) => void
  onThinking?: (thoughts: string) => void
  onToken?: (token: string) => void
  onAction?: (action: CanvasAgentAction) => void
  onHealing?: (result: VerificationResult) => void
  onError?: (error: string) => void
  onComplete?: (finalMessage: AgentChatMessage) => void
}

/**
 * 从大模型输出文本中提取结构化 <plan> 标签
 */
export function extractPlanFromText(
  text: string,
  planId: string,
): { plan?: AgentPlan; cleanText: string } {
  const planMatch = text.match(/<plan>([\s\S]*?)<\/plan>/i)
  if (!planMatch) {
    return { cleanText: text }
  }

  const rawPlanBlock = planMatch[1] || ''
  const cleanText = text.replace(/<plan>[\s\S]*?<\/plan>/i, '').trim()
  const stepLines = rawPlanBlock
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s*\-•\d.]+(\[[\s_xX]?\])?\s*/, '').trim())
    .filter((line) => line.length > 0)

  if (stepLines.length === 0) {
    return { cleanText }
  }

  const steps: AgentPlanStep[] = stepLines.map((title, idx) => ({
    id: `${planId}-${idx + 1}`,
    title,
    status: 'pending',
  }))

  const plan: AgentPlan = {
    id: planId,
    intent: '',
    steps,
    status: 'executing',
    createdAt: Date.now(),
  }

  return { plan, cleanText }
}

export class CanvasAgentHarness {
  private readonly store: StoreApi<CanvasStoreState>
  private readonly executor: CanvasAgentExecutor
  private abortController: AbortController | null = null

  constructor(store: StoreApi<CanvasStoreState>) {
    this.store = store
    this.executor = new CanvasAgentExecutor(store)
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  /**
   * 运行完整的 Observe -> Plan -> Act -> Verify -> Self-Heal 闭环
   */
  async runLoop(options: {
    userPrompt: string
    historyMessages: { role: 'user' | 'assistant' | 'system'; content: string }[]
    referencedNodeIds?: string[]
    providerId?: string
    model?: string
    events: HarnessEvents
  }): Promise<void> {
    const { userPrompt, historyMessages, referencedNodeIds, providerId, model, events } = options
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    // 0. 捕获初始全量快照，供一键撤销
    const initialSnapshot = this.executor.captureSnapshot()
    const planId = createBrowserUuid()

    // 1. Observe: 收集画布环境
    const state = this.store.getState()
    const { systemPrompt, canvasSummary } = buildAgentContext({
      snapshot: state.snapshot,
      selectedNodeIds: state.selectedNodeIds,
      referencedNodeIds,
    })

    // 组装系统提示词（严格指导大模型仅在复杂多步骤创作任务时输出 <plan> 步骤清单）
    const harnessSystemPrompt = `${systemPrompt}\n\n【画布上下文环境】\n${canvasSummary}\n
【任务规划规范】
1. 当且仅当用户提出的是【复杂的多步骤画布构建/分镜创作任务】（例如批量创建多个节点、规划完整短片分镜并连线排版等）时，你必须在正文最开头使用 <plan> 标签列出 2~4 个具体的执行步骤。例如：
<plan>
- 构思赛博朋克主角与场景设定
- 批量创建 3 幕关键分镜节点
- 建立前后因果连线并自动水平排版
</plan>

2. 对于【普通对话、概念问答、单步简单操作或功能咨询】（例如“你可以帮我做些什么”、“帮我把提示词改一下”、“把节点1变大”），【严禁输出 <plan> 标签】，直接以清晰亲切的自然语言回复或直接调用工具。`

    // 收集用户重点引用或当前选中的图片节点，支持多模态视觉感知
    const referencedImages: string[] = []
    const targetNodeIds =
      referencedNodeIds && referencedNodeIds.length > 0
        ? referencedNodeIds
        : state.selectedNodeIds.length === 1
          ? state.selectedNodeIds
          : []

    if (targetNodeIds.length > 0) {
      const targetSet = new Set(targetNodeIds)
      for (const node of state.snapshot.nodes) {
        if (targetSet.has(node.id)) {
          const nodeData = node.data as unknown as Record<string, unknown> | undefined
          if (node.type === 'image' && typeof nodeData?.url === 'string' && nodeData.url.trim()) {
            referencedImages.push(nodeData.url.trim())
          } else if (node.type === 'video' && typeof nodeData?.poster === 'string' && nodeData.poster.trim()) {
            referencedImages.push(nodeData.poster.trim())
          }
        }
      }
    }

    const userMessageContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }> =
      referencedImages.length > 0
        ? [
            { type: 'text', text: userPrompt },
            ...referencedImages.map((url) => ({
              type: 'image_url',
              image_url: { url },
            })),
          ]
        : userPrompt

    const currentMessages: Array<{
      role: 'user' | 'assistant' | 'system' | 'tool'
      content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
      tool_call_id?: string
    }> = [
      { role: 'system', content: harnessSystemPrompt },
      ...historyMessages,
      { role: 'user', content: userMessageContent },
    ]

    let maxTurns = 5
    let currentTurn = 0
    let accumulatedContent = ''
    let accumulatedThoughts = ''
    const accumulatedActions: CanvasAgentAction[] = []
    const affectedNodeIds: string[] = []
    let activePlan: AgentPlan | undefined = undefined
    let planExtracted = false

    while (currentTurn < maxTurns && !signal.aborted) {
      currentTurn += 1

      try {
        const response = await fetch('/api/agent/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            providerId,
            model,
            messages: currentMessages,
            tools: CANVAS_AGENT_TOOLS,
            stream: true,
          }),
          signal,
        })

        if (!response.ok) {
          if (currentTurn === 1) {
            const errJson = await response.json().catch(() => null)
            const rawMsg = errJson?.error?.message || errJson?.message || ''
            if (
              errJson?.error?.code === 'not_configured' ||
              response.status === 401 ||
              response.status === 403 ||
              errJson?.error?.type === 'authentication_error' ||
              rawMsg.toLowerCase().includes('authentication fails') ||
              rawMsg.toLowerCase().includes('administrator') ||
              rawMsg.toLowerCase().includes('api key')
            ) {
              await this.runLocalFallback(userPrompt, initialSnapshot, planId, events)
              return
            }
            events.onError?.(rawMsg || `大模型接口返回异常 (${response.status})`)
            return
          }
          break
        }

        // 读取 SSE 流
        const reader = response.body?.getReader()
        if (!reader) throw new Error('No readable stream')

        const decoder = new TextDecoder()
        let buffer = ''
        const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>()
        let turnContent = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith(':') || trimmed === 'data: [DONE]') continue
            if (!trimmed.startsWith('data: ')) continue

            try {
              const data = JSON.parse(trimmed.slice(6))
              const delta = data.choices?.[0]?.delta

              // 收集思考 (仅在模型有真实的 reasoning_content 时)
              if (delta?.reasoning_content) {
                accumulatedThoughts += delta.reasoning_content
                events.onThinking?.(accumulatedThoughts)
              }

              // 收集文本
              if (delta?.content) {
                turnContent += delta.content
                accumulatedContent += delta.content

                // 尝试流式检测 <plan>
                if (!planExtracted && accumulatedContent.includes('</plan>')) {
                  const parsed = extractPlanFromText(accumulatedContent, planId)
                  if (parsed.plan) {
                    activePlan = parsed.plan
                    planExtracted = true
                    events.onPlanCreated?.(activePlan)
                  }
                }

                // 仅向 UI 发送剥离了 <plan> 的纯净文字
                const displayToken = delta.content.replace(/<\/?plan>/gi, '')
                if (displayToken) {
                  events.onToken?.(displayToken)
                }
              }

              // 收集 Tool Calls
              if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0
                  const existing = toolCallsMap.get(idx) || { id: tc.id || '', name: '', arguments: '' }
                  if (tc.id) existing.id = tc.id
                  if (tc.function?.name) existing.name += tc.function.name
                  if (tc.function?.arguments) existing.arguments += tc.function.arguments
                  toolCallsMap.set(idx, existing)
                }
              }
            } catch {
              // ignore parse errors
            }
          }
        }

        // 3. Act: 执行本轮收集到的工具调用
        const toolCalls = Array.from(toolCallsMap.values())
        if (toolCalls.length > 0) {
          // 如果存在计划表，将当前步骤置为 running
          if (activePlan && activePlan.steps.length > 0) {
            const runningStep = activePlan.steps.find((s) => s.status === 'pending' || s.status === 'running')
            if (runningStep) {
              runningStep.status = 'running'
              events.onStepUpdate?.(runningStep)
            }
          }

          for (const tool of toolCalls) {
            let parsedArgs = {}
            try {
              parsedArgs = JSON.parse(tool.arguments || '{}')
            } catch {
              parsedArgs = {}
            }

            const actionResult = await this.executor.executeToolCall(tool.name, parsedArgs)
            accumulatedActions.push(actionResult)
            events.onAction?.(actionResult)

            if (actionResult.details?.nodeIds && Array.isArray(actionResult.details.nodeIds)) {
              affectedNodeIds.push(...(actionResult.details.nodeIds as string[]))
            }
          }

          // 完成当前工具对应步骤
          if (activePlan && activePlan.steps.length > 0) {
            const runningStep = activePlan.steps.find((s) => s.status === 'running')
            if (runningStep) {
              runningStep.status = 'completed'
              events.onStepUpdate?.(runningStep)
            }
          }
        }

        // 4. Verify & Self-Heal (静默后台执行)
        const verification = verifyCanvasInvariants(
          this.store.getState().snapshot,
          affectedNodeIds.length > 0 ? affectedNodeIds : undefined,
        )

        // 5. Self-Heal 判断 (静默自愈循环，不在 UI 上打印技术噪音)
        if (!verification.passed && toolCalls.length > 0 && currentTurn < maxTurns) {
          const healingPrompt = buildHealingPrompt(verification)

          currentMessages.push({
            role: 'assistant',
            content: turnContent || '已执行初步操作，正在检查对齐...',
          })
          currentMessages.push({
            role: 'user',
            content: healingPrompt,
          })

          // 继续下一轮循环自愈
          continue
        }

        // 6. Multi-turn ReAct Loop 继续推演 (工具执行反馈回大模型)
        let requiresUserConfirmation = false
        for (const action of accumulatedActions) {
          if (action.requiresConfirmation) {
            requiresUserConfirmation = true
          }
        }

        if (toolCalls.length > 0 && !requiresUserConfirmation && currentTurn < maxTurns) {
          // 将本轮 Assistant 工具调用记录加入上下文
          currentMessages.push({
            role: 'assistant',
            content: turnContent,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          })

          // 将工具执行真实结果以 standard tool role 回传大模型 (闭环 Feedback)
          for (const tc of toolCalls) {
            const correspondingAction = accumulatedActions.find((a) => a.type === tc.name)
            currentMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({
                status: correspondingAction?.status ?? 'success',
                details: correspondingAction?.details,
                summary: correspondingAction?.summary,
              }),
            })
          }

          // 推进到下一轮继续让大模型调用后续工具
          continue
        }

        // 解析可能残留的 plan 标记
        const finalParsed = extractPlanFromText(accumulatedContent, planId)
        if (finalParsed.plan && !activePlan) {
          activePlan = finalParsed.plan
        }

        if (activePlan) {
          // 全部标记完成
          activePlan.steps.forEach((s) => {
            s.status = 'completed'
          })
          activePlan.status = 'completed'
        }

        const finalChatMessage: AgentChatMessage = {
          id: createBrowserUuid(),
          role: 'assistant',
          content: finalParsed.cleanText || (accumulatedActions.length > 0 ? '已完成画布操作。' : ''),
          timestamp: Date.now(),
          thoughts: accumulatedThoughts.trim() || undefined,
          plan: activePlan,
          actions: accumulatedActions.length > 0 ? accumulatedActions : undefined,
          status: 'complete',
          canRollback: accumulatedActions.length > 0,
          rollbackSnapshot: initialSnapshot,
        }

        events.onComplete?.(finalChatMessage)
        return
      } catch (err: unknown) {
        if (signal.aborted) return
        const msg = err instanceof Error ? err.message : '执行循环发生网络异常'
        events.onError?.(msg)
        return
      }
    }
  }

  private async runLocalFallback(
    userPrompt: string,
    initialSnapshot: string,
    planId: string,
    events: HarnessEvents,
  ): Promise<void> {
    const theme = userPrompt.replace(/(帮我|创建|生成|制作|分镜|画面|个|套|请|基于)/g, '').trim() || '电商爆款产品'

    const plan: AgentPlan = {
      id: planId,
      intent: '短视频分镜故事流与方案规划',
      status: 'executing',
      createdAt: Date.now(),
      steps: [
        { id: `${planId}-1`, title: '分析脚本规范与视觉分镜要求', status: 'completed' },
        { id: `${planId}-2`, title: `批量创建 3 幕${theme}故事分镜`, status: 'running' },
        { id: `${planId}-3`, title: '建立前后因果连线与渲染方案确认', status: 'pending' },
      ],
    }
    events.onPlanCreated?.(plan)

    const intro = `收到！已为您规划一套符合规范的高质感分镜故事流，并已生成渲染方案确认门禁：\n\n`
    for (const char of intro) {
      events.onToken?.(char)
      await new Promise((r) => setTimeout(r, 4))
    }

    // 1. Create nodes
    const createAction = await this.executor.executeToolCall('create_nodes', {
      nodes: [
        {
          type: 'image',
          name: '镜头 1：超微距质感特写',
          prompt: `cinematic macro close-up shot of ${theme} luxury packaging, glowing highlights, volumetric studio lighting, 8k resolution, ultra detailed, photorealistic`,
          direction: 'right',
        },
        {
          type: 'image',
          name: '镜头 2：动态使用场景演示',
          prompt: `cinematic medium dynamic shot demonstrating core ${theme} benefits, elegant hand model interaction, soft warm sunlight, 35mm film still`,
          direction: 'right',
        },
        {
          type: 'image',
          name: '镜头 3：高潮情绪定格海报',
          prompt: `cinematic emotional hero shot of ${theme}, dramatic lens flare, artistic contrast, floating water particles, masterwork commercial aesthetic`,
          direction: 'right',
        },
      ],
    })
    events.onAction?.(createAction)

    plan.steps[1]!.status = 'completed'
    plan.steps[2]!.status = 'running'
    events.onStepUpdate?.(plan.steps[1]!)
    events.onStepUpdate?.(plan.steps[2]!)

    const createdIds = (createAction.details?.nodeIds as string[]) || []
    if (createdIds.length >= 3) {
      const [n1, n2, n3] = createdIds
      const connectAction = await this.executor.executeToolCall('connect_nodes', {
        connections: [
          { sourceNodeId: n1!, targetNodeId: n2!, relation: 'flow' },
          { sourceNodeId: n2!, targetNodeId: n3!, relation: 'flow' },
        ],
      })
      events.onAction?.(connectAction)
    }

    // 2. Request Plan Confirmation
    const planAction = await this.executor.executeToolCall('request_plan_confirmation', {
      title: '电影级分镜渲染方案确认',
      description: `已为您规划 3 个分镜草稿，请确认最终渲染模型与画质参数：`,
      targetNodeIds: createdIds,
      options: [
        { id: 'opt-model-seedance', label: 'Seedance 2.0 Fast VIP', category: 'model', defaultSelected: true },
        { id: 'opt-res-2k', label: '2K 超清成图 (2048x1152)', category: 'resolution', defaultSelected: true },
        { id: 'opt-speed-quality', label: '画质优先渲染模式', category: 'speed', defaultSelected: true },
        { id: 'opt-ratio-16-9', label: '横屏电影 16:9 画幅', category: 'aspectRatio', defaultSelected: true },
      ],
      estimatedCost: '预估消耗 6 算力积分',
    })
    events.onAction?.(planAction)

    plan.steps[2]!.status = 'completed'
    plan.status = 'completed'
    events.onStepUpdate?.(plan.steps[2]!)

    const finalChatMessage: AgentChatMessage = {
      id: createBrowserUuid(),
      role: 'assistant',
      content: `${intro}\n💡 您可以在下方方案卡片中微调选项并点击「确认执行」提交生成。`,
      timestamp: Date.now(),
      plan,
      actions: [createAction, planAction],
      status: 'complete',
      canRollback: true,
      rollbackSnapshot: initialSnapshot,
    }

    events.onComplete?.(finalChatMessage)
  }

  /**
   * 一键回滚指定快照
   */
  rollback(snapshot: string): boolean {
    return this.executor.rollback(snapshot)
  }
}
