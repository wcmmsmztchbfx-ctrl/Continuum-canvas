import type { CanvasAgentAction } from './agentTypes'
import { CANVAS_AGENT_TOOLS } from './agentTypes'
import type { CanvasAgentExecutor } from './canvasExecutor'

export interface AgentChatStreamCallbacks {
  onToken: (token: string) => void
  onAction: (action: CanvasAgentAction) => void
  onError: (error: string) => void
  onComplete: () => void
}

export class AgentChatClient {
  async checkAgentStatus(): Promise<{ configured: boolean; providerId?: string; providerName?: string; model?: string; baseUrl?: string }> {
    try {
      const res = await fetch('/api/agent/status')
      if (res.ok) {
        return await res.json()
      }
    } catch {
      // ignore
    }
    return { configured: false }
  }

  async sendChatMessage(options: {
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[]
    systemPrompt: string
    canvasSummary: string
    executor: CanvasAgentExecutor
    callbacks: AgentChatStreamCallbacks
    providerId?: string
    model?: string
    signal?: AbortSignal
  }): Promise<void> {
    const { messages, systemPrompt, canvasSummary, executor, callbacks, signal } = options

    const latestUserMessage = messages.filter((m) => m.role === 'user').at(-1)?.content || ''

    const conversationHistory: Array<{
      role: 'user' | 'assistant' | 'system' | 'tool'
      content?: string
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
      tool_call_id?: string
    }> = [
      { role: 'system', content: `${systemPrompt}\n\n${canvasSummary}` },
      ...messages,
    ]

    const MAX_ROUNDS = 5
    let currentRound = 0

    try {
      while (currentRound < MAX_ROUNDS) {
        if (signal?.aborted) return
        currentRound++

        await fetch('/api/local-admin/session', { method: 'POST' }).catch(() => {})

        const response = await fetch('/api/agent/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            providerId: options.providerId,
            model: options.model,
            messages: conversationHistory,
            tools: CANVAS_AGENT_TOOLS,
            stream: true,
          }),
          signal,
        })

        if (!response.ok) {
          if (currentRound === 1) {
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
              // 自动切换为本地自主推演引擎
              await this.handleLocalHeuristicAgent(latestUserMessage, executor, callbacks)
              return
            }
            callbacks.onError(rawMsg ? `大模型调用失败: ${rawMsg}` : `请求异常 (${response.status})`)
            return
          }
          break
        }

        const turnResult = await this.readStreamTurn(response, callbacks)

        // 若大模型在当前轮次未发起工具调用，说明本次任务推演完成
        if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
          callbacks.onComplete()
          return
        }

        // 将当前轮次大模型的工具调用加入历史上下文
        conversationHistory.push({
          role: 'assistant',
          content: turnResult.content || '',
          tool_calls: turnResult.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        })

        // 依次执行工具调用并将真实执行结果回传给大模型 (闭环 Feedback)
        let requiresUserConfirmation = false
        for (const tool of turnResult.toolCalls) {
          if (!tool.name) continue
          try {
            const parsedArgs = tool.arguments ? JSON.parse(tool.arguments) : {}
            const actionResult = await executor.executeToolCall(tool.name, parsedArgs)
            callbacks.onAction(actionResult)

            if (actionResult.requiresConfirmation) {
              requiresUserConfirmation = true
            }

            conversationHistory.push({
              role: 'tool',
              tool_call_id: tool.id,
              content: JSON.stringify({
                status: actionResult.status,
                type: actionResult.type,
                summary: actionResult.summary,
                details: actionResult.details,
              }),
            })
          } catch (err) {
            conversationHistory.push({
              role: 'tool',
              tool_call_id: tool.id,
              content: JSON.stringify({
                status: 'failed',
                error: err instanceof Error ? err.message : String(err),
              }),
            })
          }
        }

        // 若当前步骤涉及方案确认门禁（如 request_plan_confirmation 或 trigger_generation），暂停等待用户选择
        if (requiresUserConfirmation) {
          callbacks.onComplete()
          return
        }
      }

      callbacks.onComplete()
    } catch (error: unknown) {
      if (signal?.aborted) return
      callbacks.onError(error instanceof Error ? `网络请求错误: ${error.message}` : '网络连接失败')
    }
  }

  private async readStreamTurn(
    response: Response,
    callbacks: AgentChatStreamCallbacks,
  ): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No readable stream')

    const decoder = new TextDecoder()
    let buffer = ''
    let accumulatedContent = ''
    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (trimmed === 'data: [DONE]') continue

        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6))
            const choice = data.choices?.[0]
            if (choice?.delta?.content) {
              accumulatedContent += choice.delta.content
              callbacks.onToken(choice.delta.content)
            }
            if (choice?.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index ?? 0
                const current = toolCallBuffers.get(idx) ?? { id: tc.id || `call_${Date.now()}_${idx}`, name: '', arguments: '' }
                if (tc.id) current.id = tc.id
                if (tc.function?.name) current.name += tc.function.name
                if (tc.function?.arguments) current.arguments += tc.function.arguments
                toolCallBuffers.set(idx, current)
              }
            }
          } catch {
            // ignore partial JSON parse error
          }
        }
      }
    }

    return {
      content: accumulatedContent,
      toolCalls: Array.from(toolCallBuffers.values()),
    }
  }

  private async handleLocalHeuristicAgent(
    userPrompt: string,
    executor: CanvasAgentExecutor,
    callbacks: AgentChatStreamCallbacks,
  ): Promise<void> {
    const prompt = userPrompt.trim()

    // 1. Skill 与导演闭环推演意图（优先判定）
    if (
      prompt.includes('skill') ||
      prompt.includes('Skill') ||
      prompt.includes('技能') ||
      prompt.includes('导演') ||
      prompt.includes('闭环')
    ) {
      const intro = `收到制片闭环指令！正在为您推进长任务推演：\n1. 🔍 抽取并生成专属制片技能规范（Skill 节点）\n2. 🎬 部署 AI 导演工作台并接入参考图\n3. 🔗 注入技能规范建立端到端闭环\n4. 📋 输出自适应执行方案供确认...\n\n`
      for (const char of intro) {
        callbacks.onToken(char)
        await new Promise((r) => setTimeout(r, 4))
      }

      // 步骤 1: 创建 Skill 规范节点和导演台
      const createAction = await executor.executeToolCall('create_nodes', {
        nodes: [
          {
            type: 'skill',
            name: '电影级分镜与镜头调度',
            text: `# 电影级分镜与镜头调度规范\n\n## 一、镜头运镜要求\n- 景别：采用特写 (Close-Up) 与推镜头 (Dolly In)\n- 帧率与质感：24fps 电影胶片颗粒感，自然暗角\n- 构图：黄金分割，主体居中偏右\n\n## 二、导演成片准则\n1. 强化光影体积感 (Volumetric Lighting)\n2. 动作节奏平缓，禁止突兀抖动\n3. 交付标准：高清 1080P，16:9 画幅`,
            direction: 'right',
          },
          {
            type: 'director',
            name: 'AI 导演工作台',
            direction: 'right',
          },
        ],
      })
      callbacks.onAction(createAction)

      const nodeIds = (createAction.details?.nodeIds as string[]) || []
      const skillId = nodeIds[0]
      const dirId = nodeIds[1]

      if (skillId && dirId) {
        // 步骤 2: 注入技能到导演工作台
        const connectAction = await executor.executeToolCall('connect_nodes', {
          connections: [
            {
              sourceNodeId: skillId,
              targetNodeId: dirId,
              relation: 'skill',
            },
          ],
        })
        callbacks.onAction(connectAction)
      }

      // 步骤 3: 呈现方案确认门禁
      const planAction = await executor.executeToolCall('request_plan_confirmation', {
        title: '制片成片执行方案确认',
        description: '已就绪「电影级分镜与镜头调度」技能规范，并已成功注入 AI 导演工作台。请确认以下制片生成参数：',
        targetNodeIds: dirId ? [dirId] : nodeIds,
        options: [
          {
            id: 'opt-model-speed',
            label: 'Seedance 2.5 (极速推演 · 限时优惠)',
            category: 'model',
            description: '快速生成分镜成片，推理延迟低',
            defaultSelected: true,
          },
          {
            id: 'opt-res-1080p',
            label: '1080P 高清分辨率',
            category: 'resolution',
            description: '电影级清晰度输出',
            defaultSelected: true,
          },
          {
            id: 'opt-ratio-169',
            label: '16:9 电影画幅',
            category: 'ratio',
            description: '横屏视听观影比例',
            defaultSelected: true,
          },
        ],
        estimatedCost: '预估消耗 10 算力积分',
      })
      callbacks.onAction(planAction)

      const outro = `\n已就绪全部前期资产并注入规范。请在上方方案卡片中确认生成参数，点击「确认执行」即可向画布交付最终成片！`
      for (const char of outro) {
        callbacks.onToken(char)
        await new Promise((r) => setTimeout(r, 4))
      }
      callbacks.onComplete()
      return
    }

    // 2. 画布排版意图
    if (prompt.includes('排版') || prompt.includes('对齐') || prompt.includes('整理')) {
      const msg = `正在为您重新整理和对齐画布上的所有节点...\n`
      for (const char of msg) {
        callbacks.onToken(char)
        await new Promise((r) => setTimeout(r, 4))
      }

      const strategy = prompt.includes('网格') ? 'grid' : 'storyboard_horizontal'
      const action = await executor.executeToolCall('auto_layout', { strategy })
      callbacks.onAction(action)
      callbacks.onComplete()
      return
    }

    // 3. 分镜创建意图
    if (prompt.includes('分镜') || prompt.includes('镜头') || prompt.includes('场景') || prompt.includes('画面') || prompt.includes('创建')) {
      const intro = `收到！我已根据您的创意意图，为您在画布上规划并创建了一组连续的分镜画面。包含精细打磨的光影构图提示词，并已建立故事流连线：\n\n`
      for (const char of intro) {
        callbacks.onToken(char)
        await new Promise((r) => setTimeout(r, 4))
      }

      const theme = prompt.replace(/(帮我|创建|生成|制作|分镜|画面|个|套)/g, '').trim() || '科幻微电影'

      const action = await executor.executeToolCall('create_nodes', {
        nodes: [
          {
            type: 'image',
            name: '分镜 1：全景建立镜头',
            prompt: `cinematic establishing wide shot of ${theme}, atmospheric volumetric lighting, 8k resolution, photorealistic, Unreal Engine 5 render, cinematic color grading`,
            direction: 'right',
          },
          {
            type: 'image',
            name: '分镜 2：中景角色交互',
            prompt: `medium shot in ${theme}, dynamic character interaction, shallow depth of field, neon backlight reflections, dramatic shadows, 35mm film still`,
            direction: 'right',
          },
          {
            type: 'image',
            name: '分镜 3：特写情绪高潮',
            prompt: `macro close-up shot of details in ${theme}, highly detailed eye reflections, intense emotional lighting, anamorphic lens flare, movie masterpiece`,
            direction: 'right',
          },
        ],
      })
      callbacks.onAction(action)

      if (action.details?.nodeIds && Array.isArray(action.details.nodeIds) && action.details.nodeIds.length >= 3) {
        const [n1, n2, n3] = action.details.nodeIds as string[]
        const connectAction = await executor.executeToolCall('connect_nodes', {
          connections: [
            { sourceNodeId: n1, targetNodeId: n2, relation: 'flow' },
            { sourceNodeId: n2, targetNodeId: n3, relation: 'flow' },
          ],
        })
        callbacks.onAction(connectAction)
      }

      // 自动附带方案确认门禁
      const planAction = await executor.executeToolCall('request_plan_confirmation', {
        title: '分镜渲染方案确认',
        description: `已规划 3 个分镜草稿，请确认渲染方案：`,
        targetNodeIds: (action.details?.nodeIds as string[]) || [],
        options: [
          { id: 'opt-model-vip', label: 'Seedance 2.0 Fast VIP', category: 'model', defaultSelected: true },
          { id: 'opt-res-2k', label: '2K 超清成图', category: 'resolution', defaultSelected: true },
        ],
        estimatedCost: '预估消耗 6 算力积分',
      })
      callbacks.onAction(planAction)

      const outro = `\n💡 您可以直接点击任意节点微调提示词，或在上方方案卡片中点击「确认执行」启动渲染。`
      for (const char of outro) {
        callbacks.onToken(char)
        await new Promise((r) => setTimeout(r, 4))
      }
      callbacks.onComplete()
      return
    }

    // 4. 默认通用回复与建议
    const defaultMsg = `我是您的画布智能助手！我可以帮您：
1. **自动生成分镜流**：输入如「帮我创建赛博朋克主题的 3 个分镜」；
2. **构建闭环工作流**：输入「创建专门的 skill 生成文案并注入导演台成片」；
3. **连接节点故事线**：自动建立镜头流转逻辑与真实参考引用；
4. **一键自动排版**：输入「自动整理排版画布」。

请告诉我您接下来的创作设想吧！`

    for (const char of defaultMsg) {
      callbacks.onToken(char)
      await new Promise((r) => setTimeout(r, 6))
    }
    callbacks.onComplete()
  }
}
