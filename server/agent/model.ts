import type { AgentConfigStore } from '../agent-config-store.ts'
import { AgentError } from './types.ts'

export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ModelTurn { text?: string; calls: ToolCall[]; incomplete?: boolean }
export interface ModelMessage { role: 'user' | 'assistant' | 'tool'; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }
export interface AgentModelInput { system: string; messages: ModelMessage[]; tools: unknown[]; signal: AbortSignal; hasImages: boolean }
export type AgentModel = (input: AgentModelInput) => Promise<ModelTurn>

export function configuredModel(config: AgentConfigStore): AgentModel {
  return async (input) => {
    const preferred = config.getPreferred()
    const provider = preferred?.enabled && preferred.secretConfigured ? preferred : config.listPublic().find(p => p.enabled && p.secretConfigured)
    if (!provider) throw new AgentError(409, 'model_not_configured', '请先在 API 设置中配置 Agent 大模型，然后继续任务。')
    if (input.hasImages && /deepseek-chat|deepseek-reasoner|moonshot-v1|glm-4-flash|llama-3\.3|ernie-4/i.test(provider.model)) {
      throw new AgentError(409, 'vision_not_supported', '当前 Agent 模型不支持图片输入，请配置支持视觉的模型后继续；尚未查看引用图片。')
    }
    let response: Response
    try {
      response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', signal: AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]),
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.getSecret(provider.id)}` },
        body: JSON.stringify({ model: provider.model, stream: false, max_tokens: 4096,
          messages: [{ role: 'system', content: input.system }, ...input.messages], ...(input.tools.length ? { tools: input.tools, tool_choice: 'auto' } : {}) }),
      })
    } catch { throw new AgentError(502, 'model_unavailable', 'Agent 模型请求失败；任务已保留，可稍后继续。') }
    if (!response.ok) throw new AgentError(502, 'model_rejected', `Agent 模型返回错误（${response.status}）；请核对模型配置与图片能力。`)
    const reader = response.body?.getReader()
    if (!reader) throw new AgentError(502, 'model_invalid_response', 'Agent 模型未返回内容。')
    let bytes = 0; const chunks: Uint8Array[] = []
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length
      if (bytes > 512_000) { await reader.cancel(); throw new AgentError(502, 'model_response_limit', 'Agent 模型响应超出限制。') }
      chunks.push(chunk.value) }
    let payload: { choices?: Array<{ finish_reason?: string; message?: { content?: unknown; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }> }
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new AgentError(502, 'model_invalid_response', 'Agent 模型响应格式无效。') }
    const choice = payload.choices?.[0]
    if (!choice?.message || (choice.finish_reason === 'length' && (choice.message.tool_calls?.length || !choice.message.content))) throw new AgentError(502, 'model_incomplete', 'Agent 模型响应未完整结束，请继续重试。')
    const calls = choice.message.tool_calls ?? []
    if (calls.length > 8) throw new AgentError(422, 'tool_limit', '单轮工具调用超过限制。')
    return { text: typeof choice.message.content === 'string' ? choice.message.content : undefined,
      ...(choice.finish_reason === 'length' ? { incomplete: true } : {}),
      calls: calls.map((call) => {
        if (call.type !== 'function' || !call.id || !call.function?.name) throw new AgentError(502, 'model_invalid_tool', 'Agent 工具调用格式无效。')
        let args: unknown
        try { args = JSON.parse(call.function.arguments ?? '{}') } catch { throw new AgentError(502, 'model_invalid_tool', 'Agent 工具参数不是有效 JSON。') }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new AgentError(502, 'model_invalid_tool', 'Agent 工具参数必须是对象。')
        return { id: call.id, name: call.function.name, arguments: args as Record<string, unknown> }
      }) }
  }
}
