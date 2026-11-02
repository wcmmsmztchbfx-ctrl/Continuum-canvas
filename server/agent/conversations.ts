import type { AgentRun } from '../../src/contracts/agent.ts'
import type { ModelMessage } from './model.ts'
import type { StoredRun } from './types.ts'

export const conversationIdOf = (run: AgentRun) => run.conversationId ?? 'legacy'
const legacyWrites = new Set(['create_node', 'update_node', 'delete_nodes', 'duplicate_node', 'move_nodes', 'group_nodes', 'connect_nodes', 'remove_edge'])

/** Old paused tasks gain a readable receipt without rewriting user history. */
export function budgetFallback(record: StoredRun): string {
  const created = new Set(record.changes.filter(c => c.collection === 'nodes' && !c.path.length && c.before === undefined && c.after !== undefined).map(c => c.id))
  const prompts = new Set(record.changes.filter(c => c.collection === 'nodes' && c.path.join('.') === 'data.promptDraft').map(c => c.id))
  for (const change of record.changes) if (created.has(change.id) && !change.path.length) {
    const node = change.after as { data?: { promptDraft?: unknown } } | undefined
    if (typeof node?.data?.promptDraft === 'string' && node.data.promptDraft.length) prompts.add(change.id)
  }
  const writes = record.operations.filter(o => o.state === 'complete' && (legacyWrites.has(o.call.name) ? !!o.result && !(o.result as { error?: unknown }).error : (o.result as { committed?: boolean })?.committed)).length
  const pending = record.run.plan.filter(p => p.status !== 'complete' && p.status !== 'skipped').map(p => p.title)
  return `本轮已达到执行步数上限，已暂停后续操作。\n\n已记录的实际进度：\n- 新建节点：${created.size} 个\n- 更新提示词：${prompts.size} 个节点\n- 已提交画布操作：${writes} 项\n- 已回写生成结果：${record.bindings.filter(b => b.applied).length} 个\n\n${pending.length ? `尚待完成或核验：${pending.join('、')}。` : '最终核验与其余要求尚未确认完成。'}\n已提交的内容会保留；可以继续处理剩余步骤，也可以先检查画布。`
}
export function publicConversationRun(record: StoredRun): AgentRun {
  const run = structuredClone(record.run)
  if (!run.response && run.error?.code === 'run_limit') run.response = budgetFallback(record)
  return run
}

/** Conversation text is context, never a previous tool receipt or write grant. */
export function previousConversationMessages(previous: StoredRun): ModelMessage[] {
  const messages = previous.messages.filter(m => (m.role === 'user' || (m.role === 'assistant' && !m.tool_calls?.length)) && typeof m.content === 'string' && m.content.length > 0).map(m => ({ role: m.role, content: m.content } as ModelMessage))
  const response = publicConversationRun(previous).response
  if (response && !(messages.at(-1)?.role === 'assistant' && messages.at(-1)?.content === response)) messages.push({ role: 'assistant', content: response })
  while (JSON.stringify(messages).length > 56_000 && messages.length > 2) {
    messages.shift()
    while (messages.length > 2 && messages[0].role !== 'user') messages.shift()
  }
  return structuredClone(messages)
}
