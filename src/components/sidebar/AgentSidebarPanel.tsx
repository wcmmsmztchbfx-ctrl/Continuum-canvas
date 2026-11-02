import { BookOpen, ChevronDown, Loader2, Lock, Plus, Send, ServerCog, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StoreApi } from 'zustand/vanilla'
import { ACTIVE_AGENT_STATUSES, type AgentAttachment, type AgentControlAction, type AgentCreateRunInput, type AgentRun, type AgentSkillInfo } from '../../contracts/agent'
import { canvasStore } from '../../store/canvas-store'
import type { CanvasStoreState } from '../../store/types'
import { absolutePositions } from '../../store/storeHelpers'
import { AgentRuntimeClient, AgentRuntimeError, mergeAgentRuns, prepareAgentAttachment, type AgentImageSource, type AgentStatus } from '../../services/agent/agentRuntimeClient'
import { createBrowserUuid } from '../../utils/id'
import { LibTvLogo } from '../shell/LibTvLogo'
import { ManagedMediaImage } from '../canvas/ManagedMediaImage'
import { AgentRunCard } from './agent/AgentRunCard'
import { useAgentConversations, type ConversationSession } from './agent/useAgentConversations'
import { useSelectedAgentImages } from './agent/useSelectedAgentImages'
import '../../styles/agent-runtime.css'

export interface AgentSidebarPanelProps {
  onNotify?: (message: string, tone?: 'info' | 'success' | 'error') => void
  store?: StoreApi<CanvasStoreState>
  onOpenProviderDrawer?: () => void
  readOnly?: boolean
  canvasId?: string
  onBeforeRun?: () => Promise<{ expectedRevision: number }>
}
interface Draft { prompt: string; attachments: AgentAttachment[]; pending?: AgentCreateRunInput }
const EMPTY_DRAFT: Draft = { prompt: '', attachments: [] }
const keyFor = (canvasId?: string, conversationId = 'legacy') => `continuum_agent_draft_v1_${canvasId || 'default'}${conversationId === 'legacy' ? '' : `_${conversationId}`}`
function loadDraft(canvasId?: string, conversationId = 'legacy'): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(keyFor(canvasId, conversationId)) ?? 'null')
    if (value && typeof value.prompt === 'string' && Array.isArray(value.attachments)) return { prompt: value.prompt, attachments: value.attachments.filter((item: AgentAttachment) => item && typeof item.assetId === 'string' && typeof item.nodeId === 'string'), ...(value.pending?.canvasId === canvasId ? { pending: value.pending } : {}) }
  } catch { /* storage unavailable */ }
  return EMPTY_DRAFT
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Agent 请求失败，请重试'

/** A canvas switch remounts only the panel session, never cancelling a backend run. */
export function AgentSidebarPanel(props: AgentSidebarPanelProps) {
  return <AgentCanvasPanel key={props.canvasId || 'unscoped'} {...props} />
}
function AgentCanvasPanel(props: AgentSidebarPanelProps) {
  const conversations = useAgentConversations(props.canvasId)
  return <AgentConversationPanel key={conversations.conversationId} {...props} {...conversations} />
}
function AgentConversationPanel({ onNotify, store = canvasStore, onOpenProviderDrawer, readOnly = false, canvasId, onBeforeRun, conversationRuns, conversationId, conversationOptions, onConversationRuns, onChooseConversation, onNewConversation }: AgentSidebarPanelProps & ConversationSession) {
  const client = useMemo(() => new AgentRuntimeClient(), [])
  const [allRuns, setRuns] = useState<AgentRun[]>(conversationRuns)
  const runs = allRuns.filter(run => (run.conversationId ?? 'legacy') === conversationId)
  const historicalResponses = useRef<Map<string, string> | null>(conversationRuns.length ? new Map(conversationRuns.filter(run => run.response).map(run => [run.id, run.response!])) : null)
  const createdHere = useRef(new Set<string>())
  const [legacy, setLegacy] = useState<Array<{ id: string; role: string; content: string }>>([])
  const [draft, setDraft] = useState<Draft>(() => loadDraft(canvasId, conversationId))
  const draftRef = useRef(draft)
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [skills, setSkills] = useState<AgentSkillInfo[]>([])
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [skillsError, setSkillsError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [busyLabel, setBusyLabel] = useState('')
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [newTask, setNewTask] = useState(false)
  const [expandedReferences, setExpandedReferences] = useState(false)
  const [uploading, setUploading] = useState<string[]>([])
  const uploads = useRef(new Map<string, AbortController>())
  const referenceOrder = useRef(new Map(draft.attachments.map((attachment, index) => [attachment.nodeId, index])))
  const nextReferenceOrder = useRef(draft.attachments.length)
  const [visibleRunCount, setVisibleRunCount] = useState(20)
  const [visibleLegacyCount, setVisibleLegacyCount] = useState(40)
  const alive = useRef(true)
  const canWrite = useRef(!readOnly)
  canWrite.current = !readOnly
  const composing = useRef(false)
  const chatRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [newContent, setNewContent] = useState(false)
  const selectedImages = useSelectedAgentImages(store)
  const candidates = selectedImages.filter(image => !draft.attachments.some(attachment => attachment.nodeId === image.nodeId))
  const activeRun = runs.find(run => ACTIVE_AGENT_STATUSES.includes(run.status) && run.status !== 'queued') ?? runs.find(run => ACTIVE_AGENT_STATUSES.includes(run.status))
  const supplement = !!activeRun && !newTask && !draft.pending

  const saveDraft = useCallback((next: Draft) => {
    draftRef.current = next
    try { localStorage.setItem(keyFor(canvasId, conversationId), JSON.stringify(next)) } catch { /* editing remains usable */ }
    if (alive.current) setDraft(next)
  }, [canvasId, conversationId])
  const reportError = useCallback((failure: unknown) => {
    if (!alive.current) return
    const message = errorMessage(failure); setError(message); onNotify?.(message, 'error')
  }, [onNotify])
  const acceptRuns = useCallback((incoming: AgentRun[], fromPoll = false) => {
    if (!alive.current || !canvasId) return
    if (fromPoll && historicalResponses.current === null) historicalResponses.current = new Map(incoming.filter(run => run.response && !createdHere.current.has(run.id)).map(run => [run.id, run.response!]))
    setRuns(previous => mergeAgentRuns(previous, incoming, canvasId))
    onConversationRuns(incoming)
    const pending = draftRef.current.pending
    if (pending && incoming.some(run => run.canvasId === canvasId && run.requestId === pending.requestId)) { saveDraft(EMPTY_DRAFT); setError('') }
  }, [canvasId, saveDraft, onConversationRuns])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; for (const controller of uploads.current.values()) controller.abort() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let failureCount = 0
    const poll = async () => {
      if (!canvasId) return
      try { const incoming = await client.listRuns(canvasId, controller.signal); if (!active) return; acceptRuns(incoming, true); setConnectionError(''); failureCount = 0 }
      catch (failure) { if (!active) return; failureCount++; setConnectionError(`暂时无法更新任务状态：${errorMessage(failure)}`) }
      if (active) timer = setTimeout(poll, Math.min(15_000, 2000 * 2 ** Math.min(failureCount, 3)))
    }
    void poll()
    if (conversationId === 'legacy') void client.legacyHistory(canvasId, controller.signal).then(messages => { if (active) setLegacy(messages) })
    return () => { active = false; controller.abort(); clearTimeout(timer) }
  }, [client, canvasId, acceptRuns, conversationId])
  useEffect(() => {
    const controller = new AbortController()
    let version = 0
    const check = async () => {
      const requestVersion = ++version
      try { const next = await client.status(controller.signal); if (!controller.signal.aborted && requestVersion === version) setStatus(next) }
      catch { if (!controller.signal.aborted && requestVersion === version) setStatus(null) }
    }
    void check()
    void client.listSkills(controller.signal).then(items => { if (!controller.signal.aborted) setSkills(items) }).catch(failure => { if (!controller.signal.aborted) setSkillsError(errorMessage(failure)) })
    window.addEventListener('focus', check); window.addEventListener('agent-providers-changed', check)
    return () => { controller.abort(); window.removeEventListener('focus', check); window.removeEventListener('agent-providers-changed', check) }
  }, [client])
  useEffect(() => {
    if (following.current && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
    else setNewContent(true)
  }, [runs, legacy])

  const confirmReferences = async (sources: AgentImageSource[]) => {
    if (readOnly || busyRef.current || draftRef.current.pending) return
    if (supplement) { setError('当前输入用于补充文字要求；请选择「新任务」后引用图片。'); return }
    setError('')
    for (const source of sources) {
      if (draftRef.current.attachments.some(item => item.nodeId === source.nodeId) || uploads.current.has(source.nodeId)) continue
      if (draftRef.current.attachments.length + uploads.current.size >= 4) { setError('每个任务最多引用 4 张图片，请分批处理。'); break }
      referenceOrder.current.set(source.nodeId, nextReferenceOrder.current++)
      const controller = new AbortController(); uploads.current.set(source.nodeId, controller); setUploading([...uploads.current.keys()])
      void prepareAgentAttachment(source, undefined, controller.signal).then(attachment => {
        if (!alive.current || controller.signal.aborted || !canWrite.current) return
        const attachments = [...draftRef.current.attachments, attachment].sort((a, b) => (referenceOrder.current.get(a.nodeId) ?? 0) - (referenceOrder.current.get(b.nodeId) ?? 0))
        saveDraft({ ...draftRef.current, attachments })
      }).catch(failure => { if (!controller.signal.aborted) reportError(failure) }).finally(() => {
        uploads.current.delete(source.nodeId); if (alive.current) setUploading([...uploads.current.keys()])
      })
    }
  }
  const handleControl = useCallback(async (run: AgentRun, action: AgentControlAction) => {
    if (!canWrite.current || busyRef.current) return
    busyRef.current = true; setBusy(true); setError('')
    try { acceptRuns([await client.controlRun(run.id, { action, requestId: createBrowserUuid() })]) }
    catch (failure) { reportError(failure) }
    finally { busyRef.current = false; if (alive.current) setBusy(false) }
  }, [client, acceptRuns, reportError])
  const handleAnswer = useCallback(async (run: AgentRun, answer: string) => {
    if (!canWrite.current || busyRef.current || !run.question) return
    busyRef.current = true; setBusy(true); setError('')
    try { acceptRuns([await client.answerRun(run.id, { questionId: run.question.id, answer, requestId: createBrowserUuid() })]) }
    catch (failure) { reportError(failure) }
    finally { busyRef.current = false; if (alive.current) setBusy(false) }
  }, [client, acceptRuns, reportError])
  const handleSend = async () => {
    if (readOnly || busyRef.current || uploads.current.size) return
    if (!canvasId) { reportError(new Error('请先打开画布后再使用 Agent')); return }
    const text = draftRef.current.prompt.trim()
    if (!text && !draftRef.current.pending) return
    if (status?.configured === false && !supplement && !draftRef.current.pending) { reportError(new Error('尚未接入 Agent 对话大模型，请配置 API')); onOpenProviderDrawer?.(); return }
    if (supplement && draftRef.current.attachments.length) { setError('补充要求仅支持文字。请选择「新任务」发送这些引用。'); return }
    busyRef.current = true; setBusy(true); setError('')
    try {
      if (supplement && activeRun) {
        acceptRuns([await client.controlRun(activeRun.id, { action: 'message', requestId: createBrowserUuid(), message: text })])
        if (alive.current) saveDraft(EMPTY_DRAFT)
      } else {
        let input = draftRef.current.pending
        if (!input) {
          setBusyLabel('等待画布同步…')
          const { expectedRevision } = await (onBeforeRun ? onBeforeRun() : client.canvasRevision(canvasId))
          if (!alive.current || !canWrite.current) return
          const state = store.getState()
          input = { requestId: createBrowserUuid(), canvasId, expectedRevision, conversationId, ...(runs.at(-1) ? { previousRunId: runs.at(-1)!.id } : {}), prompt: text, attachments: [...draftRef.current.attachments], selectedNodeIds: [...state.selectedNodeIds], viewport: { ...state.snapshot.viewport } }
          saveDraft({ ...draftRef.current, pending: input })
        }
        setBusyLabel('正在提交任务…')
        const created = await client.createRun(input)
        if (!alive.current) return
        createdHere.current.add(created.id)
        acceptRuns([created]); saveDraft(EMPTY_DRAFT); setNewTask(false)
      }
    } catch (failure) {
      // Keep the same request and ID after an uncertain response so Retry cannot create another paid run.
      if (failure instanceof AgentRuntimeError && failure.status >= 400 && failure.status < 500 && failure.status !== 408) {
        const current = draftRef.current; saveDraft({ prompt: current.prompt, attachments: current.attachments })
      }
      reportError(failure)
    } finally { busyRef.current = false; if (alive.current) { setBusy(false); setBusyLabel('') } }
  }
  const handleLocate = useCallback((nodeIds: string[]) => {
    const state = store.getState()
    const ids = new Set(nodeIds)
    const nodes = state.snapshot.nodes.filter(node => ids.has(node.id))
    if (!nodes.length) { onNotify?.('结果节点已不存在，仍可查看任务中的素材。', 'info'); return }
    const positions = absolutePositions(state.snapshot.nodes)
    const left = Math.min(...nodes.map(node => positions.get(node.id)!.x)), top = Math.min(...nodes.map(node => positions.get(node.id)!.y))
    const right = Math.max(...nodes.map(node => positions.get(node.id)!.x + node.size.width)), bottom = Math.max(...nodes.map(node => positions.get(node.id)!.y + node.size.height))
    const bounds = document.querySelector('.react-flow')?.getBoundingClientRect()
    const width = bounds?.width || 800, height = bounds?.height || 600
    const zoom = Math.min(1, width * 0.8 / Math.max(right - left, 1), height * 0.8 / Math.max(bottom - top, 1))
    state.selectNodes(nodes.map(node => node.id)); state.setViewport({ x: width / 2 - (left + right) / 2 * zoom, y: height / 2 - (top + bottom) / 2 * zoom, zoom })
  }, [store, onNotify])

  return <div aria-label="Agent 智能助手" className="sidebar-agent-panel agent-runtime-shell">
    <header className="agent-runtime-header"><div className="agent-runtime-title"><LibTvLogo size={21} variant="outline" /><div><h2>画布 Agent</h2><span>{readOnly ? '仅房主可用' : status?.configured === false ? '未接入大模型' : status?.model || '后台任务'}</span></div></div><div className="agent-runtime-header-actions">{readOnly ? <span className="agent-runtime-muted"><Lock size={12} /> 已锁定</span> : onOpenProviderDrawer && <button type="button" aria-label="管理 API 接入" onClick={onOpenProviderDrawer}><ServerCog size={16} /></button>}</div></header>
    <div className="agent-runtime-conversations">
      <select aria-label="选择对话" value={conversationId} disabled={busy} onChange={event => onChooseConversation(event.target.value)}>{conversationOptions.map(option => <option key={option.id} value={option.id}>{option.title}{option.active ? ' · 进行中' : ''}</option>)}</select>
      <button type="button" aria-label="新建对话" title="新建独立对话" disabled={readOnly || busy} onClick={onNewConversation}><Plus size={15} />新对话</button>
    </div>
    <div className="agent-runtime-body" ref={chatRef} onScroll={() => { const body = chatRef.current; if (body) { following.current = body.scrollHeight - body.scrollTop - body.clientHeight < 48; if (following.current) setNewContent(false) } }}>
      {readOnly && <div className="agent-runtime-notice"><Lock size={18} /><h3>多人协作模式已启用</h3><p>当前 Agent 仅限房主操作。任务结果会同步到画布。</p></div>}
      {!readOnly && status?.configured === false && <div className="agent-runtime-notice"><h3>尚未接入 Agent 大模型</h3><p>配置对话大模型后，即可提交画布任务。</p>{onOpenProviderDrawer && <button type="button" onClick={onOpenProviderDrawer}><ServerCog size={14} />前往配置 API</button>}</div>}
      {legacy.length > 0 && <details className="agent-runtime-legacy" open><summary>历史对话 · 只读</summary>{legacy.length > visibleLegacyCount && <button type="button" onClick={() => setVisibleLegacyCount(count => count + 40)}>显示更早对话</button>}{legacy.slice(-visibleLegacyCount).map(message => <p key={message.id} className={message.role === 'user' ? 'agent-runtime-user-message' : ''}>{message.content}</p>)}</details>}
      {runs.length === 0 && legacy.length === 0 && !readOnly && status?.configured !== false && <div className="agent-runtime-empty"><LibTvLogo size={36} variant="outline" /><h3>下一步做什么？</h3><p>描述目标，Agent 会在画布上执行并记录结果。</p><div className="agent-runtime-suggestions">{['生成一个苹果', '整理选中节点的排版', '只写三组分镜提示词'].map(prompt => <button type="button" key={prompt} onClick={() => saveDraft({ ...draftRef.current, prompt })}>{prompt}</button>)}</div></div>}
      {runs.length > visibleRunCount && <button type="button" className="agent-runtime-more" onClick={() => setVisibleRunCount(count => count + 20)}>显示更早任务</button>}
      {runs.slice(-visibleRunCount).map(run => <AgentRunCard key={run.id} run={run} readOnly={readOnly} busy={busy} onControl={handleControl} onAnswer={handleAnswer} onLocate={handleLocate} animateResponse={!!run.response && historicalResponses.current !== null && historicalResponses.current.get(run.id) !== run.response} onResponseProgress={() => { if (following.current && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight }} />)}
      {connectionError && <p className="agent-runtime-error" role="status">{connectionError}。后台任务不会因侧栏关闭而停止。</p>}
    </div>
    {newContent && <button type="button" className="agent-runtime-new-content" onClick={() => { following.current = true; setNewContent(false); if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight }}><ChevronDown size={13} />有新内容</button>}
    {skillsOpen && <section aria-label="可用技能" className="agent-runtime-skills"><div><strong>可用技能</strong><button type="button" aria-label="关闭技能列表" onClick={() => setSkillsOpen(false)}><X size={14} /></button></div><p className="agent-runtime-muted">内置技能 · 只读，按任务加载</p>{skillsError ? <p>{skillsError}</p> : skills.length ? skills.map(skill => <article key={skill.id}><strong>{skill.name}</strong><span>v{skill.version}</span><p>{skill.description}</p></article>) : <p>暂无可用技能</p>}</section>}
    <div className="agent-runtime-composer">
      {activeRun && <div className="agent-runtime-mode"><button type="button" aria-pressed={!newTask} disabled={busy || !!draft.pending} onClick={() => setNewTask(false)}>补充当前任务</button><button type="button" aria-pressed={newTask} disabled={busy || !!draft.pending} onClick={() => setNewTask(true)}><Plus size={12} />新任务</button></div>}
      {draft.attachments.length > 0 && <div className="agent-runtime-references" aria-label="已确认引用">{draft.attachments.map((attachment, index) => <div className="agent-runtime-reference" key={attachment.id}><ManagedMediaImage src={attachment.url} alt={attachment.name} /><span>图 {index + 1} · {attachment.name}</span><button type="button" aria-label={`移除引用 ${attachment.name}`} disabled={readOnly || busy || !!draft.pending} onClick={() => saveDraft({ ...draftRef.current, attachments: draftRef.current.attachments.filter(item => item.id !== attachment.id) })}><X size={12} /></button></div>)}</div>}
      {candidates.length > 0 && <div className="agent-runtime-ghosts" aria-label="候选引用"><div className="agent-runtime-reference-heading"><span>点击引用 · 选择不会自动发送</span>{candidates.length > 1 && <button type="button" disabled={readOnly || busy || !!draft.pending} onClick={() => void confirmReferences(candidates)}>引用全部</button>}</div><div className="agent-runtime-reference-list">{(expandedReferences ? candidates : candidates.slice(0, 4)).map(source => <button type="button" key={source.nodeId} className="agent-runtime-ghost" aria-label={`引用 ${source.name}`} disabled={readOnly || busy || !!draft.pending || uploading.includes(source.nodeId)} onClick={() => void confirmReferences([source])}><ManagedMediaImage src={source.url} alt="" /><span>{source.name}</span>{uploading.includes(source.nodeId) ? <Loader2 size={12} className="agent-runtime-spin" /> : <Plus size={12} />}</button>)}{candidates.length > 4 && <button type="button" onClick={() => setExpandedReferences(value => !value)}>{expandedReferences ? '收起' : `+${candidates.length - 4}`}</button>}</div></div>}
      {error && <p className="agent-runtime-error" role="alert">{error}</p>}
      {draft.pending && !busy && <p className="agent-runtime-muted">提交结果尚未确认，重试会核对同一任务。</p>}
      <textarea aria-label="Agent 指令输入框" placeholder={readOnly ? '仅房主可操作 Agent' : supplement ? '补充当前任务的要求…' : '描述你想在画布上完成的事…'} value={draft.prompt} disabled={readOnly || busy || !!draft.pending} onChange={event => saveDraft({ ...draftRef.current, prompt: event.target.value })} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void handleSend() } }} />
      <div className="agent-runtime-composer-toolbar"><button type="button" aria-label="查看可用技能" aria-expanded={skillsOpen} onClick={() => setSkillsOpen(value => !value)}><BookOpen size={14} />Skill</button><span className="agent-runtime-muted">{uploading.length ? '正在准备引用…' : busyLabel || 'Enter 发送 · Shift+Enter 换行'}</span><button type="button" className="agent-runtime-send" aria-label={draft.pending && !busy ? '重试提交' : '发送'} disabled={readOnly || busy || uploading.length > 0 || (!draft.prompt.trim() && !draft.pending)} onClick={() => void handleSend()}>{busy ? <Loader2 size={14} className="agent-runtime-spin" /> : <Send size={14} />}</button></div>
    </div>
  </div>
}
