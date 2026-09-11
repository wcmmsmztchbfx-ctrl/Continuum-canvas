import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

import type {
  DirectorArtifact,
  DirectorLaunchSettings,
  DirectorRun,
  WorkflowCandidate,
  WorkflowRun,
} from '../src/contracts/agent-api.ts'
import type { CanvasEdge, CanvasNode, DirectorMessage, QuestionnairePayload } from '../src/model/project.ts'
import { atomicWriteJson } from './atomic-json.ts'
import type { AssetStore } from './asset-store.ts'
import type { CanvasDocumentService } from './canvas-document-service.ts'
import type { GatewayRuntime } from './runtime.ts'

interface WorkflowState {
  version: 1
  workflows: WorkflowRun[]
}

interface DirectorPayload {
  reply?: string
  videoUrl?: string
  videoUrls?: string[]
  imageUrl?: string
  imageUrls?: string[]
  aspectRatio?: string
  width?: number
  height?: number
  threadId?: string
  runId?: string
  threadUrl?: string
  thinking?: string
  executionSteps?: DirectorRun['executionSteps']
  pending?: boolean
}

interface DirectorAdapter {
  chat(
    message: string,
    threadId?: string,
    signal?: AbortSignal,
    assetIds?: string[],
    preferences?: DirectorLaunchSettings,
  ): Promise<DirectorPayload>
  checkRunStatus(
    threadId: string,
    runId: string,
    preferenceMode?: 'image' | 'video',
    signal?: AbortSignal,
  ): Promise<DirectorPayload>
  uploadAsset(bytes: Uint8Array, filename: string, contentType: string, signal?: AbortSignal): Promise<string>
}

function isDirectorAdapter(value: unknown): value is DirectorAdapter {
  return isRecord(value) && typeof value.chat === 'function' &&
    typeof value.checkRunStatus === 'function' && typeof value.uploadAsset === 'function'
}

export class WorkflowInputError extends Error {
  readonly code = 'invalid_workflow_input'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function questionnaireFromText(text: string | undefined): QuestionnairePayload | undefined {
  if (!text || !text.includes('questionnaire_id')) return undefined
  const starts: number[] = []
  for (let index = text.indexOf('{'); index >= 0; index = text.indexOf('{', index + 1)) starts.push(index)
  for (const start of starts) {
    let depth = 0
    let quoted = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]
      if (escaped) { escaped = false; continue }
      if (char === '\\' && quoted) { escaped = true; continue }
      if (char === '"') { quoted = !quoted; continue }
      if (quoted) continue
      if (char === '{') depth += 1
      if (char === '}') depth -= 1
      if (depth !== 0) continue
      try {
        const parsed = JSON.parse(text.slice(start, index + 1))
        if (isRecord(parsed) && typeof parsed.questionnaire_id === 'string' && Array.isArray(parsed.questions)) {
          return parsed as unknown as QuestionnairePayload
        }
      } catch {}
      break
    }
  }
  return undefined
}

function uniqueOutputs(payload: DirectorPayload) {
  const images = [...new Set([...(payload.imageUrls ?? []), ...(payload.imageUrl ? [payload.imageUrl] : [])])]
  const videos = [...new Set([...(payload.videoUrls ?? []), ...(payload.videoUrl ? [payload.videoUrl] : [])])]
  return { images, videos }
}

function artifactSourceKey(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
  }
}

function scriptIsComplete(text: string): boolean {
  return text.includes('简版导演手册') &&
    text.includes('人物与场景') &&
    text.includes('钩子过程') &&
    text.includes('转入口播') &&
    text.includes('主体与收尾') &&
    text.includes('场景动作与台词时间轴') &&
    /00:00\.00/.test(text) &&
    /\d{2}:\d{2}\.\d{2}\s*[–—-]\s*\d{2}:\d{2}\.\d{2}/.test(text)
}

function terminal(run: DirectorRun): boolean {
  return run.status === 'complete' || run.status === 'failed'
}

export class WorkflowService {
  readonly #filePath: string
  readonly #documents: CanvasDocumentService
  readonly #assets: AssetStore
  readonly #adapterFor: GatewayRuntime['adapterFor']
  readonly #events = new EventEmitter()
  readonly #controllers = new Map<string, AbortController>()
  #state: WorkflowState = { version: 1, workflows: [] }
  #saveQueue: Promise<unknown> = Promise.resolve()

  private constructor(options: {
    dataDir: string
    documents: CanvasDocumentService
    assets: AssetStore
    adapterFor: GatewayRuntime['adapterFor']
  }) {
    this.#filePath = join(options.dataDir, 'agent-workflows.json')
    this.#documents = options.documents
    this.#assets = options.assets
    this.#adapterFor = options.adapterFor
    this.#events.setMaxListeners(100)
  }

  static async open(options: {
    dataDir: string
    documents: CanvasDocumentService
    assets: AssetStore
    adapterFor: GatewayRuntime['adapterFor']
  }): Promise<WorkflowService> {
    const service = new WorkflowService(options)
    try {
      const parsed = JSON.parse(await readFile(service.#filePath, 'utf8')) as WorkflowState
      if (parsed?.version === 1 && Array.isArray(parsed.workflows)) service.#state = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await service.#repairLegacyArtifactDuplicates()
    queueMicrotask(() => service.resume())
    return service
  }

  list(canvasId?: string): WorkflowRun[] {
    return structuredClone(canvasId ? this.#state.workflows.filter((item) => item.canvasId === canvasId) : this.#state.workflows)
  }

  get(id: string): WorkflowRun | undefined {
    const workflow = this.#state.workflows.find((item) => item.id === id)
    return workflow ? structuredClone(workflow) : undefined
  }

  async create(input: {
    canvasId: string
    projectId: string
    candidates: WorkflowCandidate[]
    referenceNodeIds?: string[]
    skillNodeIds?: string[]
    settings: DirectorLaunchSettings
  }): Promise<WorkflowRun> {
    const document = await this.#documents.get(input.canvasId)
    if (!document || document.snapshot.projectId !== input.projectId) throw new WorkflowInputError('Canvas scope was not found')
    if (!Array.isArray(input.candidates) || input.candidates.length === 0) throw new WorkflowInputError('At least one script candidate is required')
    const uniqueIds = new Set(input.candidates.map((item) => item.nodeId))
    if (uniqueIds.size !== input.candidates.length) throw new WorkflowInputError('Script candidate IDs must be unique')
    for (const candidate of input.candidates) {
      const node = document.snapshot.nodes.find((item) => item.id === candidate.nodeId)
      if (!node || node.type !== 'text' || !scriptIsComplete(node.data.text)) {
        throw new WorkflowInputError(`Script candidate is missing the complete director manual or timeline: ${candidate.nodeId}`)
      }
    }
    for (const nodeId of [...(input.referenceNodeIds ?? []), ...(input.skillNodeIds ?? [])]) {
      if (!document.snapshot.nodes.some((node) => node.id === nodeId)) throw new WorkflowInputError(`Referenced node was not found: ${nodeId}`)
    }
    const now = new Date().toISOString()
    const workflow: WorkflowRun = {
      id: randomUUID(), canvasId: input.canvasId, projectId: input.projectId,
      status: 'awaiting_approval', candidates: structuredClone(input.candidates), approvedNodeIds: [],
      referenceNodeIds: [...new Set(input.referenceNodeIds ?? [])], skillNodeIds: [...new Set(input.skillNodeIds ?? [])],
      settings: structuredClone(input.settings), directorRuns: [], createdAt: now, updatedAt: now,
    }
    this.#state.workflows.push(workflow)
    await this.#saveAndPublish(workflow)
    return structuredClone(workflow)
  }

  async approve(id: string, approvedNodeIds: string[]): Promise<WorkflowRun> {
    const workflow = this.#require(id)
    if (workflow.status !== 'awaiting_approval') {
      if (JSON.stringify(workflow.approvedNodeIds) === JSON.stringify(approvedNodeIds)) return structuredClone(workflow)
      throw new WorkflowInputError('Workflow has already been approved')
    }
    const candidates = new Set(workflow.candidates.map((item) => item.nodeId))
    const approved = [...new Set(approvedNodeIds)]
    if (approved.length === 0 || approved.some((nodeId) => !candidates.has(nodeId))) throw new WorkflowInputError('Approved scripts are invalid')
    const now = new Date().toISOString()
    workflow.approvedNodeIds = approved
    workflow.status = 'running'
    workflow.updatedAt = now
    workflow.directorRuns = approved.map((candidateNodeId) => ({
      id: randomUUID(), workflowId: workflow.id, canvasId: workflow.canvasId, projectId: workflow.projectId,
      candidateNodeId, status: 'queued', settings: structuredClone(workflow.settings),
      referenceNodeIds: [...workflow.referenceNodeIds], skillNodeIds: [...workflow.skillNodeIds],
      artifacts: [], attempt: 1, createdAt: now, updatedAt: now,
    }))
    await this.#saveAndPublish(workflow)
    this.#dispatch(workflow)
    return structuredClone(workflow)
  }

  async answer(runId: string, answer: { optionId?: string; value: string }): Promise<DirectorRun> {
    const { workflow, run } = this.#findRun(runId)
    if (run.status !== 'awaiting_input' || !run.threadId) throw new WorkflowInputError('Director run is not waiting for input')
    run.status = 'running'
    run.questionnaire = undefined
    run.updatedAt = new Date().toISOString()
    this.#refreshWorkflowStatus(workflow)
    await this.#saveAndPublish(workflow, run)
    this.#run(workflow, run, answer.value).catch(() => undefined)
    return structuredClone(run)
  }

  async retry(runId: string): Promise<DirectorRun> {
    const { workflow, run } = this.#findRun(runId)
    if (run.status !== 'failed' && !(run.status === 'complete' && run.artifacts.length === 0)) {
      throw new WorkflowInputError('Only failed or empty completed director runs can be retried')
    }
    run.status = 'queued'
    run.error = undefined
    run.threadId = undefined
    run.runId = undefined
    run.threadUrl = undefined
    run.reply = undefined
    run.thinking = undefined
    run.executionSteps = undefined
    run.questionnaire = undefined
    run.attempt += 1
    run.updatedAt = new Date().toISOString()
    this.#refreshWorkflowStatus(workflow)
    await this.#saveAndPublish(workflow, run)
    this.#run(workflow, run).catch(() => undefined)
    return structuredClone(run)
  }

  wait(id: string, afterUpdatedAt: string | undefined, timeoutMs: number): Promise<WorkflowRun> {
    const current = this.#require(id)
    if (!afterUpdatedAt || current.updatedAt !== afterUpdatedAt || current.status === 'complete' || current.status === 'failed' || current.status === 'partial_failure' || current.status === 'awaiting_input') {
      return Promise.resolve(structuredClone(current))
    }
    return new Promise((resolve) => {
      const listener = (workflow: WorkflowRun) => {
        if (workflow.id !== id || workflow.updatedAt === afterUpdatedAt) return
        cleanup()
        resolve(structuredClone(workflow))
      }
      const timer = setTimeout(() => { cleanup(); resolve(this.get(id)!) }, Math.max(0, Math.min(timeoutMs, 60_000)))
      const cleanup = () => { clearTimeout(timer); this.#events.off('workflow', listener) }
      this.#events.on('workflow', listener)
    })
  }

  subscribe(listener: (event: { type: 'workflow.updated' | 'director.updated'; workflow?: WorkflowRun; run?: DirectorRun }) => void): () => void {
    const onWorkflow = (workflow: WorkflowRun) => listener({ type: 'workflow.updated', workflow: structuredClone(workflow) })
    const onDirector = (run: DirectorRun) => listener({ type: 'director.updated', run: structuredClone(run) })
    this.#events.on('workflow', onWorkflow)
    this.#events.on('director', onDirector)
    return () => {
      this.#events.off('workflow', onWorkflow)
      this.#events.off('director', onDirector)
    }
  }

  close(): void {
    for (const controller of this.#controllers.values()) controller.abort()
    this.#controllers.clear()
  }

  private resume(): void {
    for (const workflow of this.#state.workflows) {
      if (workflow.status !== 'running') continue
      for (const run of workflow.directorRuns.filter((item) => item.status === 'running').slice(0, 3)) {
        this.#run(workflow, run).catch(() => undefined)
      }
      this.#dispatch(workflow)
    }
  }

  #dispatch(workflow: WorkflowRun): void {
    const active = workflow.directorRuns.filter((run) => run.status === 'running').length
    const available = Math.max(0, 3 - active)
    for (const run of workflow.directorRuns.filter((item) => item.status === 'queued').slice(0, available)) {
      this.#run(workflow, run).catch(() => undefined)
    }
  }

  async #run(workflow: WorkflowRun, run: DirectorRun, answer?: string): Promise<void> {
    if (this.#controllers.has(run.id)) return
    const controller = new AbortController()
    this.#controllers.set(run.id, controller)
    try {
      run.status = 'running'
      run.updatedAt = new Date().toISOString()
      await this.#ensureDirectorNode(workflow, run)
      await this.#saveAndPublish(workflow, run)
      const adapter = this.#adapterFor(run.settings.providerId ?? 'xiaoyunque')
      if (!isDirectorAdapter(adapter)) throw new Error('The selected provider does not support Director Agent runs')
      const document = await this.#documents.get(run.canvasId)
      if (!document) throw new Error('Canvas not found')
      const candidate = document.snapshot.nodes.find((node) => node.id === run.candidateNodeId)
      if (!candidate || candidate.type !== 'text') throw new Error('Script candidate no longer exists')
      const skills = run.skillNodeIds.flatMap((id) => {
        const node = document.snapshot.nodes.find((item) => item.id === id)
        return node?.type === 'text' ? [`### 技能规范【${node.name}】：\n${node.data.text}`] : []
      }).join('\n\n')
      const prompt = answer ?? [
        candidate.data.text,
        skills ? `【已注入导演技能规范与流程要求】：\n${skills}` : '',
        '【执行指令】请立即按照以上完整文案、全部参考素材和技能规范开始实际制作。不要只回复“已确认需求”或“准备创作”；需要用户选择时返回明确选项，否则持续执行到产生并交付实际图片或视频产物。',
      ].filter(Boolean).join('\n\n')
      await this.#appendDirectorMessage(run, {
        id: randomUUID(), role: 'user', content: prompt, timestamp: Date.now(),
      })
      const assetIds = await this.#uploadReferences(adapter, document.snapshot.nodes, run.referenceNodeIds, controller.signal)
      let payload: DirectorPayload
      if (answer) {
        payload = await adapter.chat(prompt, run.threadId, controller.signal, assetIds, run.settings)
      } else if (run.threadId && run.runId) {
        payload = await adapter.checkRunStatus(run.threadId, run.runId, run.settings.preferenceMode, controller.signal)
      } else {
        payload = await adapter.chat(prompt, undefined, controller.signal, assetIds, run.settings)
      }
      await this.#consumePayload(workflow, run, payload, controller.signal)
      const deadline = Date.now() + 30 * 60_000
      while (payload.pending && run.threadId && run.runId && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_500))
        payload = await adapter.checkRunStatus(run.threadId, run.runId, run.settings.preferenceMode, controller.signal)
        await this.#consumePayload(workflow, run, payload, controller.signal)
      }
      if (payload.pending) throw new Error('Director run exceeded the 30 minute synchronization window')
      if ((run as DirectorRun).status !== 'awaiting_input') {
        if (run.artifacts.length === 0) throw new Error('Director run ended without delivering any image or video artifacts')
        run.status = 'complete'
      }
    } catch (error) {
      if (controller.signal.aborted) return
      run.status = 'failed'
      run.error = error instanceof Error ? error.message : 'Director run failed'
      await this.#appendDirectorMessage(run, {
        id: randomUUID(), role: 'assistant', content: `导演任务失败：${run.error}`, error: true, timestamp: Date.now(),
      }).catch(() => undefined)
    } finally {
      this.#controllers.delete(run.id)
      run.updatedAt = new Date().toISOString()
      this.#refreshWorkflowStatus(workflow)
      await this.#saveAndPublish(workflow, run).catch(() => undefined)
      this.#dispatch(workflow)
    }
  }

  async #consumePayload(workflow: WorkflowRun, run: DirectorRun, payload: DirectorPayload, signal: AbortSignal) {
    run.threadId = payload.threadId ?? run.threadId
    run.runId = payload.runId ?? run.runId
    run.threadUrl = payload.threadUrl ?? run.threadUrl
    run.reply = payload.reply ?? run.reply
    run.thinking = payload.thinking ?? run.thinking
    run.executionSteps = payload.executionSteps ?? run.executionSteps
    const questionnaire = questionnaireFromText(payload.reply)
    if (questionnaire) {
      run.questionnaire = questionnaire
      run.status = 'awaiting_input'
    }
    const deliveredNodeIds: string[] = []
    const outputs = uniqueOutputs(payload)
    for (const [kind, urls] of [['image', outputs.images], ['video', outputs.videos]] as const) {
      const unkeyed = run.artifacts.filter((artifact) => artifact.kind === kind && !artifact.sourceKey)
      for (const [index, url] of urls.entries()) {
        const sourceKey = artifactSourceKey(url)
        if (run.artifacts.some((artifact) => artifact.url === url || artifact.sourceKey === sourceKey)) continue
        // Artifacts written before sourceKey existed can safely adopt keys when
        // the upstream output cardinality still matches the persisted result.
        if (unkeyed.length === urls.length && unkeyed[index]) {
          unkeyed[index].sourceKey = sourceKey
          continue
        }
        const artifact = await this.#deliverArtifact(workflow, run, kind, url, sourceKey, payload, signal)
        run.artifacts.push(artifact)
        if (artifact.nodeId) deliveredNodeIds.push(artifact.nodeId)
      }
    }
    const message: DirectorMessage = {
      id: randomUUID(), role: 'assistant', content: payload.reply ?? '导演任务正在执行…',
      thinking: payload.thinking, executionSteps: payload.executionSteps, timestamp: Date.now(),
      assetIds: deliveredNodeIds.length ? deliveredNodeIds : undefined, threadUrl: run.threadUrl,
      questionnaire,
    }
    await this.#appendDirectorMessage(run, message)
    run.updatedAt = new Date().toISOString()
    this.#refreshWorkflowStatus(workflow)
    await this.#saveAndPublish(workflow, run)
  }

  async #ensureDirectorNode(workflow: WorkflowRun, run: DirectorRun) {
    if (run.directorNodeId) return
    const document = await this.#documents.get(workflow.canvasId)
    if (!document) throw new Error('Canvas not found')
    const script = document.snapshot.nodes.find((node) => node.id === run.candidateNodeId)
    if (!script) throw new Error('Script node was not found')
    const directorId = randomUUID()
    await this.#documents.mutate({ canvasId: workflow.canvasId, origin: `workflow:${workflow.id}`, mutation: (snapshot) => {
      const director: CanvasNode = {
        id: directorId, type: 'group', name: `导演台｜${script.name}`,
        position: { x: script.position.x + script.size.width + 140, y: script.position.y }, size: { width: 540, height: 700 },
        data: { childIds: [], nodeKind: 'director', promptDraft: '', messages: [], assets: [] },
      }
      snapshot.nodes.push(director)
      const edges: CanvasEdge[] = [
        { id: randomUUID(), source: script.id, target: directorId, sourceHandle: 'source', targetHandle: 'target', relation: 'flow' },
        ...workflow.referenceNodeIds.map((source, index) => ({ id: randomUUID(), source, target: directorId, sourceHandle: 'source', targetHandle: 'target', relation: 'reference' as const, referenceAlias: index + 1 })),
        ...workflow.skillNodeIds.map((source) => ({ id: randomUUID(), source, target: directorId, sourceHandle: 'source', targetHandle: 'target', relation: 'skill' as const })),
      ]
      snapshot.edges.push(...edges)
      return { snapshot, result: undefined }
    } })
    run.directorNodeId = directorId
  }

  async #appendDirectorMessage(run: DirectorRun, message: DirectorMessage) {
    if (!run.directorNodeId) return
    await this.#documents.mutate({ canvasId: run.canvasId, origin: `director:${run.id}`, mutation: (snapshot) => {
      const node = snapshot.nodes.find((item) => item.id === run.directorNodeId)
      if (!node || node.type !== 'group' || node.data.nodeKind !== 'director') throw new Error('Director node not found')
      const previous = node.data.messages ?? []
      const signature = JSON.stringify([message.content, message.thinking, message.executionSteps, message.questionnaire, message.assetIds])
      const exists = previous.some((item) => JSON.stringify([item.content, item.thinking, item.executionSteps, item.questionnaire, item.assetIds]) === signature)
      if (!exists) node.data.messages = [...previous, message]
      node.data.threadId = run.threadId
      node.data.threadUrl = run.threadUrl
      return { snapshot, result: undefined }
    } })
  }

  async #uploadReferences(adapter: DirectorAdapter, nodes: CanvasNode[], nodeIds: string[], signal: AbortSignal) {
    const results: string[] = []
    for (const nodeId of nodeIds) {
      const node = nodes.find((item) => item.id === nodeId)
      const url = node?.type === 'image' ? node.data.url : node?.type === 'video' ? (node.data.poster || node.data.url) : undefined
      const match = url?.match(/(?:^|\/)api\/assets\/([^/?#]+)/i)
      if (!match) continue
      const asset = this.#assets.get(decodeURIComponent(match[1]!))
      if (!asset) continue
      const bytes = await this.#assets.readBytes(asset.id)
      results.push(await adapter.uploadAsset(bytes, asset.filename, asset.contentType, signal))
    }
    return results
  }

  async #deliverArtifact(workflow: WorkflowRun, run: DirectorRun, kind: 'image' | 'video', remoteUrl: string, sourceKey: string, payload: DirectorPayload, signal: AbortSignal): Promise<DirectorArtifact> {
    let url = remoteUrl
    let assetId: string | undefined
    try {
      const suffix = extname(new URL(remoteUrl).pathname) || (kind === 'video' ? '.mp4' : '.png')
      const asset = await this.#assets.importRemote(remoteUrl, `director-${run.id}-${run.artifacts.length + 1}${suffix}`, signal)
      url = `/api/assets/${asset.id}`
      assetId = asset.id
    } catch {}
    const nodeId = randomUUID()
    await this.#documents.mutate({ canvasId: workflow.canvasId, origin: `director:${run.id}`, mutation: (snapshot) => {
      const director = snapshot.nodes.find((node) => node.id === run.directorNodeId)
      const position = director ? { x: director.position.x + director.size.width + 120 + (run.artifacts.length % 3) * 420, y: director.position.y + Math.floor(run.artifacts.length / 3) * 620 } : { x: 0, y: 0 }
      const node: CanvasNode = kind === 'image'
        ? { id: nodeId, type: 'image', name: `交付图片 ${run.artifacts.length + 1}`, position, size: { width: 360, height: 540 }, data: { url, assetId, objectFit: 'contain', generation: { prompt: '', status: 'complete', progress: 100, outputAspectRatio: payload.aspectRatio }, versions: [{ id: randomUUID(), url, assetId, createdAt: new Date().toISOString(), label: '导演台生成' }] } }
        : { id: nodeId, type: 'video', name: `交付成片 ${run.artifacts.length + 1}`, position, size: { width: 360, height: 640 }, data: { url, assetId, objectFit: 'contain', generation: { prompt: '', status: 'complete', progress: 100, outputAspectRatio: payload.aspectRatio } } }
      snapshot.nodes.push(node)
      if (run.directorNodeId) snapshot.edges.push({ id: randomUUID(), source: run.directorNodeId, target: nodeId, sourceHandle: 'source', targetHandle: 'target', relation: 'flow' })
      return { snapshot, result: undefined }
    } })
    return { id: randomUUID(), kind, url, sourceKey, nodeId, createdAt: new Date().toISOString() }
  }

  async #repairLegacyArtifactDuplicates(): Promise<void> {
    let changed = false
    for (const workflow of this.#state.workflows) {
      const duplicateNodeIds = new Set<string>()
      for (const run of workflow.directorRuns) {
        const seen = new Set<string>()
        const retained: DirectorArtifact[] = []
        for (const artifact of run.artifacts) {
          const match = artifact.url.match(/(?:^|\/)api\/assets\/([^/?#]+)/i)
          if (!match) {
            retained.push(artifact)
            continue
          }
          try {
            const bytes = await this.#assets.readBytes(decodeURIComponent(match[1]!))
            const key = `${artifact.kind}:${createHash('sha256').update(bytes).digest('hex')}`
            if (seen.has(key)) {
              if (artifact.nodeId) duplicateNodeIds.add(artifact.nodeId)
              changed = true
              continue
            }
            seen.add(key)
          } catch {}
          retained.push(artifact)
        }
        run.artifacts = retained
      }
      if (duplicateNodeIds.size > 0) {
        await this.#documents.mutate({
          canvasId: workflow.canvasId,
          origin: `workflow-repair:${workflow.id}`,
          mutation: (snapshot) => {
            snapshot.nodes = snapshot.nodes.filter((node) => !duplicateNodeIds.has(node.id))
            snapshot.edges = snapshot.edges.filter((edge) => !duplicateNodeIds.has(edge.source) && !duplicateNodeIds.has(edge.target))
            return { snapshot, result: undefined }
          },
        })
      }
    }
    if (changed) await atomicWriteJson(this.#filePath, this.#state)
  }

  #refreshWorkflowStatus(workflow: WorkflowRun) {
    if (workflow.directorRuns.some((run) => run.status === 'awaiting_input')) workflow.status = 'awaiting_input'
    else if (workflow.directorRuns.length > 0 && workflow.directorRuns.every(terminal)) {
      const failures = workflow.directorRuns.filter((run) => run.status === 'failed').length
      workflow.status = failures === 0 ? 'complete' : failures === workflow.directorRuns.length ? 'failed' : 'partial_failure'
    } else if (workflow.approvedNodeIds.length > 0) workflow.status = 'running'
    workflow.updatedAt = new Date().toISOString()
  }

  #require(id: string): WorkflowRun {
    const workflow = this.#state.workflows.find((item) => item.id === id)
    if (!workflow) throw new WorkflowInputError('Workflow was not found')
    return workflow
  }

  #findRun(id: string): { workflow: WorkflowRun; run: DirectorRun } {
    for (const workflow of this.#state.workflows) {
      const run = workflow.directorRuns.find((item) => item.id === id)
      if (run) return { workflow, run }
    }
    throw new WorkflowInputError('Director run was not found')
  }

  async #saveAndPublish(workflow: WorkflowRun, run?: DirectorRun) {
    this.#saveQueue = this.#saveQueue.catch(() => undefined).then(async () => {
      await mkdir(join(this.#filePath, '..'), { recursive: true })
      await atomicWriteJson(this.#filePath, this.#state)
    })
    await this.#saveQueue
    this.#events.emit('workflow', structuredClone(workflow))
    if (run) this.#events.emit('director', structuredClone(run))
  }
}
