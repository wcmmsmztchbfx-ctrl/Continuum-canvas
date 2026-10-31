import type { AgentAnswerInput, AgentAttachment, AgentControlInput, AgentCreateRunInput, AgentRun, AgentSkillInfo } from '../../contracts/agent'
import { GatewayClient, GatewayClientError, gatewayClient } from '../gatewayClient'
import { createBrowserUuid } from '../../utils/id'

export class AgentRuntimeError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.name = 'AgentRuntimeError'; this.status = status; this.code = code }
}
export interface AgentStatus { configured: boolean; providerName?: string; model?: string }
interface ClientOptions { fetchImpl?: typeof fetch; getRoomId?: () => string | undefined }
interface LocalSessionState { gateway: Pick<GatewayClient, 'ensureLocalAdminSession'>; generation: number; recovery?: Promise<void> }
// All panels/sync observers sharing a fetch transport share one bootstrap/recovery.
// A late 403 from the preceding identity must not rotate a newly recovered session.
const localSessions = new WeakMap<typeof fetch, LocalSessionState>()
const runStatuses = new Set(['queued', 'running', 'waiting_user', 'waiting_generation', 'paused', 'complete', 'partial', 'failed', 'stopped'])
function isRun(value: unknown): value is AgentRun {
  if (!value || typeof value !== 'object') return false
  const run = value as AgentRun
  return typeof run.id === 'string' && typeof run.canvasId === 'string' && typeof run.prompt === 'string' && runStatuses.has(run.status) && Number.isSafeInteger(run.sequence) && Array.isArray(run.events) && Array.isArray(run.plan) && Array.isArray(run.attachments) && Array.isArray(run.outputs)
}
function scope(canvasId: string) { if (!canvasId.trim()) throw new AgentRuntimeError(0, 'canvas_scope_required', '请先打开画布后再使用 Agent') }
function invalid(): never { throw new AgentRuntimeError(0, 'invalid_response', 'Agent 返回的数据无效，请稍后重试') }
export class AgentRuntimeClient {
  private readonly fetchImpl: typeof fetch
  private readonly getRoomId: () => string | undefined
  private readonly localSession: LocalSessionState
  constructor(options: ClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))
    this.getRoomId = options.getRoomId ?? (() => gatewayClient.getCollaborationRoomId())
    const transport = options.fetchImpl ?? globalThis.fetch
    let session = localSessions.get(transport)
    if (!session) {
      session = { gateway: options.fetchImpl ? new GatewayClient({ fetchImpl: options.fetchImpl }) : gatewayClient, generation: 0 }
      localSessions.set(transport, session)
    }
    this.localSession = session
  }
  private async recoverLocalSession(generation: number): Promise<void> {
    const session = this.localSession
    if (session.generation !== generation) return
    if (!session.recovery) {
      // The shared gateway caches an earlier successful bootstrap. A fresh client
      // invokes the same server-validated endpoint after an explicit auth rejection.
      const gateway = new GatewayClient({ fetchImpl: this.fetchImpl })
      session.recovery = gateway.ensureLocalAdminSession().then(() => {
        session.gateway = gateway; session.generation++
      }).finally(() => { session.recovery = undefined })
    }
    await session.recovery
  }
  private async request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('Agent 请求超时，请检查连接后重试')), 30_000)
    try {
      const headers = new Headers(init.headers)
      const roomId = this.getRoomId()
      if (roomId) headers.set('x-collaboration-room', roomId)
      const protectedRoute = path === '/api/agent/runs' || path.startsWith('/api/agent/runs/') || path.startsWith('/api/agent/canvases/')
      if (protectedRoute && !roomId) await this.localSession.gateway.ensureLocalAdminSession()
      const generation = this.localSession.generation
      for (let attempt = 0; attempt < 2; attempt++) {
        if (controller.signal.aborted) throw controller.signal.reason
        if (this.getRoomId() !== roomId) throw new AgentRuntimeError(409, 'scope_changed', '协作身份已改变，请在当前画布重试')
        const response = await this.fetchImpl(path, { ...init, headers, credentials: 'same-origin', signal: controller.signal })
        const data = await response.json().catch(() => undefined)
        if (!response.ok) {
          if (attempt === 0 && protectedRoute && !roomId && response.status === 403 && data?.error?.code === 'local_admin_unauthorized') {
            if (this.getRoomId() !== roomId) throw new AgentRuntimeError(409, 'scope_changed', '协作身份已改变，请在当前画布重试')
            await this.recoverLocalSession(generation)
            continue
          }
          throw new AgentRuntimeError(response.status, data?.error?.code ?? 'request_failed', data?.error?.message ?? `Agent 请求失败 (${response.status})`)
        }
        if (!data || typeof data !== 'object') invalid()
        return data as T
      }
      return invalid()
    } catch (error) {
      if (error instanceof GatewayClientError) throw new AgentRuntimeError(error.status, error.code, error.message)
      throw error
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
  }
  private async mutate(path: string, body: unknown): Promise<AgentRun> {
    const data = await this.request<{ run: AgentRun }>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!isRun(data.run)) invalid()
    return data.run
  }
  async status(signal?: AbortSignal): Promise<AgentStatus> { return this.request('/api/agent/status', {}, signal) }
  async listSkills(signal?: AbortSignal): Promise<AgentSkillInfo[]> {
    const data = await this.request<{ skills: AgentSkillInfo[] }>('/api/agent/skills', {}, signal)
    if (!Array.isArray(data.skills) || data.skills.some(skill => typeof skill.id !== 'string' || typeof skill.name !== 'string' || typeof skill.description !== 'string')) invalid()
    return data.skills
  }
  async listRuns(canvasId: string, signal?: AbortSignal): Promise<AgentRun[]> {
    scope(canvasId)
    const data = await this.request<{ runs: AgentRun[] }>(`/api/agent/canvases/${encodeURIComponent(canvasId)}/runs`, {}, signal)
    if (!Array.isArray(data.runs) || !data.runs.every(isRun)) invalid()
    return data.runs.filter(run => run.canvasId === canvasId)
  }
  async getRun(runId: string, signal?: AbortSignal): Promise<AgentRun> {
    const data = await this.request<{ run: AgentRun }>(`/api/agent/runs/${encodeURIComponent(runId)}`, {}, signal)
    if (!isRun(data.run)) invalid()
    return data.run
  }
  async canvasRevision(canvasId: string): Promise<{ expectedRevision: number }> {
    scope(canvasId)
    const data = await this.request<{ revision: number }>(`/api/canvases/${encodeURIComponent(canvasId)}`)
    if (!Number.isSafeInteger(data.revision) || data.revision < 0) invalid()
    return { expectedRevision: data.revision }
  }
  async createRun(input: AgentCreateRunInput): Promise<AgentRun> { scope(input.canvasId); return this.mutate('/api/agent/runs', input) }
  controlRun(runId: string, input: AgentControlInput): Promise<AgentRun> { return this.mutate(`/api/agent/runs/${encodeURIComponent(runId)}/control`, input) }
  answerRun(runId: string, input: AgentAnswerInput): Promise<AgentRun> { return this.mutate(`/api/agent/runs/${encodeURIComponent(runId)}/answer`, input) }
  async legacyHistory(canvasId?: string, signal?: AbortSignal): Promise<Array<{ id: string; role: string; content: string }>> {
    let messages: unknown
    if (canvasId) {
      try { messages = (await this.request<{ messages: unknown }>(`/api/canvases/${encodeURIComponent(canvasId)}/agent-chat`, {}, signal)).messages } catch { /* read-only fallback */ }
    }
    if (!Array.isArray(messages)) {
      try { messages = JSON.parse(localStorage.getItem(`continuum_agent_chat_${canvasId || 'default'}`) ?? '[]') } catch { messages = [] }
    }
    return Array.isArray(messages) ? messages.filter(message => message && typeof message.id === 'string' && typeof message.content === 'string').map(({ id, role, content }) => ({ id, role, content })) : []
  }
}

/** Only monotonically newer persisted snapshots can replace a rendered run. */
export function mergeAgentRuns(previous: AgentRun[], incoming: AgentRun[], canvasId: string): AgentRun[] {
  const byId = new Map(previous.filter(run => run.canvasId === canvasId).map(run => [run.id, run]))
  let changed = byId.size !== previous.length
  for (const run of incoming) {
    if (run.canvasId !== canvasId || (byId.get(run.id)?.sequence ?? -1) >= run.sequence) continue
    const sequences = new Set<number>()
    const events = run.events.filter(event => { if (sequences.has(event.sequence)) return false; sequences.add(event.sequence); return true }).sort((a, b) => a.sequence - b.sequence)
    byId.set(run.id, { ...run, events }); changed = true
  }
  return changed ? [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) : previous
}
export interface AgentImageSource { nodeId: string; name: string; url: string; assetId?: string; width?: number; height?: number }
interface AssetGateway {
  importAsset(url: string, filename?: string, options?: { signal?: AbortSignal }): Promise<{ id: string; url: string }>
  uploadAsset(body: Blob, filename: string, options?: { signal?: AbortSignal }): Promise<{ id: string; url: string }>
}
/** Called only by an explicit reference click. Freezes the bytes behind temporary/remote URLs. */
export async function prepareAgentAttachment(source: AgentImageSource, gateway: AssetGateway = gatewayClient, signal?: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<AgentAttachment> {
  const local = source.url.match(/^\/api\/assets\/([0-9a-f-]{36})(?:\?.*)?$/i)
  let asset: { id: string; url: string }
  if (local) asset = { id: local[1], url: `/api/assets/${local[1]}` }
  else if (/^https?:\/\//i.test(source.url)) asset = await gateway.importAsset(source.url, source.name, { signal })
  else if (/^(blob:|data:image\/|\/(?!\/))/.test(source.url)) {
    const response = await fetchImpl(source.url, { signal })
    if (!response.ok) throw new Error('无法读取引用图片，请重新选择')
    const blob = await response.blob()
    if (!blob.type.startsWith('image/') || blob.size > 20 * 1024 * 1024) throw new Error('引用需为不超过 20 MB 的图片')
    asset = await gateway.uploadAsset(blob, source.name, { signal })
  } else throw new Error('不支持此图片来源，请先导入画布')
  return { id: createBrowserUuid(), nodeId: source.nodeId, name: source.name, assetId: asset.id, mediaType: 'image', url: asset.url, width: source.width, height: source.height }
}
