import type { ModelMessage } from './model.ts'
import { AgentError } from './types.ts'

interface Round { assistant: ModelMessage; tools: ModelMessage[]; users: ModelMessage[]; complete: boolean }

/** Keep a tool response adjacent to its request even if a user supplemented a
 * running generation before it finished. Never split a tool-call/result group. */
function conversationParts(messages: ModelMessage[]): Array<ModelMessage | Round> {
  const parts: Array<ModelMessage | Round> = []
  for (let index = 0; index < messages.length;) {
    const message = messages[index++]
    if (message.role !== 'assistant') { parts.push(message); continue }
    const following: ModelMessage[] = []
    while (index < messages.length && messages[index].role !== 'assistant') following.push(messages[index++])
    const calls = (message.tool_calls ?? []) as Array<{ id?: string }>
    const responses = following.filter(m => m.role === 'tool')
    const tools = calls.flatMap(call => responses.filter(m => m.tool_call_id === call.id).slice(-1))
    parts.push({ assistant: message, tools, users: following.filter(m => m.role === 'user'), complete: calls.length === tools.length })
  }
  return parts
}

export function normalizedConversation(messages: ModelMessage[]): ModelMessage[] {
  return conversationParts(messages).flatMap(part => 'assistant' in part ? [part.assistant, ...part.tools, ...part.users] : [part])
}

export function compactConversation(messages: ModelMessage[], limit = 80_000): { messages: ModelMessage[]; removedRounds: number } {
  const parts = conversationParts(messages)
  let removedRounds = 0
  const flatten = () => parts.flatMap(part => 'assistant' in part ? [part.assistant, ...part.tools, ...part.users] : [part])
  let current = flatten()
  // User requirements/answers are never summarized away. Plans and actual
  // operation receipts are separately persisted and included in current context.
  for (let index = 0; JSON.stringify(current).length > limit && index < parts.length; index++) {
    const part = parts[index]
    if (!('assistant' in part) || !part.complete) continue
    parts.splice(index, 1, ...part.users); index += part.users.length - 1
    removedRounds++; current = flatten()
  }
  if (JSON.stringify(current).length > limit) throw new AgentError(409, 'user_context_limit', '用户要求本身已超过上下文容量；请新建任务并明确当前需要保留的要求，原记录仍已保存。')
  return { messages: current, removedRounds }
}
