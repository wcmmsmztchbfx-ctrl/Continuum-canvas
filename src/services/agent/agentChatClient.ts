import type { CanvasAgentAction } from './agentTypes'
import { CANVAS_AGENT_TOOLS } from './agentTypes'
import type { CanvasAgentExecutor } from './canvasExecutor'
import { gatewayClient } from '../gatewayClient'

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

    try {
      const roomId = gatewayClient.getCollaborationRoomId()
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (roomId) {
        headers['x-collaboration-room'] = roomId
      }
      // 尝试向本地 Gateway 的 /api/agent/chat 发送请求
      const response = await fetch('/api/agent/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          providerId: options.providerId,
          model: options.model,
          messages: [
            { role: 'system', content: `${systemPrompt}\n\n${canvasSummary}` },
            ...messages,
          ],
          tools: CANVAS_AGENT_TOOLS,
          stream: true,
        }),
        signal,
      })

      if (response.ok) {
        if (response.body) {
          await this.handleSseResponse(response, executor, callbacks)
          return
        }
        const data = await response.json().catch(() => null)
        if (data?.choices?.[0]?.message?.content) {
          const content = data.choices[0].message.content as string
          for (const char of content) {
            callbacks.onToken(char)
            await new Promise((r) => setTimeout(r, 4))
          }
          callbacks.onComplete()
          return
        }
        // 回退到本地启发式指令执行器
        await this.handleLocalHeuristicAgent(latestUserMessage, executor, callbacks)
        return
      }

      const errJson = await response.json().catch(() => null)
      if (errJson?.error?.code === 'not_configured') {
        callbacks.onError('尚未接入 Agent 大模型，请在「管理 API 接入」中配置大模型的 API Key')
        return
      }

      const rawMsg = errJson?.error?.message || errJson?.message || ''
      callbacks.onError(
        rawMsg ? `大模型接口调用失败 (${response.status}): ${rawMsg}` : `大模型请求异常 (${response.status})`,
      )
    } catch (error: unknown) {
      if (signal?.aborted) return
      callbacks.onError(error instanceof Error ? `网络请求错误: ${error.message}` : '网络连接失败')
    }
  }

  private async handleSseResponse(
    response: Response,
    executor: CanvasAgentExecutor,
    callbacks: AgentChatStreamCallbacks,
  ): Promise<void> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No readable stream')

    const decoder = new TextDecoder()
    let buffer = ''
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
              callbacks.onToken(choice.delta.content)
            }
            if (choice?.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index ?? 0
                const current = toolCallBuffers.get(idx) ?? { id: tc.id || '', name: '', arguments: '' }
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

    // 执行收集到的 Tool Calls
    for (const [, tool] of toolCallBuffers) {
      if (!tool.name) continue
      try {
        const parsedArgs = tool.arguments ? JSON.parse(tool.arguments) : {}
        const actionResult = await executor.executeToolCall(tool.name, parsedArgs)
        callbacks.onAction(actionResult)
      } catch (err) {
        console.error('Failed to execute tool call:', tool, err)
      }
    }

    callbacks.onComplete()
  }

  private async handleLocalHeuristicAgent(
    userPrompt: string,
    executor: CanvasAgentExecutor,
    callbacks: AgentChatStreamCallbacks,
  ): Promise<void> {
    // 智能本地启发式解析器：即使在无外网 API Key 时也能自主响应和操控画布
    const prompt = userPrompt.trim()

    // 1. 画布排版意图（优先判定）
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

    // 2. 分镜创建意图
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

      const outro = `\n💡 您可以直接点击任意节点微调提示词，或点击下方的「生成」按钮开始批量渲染。若需调整布局，可随时按 Ctrl+Z 一键撤销！`
      for (const char of outro) {
        callbacks.onToken(char)
        await new Promise((r) => setTimeout(r, 4))
      }
      callbacks.onComplete()
      return
    }

    // 3. 默认通用回复与建议
    const defaultMsg = `我是您的画布智能助手！我可以帮您：
1. **自动生成分镜流**：输入如「帮我创建赛博朋克主题的 3 个分镜」；
2. **连接节点故事线**：自动建立镜头流转逻辑；
3. **润色撰写提示词**：为图片/视频节点编写电影级 prompt；
4. **一键自动排版**：输入「自动整理排版画布」。

请告诉我您接下来的创作设想吧！`

    for (const char of defaultMsg) {
      callbacks.onToken(char)
      await new Promise((r) => setTimeout(r, 6))
    }
    callbacks.onComplete()
  }
}
