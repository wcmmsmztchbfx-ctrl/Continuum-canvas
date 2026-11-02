import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AgentAnswerInput, AgentControlInput, AgentCreateRunInput, AgentRun, AgentRunEvent } from '../../src/contracts/agent.ts'
import type { CanvasNode, CanvasSnapshotV2 } from '../../src/model/project.ts'
import { parseCanvasSnapshot, DEFAULT_IMAGE_GENERATION_SETTINGS, DEFAULT_VIDEO_GENERATION_SETTINGS } from '../../src/model/project.ts'
import type { GenerationJob, GenerationRequest } from '../../src/contracts/generation.ts'
import type { GatewayRuntime } from '../runtime.ts'
import { WorkspaceConflictError } from '../workspace-commit.ts'
import { CollaborationConflictError } from '../collaboration-service.ts'
import { GenerationDispatchDeferredError } from '../jobs.ts'
import { validateGenerationRequest } from '../generation-validation.ts'
import { AgentRunStore } from './store.ts'
import { AgentSkills } from './skills.ts'
import { agentTools, agentToolsV2, validateToolArguments } from './tools.ts'
import { configuredModel, type AgentModel, type ModelMessage, type ToolCall } from './model.ts'
import { AgentError, type AgentGrant, type GenerationBinding, type StoredOperation, type StoredRun } from './types.ts'
import { applyChanges, changesBetween, changesMatch, readCanvas } from './canvas.ts'
import { computeCanvasCommand, describeCanvasCommand, listCanvasCommands } from './commands.ts'
import { budgetFallback, conversationIdOf, previousConversationMessages, publicConversationRun } from './conversations.ts'
import { compactConversation, normalizedConversation } from './context.ts'

const terminal = new Set(['complete', 'partial', 'failed', 'stopped'])
class UncommittedCanvasConflict extends AgentError {}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const text = (value: unknown, max = 8000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AgentError(400, 'invalid_input', '文本为空或超出长度限制。')
  return value.trim()
}
const ids = (value: unknown, max = 100): string[] => {
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !v || v.length > 256)) throw new AgentError(400, 'invalid_input', '对象列表无效。')
  return [...new Set(value)] as string[]
}
function numeric(value: unknown, fallback: number, min = -1_000_000, max = 1_000_000): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new AgentError(400, 'invalid_input', '数值超出范围。')
  return value
}
function budgetFor(prompt: string) {
  if (/(?:只|仅|先|只需|仅需).{0,20}(?:提示词|方案|计划)|(?:不要|不许|禁止|别|无需|不再|停止|取消|拒绝).{0,12}(?:生图|生成|画图|重试|再试)|(?:prompt|plan|planning)\s+only|only.{0,20}(?:prompt|plan)|(?:do\s+not|don['’]?t|never|no\s+more|stop|without|avoid|not\s+yet|decline).{0,32}(?:generat|render|draw|images?|retry)/i.test(prompt)) return 0
  const match = /(?:生成|制作|重试|再试|画|create|generate|retry|make|draw).{0,16}?(\d{1,2}|[一二三四五六七八九十两])\s*(?:张|幅|个|images?|posters?|pictures?)/i.exec(prompt)
  const chinese: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  return match ? Number(match[1]) || chinese[match[1]] || 1 : 1
}
function planOnly(prompt: string) {
  return /(?:只|仅|先).{0,12}(?:方案|计划)|(?:plan|planning)\s+only|only.{0,12}plan|(?:等我|等待|需要我).{0,10}(?:确认|批准)|before.{0,12}(?:approval|confirmation)/i.test(prompt)
}
function initialGenerationBudget(prompt: string) {
  return /生成|生图|画一|generate|draw|render|(?:制作|create|make).{0,40}(?:海报|图片|图像|视频|images?|posters?|pictures?|videos?)/i.test(prompt) ? budgetFor(prompt) : 0
}
function approvesExecution(message: string) { return /(?:确认|同意|批准|开始|现在).{0,8}(?:执行|修改|创建|生成)|(?:execute|proceed|implement|go ahead|approved)/i.test(message) && !/不要|禁止|别|不确认|do not|don['’]?t|not yet/i.test(message) }
function publicFailure(error: unknown) {
  return error instanceof AgentError ? { code: error.code, message: error.message } :
    { code: 'agent_operation_failed', message: '操作未完成；已保留任务和结果，请核对配置、权限或画布状态后继续。' }
}

export class CanvasAgentService {
  readonly skills = new AgentSkills()
  private readonly runtime: GatewayRuntime
  private readonly store: AgentRunStore
  private readonly newTaskVersion: 1 | 2
  private model: AgentModel
  private queue: Promise<unknown> = Promise.resolve()
  private flights = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private closed = false
  private unsubscribe?: () => void
  private timer?: ReturnType<typeof setInterval>
  private constructor(runtime: GatewayRuntime, model?: AgentModel, privateRuntimeVersion: 1 | 2 = 1) {
    this.newTaskVersion = privateRuntimeVersion
    this.runtime = runtime; this.store = new AgentRunStore(runtime.dataDir); this.model = model ?? configuredModel(runtime.agentConfig)
  }
  static async open(runtime: GatewayRuntime, model?: AgentModel, version: 1 | 2 = 1) {
    const service = new CanvasAgentService(runtime, model, version)
    await service.store.open()
    service.unsubscribe = runtime.jobs.onChange(job => { if (job.clientRequestId.startsWith('agent-')) void service.reconcileJob(job).catch(() => {}) })
    for (const record of service.store.records.values()) {
      if (record.executionVersion === 2 && !record.skillPackage) throw new Error('Version 2 task is missing its pinned Skill package; recovery required')
      // In-flight model turns may be repeated, but persisted tool intents are reconciled first.
      if (record.run.status === 'running') record.run.status = 'queued'
      if (record.pendingWrite && !record.stopped && !record.undone && ['queued', 'running'].includes(record.run.status)) {
        try { await service.applyPendingWrite(record) } catch (error) { await service.pauseWithError(record, error) }
      }
    }
    for (const job of runtime.jobs.list()) if (job.clientRequestId.startsWith('agent-')) await service.reconcileJob(job)
    for (const record of service.store.records.values()) {
      if (record.run.status !== 'waiting_generation') continue
      for (const binding of record.bindings.filter(b => !b.settled)) {
        const job = runtime.jobs.list().find(j => j.clientRequestId === binding.request.clientRequestId)
        if (!job || (!job.upstreamTaskId && !job.createAttemptedAt)) await service.pauseWithError(record,
          new AgentError(409, 'submission_recovery', '后台重启：提交尚未确认，请核对后继续；将沿用原请求编号。'))
      }
    }
    service.timer = setInterval(() => { void service.checkWaiting().catch(() => {}) }, 15_000)
    service.timer.unref()
    service.pump()
    return service
  }
  setModelForTesting(model: AgentModel) { this.model = model }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const active = this.queue.catch(() => {}).then(operation); this.queue = active.catch(() => {}); return active
  }
  private require(id: string) { const r = this.store.records.get(id); if (!r) throw new AgentError(404, 'run_not_found', '任务不存在。'); return r }
  get(id: string): AgentRun { return publicConversationRun(this.require(id)) }
  list(canvasId: string): AgentRun[] { return [...this.store.records.values()].filter(r => r.run.canvasId === canvasId).sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt)).map(r => publicConversationRun(r)) }
  authorize(id: string, actor: AgentGrant) {
    const record = this.require(id)
    if (actor.kind === 'local-admin') return
    this.runtime.collaboration.authorizeAgentGrant(actor, record.run.canvasId)
    const originalCreator = record.grant.kind === 'collaboration' && record.grant.roomId === actor.roomId && record.grant.memberId === actor.memberId
    const authorityChanged = record.authority !== actor.epoch
    if (!originalCreator && !(authorityChanged && this.runtime.collaboration.isAgentRoomOwner(actor, record.run.canvasId))) throw new AgentError(403, 'run_forbidden', '无权访问这个任务。')
  }
  referencedAssetIds() { return new Set([...this.store.records.values()].flatMap(r => [...r.run.attachments.map(a => a.assetId), ...r.run.outputs.map(o => o.assetId)])) }
  private event(record: StoredRun, type: AgentRunEvent['type'], title: string, status: AgentRunEvent['status'] = 'complete', extra: Partial<AgentRunEvent> = {}) {
    record.run.sequence += 1; record.run.updatedAt = new Date().toISOString()
    record.run.events.push({ id: `${record.run.id}:${record.run.sequence}`, sequence: record.run.sequence, type, title, status, createdAt: record.run.updatedAt, ...extra })
  }
  private async save(record: StoredRun) { record.run.updatedAt = new Date().toISOString(); await this.store.save(record) }
  async create(input: AgentCreateRunInput, grant: AgentGrant): Promise<AgentRun> {
    return this.exclusive(async () => {
      text(input.requestId, 128); text(input.prompt, 16000)
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.canvasId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new AgentError(400, 'invalid_input', '画布和修订号无效。')
      if (!Array.isArray(input.attachments) || input.attachments.length > 4) throw new AgentError(400, 'attachment_limit', '每次最多引用 4 张图片，请拆分任务。')
      const duplicate = [...this.store.records.values()].find(r => r.run.requestId === input.requestId)
      if (duplicate) {
        this.authorize(duplicate.run.id, grant)
        if (duplicate.inputDigest !== hash(input)) throw new AgentError(409, 'request_conflict', '请求编号已用于不同的任务。')
        return structuredClone(duplicate.run)
      }
      const canvas = await this.runtime.workspace.getCanvasRecord(input.canvasId)
      if (!canvas || canvas.deleted || !canvas.snapshot) throw new AgentError(404, 'canvas_missing', '画布不存在。')
      if (canvas.revision !== input.expectedRevision) throw new AgentError(409, 'revision_conflict', '请等待画布保存同步完成后重试。')
      const authority = this.runtime.collaboration.agentAuthority(canvas.projectId, input.canvasId)
      if (grant.kind === 'collaboration') this.runtime.collaboration.authorizeAgentGrant(grant, input.canvasId)
      else if (authority !== 'local') throw new AgentError(403, 'collaboration_grant_required', '请使用当前协作会话发起任务。')
      if (input.conversationId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text(input.conversationId, 128))) throw new AgentError(400, 'invalid_conversation', '对话编号无效。')
      if (input.previousRunId !== undefined) {
        const previous = this.require(text(input.previousRunId, 128))
        this.authorize(previous.run.id, grant)
        if (previous.run.canvasId !== input.canvasId || previous.run.projectId !== canvas.projectId || conversationIdOf(previous.run) !== (input.conversationId ?? 'legacy')) throw new AgentError(409, 'conversation_mismatch', '只能在同一画布的同一对话中接续历史。')
      }
      const attachments = input.attachments.map(a => {
        text(a.id, 128); text(a.nodeId, 256); text(a.name, 256)
        const asset = this.runtime.assets.get(a.assetId)
        if (!asset || !asset.contentType.startsWith('image/') || a.mediaType !== 'image') throw new AgentError(400, 'attachment_missing', '引用图片尚未上传或已删除。')
        return { id: a.id, nodeId: a.nodeId, name: a.name, assetId: a.assetId, mediaType: 'image' as const, url: asset.url }
      })
      if (new Set(attachments.map(a => a.id)).size !== attachments.length) throw new AgentError(400, 'invalid_input', '引用编号重复。')
      const now = new Date().toISOString(); const id = randomUUID()
      const skillPackage = this.newTaskVersion === 2 ? await this.skills.snapshotV2() : undefined
      const base = skillPackage ? this.skills.readResource(skillPackage, 'canvas-base') : await this.skills.read('canvas-base')
      const record: StoredRun = { version: skillPackage ? 2 : 1, ...(skillPackage ? { executionVersion: 2 as const, skillPackage } : {}), run: { id, requestId: input.requestId, canvasId: input.canvasId, projectId: canvas.projectId,
        prompt: input.prompt, attachments, ...(input.conversationId ? { conversationId: input.conversationId } : {}), ...(input.previousRunId ? { previousRunId: input.previousRunId } : {}), status: 'queued', createdAt: now, updatedAt: now, sequence: 0, events: [], plan: [], outputs: [], canUndo: false },
        grant, authority, inputDigest: hash(input), selectedNodeIds: ids(input.selectedNodeIds ?? []), viewport: input.viewport,
        messages: [{ role: 'user', content: input.prompt }], conversationPrepared: !input.previousRunId, operations: [], changes: [], bindings: [], round: 0,
        generationBudget: initialGenerationBudget(input.prompt), generationAttemptsAllowed: initialGenerationBudget(input.prompt), writeAuthorized: !planOnly(input.prompt), stopped: false, undone: false, skills: { 'canvas-base': base },
        handledRequests: {}, pendingCalls: [], intentVersion: 0, observed: {} }
      await readCanvas(this.runtime, record)
      this.event(record, 'skill', `读取技能 · ${base.info.name} v${base.info.version}`)
      if (attachments.length) { const skill = await this.taskSkill(record, 'image-reference'); record.skills[skill.info.id] = skill; this.event(record, 'skill', `读取技能 · ${skill.info.name} v${skill.info.version}`) }
      await this.save(record); this.store.records.set(id, record); this.pump()
      return structuredClone(record.run)
    })
  }
  async control(id: string, input: AgentControlInput, refreshedGrant?: AgentGrant): Promise<AgentRun> {
    return this.exclusive(async () => {
      const record = this.require(id); text(input.requestId, 128)
      if (this.handled(record, input.requestId, input)) return structuredClone(record.run)
      if (input.action === 'stop' || input.action === 'undo') {
        record.stopped = true; record.run.status = 'stopped'; delete record.run.question
        this.controllers.get(id)?.abort()
        this.event(record, 'status', input.action === 'undo' ? '已停止后续步骤，开始撤销本次变更' : '后续步骤已停止；已提交生成仍可能完成')
        await this.save(record)
        if (input.action === 'undo' && !record.undone) {
          if (record.pendingWrite?.operationId.startsWith('agent-undo-')) await this.applyPendingWrite(record, false)
          if (record.undone) { record.handledRequests[input.requestId] = hash(input); await this.save(record); return structuredClone(record.run) }
          await this.rememberCommittedIntent(record)
          const { snapshot } = await readCanvas(this.runtime, record)
          const reversed = applyChanges(snapshot, record.changes, true)
          await this.writeCanvas(record, `agent-undo-${hash([record.run.id, input.requestId]).slice(0, 40)}`, snapshot, reversed.snapshot, false)
          record.undone = true
          record.run.canUndo = false
          this.event(record, 'status', '已撤销本次可安全回退的变更')
          if (reversed.conflicts.length) this.event(record, 'message', '撤销时保留了后续人工修改', 'waiting', { detail: reversed.conflicts.slice(0, 20).join('、') })
        } else if (input.action === 'stop' && !record.undone && !record.pendingWrite?.operationId.startsWith('agent-undo-')) {
          try { await this.rememberCommittedIntent(record); await this.clearStoppedMarkers(record) }
          catch (error) { this.event(record, 'message', '任务已停止；部分生成标记因画布或权限变化未能清理', 'waiting', { detail: publicFailure(error).message }) }
        }
      } else if (input.action === 'pause') {
        if (!terminal.has(record.run.status)) { record.run.status = record.run.question ? 'waiting_user' : 'paused'; record.intentVersion++; this.controllers.get(id)?.abort(); this.event(record, 'status', record.run.question ? '等待当前问题的回答' : '已暂停；已提交生成可以完成回写', 'waiting') }
      } else if (input.action === 'resume') {
        if (record.stopped || record.undone || record.run.status === 'complete') throw new AgentError(409, 'run_finished', '已结束的任务不能重新执行，请创建新任务。')
        if (record.run.question) {
          record.run.status = 'waiting_user'; record.handledRequests[input.requestId] = hash(input); await this.save(record); return structuredClone(record.run)
        }
        if (refreshedGrant) record.grant = refreshedGrant
        record.authority = this.runtime.collaboration.agentAuthority(record.run.projectId, record.run.canvasId)
        await readCanvas(this.runtime, record)
        if (record.pendingWrite) await this.applyPendingWrite(record)
        if (JSON.stringify(record.messages).length > 80_000) {
          const checkpoint = compactConversation(record.messages); record.messages = checkpoint.messages
          this.event(record, 'status', `恢复上下文检查点 · 已保留用户要求和实际操作回执，压缩 ${checkpoint.removedRounds} 轮历史`)
        }
        record.roundLimit = record.round + 24; record.reviewFromOperation = record.operations.length; record.run.status = 'queued'; delete record.run.error
        this.event(record, 'status', '继续任务')
      } else if (input.action === 'message') {
        if (record.stopped || record.undone || record.run.status === 'complete') throw new AgentError(409, 'run_finished', '任务已结束，请创建新任务。')
        const message = text(input.message, 8000)
        if (record.pendingWrite) {
          const pendingId = record.pendingWrite.operationId
          await this.applyPendingWrite(record)
          const operation = record.operations.find(o => o.id === pendingId)
          if (operation?.state === 'complete' && record.pendingCalls[0]?.id === operation.call.id) this.finishCall(record, operation)
        }
        record.messages.push({ role: 'user', content: message }); record.intentVersion++
        this.skipPending(record, '用户补充了要求，重新规划未执行步骤。', true)
        this.updateGenerationAuthorization(record, message)
        if (planOnly(message)) record.writeAuthorized = false
        else if (approvesExecution(message)) record.writeAuthorized = true
        delete record.replyContinuation
        if (record.run.status === 'partial' || record.run.status === 'failed' || (record.run.status === 'paused' && !record.run.question)) { record.run.status = 'queued'; record.roundLimit = record.round + 24; record.reviewFromOperation = record.operations.length; delete record.run.error }
        this.event(record, 'message', '已收到补充要求', 'complete', { detail: message })
      } else throw new AgentError(400, 'invalid_action', '未知任务操作。')
      record.handledRequests[input.requestId] = hash(input); await this.save(record); this.pump(); return structuredClone(record.run)
    })
  }
  private handled(record: StoredRun, id: string, input: unknown) {
    if (!Object.hasOwn(record.handledRequests, id)) return false
    if (record.handledRequests[id] !== hash(input)) throw new AgentError(409, 'request_conflict', '请求编号已用于不同操作。')
    return true
  }
  async answer(id: string, input: AgentAnswerInput): Promise<AgentRun> {
    return this.exclusive(async () => {
      const record = this.require(id); text(input.requestId, 128); text(input.answer, 8000)
      if (this.handled(record, input.requestId, input)) return structuredClone(record.run)
      if (!['waiting_user', 'paused'].includes(record.run.status) || record.run.question?.id !== input.questionId) throw new AgentError(409, 'stale_question', '这个问题已失效，请刷新任务。')
      record.messages.push({ role: 'user', content: `回答问题 ${input.questionId}：${input.answer}` })
      record.reviewFromOperation = record.operations.length
      const confirmsQuestion = /^(同意|确认|是|yes|approve|开始)$/i.test(input.answer.trim())
      this.updateGenerationAuthorization(record, confirmsQuestion ? record.run.question!.title : input.answer)
      if (approvesExecution(input.answer) || /执行|修改|生成|execute|proceed/i.test(record.run.question!.title) && /^(同意|确认|是|yes|approve|开始)$/i.test(input.answer.trim())) record.writeAuthorized = true
      delete record.run.question; delete record.run.error; record.run.status = 'queued'; record.intentVersion++
      record.handledRequests[input.requestId] = hash(input)
      this.event(record, 'message', '已收到回答', 'complete', { detail: input.answer })
      await this.save(record); this.pump(); return structuredClone(record.run)
    })
  }
  private updateGenerationAuthorization(record: StoredRun, message: string) {
    // A prohibition takes effect immediately. Only explicit added generation or
    // retry language (including an explicitly accepted question) expands scope.
    if (budgetFor(message) === 0 || /^(不|否|不用|拒绝|no|decline|cancel)$/i.test(message.trim())) {
      record.generationAttemptsAllowed = this.attemptsUsed(record); record.generationPausedByUser = true
    } else if (/再生成|另外生成|再做|generate|生成\s*\d|重试|再试|retry/i.test(message)) {
      const extra = budgetFor(message)
      record.generationAttemptsAllowed = Math.min(12, this.attemptsUsed(record) + extra)
      record.generationPausedByUser = false
      if (!/重试|再试|retry|失败|剩余|补生成/i.test(message)) record.generationBudget += extra
    }
  }
  private pump() {
    if (this.closed) return
    queueMicrotask(() => {
      const blocked = new Set<string>()
      const busyCanvases = new Set([...this.flights.keys()].map(id => this.require(id).run.canvasId))
      const ordered = [...this.store.records.values()].sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt) || a.run.id.localeCompare(b.run.id))
      for (const record of ordered) {
        if (terminal.has(record.run.status)) continue
        const parent = record.run.previousRunId ? this.store.records.get(record.run.previousRunId) : undefined
        if (parent && parent.run.canvasId === record.run.canvasId && conversationIdOf(parent.run) === conversationIdOf(record.run) && !terminal.has(parent.run.status)) continue
        const lane = JSON.stringify([record.run.canvasId, conversationIdOf(record.run)])
        if (blocked.has(lane)) continue
        blocked.add(lane)
        if (busyCanvases.has(record.run.canvasId) || !['queued', 'running'].includes(record.run.status) || this.flights.has(record.run.id)) continue
        busyCanvases.add(record.run.canvasId)
        const flight = this.execute(record).catch(async error => { if (!this.closed && !record.stopped) await this.exclusive(() => this.pauseWithError(record, error)) })
        this.flights.set(record.run.id, flight)
        void flight.finally(() => { this.flights.delete(record.run.id); this.pump() }).catch(() => {})
      }
    })
  }
  private async pauseWithError(record: StoredRun, error: unknown) {
    if (record.stopped || this.closed) return
    record.run.error = publicFailure(error); record.run.status = 'paused'
    this.event(record, 'status', record.run.error.message, 'waiting'); await this.save(record)
  }
  private active(record: StoredRun) { return !this.closed && !record.stopped && !record.undone && ['queued', 'running'].includes(record.run.status) }
  private attemptsUsed(record: StoredRun) { return record.bindings.filter(b => !b.notSubmitted).length }
  private async closeBudget(record: StoredRun) {
    const controller = new AbortController(); this.controllers.set(record.run.id, controller)
    let input: Parameters<AgentModel>[0] | undefined; let version = record.intentVersion
    try {
      await this.exclusive(async () => {
        if (!this.active(record)) return
        if (record.summaryAtRound === record.round) {
          record.run.response = budgetFallback(record)
          await this.pauseWithError(record, new AgentError(409, 'run_limit', '本轮操作已暂停，可以检查结果后继续。')); return
        }
        const { snapshot } = await readCanvas(this.runtime, record)
        record.summaryAtRound = record.round; version = record.intentVersion
        const owned = new Set([...record.selectedNodeIds, ...record.changes.filter(c => c.collection === 'nodes').map(c => c.id)])
        const actual = snapshot.nodes.filter(n => owned.has(n.id)).slice(0, 30).map(n => ({ id: n.id, type: n.type, name: n.name, ...((n.type === 'image' || n.type === 'video') ? { prompt: n.data.promptDraft?.slice(0, 500), assetId: n.data.assetId } : {}) }))
        input = { system: `本轮画布操作预算已用完。现在只做最终答复，禁止调用工具、修改画布、提交生成或宣称未完成的工作已经完成。根据已提交回执和当前回读汇总已完成项、剩余项，并说明任务已暂停、可继续处理。不要把内部推理当作答复。\n实际回读：${JSON.stringify(actual)}\n保底进度：${budgetFallback(record)}`,
          messages: normalizedConversation(record.messages), tools: [], hasImages: false, signal: AbortSignal.any([this.runtime.signal, controller.signal]) }
        this.event(record, 'status', '正在汇总已完成的操作', 'running'); await this.save(record)
      })
      if (!input) return
      let response = budgetFallback(record)
      try { const turn = await this.model(input); if (!turn.incomplete && !turn.calls.length && turn.text?.trim()) response = turn.text } catch { /* Durable factual fallback; no extra retry or tool dispatch. */ }
      await this.exclusive(async () => {
        if (!this.active(record) || version !== record.intentVersion) return
        record.run.response = response; record.messages.push({ role: 'assistant', content: response })
        this.event(record, 'message', response, 'waiting')
        await this.pauseWithError(record, new AgentError(409, 'run_limit', '本轮操作已暂停，可以检查结果后继续。'))
      })
    } finally { this.controllers.delete(record.run.id) }
  }
  private async execute(record: StoredRun) {
    while (this.active(record)) {
      if (!record.conversationPrepared && record.run.previousRunId && record.round === 0) await this.exclusive(async () => {
        if (!this.active(record)) return
        const previous = this.require(record.run.previousRunId!)
        this.authorize(previous.run.id, record.grant)
        record.messages = [...previousConversationMessages(previous), ...record.messages]
        record.conversationPrepared = true; await this.save(record)
      })
      if (!this.active(record)) return
      if (record.pendingCalls.length) {
        const call = record.pendingCalls[0]
        const shouldContinue = await this.perform(record, call)
        if (!shouldContinue) return
        continue
      }
      if (record.bindings.some(b => !b.settled)) { await this.exclusive(async () => { record.run.status = 'waiting_generation'; await this.save(record) }); return }
      if (JSON.stringify(record.messages).length > 90_000) {
        await this.exclusive(async () => {
          const checkpoint = compactConversation(record.messages); record.messages = checkpoint.messages
          this.event(record, 'status', `已压缩 ${checkpoint.removedRounds} 轮历史；用户要求与实际回执已保留`); await this.save(record)
        })
      }
      if (record.round >= (record.roundLimit ?? 24) && !record.replyContinuation) {
        await this.closeBudget(record); return
      }
      let version = 0; let modelInput: { system: string; messages: ModelMessage[]; tools: unknown[]; signal: AbortSignal; hasImages: boolean }
      const controller = new AbortController(); this.controllers.set(record.run.id, controller)
      try {
        const context = await this.exclusive(async () => {
          if (!this.active(record)) return undefined
          const { snapshot, revision } = await readCanvas(this.runtime, record)
          record.run.status = 'running'; record.round++; version = record.intentVersion
          const selected = snapshot.nodes.filter(n => record.selectedNodeIds.includes(n.id)).slice(0, 30)
          for (const node of selected) if (!record.observed[node.id]) record.observed[node.id] = structuredClone(node)
          await this.save(record)
          return { canvasId: record.run.canvasId, currentPrompt: record.run.prompt, ...(record.executionVersion === 2 ? { revision } : {}), nodeCount: snapshot.nodes.length, selectedNodes: selected.map(n => this.summarizeNode(n, record.executionVersion === 2)),
            attachments: record.run.attachments.map(a => ({ id: a.id, nodeId: a.nodeId, name: a.name })),
            generationBudget: record.generationBudget, generationAttemptsAllowed: record.generationAttemptsAllowed ?? record.generationBudget, writeAuthorized: record.writeAuthorized !== false, maxAttemptsPerRun: 12, attemptsUsed: this.attemptsUsed(record),
            plan: record.run.plan, recentOperations: record.operations.slice(-16).map(o => ({ operationId: o.id, tool: o.call.name, status: o.state, receipt: JSON.stringify(o.result ?? {}).slice(0, 800) })),
            outputs: record.run.outputs, availableSkills: this.skills.list().map(s => record.executionVersion === 2 ? { ...s, version: '2' } : s), executionVersion: record.executionVersion ?? 1, skillDigest: record.skillPackage?.digest }
        })
        if (!context) return
        const images = await this.imageMessages(record)
        modelInput = { system: Object.values(record.skills).map(s => s.content).join('\n\n') + '\n\nActual current context:\n' + JSON.stringify(context),
          messages: [...normalizedConversation(record.messages), ...images], tools: record.replyContinuation ? [] : record.executionVersion === 2 ? agentToolsV2 : agentTools, hasImages: images.length > 0,
          signal: AbortSignal.any([this.runtime.signal, controller.signal]) }
        const turn = await this.model(modelInput)
        await this.exclusive(async () => {
          if (!this.active(record) || version !== record.intentVersion) return
          if (!Array.isArray(turn.calls) || turn.calls.length > 8) throw new AgentError(502, 'model_invalid_tool', '工具调用超过限制。')
          if (record.replyContinuation && turn.calls.length) throw new AgentError(502, 'unexpected_continuation_tool', '补全正文时不能执行画布工具。')
          if (turn.incomplete && turn.calls.length) throw new AgentError(502, 'model_incomplete', '工具调用不完整，未执行。')
          if (turn.calls.length) {
            if (new Set(turn.calls.map(c => c.id)).size !== turn.calls.length) throw new AgentError(502, 'duplicate_tool_id', '模型返回重复工具编号。')
            record.messages.push({ role: 'assistant', content: turn.text ?? null, tool_calls: turn.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) })
            record.pendingCalls = turn.calls
            record.pendingRound = record.round
          } else {
            const prefix = record.replyContinuation?.prefix ?? ''
            const text = turn.text || '任务执行结束。'
            record.run.response = prefix && !text.startsWith(prefix) ? `${prefix}${text}` : text
            if (turn.incomplete) {
              const attempted = record.replyContinuation?.attempts ?? 0
              record.replyContinuation = { prefix: record.run.response, attempts: 1 }
              record.messages.push({ role: 'assistant', content: text })
              if (attempted) {
                this.event(record, 'message', record.run.response, 'waiting')
                await this.pauseWithError(record, new AgentError(409, 'model_incomplete', '回答尚未结束，已保留全部收到的正文，可以继续补全。'))
              } else {
                record.messages.push({ role: 'user', content: '请从刚才中断的位置继续完成正文，不重复已有内容。只补全回答，禁止调用工具或提交生成。' })
                this.event(record, 'status', '正在补全回答', 'running'); await this.save(record)
              }
              return
            }
            delete record.replyContinuation
            const failed = record.operations.slice(record.reviewFromOperation ?? 0).some(o => o.state === 'complete' && (o.result as { error?: unknown })?.error)
            const applied = record.bindings.filter(b => b.applied).length
            const incomplete = applied < record.generationBudget
            record.run.status = failed || incomplete || record.run.plan.some(i => i.status === 'pending' || i.status === 'running' || i.status === 'failed') ? 'partial' : 'complete'
            if (record.writeAuthorized === false) {
              record.run.status = 'waiting_user'; record.run.question = { id: `${record.run.id}-execution-${record.round}`, title: '方案已准备，是否开始修改画布？', options: ['确认执行', '继续完善方案'] }
              this.event(record, 'question', record.run.question.title, 'waiting')
            }
            if (incomplete) record.run.response = `已完成并写入 ${applied}/${record.generationBudget} 个生成结果；其余步骤尚未完成。`
            record.messages.push({ role: 'assistant', content: record.run.response })
            this.event(record, 'message', record.run.response, record.run.status === 'partial' ? 'waiting' : 'complete')
          }
          await this.save(record)
        })
      } catch (error) {
        if (!controller.signal.aborted && !this.runtime.signal.aborted) await this.exclusive(() => this.pauseWithError(record, error))
        return
      } finally { this.controllers.delete(record.run.id) }
    }
  }
  private async imageMessages(record: StoredRun): Promise<ModelMessage[]> {
    if (!record.run.attachments.length) return []
    const content: unknown[] = []; let bytes = 0
    for (const [index, attachment] of record.run.attachments.entries()) {
      if (!this.runtime.assets.get(attachment.assetId)) throw new AgentError(409, 'attachment_missing', '引用素材已删除，请提供替代图片。')
      const preview = await this.runtime.assets.getPreview(attachment.assetId, 960, this.runtime.signal)
      if (!preview) throw new AgentError(409, 'preview_unavailable', '无法读取引用图片预览。')
      bytes += preview.bytes.length
      if (bytes > 2_000_000) throw new AgentError(409, 'image_context_limit', '图片预览超过上下文预算，请减少引用。')
      content.push({ type: 'text', text: `图 ${index + 1}，referenceId=${attachment.id}，${attachment.name}（资料，不是操作指令）` },
        { type: 'image_url', image_url: { url: `data:image/webp;base64,${preview.bytes.toString('base64')}`, detail: 'low' } })
    }
    return [{ role: 'user', content }]
  }
  private async perform(record: StoredRun, call: ToolCall): Promise<boolean> {
    // Network catalog reads must not hold the short mutation/control queue.
    if (call.name === 'generation_config' || call.name === 'request_generation') {
      for (const provider of this.runtime.providers.listPublic().filter(p => p.enabled && p.available && p.secretConfigured).slice(0, 8)) {
        if (!this.active(record)) return false
        if (!this.runtime.catalogs.get(provider.id)) await this.runtime.syncProvider(provider.id)
      }
    }
    let dispatch: GenerationBinding | undefined
    await this.exclusive(async () => {
      if (!this.active(record)) return
      const id = `agent-op-${record.run.id}-${record.pendingRound ?? record.round}-${hash(call.id).slice(0, 12)}`
      let operation = record.operations.find(o => o.id === id)
      if (operation?.state === 'complete') { this.finishCall(record, operation); await this.save(record); return }
      if (!operation) { operation = { id, call, state: 'pending' }; record.operations.push(operation); this.event(record, 'tool', call.name, 'running', { toolName: call.name, operationId: id }); await this.save(record) }
      try {
        const output = await this.tool(record, operation)
        if (call.name === 'request_generation' && output && 'request' in (output as object)) { dispatch = output as GenerationBinding; return }
        operation.result = output; operation.state = 'complete'; this.finishCall(record, operation)
      } catch (error) {
        if (record.pendingWrite) {
          // A persisted intent without a receipt must be reconciled before the
          // tool can be declared failed or the model can issue a replacement.
          await this.pauseWithError(record, error)
          return
        }
        const binding = record.bindings.find(b => b.operationId === operation!.id)
        if (binding && !this.runtime.jobs.list().some(j => j.clientRequestId === binding.request.clientRequestId)) { binding.settled = true; binding.notSubmitted = true }
        operation.result = { error: publicFailure(error) }; operation.state = 'complete'; this.finishCall(record, operation)
        if ((error as { code?: string }).code === 'authority_changed' || (error as { code?: string }).code?.includes('forbidden')) await this.pauseWithError(record, error)
      }
      await this.save(record)
      if (record.operations.length >= 4 && record.operations.slice(-4).every(o => (o.result as { error?: unknown })?.error) && this.active(record)) await this.pauseWithError(record, new AgentError(409, 'no_progress', '连续操作未能推进任务，请核对错误后继续。'))
    })
    if (dispatch) {
      const binding = dispatch
      try {
        // The intent and stable ID are durable before any potentially paid dispatch.
        const existing = this.runtime.jobs.list().find(j => j.clientRequestId === binding.request.clientRequestId)
        if (existing && (existing.createAttemptedAt || existing.upstreamTaskId || existing.status === 'complete' || existing.status === 'failed')) await this.reconcileJob(existing)
        else if (!record.stopped && !record.undone && !this.closed && record.run.status === 'waiting_generation') {
          const job = await this.runtime.submit(binding.request, record.grant.kind === 'collaboration' ? { roomId: record.grant.roomId, targetNodeId: binding.nodeId } : undefined)
          await this.reconcileJob(job)
        }
      } catch (error) {
        const existing = this.runtime.jobs.list().find(j => j.clientRequestId === binding.request.clientRequestId)
        if (existing) await this.reconcileJob(existing)
        else await this.exclusive(() => this.rejectUndispatched(record, binding, error))
      }
      return false
    }
    return this.active(record)
  }
  private finishCall(record: StoredRun, operation: StoredOperation) {
    if (record.pendingCalls[0]?.id === operation.call.id) record.pendingCalls.shift()
    record.messages.push({ role: 'tool', tool_call_id: operation.call.id, content: JSON.stringify(operation.result ?? {}) })
    let detail = operation.result
    if (operation.call.name === 'run_canvas_command' && operation.result && !(operation.result as { error?: unknown }).error) {
      const receipt = operation.result as { affectedNodeIds: string[]; affectedEdgeIds: string[] }
      detail = { ...Object.fromEntries(Object.entries(receipt).filter(([key]) => !['actual', 'result', 'affectedNodeIds', 'affectedEdgeIds'].includes(key))),
        affectedNodeCount: receipt.affectedNodeIds.length, affectedEdgeCount: receipt.affectedEdgeIds.length }
    }
    this.event(record, 'tool', operation.call.name, (operation.result as { error?: unknown })?.error ? 'failed' : 'complete',
      { toolName: operation.call.name, operationId: operation.id, detail: JSON.stringify(detail ?? {}).slice(0, 2000) })
    if (operation.call.name === 'ask_user' && record.run.status === 'waiting_user') this.skipPending(record, '先等待用户回答，再规划后续操作。')
  }
  private skipPending(record: StoredRun, reason: string, preserveGeneration = false) {
    const retained: ToolCall[] = []
    for (const call of record.pendingCalls) {
      if (preserveGeneration && call.name === 'request_generation' && record.bindings.some(b => !b.settled && record.operations.find(o => o.id === b.operationId)?.call.id === call.id)) { retained.push(call); continue }
      record.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ skipped: true, reason }) })
      this.event(record, 'tool', call.name, 'skipped', { toolName: call.name, detail: reason })
    }
    record.pendingCalls = retained
  }
  private scope(record: StoredRun, id: string, snapshot: CanvasSnapshotV2, allowUnlock = false): CanvasNode {
    const node = snapshot.nodes.find(n => n.id === id)
    if (!node) throw new AgentError(409, 'node_missing', '目标节点已删除。')
    const created = record.changes.some(c => c.collection === 'nodes' && c.id === id && !c.path.length && c.before === undefined)
    if (!created && !record.selectedNodeIds.includes(id)) throw new AgentError(403, 'node_out_of_scope', '目标不在本任务授权范围，请先选择该节点并创建新任务。')
    if (node.locked && !allowUnlock) throw new AgentError(409, 'node_locked', '目标节点已锁定。')
    return node
  }
  private summarizeNode(node: CanvasNode, full = false) {
    if (full) return structuredClone(node)
    return { id: node.id, type: node.type, name: node.name.slice(0, 256), position: node.position, size: node.size, parentId: node.parentId, locked: node.locked,
      ...(node.type === 'text' ? { text: node.data.text.slice(0, 2000) } : {}),
      ...(node.type === 'image' || node.type === 'video' ? { assetId: node.data.assetId, prompt: node.data.promptDraft?.slice(0, 2000), generationSettings: node.data.generationSettings, generationStatus: node.data.generation?.status } : {}) }
  }
  private async taskSkill(record: StoredRun, id: string, resource?: string) {
    if (record.executionVersion === 2) {
      if (!record.skillPackage) throw new AgentError(409, 'skill_package_missing', '任务固定的 Skill 包缺失，需恢复后继续。')
      return this.skills.readResource(record.skillPackage, id, resource)
    }
    if (resource) throw new AgentError(400, 'skill_resource_unsupported', '旧任务只支持原 Skill。')
    return this.skills.read(id)
  }
  private async runCommand(record: StoredRun, operation: StoredOperation, snapshot: CanvasSnapshotV2, revision: number) {
    const args = operation.call.arguments
    const command = String(args.command); const parameters = args.parameters as Record<string, unknown>
    if (args.expectedRevision !== revision) throw new AgentError(409, 'revision_conflict', '修订已变化，请重新读取并计算。')
    if (record.writeAuthorized === false && !args.dryRun) throw new AgentError(403, 'execution_approval_required', '当前任务只允许方案与预演。')
    const asset = command === 'assets.associate' ? this.runtime.assets.get(String(parameters.assetId)) : undefined
    const candidate = computeCanvasCommand(snapshot, command, parameters, hash(operation.id).slice(0, 24), {
      assets: asset ? { [asset.id]: asset } : {}, timestamp: record.run.createdAt,
    })
    const changes = changesBetween(snapshot, candidate.snapshot, true)
    const affected = new Set(changes.filter(c => c.collection === 'nodes').map(c => c.id))
    const edgeIds = new Set(changes.filter(c => c.collection === 'edges').map(c => c.id))
    const required = new Set(affected)
    for (const key of ['nodeId', 'source', 'target', 'parentId', 'targetId']) if (typeof parameters[key] === 'string') required.add(parameters[key] as string)
    if (Array.isArray(parameters.nodeIds)) for (const id of parameters.nodeIds) required.add(String(id))
    if (Array.isArray(parameters.moves)) for (const move of parameters.moves as { nodeId: string }[]) required.add(move.nodeId)
    for (const edge of [...snapshot.edges, ...candidate.snapshot.edges]) if (edgeIds.has(edge.id)) { required.add(edge.source); required.add(edge.target) }
    if (command === 'nodes.duplicate') {
      const visit = (parent: string) => { for (const child of snapshot.nodes.filter(n => n.parentId === parent)) { required.add(child.id); visit(child.id) } }
      for (const id of [...required]) if (snapshot.nodes.find(n => n.id === id)?.type === 'group') visit(id)
    }
    if (command === 'nodes.rename_canvas') {
      const permitted = snapshot.nodes.filter(n => record.selectedNodeIds.includes(n.id) || record.changes.some(c => c.collection === 'nodes' && c.id === n.id && !c.path.length && c.before === undefined))
      if (!permitted.length) throw new AgentError(403, 'node_out_of_scope', '修改画布名称需要本任务授权节点。')
      for (const n of permitted) required.add(n.id)
    }
    for (const id of required) {
      if (!snapshot.nodes.some(n => n.id === id)) continue
      const allowUnlock = command === 'styles.flags' && parameters.nodeId === id && parameters.locked === false
      const node = this.scope(record, id, snapshot, allowUnlock)
      const observed = record.observed[id]
      if (!observed) throw new AgentError(409, 'node_not_read', '请先读取完整影响集再操作。')
      if (!isDeepStrictEqual(node, observed)) throw new AgentError(409, 'target_changed', '目标已变化，请先重新读取。')
    }
    for (const id of required) affected.add(id)
    const receipt = { operationId: operation.id, command, committed: false, status: args.dryRun ? 'preview' : changes.length ? 'pending' : 'unchanged', revision,
      affectedNodeIds: [...affected], affectedEdgeIds: [...edgeIds], result: candidate.result,
      actual: { name: candidate.snapshot.name, nodes: candidate.snapshot.nodes.filter(n => affected.has(n.id)), edges: candidate.snapshot.edges.filter(e => edgeIds.has(e.id)) } }
    if (args.dryRun || !changes.length) return { ...receipt, verified: true }
    operation.result = receipt
    await this.writeCanvas(record, operation.id, snapshot, candidate.snapshot, true, revision)
    for (const node of candidate.snapshot.nodes) if (affected.has(node.id)) record.observed[node.id] = structuredClone(node)
    return operation.result
  }
  private async writeCanvas(record: StoredRun, operationId: string, before: CanvasSnapshotV2, after: CanvasSnapshotV2, track = true, expectedRevision?: number) {
    const changes = changesBetween(before, parseCanvasSnapshot(JSON.stringify(after)), record.executionVersion === 2)
    if (!changes.length) return
    let dependencies: CanvasNode[] | undefined
    const operation = record.operations.find(o => o.id === operationId)
    if (record.executionVersion === 2 && operation?.call.name === 'run_canvas_command') {
      const receipt = operation.result as { affectedNodeIds: string[] }
      const ids = new Set(receipt.affectedNodeIds)
      const command = String(operation.call.arguments.command)
      if (command.startsWith('geometry.') || command.startsWith('hierarchy.')) {
        for (const id of [...ids]) {
          let parent = before.nodes.find(n => n.id === id)?.parentId
          while (parent) { ids.add(parent); parent = before.nodes.find(n => n.id === parent)?.parentId }
        }
      }
      dependencies = structuredClone(before.nodes.filter(n => ids.has(n.id)))
    }
    const { revision, snapshot: current } = await readCanvas(this.runtime, record)
    if (expectedRevision !== undefined && revision !== expectedRevision) throw new AgentError(409, 'revision_conflict', '提交前修订已变化，请重新读取。')
    if (dependencies?.some(original => !isDeepStrictEqual(original, current.nodes.find(n => n.id === original.id)))) throw new AgentError(409, 'target_changed', '候选变更的计算依赖已变化，请重新读取。')
    const merged = applyChanges(current, changes)
    if (merged.conflicts.length) throw new AgentError(409, 'canvas_conflict', '目标字段已被修改，已保留人工修改。')
    after = merged.snapshot; before = current
    record.pendingWrite = { operationId, changes, trackChanges: track, ...(dependencies ? { dependencies, expectedRevision } : {}),
      ...(record.grant.kind === 'local-admin' ? { mutation: { protocolVersion: 1, operationId, kind: 'save-canvas', expectedRevision: revision, canvas: after } } : { before, after }) }
    await this.save(record)
    try { await this.applyPendingWrite(record, track) }
    catch (error) {
      if (error instanceof WorkspaceConflictError || (record.executionVersion === 2 && error instanceof UncommittedCanvasConflict)) { delete record.pendingWrite; await this.save(record); throw new AgentError(409, 'canvas_conflict', record.executionVersion === 2 ? '画布刚刚发生更改或目标正被编辑，请重新读取后继续。' : '画布刚刚发生更改，请重新读取后继续。') }
      throw error
    }
  }
  private async applyPendingWrite(record: StoredRun, track = true) {
    const pending = record.pendingWrite
    if (!pending) return
    const checked = await readCanvas(this.runtime, record)
    if (pending.mutation) {
      const receipt = await this.runtime.workspace.applyWorkspaceMutation(pending.mutation)
      record.run.appliedCanvasRevision = receipt.canvasRevisions[record.run.canvasId]
    } else if (record.grant.kind === 'collaboration' && pending.before && pending.after) {
      const current = this.runtime.collaboration.exportSnapshot(record.grant.roomId)
      const reapplied = applyChanges(current, pending.changes)
      const alreadyApplied = record.executionVersion === 2 ? changesMatch(current, pending.changes) : isDeepStrictEqual(current, pending.after)
      if (reapplied.conflicts.length && !alreadyApplied) throw new UncommittedCanvasConflict(409, 'canvas_conflict', '协作画布字段已被修改，已保留双方结果。')
      if (!alreadyApplied) {
        if (pending.expectedRevision !== undefined && checked.revision !== pending.expectedRevision) throw new UncommittedCanvasConflict(409, 'revision_conflict', '提交前修订已变化，请重新读取。')
        let protectedIds: string[] | undefined
        if (record.executionVersion === 2) {
          const receipt = record.operations.find(o => o.id === pending.operationId)?.result as { affectedNodeIds?: string[] } | undefined
          const ids = new Set(pending.dependencies?.map(n => n.id) ?? receipt?.affectedNodeIds ?? pending.changes.filter(c => c.collection === 'nodes').map(c => c.id))
          const command = record.operations.find(o => o.id === pending.operationId)?.call.arguments.command
          if (typeof command === 'string' && (command.startsWith('geometry.') || command.startsWith('hierarchy.'))) {
            for (const id of [...ids]) {
              let parent = pending.before.nodes.find(n => n.id === id)?.parentId
              while (parent) { ids.add(parent); parent = pending.before.nodes.find(n => n.id === parent)?.parentId }
            }
          }
          for (const id of ids) {
            const original = pending.dependencies?.find(n => n.id === id) ?? pending.before.nodes.find(n => n.id === id)
            if (original && !isDeepStrictEqual(original, current.nodes.find(n => n.id === id))) throw new UncommittedCanvasConflict(409, 'target_changed', '提交前目标或计算依赖已变化，请重新读取。')
          }
          for (const edge of [...current.edges, ...reapplied.snapshot.edges]) if (pending.changes.some(c => c.collection === 'edges' && c.id === edge.id)) { ids.add(edge.source); ids.add(edge.target) }
          if (pending.changes.some(c => c.collection === 'canvas' && c.path[0] === 'nodes')) {
            for (const [i, n] of current.nodes.entries()) if (reapplied.snapshot.nodes[i]?.id !== n.id) ids.add(n.id)
          }
          protectedIds = [...ids]
        }
        try { this.runtime.collaboration.applyAgentChange(record.grant, current, reapplied.snapshot, protectedIds) }
        catch (error) {
          if (record.executionVersion === 2 && error instanceof CollaborationConflictError) throw new UncommittedCanvasConflict(409, 'canvas_conflict', error.message)
          throw error
        }
      }
      await this.runtime.collaboration.checkpointRoom(record.grant.roomId)
      record.run.appliedCanvasRevision = (await this.runtime.workspace.getCanvasRecord(record.run.canvasId))?.revision
    }
    const operation = record.operations.find(o => o.id === pending.operationId)
    if (operation?.call.name === 'run_canvas_command' && operation.result) {
      const actual = await readCanvas(this.runtime, record)
      const receipt = operation.result as { affectedNodeIds: string[]; affectedEdgeIds: string[] }
      operation.result = { ...receipt, committed: true, status: 'committed', revision: record.run.appliedCanvasRevision,
        verified: changesMatch(actual.snapshot, pending.changes), verificationRevision: actual.revision,
        actual: { name: actual.snapshot.name, nodes: actual.snapshot.nodes.filter(n => receipt.affectedNodeIds.includes(n.id)), edges: actual.snapshot.edges.filter(e => receipt.affectedEdgeIds.includes(e.id)) } }
    }
    if (pending.trackChanges ?? track) { record.changes.push(...pending.changes); record.run.canUndo = true }
    else if (pending.operationId.startsWith('agent-undo-')) { record.undone = true; record.run.canUndo = false }
    if (operation && operation.call.name !== 'request_generation' && operation.result !== undefined) operation.state = 'complete'
    const appliedBinding = record.bindings.find(b => `${b.operationId}-result` === pending.operationId)
    if (appliedBinding) appliedBinding.applied = true
    delete record.pendingWrite
    await this.save(record)
  }

  private async rememberCommittedIntent(record: StoredRun) {
    const pending = record.pendingWrite
    if (!pending) return
    const { snapshot } = await readCanvas(this.runtime, record)
    if (pending.mutation) {
      const receipt = await this.runtime.workspace.getOperationReceipt(pending.mutation)
      if (receipt && pending.trackChanges !== false) { record.changes.push(...pending.changes); record.run.canUndo = true; record.run.appliedCanvasRevision = receipt.canvasRevisions[record.run.canvasId] }
    } else if (pending.trackChanges !== false && pending.after) {
      // Yjs writes happen synchronously before checkpointing. Remember only
      // fields still matching the intended write; undo retains later edits.
      const reversed = applyChanges(snapshot, pending.changes, true)
      const applied = changesBetween(reversed.snapshot, snapshot, record.executionVersion === 2)
      if (applied.length) { record.changes.push(...applied); record.run.canUndo = true }
    }
    delete record.pendingWrite
    await this.save(record)
  }

  private async clearStoppedMarkers(record: StoredRun) {
    const { snapshot } = await readCanvas(this.runtime, record)
    const after = structuredClone(snapshot)
    for (const binding of record.bindings.filter(b => !b.settled)) {
      const node = after.nodes.find(n => n.id === binding.nodeId)
      if (!node || (node.type !== 'image' && node.type !== 'video') || !Object.entries(binding.expectedFields).every(([key, value]) => isDeepStrictEqual((node.data as unknown as Record<string, unknown>)[key], value))) continue
      node.data.generation = { ...node.data.generation, prompt: binding.request.prompt, clientRequestId: binding.request.clientRequestId, status: 'failed', phase: 'failed', error: { code: 'AGENT_STOPPED', message: '任务已停止，已提交的生成结果仍会保留在任务记录中。' } }
      this.event(record, 'generation', '已停止后续处理；已提交结果仍将保留', 'skipped', { operationId: binding.operationId, nodeIds: [binding.nodeId] })
    }
    await this.writeCanvas(record, `agent-stop-${hash(record.run.id).slice(0, 40)}`, snapshot, after)
  }

  private async tool(record: StoredRun, operation: StoredOperation): Promise<unknown> {
    const { name, arguments: args } = operation.call
    validateToolArguments(name, args, record.executionVersion ?? 1)
    if (name === 'read_skill') {
      const id = text(args.id, 64); const resource = args.resource === undefined ? undefined : text(args.resource, 256)
      const key = resource ? `${id}/${resource}` : id
      const skill = record.skills[key] ?? await this.taskSkill(record, id, resource)
      record.skills[key] = skill; this.event(record, 'skill', `读取技能 · ${skill.info.name} v${skill.info.version}`)
      return skill
    }
    if (name === 'list_canvas_commands') return { executionVersion: 2, commands: listCanvasCommands() }
    if (name === 'describe_canvas_command') { const { validate: _validate, ...contract } = describeCanvasCommand(text(args.command, 128)); return contract }
    if (name === 'ask_user') {
      const options = ids(args.options, 6)
      if (options.length < 2) throw new AgentError(400, 'invalid_question', '请提供至少两个明确选项。')
      record.run.question = { id: `${operation.id}-question`, title: text(args.title, 1000), options, multiple: args.multiple === true }
      record.run.status = 'waiting_user'
      this.event(record, 'question', record.run.question.title, 'waiting')
      return { questionId: record.run.question.id, status: 'waiting_user' }
    }
    if (name === 'update_plan') {
      if (!Array.isArray(args.items) || args.items.length > 20 || args.items.some(i => !i || typeof i !== 'object' ||
        typeof i.id !== 'string' || typeof i.title !== 'string' || i.title.length > 256 || !['pending', 'running', 'complete', 'failed', 'skipped'].includes(i.status))) throw new AgentError(400, 'invalid_plan', '计划格式无效。')
      record.run.plan = structuredClone(args.items)
      this.event(record, 'plan', '更新执行计划')
      return { items: record.run.plan }
    }
    if (name === 'report') { const message = text(args.text); this.event(record, 'message', message); return { recorded: true } }
    if (name === 'view_image') {
      const attachment = record.run.attachments.find(a => a.id === args.referenceId)
      if (!attachment || !this.runtime.assets.get(attachment.assetId)) throw new AgentError(400, 'attachment_missing', '只能查看已确认且可访问的引用。')
      this.event(record, 'tool', `查看图片 · ${attachment.name}`, 'complete', { toolName: name, operationId: operation.id, nodeIds: [attachment.nodeId] })
      return { referenceId: attachment.id, preview: 'Actual image preview (at most 960px) is included in every model request.', assetId: attachment.assetId }
    }
    if (name === 'generation_config') {
      const providers = this.runtime.providers.listPublic().filter(p => p.enabled && p.available && p.secretConfigured)
      const configured = []
      for (const provider of providers.slice(0, 8)) {
        const catalog = this.runtime.catalogs.get(provider.id)
        if (!catalog) continue
        configured.push({ providerId: provider.id, preferred: provider.preferred, catalogVersion: catalog.version,
          models: catalog.models.slice(0, 30).map(m => ({ model: m.model, mediaType: m.mediaType, channel: m.channel, aspectRatios: m.aspectRatios, qualities: m.qualityOptions.map(q => q.value), durationOptions: m.durationOptions, modes: m.modes, inputLimits: m.inputLimits })) })
      }
      return { providers: configured, configured: configured.length > 0, maxOutputs: record.generationBudget, attemptsUsed: this.attemptsUsed(record) }
    }
    const { snapshot, revision } = await readCanvas(this.runtime, record)
    if (name === 'read_canvas' || name === 'read_nodes') {
      const nodes = name === 'read_nodes' ? snapshot.nodes.filter(n => ids(args.nodeIds, 30).includes(n.id)) :
        snapshot.nodes.slice(Math.floor(numeric(args.offset, 0, 0)), Math.floor(numeric(args.offset, 0, 0)) + Math.floor(numeric(args.limit, 20, 1, 30)))
      for (const node of nodes) record.observed[node.id] = structuredClone(node)
      const nodeIds = new Set(nodes.map(n => n.id))
      const adjacent = snapshot.edges.filter(e => nodeIds.has(e.source) || nodeIds.has(e.target))
      const edgeOffset = record.executionVersion === 2 ? Math.floor(numeric(args.edgeOffset, 0, 0)) : 0
      const edgeLimit = record.executionVersion === 2 ? Math.floor(numeric(args.edgeLimit, 100, 1, 100)) : 100
      return { canvasId: snapshot.canvasId, name: snapshot.name, revision, totalNodes: snapshot.nodes.length, nodes: nodes.map(n => this.summarizeNode(n, record.executionVersion === 2)),
        edges: adjacent.slice(edgeOffset, edgeOffset + edgeLimit),
        ...(record.executionVersion === 2 ? { order: nodes.map(n => ({ nodeId: n.id, index: snapshot.nodes.findIndex(candidate => candidate.id === n.id) })), totalEdges: adjacent.length, edgeOffset, hasMoreEdges: edgeOffset + edgeLimit < adjacent.length } : {}) }
    }
    if (name === 'run_canvas_command') return this.runCommand(record, operation, snapshot, revision)
    if (name === 'focus_nodes') { const nodeIds = ids(args.nodeIds); this.event(record, 'view', '可定位结果', 'complete', { nodeIds }); return { available: true, browserMoved: false, nodeIds } }
    if (record.writeAuthorized === false) throw new AgentError(403, 'execution_approval_required', '当前只允许方案和读取；请等待用户明确确认执行后再修改画布。')
    if (name === 'request_generation') return this.prepareGeneration(record, operation, snapshot)
    const after = structuredClone(snapshot)
    let result: Record<string, unknown> = {}
    const actualId = `agent-node-${hash(operation.id).slice(0, 24)}`
    if (name === 'create_node' || name === 'duplicate_node') {
      const existing = snapshot.nodes.find(n => n.id === actualId)
      if (existing) return { nodeId: existing.id, recovered: true }
      let node: CanvasNode
      const x = numeric(args.x, record.viewport ? -record.viewport.x / record.viewport.zoom + 80 + record.changes.filter(c => !c.path.length).length * 380 : 80 + record.changes.filter(c => !c.path.length).length * 380)
      const y = numeric(args.y, record.viewport ? -record.viewport.y / record.viewport.zoom + 80 : 80)
      const base = { id: actualId, name: text(args.name ?? '副本', 128), position: { x, y }, size: { width: numeric(args.width, 320, 32, 4096), height: numeric(args.height, 240, 32, 4096) } }
      if (name === 'duplicate_node') {
        const source = this.scope(record, text(args.nodeId, 256), snapshot)
        node = { ...structuredClone(source), id: actualId, name: args.name ? text(args.name, 128) : `${source.name} 副本`, parentId: undefined,
          position: { x: source.position.x + source.size.width + 40, y: source.position.y } }
        if (node.type === 'image' || node.type === 'video') delete node.data.generation
        if (node.type === 'group' || node.type === 'frame') node.data.childIds = []
      } else if (args.type === 'image' || args.type === 'video') {
        node = { ...base, type: args.type, data: { url: '', promptDraft: typeof args.prompt === 'string' ? args.prompt.slice(0, 12000) : '',
          generationSettings: args.type === 'image' ? { ...DEFAULT_IMAGE_GENERATION_SETTINGS } : { ...DEFAULT_VIDEO_GENERATION_SETTINGS } } } as CanvasNode
      } else if (args.type === 'text') node = { ...base, type: 'text', data: { text: typeof args.text === 'string' ? args.text.slice(0, 16000) : '' } }
      else if (args.type === 'group') node = { ...base, type: 'group', data: { childIds: [] } }
      else throw new AgentError(400, 'invalid_node_type', '不支持这个节点类型。')
      after.nodes.push(node); result = { nodeId: node.id, node }
    } else if (name === 'update_node') {
      const node = this.scope(record, text(args.nodeId, 256), snapshot); const next = after.nodes.find(n => n.id === node.id)!
      const seen = record.observed[node.id] as CanvasNode | undefined
      if (!seen) throw new AgentError(409, 'read_required', '修改前请先读取节点。')
      if (args.name !== undefined) { if (!isDeepStrictEqual(seen.name, node.name)) throw new AgentError(409, 'canvas_conflict', '名称已被用户修改。'); next.name = text(args.name, 128) }
      if (args.prompt !== undefined) {
        if ((next.type !== 'image' && next.type !== 'video') || (seen.type !== 'image' && seen.type !== 'video') || (node.type !== 'image' && node.type !== 'video')) throw new AgentError(400, 'invalid_field', '提示词只适用于媒体节点。')
        if (!isDeepStrictEqual(seen.data.promptDraft, node.data.promptDraft)) throw new AgentError(409, 'canvas_conflict', '提示词已被用户修改。')
        next.data.promptDraft = text(args.prompt, 12000)
      }
      if (args.text !== undefined) { if (next.type !== 'text' || node.type !== 'text' || seen.type !== 'text') throw new AgentError(400, 'invalid_field', '正文只适用于文本节点。')
        if (seen.data.text !== node.data.text) throw new AgentError(409, 'canvas_conflict', '文本已被用户修改。'); next.data.text = text(args.text, 16000) }
      result = { nodeId: node.id }
    } else if (name === 'move_nodes') {
      if (!Array.isArray(args.nodes) || args.nodes.length > 100) throw new AgentError(400, 'invalid_input', '移动列表无效。')
      for (const move of args.nodes) {
        const node = this.scope(record, text(move.nodeId, 256), snapshot)
        const seen = record.observed[node.id] as CanvasNode | undefined
        if (!seen || !isDeepStrictEqual(seen.position, node.position)) throw new AgentError(409, 'canvas_conflict', '节点位置已改变，请重新读取。')
        after.nodes.find(n => n.id === node.id)!.position = { x: numeric(move.x, node.position.x), y: numeric(move.y, node.position.y) }
      }
      result = { moved: args.nodes.length }
    } else if (name === 'group_nodes') {
      const nodeIds = ids(args.nodeIds); const children = nodeIds.map(id => this.scope(record, id, snapshot))
      if (!children.length || children.some(n => n.parentId || n.type === 'group' || n.type === 'frame')) throw new AgentError(409, 'group_scope', '请选择未分组的普通节点。')
      const x = Math.min(...children.map(n => n.position.x)) - 24; const y = Math.min(...children.map(n => n.position.y)) - 48
      after.nodes.push({ id: actualId, type: 'group', name: text(args.name, 128), position: { x, y },
        size: { width: Math.max(...children.map(n => n.position.x + n.size.width)) - x + 24, height: Math.max(...children.map(n => n.position.y + n.size.height)) - y + 24 }, data: { childIds: nodeIds } })
      for (const node of after.nodes.filter(n => nodeIds.includes(n.id))) { node.parentId = actualId; node.position = { x: node.position.x - x, y: node.position.y - y } }
      result = { nodeId: actualId, childIds: nodeIds }
    } else if (name === 'delete_nodes') {
      if (!/删除|移除|delete|remove/i.test(record.run.prompt + record.messages.filter(m => m.role === 'user').map(m => m.content).join(' '))) throw new AgentError(403, 'delete_not_authorized', '用户没有授权删除。')
      const nodeIds = ids(args.nodeIds); for (const id of nodeIds) this.scope(record, id, snapshot)
      if (snapshot.nodes.some(n => n.parentId && nodeIds.includes(n.parentId) && !nodeIds.includes(n.id))) throw new AgentError(409, 'group_has_children', '不能删除仍有保留子节点的分组。')
      after.nodes = after.nodes.filter(n => !nodeIds.includes(n.id)); after.edges = after.edges.filter(e => !nodeIds.includes(e.source) && !nodeIds.includes(e.target)); result = { deletedNodeIds: nodeIds }
    } else if (name === 'connect_nodes') {
      const source = this.scope(record, text(args.source, 256), snapshot); const target = this.scope(record, text(args.target, 256), snapshot)
      const relation = args.relation === 'reference' ? 'reference' : 'flow'
      const id = `agent-edge-${hash(operation.id).slice(0, 24)}`
      after.edges.push({ id, source: source.id, target: target.id, relation,
        ...(relation === 'reference' ? { referenceAlias: Math.max(0, ...snapshot.edges.filter(e => e.target === target.id).map(e => e.referenceAlias ?? 0)) + 1 } : {}) }); result = { edgeId: id }
    } else if (name === 'remove_edge') {
      const edge = snapshot.edges.find(e => e.id === args.edgeId)
      if (!edge) throw new AgentError(404, 'edge_missing', '连线不存在。')
      this.scope(record, edge.source, snapshot); this.scope(record, edge.target, snapshot)
      after.edges = after.edges.filter(e => e.id !== edge.id); result = { edgeId: edge.id }
    } else throw new AgentError(400, 'unknown_tool', '工具不存在。')
    // Persist the intended tool receipt alongside the write intent, so restart can
    // acknowledge an already committed change without recomputing or duplicating it.
    operation.result = result
    await this.writeCanvas(record, operation.id, snapshot, after)
    // A write acknowledges only its own fields. Refreshing unrelated fields here
    // would let a later call in the same model turn overwrite an unseen user edit.
    const changes = changesBetween(snapshot, parseCanvasSnapshot(JSON.stringify(after)))
    const known = { ...snapshot, nodes: snapshot.nodes.map(node => structuredClone(record.observed[node.id] as CanvasNode ?? node)) }
    const observedAfter = applyChanges(known, changes).snapshot
    const touched = new Set(changes.filter(change => change.collection === 'nodes').map(change => change.id))
    for (const node of observedAfter.nodes) if (touched.has(node.id)) record.observed[node.id] = structuredClone(node)
    return { ...result, revision: record.run.appliedCanvasRevision }
  }

  private async prepareGeneration(record: StoredRun, operation: StoredOperation, snapshot: CanvasSnapshotV2): Promise<GenerationBinding> {
    const prior = record.bindings.find(b => b.operationId === operation.id)
    if (prior) { record.run.status = 'waiting_generation'; return prior }
    if (record.generationPausedByUser || this.attemptsUsed(record) >= Math.min(12, record.generationAttemptsAllowed ?? record.generationBudget)) throw new AgentError(403, 'generation_budget', '已达到用户授权次数或每次任务 12 个输出的限制；不能自动增加收费请求。')
    const args = operation.call.arguments; const node = this.scope(record, text(args.nodeId, 256), snapshot)
    if (node.type !== 'image' && node.type !== 'video') throw new AgentError(400, 'invalid_target', '生成需要图片或视频节点。')
    if (node.data.generation?.status === 'generating') throw new AgentError(409, 'node_busy', '这个节点已有生成任务。')
    const prompt = text(node.data.promptDraft, 5000)
    const settings = node.data.generationSettings
    const providers = this.runtime.providers.listPublic().filter(p => p.enabled && p.secretConfigured && p.available)
    const requestedProvider = args.providerId || settings?.providerId
    const provider = requestedProvider ? providers.find(p => p.id === requestedProvider) : providers.find(p => p.preferred) ?? providers[0]
    if (!provider) throw new AgentError(409, 'generation_not_configured', '请在 API 设置配置可用的生成模型。')
    const catalog = this.runtime.catalogs.get(provider.id)
    if (!catalog) throw new AgentError(409, 'generation_catalog_missing', '生成模型目录尚未同步，请稍后继续。')
    const requestedModel = args.model || settings?.model
    const model = requestedModel ? catalog.models.find(m => m.mediaType === node.type && m.model === requestedModel &&
      (args.model || settings?.channel === undefined || settings.channel === '' || String(m.channel) === String(settings.channel))) : catalog.models.find(m => m.mediaType === node.type)
    if (!model) throw new AgentError(409, 'generation_model_missing', '所要求的生成模型不可用，请先同步模型配置。')
    const referenceIds = ids(args.referenceIds ?? [], 4)
    const references = referenceIds.map((id, index) => {
      const a = record.run.attachments.find(ref => ref.id === id)
      if (!a || !this.runtime.assets.get(a.assetId)) throw new AgentError(409, 'reference_missing', '生成参考必须是本任务已确认的可用图片。')
      return { alias: index + 1, assetId: a.assetId, mediaType: 'image' as const }
    })
    if (references.length > model.inputLimits.images) throw new AgentError(400, 'reference_limit', '模型不支持这么多参考图。')
    // An existing configured node is authoritative for omitted options. New
    // unconfigured placeholder defaults may be mapped to supported catalog defaults.
    const configuredSettings = Boolean(settings?.providerId && settings.model)
    const aspectRatio = args.aspectRatio ? text(args.aspectRatio, 32) :
      settings?.aspectRatio && (configuredSettings || model.aspectRatios.includes(settings.aspectRatio)) ? settings.aspectRatio : model.aspectRatios[0]
    if (aspectRatio && !model.aspectRatios.includes(aspectRatio)) throw new AgentError(400, 'aspect_ratio_unsupported', '模型不支持指定比例。')
    const request: GenerationRequest = { clientRequestId: `agent-${record.run.id}-${hash(operation.id).slice(0, 20)}`, projectId: record.run.projectId,
      canvasId: record.run.canvasId, targetNodeId: node.id, providerId: provider.id, catalogVersion: catalog.version, mediaType: node.type,
      channel: model.channel, model: model.model, prompt, n: 1, references,
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(args.quality ? { quality: text(args.quality, 64) } : settings?.kind === 'image' && (configuredSettings || model.qualityOptions.some(q => q.value === settings.quality)) ? { quality: settings.quality } : model.qualityOptions[0] ? { quality: model.qualityOptions[0].value } : {}),
      ...(node.type === 'video' ? { duration: numeric(args.duration, settings?.kind === 'video' && configuredSettings ? settings.durationSec : model.durationOptions[0] ?? 5, 1, 120), generateAudio: settings?.kind === 'video' ? settings.generateAudio : true } : {}),
      ...(configuredSettings && settings?.mode ? { mode: settings.mode } : model.modes.length ? { mode: references.length ? model.modes.find(m => /image2|reference|edit/.test(m)) ?? model.modes[0] : model.modes.find(m => /text2/.test(m)) ?? model.modes[0] } : {}) }
    try { validateGenerationRequest(request, catalog) } catch (error) { throw new AgentError(400, 'invalid_generation_request', error instanceof Error ? error.message : '生成参数无效。') }
    const after = structuredClone(snapshot); const target = after.nodes.find(n => n.id === node.id)!
    if (target.type !== 'image' && target.type !== 'video') throw new Error('Invalid media node')
    target.data.generation = { prompt, status: 'generating', phase: 'queued', progress: 0, clientRequestId: request.clientRequestId, providerId: provider.id }
    target.data.generationSettings = node.type === 'image' ? { ...DEFAULT_IMAGE_GENERATION_SETTINGS, ...(settings?.kind === 'image' ? settings : {}), providerId: provider.id, catalogVersion: catalog.version, channel: model.channel, model: model.model,
      aspectRatio: aspectRatio ?? '1:1', quality: request.quality ?? 'standard', count: 1, mode: request.mode } :
      { ...DEFAULT_VIDEO_GENERATION_SETTINGS, ...(settings?.kind === 'video' ? settings : {}), providerId: provider.id, catalogVersion: catalog.version, channel: model.channel, model: model.model, aspectRatio: aspectRatio ?? '16:9', durationSec: request.duration ?? 5, generateAudio: request.generateAudio ?? true, count: 1, mode: request.mode }
    const skillId = node.type === 'image' ? 'image-generation' : 'video-generation'
    if (!record.skills[skillId]) { const skill = await this.taskSkill(record, skillId); record.skills[skillId] = skill; this.event(record, 'skill', `读取技能 · ${skill.info.name} v${skill.info.version}`) }
    const binding: GenerationBinding = { operationId: operation.id, nodeId: node.id, request,
      expectedFields: { assetId: node.data.assetId, url: node.data.url, generation: target.data.generation,
        ...(node.type === 'image' ? { versions: node.data.versions, activeVersionId: node.data.activeVersionId } : {}) } }
    // The binding is committed before the canvas marker and provider dispatch.
    record.bindings.push(binding); await this.save(record)
    await this.writeCanvas(record, `${operation.id}-prepare`, snapshot, after)
    record.observed[node.id] = structuredClone(target)
    record.run.status = 'waiting_generation'; this.event(record, 'generation', `生成${node.type === 'image' ? '图片' : '视频'} · ${node.name}`, 'running', { nodeIds: [node.id], operationId: operation.id })
    await this.save(record); return binding
  }

  private async reconcileJob(job: GenerationJob) {
    await this.exclusive(async () => {
      if (this.closed) return
      const record = [...this.store.records.values()].find(r => r.bindings.some(b => b.request.clientRequestId === job.clientRequestId))
      if (!record) return
      const binding = record.bindings.find(b => b.request.clientRequestId === job.clientRequestId)!
      binding.jobId = job.id
      if (binding.settled || (job.status !== 'complete' && job.status !== 'failed')) { await this.save(record); return }
      const operation = record.operations.find(o => o.id === binding.operationId)
      if (job.status === 'complete') {
        for (const output of job.outputs) if (!record.run.outputs.some(o => o.assetId === output.assetId)) record.run.outputs.push({ nodeId: binding.nodeId, assetId: output.assetId, url: output.url, mediaType: binding.request.mediaType })
        await this.save(record)
        if (!binding.applied && !record.stopped && !record.undone && !['failed', 'stopped'].includes(record.run.status)) {
          try {
            const { snapshot } = await readCanvas(this.runtime, record)
            if (binding.request.references.some(ref => !ref.assetId || !this.runtime.assets.get(ref.assetId))) throw new AgentError(409, 'reference_revoked', '生成参考素材已删除；结果已保留，未自动写入画布。')
            const node = snapshot.nodes.find(n => n.id === binding.nodeId)
            if (!node || (node.type !== 'image' && node.type !== 'video')) throw new AgentError(409, 'target_missing', '生成已完成，但原目标已删除；结果保留在任务中。')
            const data = node.data as unknown as Record<string, unknown>
            if (Object.entries(binding.expectedFields).some(([key, value]) => !isDeepStrictEqual(data[key], value))) throw new AgentError(409, 'target_changed', '生成已完成，但目标内容已改变；结果已保留，未覆盖。')
            const output = job.outputs[0]
            const asset = output && this.runtime.assets.get(output.assetId)
            if (!output || !asset || output.url !== asset.url || !asset.contentType.startsWith(`${binding.request.mediaType}/`)) throw new AgentError(409, 'output_missing', '生成结果素材不可读取。')
            const after = structuredClone(snapshot); const target = after.nodes.find(n => n.id === binding.nodeId)!
            if (target.type !== 'image' && target.type !== 'video') throw new Error('Invalid media node')
            target.data.assetId = output.assetId; target.data.url = output.url
            target.data.generation = { ...target.data.generation, prompt: binding.request.prompt, jobId: job.id, clientRequestId: job.clientRequestId, status: 'complete', phase: 'complete', progress: 100, outputs: job.outputs,
              providerId: binding.request.providerId, createdAt: job.createdAt, actualSettings: binding.request.mediaType === 'image' ?
                { ...DEFAULT_IMAGE_GENERATION_SETTINGS, providerId: binding.request.providerId, channel: binding.request.channel, model: binding.request.model,
                  quality: binding.request.quality ?? 'standard', aspectRatio: binding.request.aspectRatio ?? '1:1', count: 1, mode: binding.request.mode } :
                { ...DEFAULT_VIDEO_GENERATION_SETTINGS, providerId: binding.request.providerId, channel: binding.request.channel, model: binding.request.model,
                  aspectRatio: binding.request.aspectRatio ?? '16:9', durationSec: binding.request.duration ?? 5, generateAudio: binding.request.generateAudio ?? true, count: 1, mode: binding.request.mode }, outputAspectRatio: binding.request.aspectRatio }
            if (target.type === 'image') { const versionId = `agent-output-${job.id}`; target.data.versions = [...(target.data.versions ?? []), { id: versionId, assetId: output.assetId, url: output.url, createdAt: job.updatedAt, label: 'Agent 生成' }]; target.data.activeVersionId = versionId }
            await this.writeCanvas(record, `${binding.operationId}-result`, snapshot, after); binding.applied = true
            record.observed[node.id] = structuredClone(target)
          } catch (error) { record.run.error = publicFailure(error); this.event(record, 'generation', record.run.error.message, 'waiting', { operationId: binding.operationId }); if (!terminal.has(record.run.status)) record.run.status = 'paused' }
        }
        this.event(record, 'generation', binding.applied ? '生成完成并已写入画布' : '生成完成；结果已保存，未自动写入画布', binding.applied ? 'complete' : 'waiting', { nodeIds: [binding.nodeId], operationId: binding.operationId })
      } else {
        if (!record.stopped && !record.undone && !terminal.has(record.run.status)) {
          try {
            const { snapshot } = await readCanvas(this.runtime, record)
            const node = snapshot.nodes.find(n => n.id === binding.nodeId)
            if (node && (node.type === 'image' || node.type === 'video') && Object.entries(binding.expectedFields).every(([key, value]) => isDeepStrictEqual((node.data as unknown as Record<string, unknown>)[key], value))) {
              const after = structuredClone(snapshot); const target = after.nodes.find(n => n.id === binding.nodeId)!
              if (target.type === 'image' || target.type === 'video') target.data.generation = { prompt: binding.request.prompt, status: 'failed', phase: 'failed', progress: job.progress, jobId: job.id, clientRequestId: job.clientRequestId, error: job.error }
              await this.writeCanvas(record, `${binding.operationId}-failure`, snapshot, after)
              record.observed[node.id] = structuredClone(target)
            }
          } catch (error) { await this.pauseWithError(record, error) }
        }
        this.event(record, 'generation', /CREATE_STATE_UNKNOWN|CREATE_AMBIGUOUS/.test(job.error?.code ?? '') ? '供应商提交状态未知；已停止自动重试' : '生成失败', 'failed', { detail: job.error?.message, operationId: binding.operationId })
      }
      binding.settled = true
      if (operation && operation.state !== 'complete') {
        operation.result = job.status === 'failed' ? { error: job.error ?? { code: 'generation_failed', message: '生成失败' }, jobId: job.id, clientRequestId: job.clientRequestId } :
          { jobId: job.id, clientRequestId: job.clientRequestId, nodeId: binding.nodeId, outputs: job.outputs, applied: Boolean(binding.applied), ...(record.run.error ? { error: record.run.error } : {}) }
        operation.state = 'complete'; this.finishCall(record, operation)
      }
      if (record.run.status === 'waiting_generation') record.run.status = 'queued'
      await this.save(record)
    })
    this.pump()
  }
  private async checkWaiting() {
    for (const record of this.store.records.values()) {
      if (record.stopped || terminal.has(record.run.status)) continue
      for (const binding of record.bindings.filter(b => !b.settled)) {
        const job = this.runtime.jobs.list().find(j => j.clientRequestId === binding.request.clientRequestId)
        if (job) await this.reconcileJob(job)
        if (Date.now() - Date.parse(record.run.createdAt) > 45 * 60_000 && record.run.status === 'waiting_generation') await this.exclusive(() => this.pauseWithError(record, new AgentError(409, 'generation_wait_limit', '生成等待超过 45 分钟；任务仍可查询，已暂停后续步骤。')))
      }
    }
  }
  private async rejectUndispatched(record: StoredRun, binding: GenerationBinding, error: unknown) {
    // Runtime persists a job before any provider call. With no job, a local
    // catalog/validation/configuration failure is known not to have been sent.
    binding.settled = true; binding.notSubmitted = true
    const failure = { code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'submission_not_started', message: '生成尚未提交给供应商；请核对生成模型或参数后重试。' }
    if (!record.stopped && !record.undone) {
      try {
        const { snapshot } = await readCanvas(this.runtime, record)
        const node = snapshot.nodes.find(n => n.id === binding.nodeId)
        if (node && (node.type === 'image' || node.type === 'video') && Object.entries(binding.expectedFields).every(([key, value]) => isDeepStrictEqual((node.data as unknown as Record<string, unknown>)[key], value))) {
          const after = structuredClone(snapshot); const target = after.nodes.find(n => n.id === binding.nodeId)!
          if (target.type === 'image' || target.type === 'video') target.data.generation = { prompt: binding.request.prompt, status: 'failed', phase: 'failed', clientRequestId: binding.request.clientRequestId, error: failure }
          await this.writeCanvas(record, `${binding.operationId}-not-submitted`, snapshot, after)
        }
      } catch (writeError) { await this.pauseWithError(record, writeError) }
    }
    const operation = record.operations.find(o => o.id === binding.operationId)
    if (operation && operation.state !== 'complete') { operation.state = 'complete'; operation.result = { error: failure, submitted: false }; this.finishCall(record, operation) }
    this.event(record, 'generation', failure.message, 'failed', { operationId: binding.operationId })
    if (record.run.status === 'waiting_generation') record.run.status = 'queued'
    await this.save(record)
  }
  async dispatchGeneration<T>(job: GenerationJob, prepare: () => Promise<void>, start: () => Promise<T>): Promise<T> {
    const launched = await this.exclusive(async () => {
      const record = [...this.store.records.values()].find(r => r.bindings.some(b => b.request.clientRequestId === job.clientRequestId))
      const allowed = () => record && !this.closed && !record.stopped && !record.undone && !record.generationPausedByUser && record.writeAuthorized !== false && this.attemptsUsed(record) <= (record.generationAttemptsAllowed ?? record.generationBudget) && record.run.status === 'waiting_generation'
      if (!record || !allowed()) throw new GenerationDispatchDeferredError('Agent dispatch is paused or stopped')
      try {
        await readCanvas(this.runtime, record)
        await prepare()
        // The attempt marker is durable. Recheck after that await, then call the
        // provider synchronously while controls share this same short queue.
        const { snapshot } = await readCanvas(this.runtime, record)
        const binding = record.bindings.find(b => b.request.clientRequestId === job.clientRequestId)!
        const node = snapshot.nodes.find(n => n.id === binding.nodeId)
        if (binding.request.references.some(ref => !ref.assetId || !this.runtime.assets.get(ref.assetId))) throw new AgentError(409, 'reference_revoked', '生成参考素材已删除，已停止新的生成提交。')
        if (!allowed() || !node || (node.type !== 'image' && node.type !== 'video') || node.data.generation?.clientRequestId !== job.clientRequestId) throw new GenerationDispatchDeferredError('Generation target or run changed')
        if (record.grant.kind === 'collaboration') this.runtime.collaboration.authorizeAgentGrant(record.grant, record.run.canvasId)
      } catch (error) {
        if (!(error instanceof GenerationDispatchDeferredError)) await this.pauseWithError(record, error)
        throw new GenerationDispatchDeferredError('Agent authorization or target could not be verified')
      }
      // Do not classify a synchronous provider exception as a safe deferral.
      return { promise: start() }
    })
    return launched.promise
  }
  async idle() { await Promise.allSettled([...this.flights.values()]); await this.queue }
  async reset() {
    await this.exclusive(async () => {
      for (const record of this.store.records.values()) { record.stopped = true; record.run.status = 'stopped'; record.undone = true; await this.save(record) }
      for (const controller of this.controllers.values()) controller.abort()
    })
    await this.idle()
    this.store.records.clear()
  }
  async close() {
    this.closed = true; this.unsubscribe?.(); if (this.timer) clearInterval(this.timer)
    for (const controller of this.controllers.values()) controller.abort()
    await this.idle()
  }
}
