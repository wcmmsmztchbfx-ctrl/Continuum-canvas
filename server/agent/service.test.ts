import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createGatewayRuntime, type GatewayRuntime } from '../runtime.ts'
import { defaultInitialCanvas } from '../canvas-storage.ts'
import type { AgentModel, ModelTurn } from './model.ts'
import type { GenerationRequest, ProviderCatalog } from '../../src/contracts/generation.ts'
import type { ProviderAdapter } from '../providers/provider-adapter.ts'
import { WorkspaceConflictError } from '../workspace-commit.ts'
import { validateToolArguments } from './tools.ts'
import { changesBetween } from './canvas.ts'
import { parseCanvasSnapshot } from '../../src/model/project.ts'

const open: GatewayRuntime[] = []
afterEach(async () => { await Promise.all(open.splice(0).map(r => r.close())) })
const call = (name: string, args: Record<string, unknown>, id = name): ModelTurn => ({ calls: [{ id, name, arguments: args }] })
async function fixture(turns: ModelTurn[], options: Parameters<typeof createGatewayRuntime>[0] = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'continuum-agent-'))
  const model = vi.fn<AgentModel>(async () => turns.shift() ?? { text: '完成', calls: [] })
  const runtime = await createGatewayRuntime({ dataDir, envFile: join(dataDir, '.env'), env: {}, agentModel: model, ...options })
  open.push(runtime)
  await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'seed', kind: 'save-canvas', expectedRevision: 0,
    canvas: { ...defaultInitialCanvas('canvas-test', 'project-test', 'Test'), nodes: [], edges: [] } })
  const input = { requestId: 'request-one', canvasId: 'canvas-test', expectedRevision: 1, prompt: '创建苹果图片节点，只写提示词', attachments: [] }
  return { runtime, model, input, dataDir }
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const testCatalog: ProviderCatalog = { providerId: 'agent-test', version: 'test-v1', fetchedAt: new Date().toISOString(), stale: false,
  models: [{ mediaType: 'image', channel: 'images', model: 'test-image', qualityOptions: [{ value: 'standard', label: 'Standard', pricing: { type: 'per_item', credits: 1 } }], aspectRatios: ['1:1'], countOptions: [1], countRange: { min: 1, max: 1, options: [1] }, durationOptions: [], modes: ['text2image'], inputLimits: { images: 4, videos: 0, audios: 0 }, raw: {} }] }
async function generationFixture(adapter?: ProviderAdapter) {
  const base = await fixture([], adapter ? { adapterFactory: () => adapter } : {})
  const { runtime } = base
  await runtime.providers.upsert({ id: 'agent-test', name: 'Test', adapterType: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', enabled: true, preferred: true })
  await runtime.providers.setSecret('agent-test', 'test-only')
  await runtime.catalogs.sync('agent-test', async () => testCatalog)
  const model = vi.fn<AgentModel>(async ({ messages }) => {
    const results = messages.filter(m => m.role === 'tool').map(m => JSON.parse(String(m.content)))
    if (!results.length) return call('create_node', { type: 'image', name: '苹果', prompt: '一颗红苹果' })
    if (results.length === 1) return call('request_generation', { nodeId: results[0].nodeId })
    return { text: '已生成 1 张苹果图片', calls: [] }
  })
  runtime.agent.setModelForTesting(model)
  const submit = vi.fn(async (request: GenerationRequest, collaboration?: { roomId: string; targetNodeId: string }) => {
    const { job } = await runtime.jobs.create(request, collaboration)
    return runtime.jobs.update(job.id, { status: 'running', createAttemptedAt: new Date().toISOString() })
  })
  const realSubmit = runtime.submit.bind(runtime)
  runtime.submit = submit
  return { ...base, model, submit, realSubmit, input: { ...base.input, prompt: '生成一个苹果' }, complete: async (target = runtime) => {
    const asset = await target.assets.save({ filename: 'apple.png', contentType: 'image/png', bytes: png })
    const job = target.jobs.list().at(-1)!
    await target.jobs.update(job.id, { status: 'complete', progress: 100, outputs: [{ assetId: asset.id, url: asset.url, contentType: asset.contentType, size: asset.size }] })
    return asset
  } }
}
const adapterStub = (overrides: Partial<ProviderAdapter> = {}): ProviderAdapter => ({
  testConnection: async () => {}, syncCatalog: async () => testCatalog,
  presignReference: async () => ({ fileKey: 'ref-file', uploadUrl: 'https://example.invalid/upload', method: 'PUT', headers: {}, expiresAt: Date.now() + 60_000 }),
  uploadReference: async () => {}, completeReference: async () => ({ url: 'https://example.invalid/reference.png' }),
  createGeneration: async () => 'upstream-test', getGenerationStatus: async () => [], getGenerationDetail: async () => ({ taskId: 'upstream-test', status: 1 }), ...overrides,
})
describe('durable canvas agent', () => {
  it('feeds actual tool results and base skill into every round and deduplicates create requests', async () => {
    const { runtime, model, input } = await fixture([call('create_node', { type: 'image', name: '苹果', prompt: '红苹果' }), { text: '节点已创建', calls: [] }])
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    expect((await runtime.agent.create(input, { kind: 'local-admin' })).id).toBe(run.id)
    const snapshot = JSON.parse((await runtime.workspace.getCanvasDocument(input.canvasId))!)
    expect(snapshot.nodes).toHaveLength(1)
    expect(model.mock.calls[1][0].messages.some(m => m.role === 'tool' && String(m.content).includes(snapshot.nodes[0].id))).toBe(true)
    expect(model.mock.calls.every(c => c[0].system.includes('canvas-base@1'))).toBe(true)
    expect(runtime.jobs.list()).toHaveLength(0)
  })
  it('persists clarification, rejects stale answers and resumes the same run', async () => {
    const { runtime, input } = await fixture([call('ask_user', { title: '哪种苹果？', options: ['水果', '产品'] }), call('create_node', { type: 'text', name: '确认', text: '水果' })])
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('waiting_user'))
    await expect(runtime.agent.answer(run.id, { requestId: 'bad', questionId: 'stale', answer: '水果' })).rejects.toMatchObject({ code: 'stale_question' })
    const questionId = runtime.agent.get(run.id).question!.id
    await runtime.agent.answer(run.id, { requestId: 'answer-one', questionId, answer: '水果' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    expect(runtime.agent.get(run.id).events.some(e => e.type === 'question')).toBe(true)
  })
  it('stops a pending model turn before it can write, including after restart', async () => {
    const { runtime, input, dataDir } = await fixture([])
    let release!: (value: ModelTurn) => void
    const model = vi.fn<AgentModel>(() => new Promise(resolve => { release = resolve }))
    runtime.agent.setModelForTesting(model)
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(model).toHaveBeenCalled())
    await runtime.agent.control(run.id, { requestId: 'stop', action: 'stop' })
    release(call('create_node', { type: 'image', name: 'Never' }))
    await runtime.agent.idle()
    expect(JSON.parse((await runtime.workspace.getCanvasDocument(input.canvasId))!).nodes).toHaveLength(0)
    await runtime.close(); open.splice(open.indexOf(runtime), 1)
    const restored = await createGatewayRuntime({ dataDir, envFile: join(dataDir, '.env'), env: {}, agentModel: model })
    open.push(restored)
    expect(restored.agent.get(run.id).status).toBe('stopped')
    expect(model).toHaveBeenCalledTimes(1)
  })
  it('undo removes only unchanged task objects and preserves later manual nodes', async () => {
    const { runtime, input } = await fixture([call('create_node', { type: 'text', name: 'Agent', text: 'x' })])
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    const record = (await runtime.workspace.getCanvasRecord(input.canvasId))!
    const snapshot = record.snapshot!
    await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'manual', kind: 'save-canvas', expectedRevision: record.revision,
      canvas: { ...snapshot, nodes: [...snapshot.nodes, { id: 'manual', type: 'text', name: 'Manual', position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, data: { text: 'keep' } }] } })
    await runtime.agent.control(run.id, { requestId: 'undo', action: 'undo' })
    expect(JSON.parse((await runtime.workspace.getCanvasDocument(input.canvasId))!).nodes.map((n: { id: string }) => n.id)).toEqual(['manual'])
  })
  it('generates an apple through the real persisted job/asset protocol and feeds its actual receipt to the model', async () => {
    const { runtime, input, complete, submit, model } = await generationFixture()
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await complete()
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    const current = runtime.agent.get(run.id)
    expect(current.outputs).toHaveLength(1)
    const canvas = JSON.parse((await runtime.workspace.getCanvasDocument(input.canvasId))!)
    expect(canvas.nodes[0].data.assetId).toBe(current.outputs[0].assetId)
    expect(canvas.nodes[0].data.generation.status).toBe('complete')
    expect(model.mock.calls.at(-1)![0].messages.some(m => m.role === 'tool' && String(m.content).includes('"applied":true'))).toBe(true)
    expect(current.events.map(e => e.sequence)).toEqual(current.events.map((_, index) => index + 1))
  })
  it.each(['stop', 'undo'] as const)('%s prevents a late paid result from writing while preserving its asset', async (action) => {
    const { runtime, input, complete, submit } = await generationFixture()
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await runtime.agent.control(run.id, { action, requestId: action })
    const before = await runtime.workspace.getCanvasDocument(input.canvasId)
    await complete()
    await vi.waitFor(() => expect(runtime.agent.get(run.id).outputs).toHaveLength(1))
    await runtime.agent.idle()
    expect(await runtime.workspace.getCanvasDocument(input.canvasId)).toBe(before)
    expect(runtime.agent.get(run.id).status).toBe('stopped')
  })
  it('pause permits already submitted output but no dependent model turn', async () => {
    const { runtime, input, complete, submit, model } = await generationFixture()
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await runtime.agent.control(run.id, { action: 'pause', requestId: 'pause' })
    const count = model.mock.calls.length
    await complete()
    await vi.waitFor(() => expect(runtime.agent.get(run.id).outputs).toHaveLength(1))
    await runtime.agent.idle()
    expect(model).toHaveBeenCalledTimes(count)
    expect(runtime.agent.get(run.id).status).toBe('paused')
    expect(JSON.parse((await runtime.workspace.getCanvasDocument(input.canvasId))!).nodes[0].data.generation.status).toBe('complete')
  })
  it('lost acceptance acknowledgement uses the existing stable request and never submits again', async () => {
    const { runtime, input, complete, submit } = await generationFixture()
    runtime.submit = vi.fn(async (request, collaboration) => { await submit(request, collaboration); throw new Error('connection lost after acceptance') })
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await runtime.agent.idle()
    expect(runtime.agent.get(run.id).status).toBe('waiting_generation')
    await complete()
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    expect(submit).toHaveBeenCalledTimes(1)
    expect(runtime.jobs.list()).toHaveLength(1)
  })
  it('stopped state survives restart and terminal replay cannot resurrect the target', async () => {
    const { runtime, input, complete, submit, dataDir } = await generationFixture()
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await runtime.agent.control(run.id, { action: 'undo', requestId: 'undo' })
    await complete(); await runtime.agent.idle()
    await runtime.close(); open.splice(open.indexOf(runtime), 1)
    const model = vi.fn<AgentModel>(async () => ({ calls: [] }))
    const restored = await createGatewayRuntime({ dataDir, envFile: join(dataDir, '.env'), env: {}, agentModel: model })
    open.push(restored)
    expect(restored.agent.get(run.id)).toMatchObject({ status: 'stopped', outputs: [{ assetId: expect.any(String) }] })
    expect(JSON.parse((await restored.workspace.getCanvasDocument(input.canvasId))!).nodes).toHaveLength(0)
    expect(model).not.toHaveBeenCalled()
  })
  it('late writeback preserves independent manual fields and rejects target replacement', async () => {
    const { runtime, input, complete, submit } = await generationFixture()
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    const record = (await runtime.workspace.getCanvasRecord(input.canvasId))!
    const snapshot = structuredClone(record.snapshot!)
    snapshot.nodes[0].name = 'User name'; snapshot.nodes[0].position.x = 900
    await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'manual-move', kind: 'save-canvas', expectedRevision: record.revision, canvas: snapshot })
    await complete(); await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    const actual = JSON.parse((await runtime.workspace.getCanvasDocument(input.canvasId))!).nodes[0]
    expect(actual.name).toBe('User name'); expect(actual.position.x).toBe(900); expect(actual.data.assetId).toBeTruthy()
    await runtime.agent.control(run.id, { action: 'undo', requestId: 'undo' })
    const after = JSON.parse((await runtime.workspace.getCanvasDocument(input.canvasId))!).nodes[0]
    expect(after.name).toBe('User name'); expect(after.position.x).toBe(900)
  })
  it('actual confirmed image previews reach the model and ghost selections do not', async () => {
    const { runtime, input, model } = await fixture([])
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#f00' } }).png().toBuffer()
    const asset = await runtime.assets.save({ filename: 'reference.png', contentType: 'image/png', bytes })
    const run = await runtime.agent.create({ ...input, selectedNodeIds: ['ghost'], attachments: [{ id: 'ref-one', nodeId: 'uploaded-image', name: 'Reference', assetId: asset.id, mediaType: 'image' }] }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    const serialized = JSON.stringify(model.mock.calls[0][0].messages)
    expect(serialized).toContain('data:image/webp;base64,'); expect(serialized).toContain('ref-one'); expect(serialized).not.toContain('ghost')
  })
  it('authority changes pause a local run without a stale write', async () => {
    const { runtime, input } = await fixture([])
    let release!: (turn: ModelTurn) => void
    const model = vi.fn<AgentModel>(() => new Promise(resolve => { release = resolve }))
    runtime.agent.setModelForTesting(model)
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(model).toHaveBeenCalled())
    const snapshot = (await runtime.workspace.getCanvasRecord(input.canvasId))!.snapshot!
    const owner = await runtime.collaboration.enableRoom({ projectId: snapshot.projectId, canvasId: snapshot.canvasId, snapshot, deviceId: 'owner-device', displayName: 'Owner' })
    release(call('create_node', { type: 'text', name: 'Must not write', text: 'x' }))
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('paused'))
    expect((await runtime.workspace.getCanvasRecord(input.canvasId))!.snapshot!.nodes).toHaveLength(0)
    const grant = runtime.collaboration.createAgentGrant(owner.room.roomId, owner.sessionToken)
    expect(() => runtime.agent.authorize(run.id, grant)).not.toThrow()
    let round = 0
    runtime.agent.setModelForTesting(async () => round++ ? { calls: [], text: '完成' } : call('create_node', { type: 'text', name: 'Rebound', text: 'x' }))
    await runtime.agent.control(run.id, { action: 'resume', requestId: 'resume-new-authority' }, grant)
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    expect(runtime.collaboration.exportSnapshot(owner.room.roomId).nodes[0].name).toBe('Rebound')
  })
  it('an undo conflict remains retryable and never reports a completed undo before its receipt', async () => {
    const { runtime, input } = await fixture([call('create_node', { type: 'text', name: 'Undo', text: 'x' })])
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    const write = vi.spyOn(runtime.workspace, 'applyWorkspaceMutation').mockRejectedValueOnce(new WorkspaceConflictError())
    await expect(runtime.agent.control(run.id, { action: 'undo', requestId: 'undo-retry' })).rejects.toMatchObject({ code: 'canvas_conflict' })
    expect(runtime.agent.get(run.id).canUndo).toBe(true)
    expect(runtime.agent.get(run.id).events.some(e => e.title === '已撤销本次可安全回退的变更')).toBe(false)
    write.mockRestore()
    await runtime.agent.control(run.id, { action: 'undo', requestId: 'undo-retry' })
    expect((await runtime.workspace.getCanvasRecord(input.canvasId))!.snapshot!.nodes).toHaveLength(0)
    expect(runtime.agent.get(run.id).canUndo).toBe(false)
  })
  it.each(['stop', 'pause'] as const)('%s during runtime catalog refresh prevents the real provider create boundary', async (action) => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const sync = vi.fn(async () => { await gate; return testCatalog })
    const create = vi.fn(async () => 'upstream-test')
    const { runtime, input, realSubmit } = await generationFixture(adapterStub({ syncCatalog: sync, createGeneration: create }))
    runtime.submit = realSubmit
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(sync).toHaveBeenCalled())
    await runtime.agent.control(run.id, { action, requestId: action })
    release(); await runtime.agent.idle()
    expect(create).not.toHaveBeenCalled()
    expect(runtime.jobs.list()[0], JSON.stringify(runtime.agent.get(run.id))).toMatchObject({ status: 'queued' })
    expect(runtime.jobs.list()[0].createAttemptedAt).toBeUndefined()
    if (action === 'pause') {
      const stableId = runtime.jobs.list()[0].clientRequestId
      await runtime.agent.control(run.id, { action: 'resume', requestId: 'resume' })
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      expect(runtime.jobs.list()[0].clientRequestId).toBe(stableId)
      expect(runtime.jobs.list()).toHaveLength(1)
      await runtime.agent.control(run.id, { action: 'stop', requestId: 'stop' })
    }
  })
  it('stop during reference upload prevents provider create after staging completes', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    const upload = vi.fn(async () => { await gate })
    const create = vi.fn(async () => 'upstream-test')
    const { runtime, input, realSubmit } = await generationFixture(adapterStub({ uploadReference: upload, createGeneration: create }))
    runtime.submit = realSubmit
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#f00' } }).png().toBuffer()
    const asset = await runtime.assets.save({ filename: 'ref.png', contentType: 'image/png', bytes })
    runtime.agent.setModelForTesting(async ({ messages }) => {
      const results = messages.filter(m => m.role === 'tool').map(m => JSON.parse(String(m.content)))
      return !results.length ? call('create_node', { type: 'image', name: '苹果', prompt: '红苹果' }) : call('request_generation', { nodeId: results[0].nodeId, referenceIds: ['ref-one'] })
    })
    const run = await runtime.agent.create({ ...input, attachments: [{ id: 'ref-one', nodeId: 'upload', name: 'Reference', assetId: asset.id, mediaType: 'image' }] }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(upload, JSON.stringify(runtime.agent.get(run.id))).toHaveBeenCalled())
    await runtime.agent.control(run.id, { action: 'stop', requestId: 'stop' })
    release(); await runtime.agent.idle()
    expect(create).not.toHaveBeenCalled()
  })
  it('revoked collaborative sessions preserve late output without the old automatic callback writing', async () => {
    const { runtime, input, complete, submit } = await generationFixture()
    const canvas = (await runtime.workspace.getCanvasRecord(input.canvasId))!.snapshot!
    const owner = await runtime.collaboration.enableRoom({ projectId: canvas.projectId, canvasId: canvas.canvasId, snapshot: canvas, deviceId: 'owner', displayName: 'Owner' })
    const grant = runtime.collaboration.createAgentGrant(owner.room.roomId, owner.sessionToken)
    const run = await runtime.agent.create(input, grant)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    const before = runtime.collaboration.exportSnapshot(owner.room.roomId)
    await runtime.collaboration.revokeSession(owner.sessionToken)
    await complete(); await runtime.agent.idle()
    await vi.waitFor(() => expect(runtime.agent.get(run.id).outputs).toHaveLength(1))
    expect(runtime.agent.get(run.id).status).toBe('paused')
    expect(runtime.collaboration.exportSnapshot(owner.room.roomId)).toEqual(before)
  })
  it('active collaboration node leases prevent Agent overwrite', async () => {
    const { runtime, input } = await fixture([])
    const canvas = (await runtime.workspace.getCanvasRecord(input.canvasId))!.snapshot!
    canvas.nodes = [{ id: 'node-one', type: 'text', name: 'Manual', position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, data: { text: 'keep' } }]
    await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'with-node', kind: 'save-canvas', expectedRevision: 1, canvas })
    const owner = await runtime.collaboration.enableRoom({ projectId: canvas.projectId, canvasId: canvas.canvasId, snapshot: canvas, deviceId: 'owner', displayName: 'Owner' })
    runtime.collaboration.setAgentLeaseReader(() => new Set(['node-one']))
    let round = 0
    runtime.agent.setModelForTesting(async () => round++ ? { calls: [], text: '无法修改' } : call('update_node', { nodeId: 'node-one', text: 'overwrite' }))
    const run = await runtime.agent.create({ ...input, expectedRevision: 2, selectedNodeIds: ['node-one'] }, runtime.collaboration.createAgentGrant(owner.room.roomId, owner.sessionToken))
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('paused'))
    expect(runtime.collaboration.exportSnapshot(owner.room.roomId).nodes[0].data).toMatchObject({ text: 'keep' })
  })
  it('pausing a clarification keeps its original question answerable', async () => {
    const { runtime, input } = await fixture([call('ask_user', { title: '水果还是产品？', options: ['水果', '产品'] }), { calls: [], text: '已确认' }])
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('waiting_user'))
    const questionId = runtime.agent.get(run.id).question!.id
    await runtime.agent.control(run.id, { action: 'pause', requestId: 'pause' })
    expect(runtime.agent.get(run.id)).toMatchObject({ status: 'waiting_user', question: { id: questionId } })
    await runtime.agent.answer(run.id, { requestId: 'answer', questionId, answer: '水果' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
  })
  it('plan-only gates all canvas mutation until an explicit execution answer', async () => {
    const { runtime, input } = await fixture([call('create_node', { type: 'text', name: 'Too early', text: 'no' }), { calls: [], text: '方案：创建一个文本节点。' },
      call('create_node', { type: 'text', name: 'Approved', text: 'yes' }), { calls: [], text: '完成' }])
    const run = await runtime.agent.create({ ...input, prompt: '只做方案，等我确认后再修改画布' }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('waiting_user'))
    expect((await runtime.workspace.getCanvasRecord(input.canvasId))!.snapshot!.nodes).toHaveLength(0)
    await runtime.agent.answer(run.id, { requestId: 'approve', questionId: runtime.agent.get(run.id).question!.id, answer: '确认执行' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    expect((await runtime.workspace.getCanvasRecord(input.canvasId))!.snapshot!.nodes[0].name).toBe('Approved')
  })
  it.each([
    ['connect_nodes', { source: 'a', target: 'b', relation: 'output' }],
    ['move_nodes', { nodes: [{ nodeId: 'a', x: 10 }] }],
    ['move_nodes', { nodes: [{ nodeId: 'a', x: '10', y: 20 }] }],
    ['ask_user', { title: 'Pick', options: ['a', 'b'], multiple: 'yes' }],
    ['create_node', { type: 'image', name: 'X', extra: 'ignored' }],
  ])('validates nested schema before invoking %s', (name, args) => {
    expect(() => validateToolArguments(name as string, args)).toThrow(expect.objectContaining({ code: 'invalid_tool_arguments' }))
  })
  it.each(['不要生图，仅写提示词', 'Only write a prompt; do not generate images', 'Don’t generate any more images'])('does not authorize paid calls for %s', async (prompt) => {
    const { runtime, input, submit } = await generationFixture()
    const run = await runtime.agent.create({ ...input, prompt }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('partial'))
    expect(submit).not.toHaveBeenCalled()
  })
  it('keeps configured node defaults including provider, model, aspect ratio and resolution', async () => {
    const { runtime, input, submit } = await generationFixture()
    await runtime.catalogs.sync('agent-test', async () => ({ ...testCatalog, models: [{ ...testCatalog.models[0], aspectRatios: ['1:1', '16:9'] }] }))
    const state = (await runtime.workspace.getCanvasRecord(input.canvasId))!
    const canvas = { ...state.snapshot!, nodes: [{ id: 'configured', type: 'image' as const, name: 'Configured', position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
      data: { url: '', promptDraft: '苹果', generationSettings: { kind: 'image' as const, providerId: 'agent-test', model: 'test-image', channel: 'images', quality: 'standard', aspectRatio: '16:9', resolution: '4K', count: 1, mode: 'text2image' } } }] }
    await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'configured-node', kind: 'save-canvas', expectedRevision: state.revision, canvas })
    runtime.agent.setModelForTesting(async () => call('request_generation', { nodeId: 'configured' }))
    const run = await runtime.agent.create({ ...input, expectedRevision: 2, selectedNodeIds: ['configured'] }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(submit.mock.calls[0][0]).toMatchObject({ providerId: 'agent-test', model: 'test-image', aspectRatio: '16:9' })
    expect((await runtime.workspace.getCanvasRecord(input.canvasId))!.snapshot!.nodes[0].data).toMatchObject({ generationSettings: { resolution: '4K', aspectRatio: '16:9' } })
    await runtime.agent.control(run.id, { action: 'stop', requestId: 'stop' })
  })
  it('failed generation clears the marker; resume adds no paid attempt, explicit retry reuses the run', async () => {
    const { runtime, input, submit, complete } = await generationFixture()
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(runtime.jobs.list()).toHaveLength(1))
    const job = runtime.jobs.list()[0]
    await runtime.jobs.update(job.id, { status: 'failed', error: { code: 'PROVIDER_REJECTED', message: 'Unavailable' } })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('partial'))
    expect((await runtime.workspace.getCanvasRecord(input.canvasId))!.snapshot!.nodes[0].data).toMatchObject({ generation: { status: 'failed', jobId: job.id } })
    await runtime.agent.control(run.id, { action: 'resume', requestId: 'resume' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('partial'))
    expect(submit).toHaveBeenCalledTimes(1)
    let retryRound = 0
    runtime.agent.setModelForTesting(async () => retryRound++ ? { calls: [], text: '已补齐' } : call('request_generation', { nodeId: job.request.targetNodeId }))
    await runtime.agent.control(run.id, { action: 'message', requestId: 'retry', message: '重试失败的生成' })
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
    await complete()
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    expect(runtime.agent.get(run.id).outputs).toHaveLength(1)
  })
  it('reconciles a committed workspace intent after restart without duplicating the created node', async () => {
    const { runtime, input, dataDir } = await fixture([call('create_node', { type: 'text', name: 'Durable', text: 'x' })])
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    await runtime.close(); open.splice(open.indexOf(runtime), 1)
    const path = join(dataDir, 'agent-runs', `${run.id}.json`)
    const record = JSON.parse(await readFile(path, 'utf8'))
    const operation = record.operations[0]
    const journal = JSON.parse(await readFile(join(dataDir, 'workspace', 'operations', `${operation.id}.json`), 'utf8'))
    record.pendingWrite = { operationId: operation.id, changes: record.changes, mutation: journal.mutation, trackChanges: true }
    record.changes = []; operation.state = 'pending'; record.run.status = 'running'; record.round = 1; record.pendingRound = 1; record.pendingCalls = [operation.call]
    record.messages = record.messages.slice(0, 2)
    await writeFile(path, JSON.stringify(record), 'utf8')
    const restored = await createGatewayRuntime({ dataDir, envFile: join(dataDir, '.env'), env: {}, agentModel: async () => ({ calls: [], text: 'Recovered' }) })
    open.push(restored)
    await vi.waitFor(() => expect(restored.agent.get(run.id).status).toBe('complete'))
    expect((await restored.workspace.getCanvasRecord(input.canvasId))!.snapshot!.nodes).toHaveLength(1)
  })
  it.each(['确认重试一张', '不要重试', 'do not retry'])('applies explicit retry answers without treating a refusal as paid authorization: %s', async answer => {
    const { runtime, input, submit, complete } = await generationFixture()
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(runtime.jobs.list()).toHaveLength(1))
    const job = runtime.jobs.list()[0]
    let turn = 0
    runtime.agent.setModelForTesting(async () => turn++ === 0 ? call('ask_user', { title: '是否额外重试一张？', options: ['确认重试一张', '不要重试'] }) : turn === 2 ? call('request_generation', { nodeId: job.request.targetNodeId }) : { calls: [], text: '结束' })
    await runtime.jobs.update(job.id, { status: 'failed', error: { code: 'PROVIDER_REJECTED', message: 'Unavailable' } })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('waiting_user'))
    await runtime.agent.answer(run.id, { questionId: runtime.agent.get(run.id).question!.id, requestId: 'retry-answer', answer })
    if (answer === '确认重试一张') {
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
      await complete()
      await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    } else {
      await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('partial'))
      expect(submit).toHaveBeenCalledTimes(1)
    }
  })
  it('a confirmed local rejection consumes no attempt at the real provider dispatch boundary', async () => {
    const create = vi.fn(async () => 'upstream-test')
    const { runtime, input, realSubmit } = await generationFixture(adapterStub({ createGeneration: create }))
    let submitted = 0
    runtime.submit = async (...args) => { if (submitted++ === 0) throw new Error('Local validation rejected before dispatch'); return realSubmit(...args) }
    runtime.agent.setModelForTesting(async ({ messages }) => {
      const receipts = messages.filter(m => m.role === 'tool').map(m => JSON.parse(String(m.content)))
      return !receipts.length ? call('create_node', { type: 'image', name: 'Apple', prompt: 'Apple' }) : call('request_generation', { nodeId: receipts[0].nodeId })
    })
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(submitted).toBe(2)
    expect(runtime.jobs.list()).toHaveLength(1)
    await runtime.agent.control(run.id, { action: 'stop', requestId: 'stop' })
  })
  it.each(['不要重试', 'do not retry'])('a negative retry supplement cannot expand paid authorization: %s', async message => {
    const { runtime, input, submit } = await generationFixture()
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(runtime.jobs.list()).toHaveLength(1))
    const job = runtime.jobs.list()[0]
    await runtime.jobs.update(job.id, { status: 'failed', error: { code: 'PROVIDER_REJECTED', message: 'Unavailable' } })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('partial'))
    let round = 0
    runtime.agent.setModelForTesting(async () => round++ ? { calls: [] } : call('request_generation', { nodeId: job.request.targetNodeId }))
    await runtime.agent.control(run.id, { action: 'message', requestId: 'refuse-retry', message })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('partial'))
    expect(submit).toHaveBeenCalledTimes(1)
  })
  it('an explicit stop releases its matching generation marker without accepting the late result', async () => {
    const { runtime, input, submit, complete } = await generationFixture()
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await runtime.agent.control(run.id, { action: 'stop', requestId: 'stop' })
    const stopped = (await runtime.workspace.getCanvasRecord(input.canvasId))!.snapshot!
    expect(stopped.nodes[0].data).toMatchObject({ generation: { status: 'failed', error: { code: 'AGENT_STOPPED' } } })
    await complete(); await runtime.agent.idle()
    expect((await runtime.workspace.getCanvasRecord(input.canvasId))!.snapshot).toEqual(stopped)
  })
  it.each([true, false])('undo accounts for a pending intent only if it was committed (%s), without replaying it', async committed => {
    const { runtime, input, dataDir } = await fixture([call('create_node', { type: 'text', name: 'First', text: 'x' })])
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    const current = (await runtime.workspace.getCanvasRecord(input.canvasId))!
    let after = structuredClone(current.snapshot!)
    after.nodes.push({ id: 'second', type: 'text', name: 'Second', position: { x: 400, y: 0 }, size: { width: 100, height: 100 }, data: { text: 'x' } })
    after = parseCanvasSnapshot(JSON.stringify(after))
    const mutation = { protocolVersion: 1 as const, kind: 'save-canvas' as const, operationId: 'pending-second', expectedRevision: current.revision, canvas: after }
    if (committed) await runtime.workspace.applyWorkspaceMutation(mutation)
    await runtime.close(); open.splice(open.indexOf(runtime), 1)
    const path = join(dataDir, 'agent-runs', `${run.id}.json`)
    const record = JSON.parse(await readFile(path, 'utf8'))
    record.pendingWrite = { operationId: mutation.operationId, mutation, changes: changesBetween(current.snapshot!, after), trackChanges: true }
    record.run.status = 'paused'
    await writeFile(path, JSON.stringify(record), 'utf8')
    const model = vi.fn<AgentModel>(async () => ({ calls: [] }))
    const restored = await createGatewayRuntime({ dataDir, envFile: join(dataDir, '.env'), env: {}, agentModel: model }); open.push(restored)
    const write = vi.spyOn(restored.workspace, 'applyWorkspaceMutation')
    await restored.agent.control(run.id, { action: 'undo', requestId: 'undo-pending' })
    expect((await restored.workspace.getCanvasRecord(input.canvasId))!.snapshot!.nodes).toHaveLength(0)
    expect(write.mock.calls.every(([value]) => value.operationId !== mutation.operationId)).toBe(true)
    expect(model).not.toHaveBeenCalled()
  })
  it('resumes a context checkpoint with user constraints, plan and actual receipts intact', async () => {
    const { runtime, input, dataDir } = await fixture([call('create_node', { type: 'text', name: 'Receipt node', text: 'x' })])
    const run = await runtime.agent.create(input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    await runtime.close(); open.splice(open.indexOf(runtime), 1)
    const path = join(dataDir, 'agent-runs', `${run.id}.json`)
    const record = JSON.parse(await readFile(path, 'utf8'))
    record.run.status = 'paused'; record.round = 24; record.roundLimit = 24
    record.run.plan = [{ id: 'remaining', title: 'Preserve planned work', status: 'pending' }]
    for (let i = 0; i < 10; i++) record.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `old-${i}` }] }, { role: 'tool', tool_call_id: `old-${i}`, content: 'large receipt '.repeat(1000) }, { role: 'user', content: `Constraint ${i}` })
    await writeFile(path, JSON.stringify(record), 'utf8')
    const model = vi.fn<AgentModel>(async () => ({ calls: [], text: 'Checkpoint resumed' }))
    const restored = await createGatewayRuntime({ dataDir, envFile: join(dataDir, '.env'), env: {}, agentModel: model }); open.push(restored)
    await restored.agent.control(run.id, { action: 'resume', requestId: 'resume-checkpoint' })
    await vi.waitFor(() => expect(restored.agent.get(run.id).status).toBe('partial'))
    expect(model.mock.calls[0][0].system).toContain('Preserve planned work')
    expect(model.mock.calls[0][0].system).toContain('Receipt node')
    expect(model.mock.calls[0][0].messages.filter(m => m.role === 'user')).toHaveLength(11)
    expect(JSON.stringify(model.mock.calls[0][0].messages).length).toBeLessThan(80_000)
  })
  it.each(['制作两张海报', 'create 2 posters'])('does not claim a requested output quantity is complete without actual assets: %s', async prompt => {
    const { runtime, input } = await fixture([{ calls: [], text: 'All requested posters are complete' }])
    const run = await runtime.agent.create({ ...input, prompt }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('partial'))
    expect(runtime.agent.get(run.id).response).toContain('0/2')
  })
  it('a first tool write cannot silently refresh the model observation for another stale tool in the same turn', async () => {
    const { runtime, input } = await fixture([])
    const canvas = (await runtime.workspace.getCanvasRecord(input.canvasId))!.snapshot!
    canvas.nodes = ['a', 'b'].map(id => ({ id, type: 'text' as const, name: id, position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, data: { text: 'original' } }))
    await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'two-nodes', kind: 'save-canvas', expectedRevision: 1, canvas })
    let release!: (turn: ModelTurn) => void
    const model = vi.fn<AgentModel>().mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValue({ calls: [], text: 'Done' })
    runtime.agent.setModelForTesting(model)
    const run = await runtime.agent.create({ ...input, expectedRevision: 2, selectedNodeIds: ['a', 'b'] }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1))
    const manual = (await runtime.workspace.getCanvasRecord(input.canvasId))!
    const changed = structuredClone(manual.snapshot!); if (changed.nodes[1].type === 'text') changed.nodes[1].data.text = 'Manual latest'
    await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'manual-b', kind: 'save-canvas', expectedRevision: manual.revision, canvas: changed })
    release({ calls: [{ id: 'write-a', name: 'update_node', arguments: { nodeId: 'a', text: 'Agent A' } }, { id: 'write-b', name: 'update_node', arguments: { nodeId: 'b', text: 'Stale Agent B' } }] })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('partial'))
    expect((await runtime.workspace.getCanvasRecord(input.canvasId))!.snapshot!.nodes[1].data).toMatchObject({ text: 'Manual latest' })
  })
})
