import { Check, Circle, CircleAlert, Loader2, Pause, Play, Square, Undo2, LocateFixed } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import { ACTIVE_AGENT_STATUSES, type AgentControlAction, type AgentQuestion, type AgentRun, type AgentRunEvent } from '../../../contracts/agent'
import { ManagedMediaImage } from '../../canvas/ManagedMediaImage'

export const AGENT_STATUS_LABELS: Record<AgentRun['status'], string> = { queued: '排队中', running: '执行中', waiting_user: '等待回答', waiting_generation: '等待生成', paused: '已暂停', complete: '已完成', partial: '部分完成', failed: '失败', stopped: '已停止' }
const TOOL_LABELS: Record<string, string> = {
  read_skill: '读取技能', read_canvas: '读取画布', read_nodes: '读取节点', view_image: '查看引用图片', generation_config: '读取生成配置',
  create_node: '创建节点', update_node: '写入节点内容', delete_nodes: '删除节点', duplicate_node: '复制节点', move_nodes: '调整节点位置',
  group_nodes: '创建分组', connect_nodes: '连接节点', remove_edge: '移除连线', request_generation: '提交生成', ask_user: '等待确认',
  update_plan: '更新计划', report: '汇报进度', focus_nodes: '定位节点',
  list_canvas_commands: '查看画布操作', describe_canvas_command: '读取操作说明', run_canvas_command: '执行画布操作',
}
const DETAIL_LABELS: Record<string, string> = { nodeId: '节点', edgeId: '连线', jobId: '生成任务', referenceId: '引用图片', providerId: '服务商', model: '模型', aspectRatio: '画幅', quality: '质量', duration: '时长', moved: '移动节点数', totalNodes: '画布节点数', maxOutputs: '生成数量上限', attemptsUsed: '已提交次数' }
function readableDetail(detail: string | undefined) {
  if (!detail || (!detail.trimStart().startsWith('{') && !detail.trimStart().startsWith('['))) return detail
  try {
    const result: unknown = JSON.parse(detail)
    if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined
    const record = result as Record<string, unknown>
    const error = record.error
    const message = typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error ? error.message : record.message ?? record.reason
    const lines = typeof message === 'string' ? [message] : []
    if (record.status === 'preview') lines.push('预演完成，尚未提交')
    if (record.committed === true) lines.push(record.verified === true ? '已提交并核验' : '已提交，请回读核对最新修改')
    if (record.status === 'unchanged') lines.push('内容已符合要求，无需修改')
    if (typeof record.revision === 'number') lines.push(`画布版本：${record.revision}`)
    if (Array.isArray(record.affectedNodeIds)) lines.push(`影响节点：${record.affectedNodeIds.length}`)
    if (Array.isArray(record.affectedEdgeIds)) lines.push(`影响连线：${record.affectedEdgeIds.length}`)
    for (const [key, label] of Object.entries(DETAIL_LABELS)) {
      const value = record[key]
      if (typeof value === 'string' || typeof value === 'number') lines.push(`${label}：${String(value).slice(0, 240)}`)
    }
    for (const [key, label] of [['nodes', '读取节点'], ['deletedNodeIds', '删除节点'], ['childIds', '分组节点'], ['items', '计划步骤'], ['providers', '可用服务商']] as const) {
      if (Array.isArray(record[key])) lines.push(`${label}：${record[key].length}`)
    }
    return lines.join('\n') || undefined
  } catch { return undefined }
}
function visibleEvents(events: AgentRunEvent[]) {
  const operations = new Map<string, AgentRunEvent>()
  const stages: AgentRunEvent[] = []
  for (const event of events) {
    if ((event.type === 'tool' || event.type === 'generation') && event.operationId) {
      const key = `${event.type}:${event.operationId}`
      if (event.sequence > (operations.get(key)?.sequence ?? -1)) operations.set(key, event)
    } else stages.push(event)
  }
  return [...stages, ...operations.values()].sort((a, b) => a.sequence - b.sequence)
}
function StatusIcon({ status, animate = true }: { status: string; animate?: boolean }) {
  if (status === 'complete') return <Check size={13} />
  if (status === 'running' && animate) return <Loader2 size={13} className="agent-runtime-spin" />
  if (status === 'failed') return <CircleAlert size={13} />
  return <Circle size={11} />
}
function QuestionCard({ question, disabled, onAnswer }: { question: AgentQuestion; disabled: boolean; onAnswer: (answer: string) => void }) {
  const [selected, setSelected] = useState<string[]>([])
  const [text, setText] = useState('')
  const answer = [...selected, text.trim()].filter(Boolean).join('\n')
  return <section className="agent-runtime-question" aria-label="等待你的回答">
    <h3>{question.title}</h3>
    <div className="agent-runtime-options">{question.options.map(option => <button key={option} type="button" disabled={disabled} aria-pressed={selected.includes(option)} onClick={() => setSelected(previous => question.multiple ? previous.includes(option) ? previous.filter(item => item !== option) : [...previous, option] : [option])}>{option}</button>)}</div>
    <textarea aria-label="补充回答" placeholder="也可以输入自己的说明…" disabled={disabled} value={text} onChange={event => setText(event.target.value)} />
    <button className="agent-runtime-primary" type="button" disabled={disabled || !answer} onClick={() => onAnswer(answer)}>提交回答</button>
    <p className="agent-runtime-muted">回答后继续；关闭侧栏会保留这个问题。</p>
  </section>
}
interface Props {
  run: AgentRun
  readOnly: boolean
  busy: boolean
  onControl: (run: AgentRun, action: AgentControlAction) => void
  onAnswer: (run: AgentRun, answer: string) => void
  onLocate: (nodeIds: string[]) => void
}
export const AgentRunCard = memo(function AgentRunCard({ run, readOnly, busy, onControl, onAnswer, onLocate }: Props) {
  const active = ACTIVE_AGENT_STATUSES.includes(run.status)
  const progressing = active && run.status !== 'paused' && run.status !== 'waiting_user'
  const events = useMemo(() => visibleEvents(run.events), [run.events])
  const lastMessage = events.findLast(event => event.type === 'message')
  const duplicateMessage = run.response && run.response.trim() === lastMessage?.title.trim() ? lastMessage : undefined
  return <article className="agent-runtime-run" aria-label={`任务：${run.prompt}`}>
    <div className="agent-runtime-user-message">{run.prompt}</div>
    {run.attachments.length > 0 && <div className="agent-runtime-sent-images">{run.attachments.map((attachment, index) => <figure key={attachment.id}><ManagedMediaImage src={attachment.url ?? `/api/assets/${attachment.assetId}`} alt={attachment.name} /><figcaption>图 {index + 1} · {attachment.name}</figcaption></figure>)}</div>}
    <div className={`agent-runtime-run-status is-${run.status}`} role="status"><StatusIcon status={run.status} />{AGENT_STATUS_LABELS[run.status]}</div>
    {run.plan.length > 0 && <details className="agent-runtime-plan" open={active || run.status === 'failed'}><summary>任务规划与进度 · {run.plan.filter(step => step.status === 'complete').length}/{run.plan.length}</summary><ol>{run.plan.map(step => <li key={step.id} className={`is-${step.status}`}><StatusIcon status={step.status} animate={progressing} /><span>{step.title}</span></li>)}</ol></details>}
    <div className="agent-runtime-events">{events.filter(event => event !== duplicateMessage).map(event => {
      const title = event.toolName && event.title === event.toolName && Object.hasOwn(TOOL_LABELS, event.toolName) ? TOOL_LABELS[event.toolName] : event.title
      const detail = event.type === 'tool' ? readableDetail(event.detail) : event.detail
      return <details className={`agent-runtime-event is-${event.status}`} key={event.operationId && (event.type === 'tool' || event.type === 'generation') ? `${event.type}:${event.operationId}` : event.sequence} open={event.status === 'failed' || event.status === 'waiting'}><summary><StatusIcon status={event.status} animate={progressing} /><span>{title}</span></summary>{detail && <p>{detail}</p>}{event.nodeIds?.length ? <button type="button" onClick={() => onLocate(event.nodeIds!)}><LocateFixed size={12} />定位对象</button> : null}</details>
    })}</div>
    {run.question && run.status === 'waiting_user' && <QuestionCard key={run.question.id} question={run.question} disabled={readOnly || busy} onAnswer={answer => onAnswer(run, answer)} />}
    {run.response && <p className="agent-runtime-response">{run.response}</p>}
    {run.error && <p className="agent-runtime-error">{run.error.message}</p>}
    {run.outputs.length > 0 && <div className="agent-runtime-outputs">{run.outputs.map(output => <a href={output.url} target="_blank" rel="noreferrer" key={`${output.nodeId}:${output.assetId}`} aria-label="查看生成结果">{output.mediaType === 'image' ? <ManagedMediaImage src={output.url} alt="生成结果" /> : '查看视频结果'}</a>)}</div>}
    {run.status === 'paused' && <p className="agent-runtime-muted">已暂停新步骤；已提交的生成仍会完成。</p>}
    {run.status === 'stopped' && <p className="agent-runtime-muted">后续步骤已停止；已提交的生成可能仍在运行，结果会保留但不会自动写入画布。</p>}
    <div className="agent-runtime-controls">
      {run.outputs.length > 0 && <button type="button" onClick={() => onLocate(run.outputs.map(output => output.nodeId))}><LocateFixed size={13} />定位结果</button>}
      {!readOnly && active && <>
        {run.status === 'paused' ? <button type="button" disabled={busy} onClick={() => onControl(run, 'resume')} aria-label="继续任务"><Play size={13} />继续</button> : run.status !== 'waiting_user' && <button type="button" disabled={busy} onClick={() => onControl(run, 'pause')} aria-label="暂停任务"><Pause size={13} />暂停</button>}
        <button type="button" disabled={busy} onClick={() => onControl(run, 'stop')} aria-label="停止任务"><Square size={12} />停止</button>
      </>}
      {!readOnly && (run.status === 'partial' || run.status === 'failed') && <button type="button" disabled={busy} onClick={() => onControl(run, 'resume')}><Play size={13} />继续处理未完成部分</button>}
      {!readOnly && run.canUndo && <button type="button" disabled={busy} onClick={() => onControl(run, 'undo')} aria-label="撤销本次操作"><Undo2 size={13} />撤销本次操作</button>}
    </div>
  </article>
})
