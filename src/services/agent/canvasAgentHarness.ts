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
    providerId?: string
    model?: string
    events: HarnessEvents
  }): Promise<void> {
    const { userPrompt, historyMessages, providerId, model, events } = options
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

    const currentMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
      { role: 'system', content: harnessSystemPrompt },
      ...historyMessages,
      { role: 'user', content: userPrompt },
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
          const errJson = await response.json().catch(() => null)
          const msg = errJson?.error?.message || `大模型接口返回异常 (${response.status})`
          events.onError?.(msg)
          return
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

  /**
   * 一键回滚指定快照
   */
  rollback(snapshot: string): boolean {
    return this.executor.rollback(snapshot)
  }
}
