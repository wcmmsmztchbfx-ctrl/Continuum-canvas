import { useCallback, useMemo, useRef, useState } from 'react'
import { ACTIVE_AGENT_STATUSES, type AgentRun } from '../../../contracts/agent'
import { mergeAgentRuns } from '../../../services/agent/agentRuntimeClient'
import { createBrowserUuid } from '../../../utils/id'

interface Session { selectedId?: string; emptyIds: string[] }
export interface ConversationOption { id: string; title: string; active: boolean }
export interface ConversationSession {
  conversationRuns: AgentRun[]
  conversationId: string
  conversationOptions: ConversationOption[]
  onConversationRuns: (runs: AgentRun[]) => void
  onChooseConversation: (id: string) => void
  onNewConversation: () => void
}
export function useAgentConversations(canvasId?: string): ConversationSession {
  const key = `continuum_agent_conversations_v1_${canvasId || 'default'}`
  const [session, setSession] = useState<Session>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? 'null')
      if (stored && Array.isArray(stored.emptyIds) && stored.emptyIds.every((id: unknown) => typeof id === 'string') && (stored.selectedId === undefined || typeof stored.selectedId === 'string')) return stored
    } catch { /* unavailable storage */ }
    return { emptyIds: ['legacy'] }
  })
  const sessionRef = useRef(session); sessionRef.current = session
  const [runs, setRuns] = useState<AgentRun[]>([])
  const save = useCallback((next: Session) => {
    sessionRef.current = next; setSession(next)
    try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* server-backed conversation history remains available */ }
  }, [key])
  const onConversationRuns = useCallback((incoming: AgentRun[]) => {
    setRuns(previous => mergeAgentRuns(previous, incoming, canvasId || ''))
    if (!sessionRef.current.selectedId) save({ ...sessionRef.current, selectedId: incoming.at(-1)?.conversationId ?? 'legacy' })
  }, [canvasId, save])
  const conversationOptions = useMemo(() => {
    const groups = new Map<string, ConversationOption>(session.emptyIds.map(id => [id, { id, title: id === 'legacy' ? '默认对话' : '新对话', active: false }]))
    const titled = new Set<string>()
    for (const run of runs) {
      const id = run.conversationId ?? 'legacy'
      const previous = groups.get(id)
      groups.set(id, { id, title: titled.has(id) ? previous!.title : run.prompt.split('\n')[0].slice(0, 32) || '新对话', active: previous?.active === true || ACTIVE_AGENT_STATUSES.includes(run.status) })
      titled.add(id)
    }
    if (session.selectedId && !groups.has(session.selectedId)) groups.set(session.selectedId, { id: session.selectedId, title: '加载对话中…', active: false })
    return [...groups.values()]
  }, [runs, session])
  return { conversationRuns: runs, conversationId: session.selectedId ?? 'legacy', conversationOptions, onConversationRuns,
    onChooseConversation: id => save({ ...sessionRef.current, selectedId: id }),
    onNewConversation: () => { const id = createBrowserUuid(); save({ selectedId: id, emptyIds: [...sessionRef.current.emptyIds, id] }) },
  }
}
