import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGatewayRuntime, type GatewayRuntime } from '../runtime.ts'
import { defaultInitialCanvas } from '../canvas-storage.ts'
import type { AgentModel, ModelTurn } from './model.ts'
import { budgetFallback } from './conversations.ts'

const opened: GatewayRuntime[] = []
afterEach(async () => { await Promise.all(opened.splice(0).map(r => r.close())) })
const call = (name: string, args: Record<string, unknown>): ModelTurn => ({ calls: [{ id: name, name, arguments: args }] })
async function fixture(model: AgentModel) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-chats-'))
  const runtime = await createGatewayRuntime({ dataDir, envFile: join(dataDir, '.env'), env: { CANVAS_AGENT_RUNTIME_VERSION: '2' }, agentModel: model }); opened.push(runtime)
  await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'seed', kind: 'save-canvas', expectedRevision: 0, canvas: defaultInitialCanvas('c1', 'p1', 'Chat') })
  const input = { requestId: 'r1', canvasId: 'c1', expectedRevision: 1, prompt: '你好', attachments: [], conversationId: 'chat-one' }
  return { runtime, input, dataDir }
}
describe('canvas conversation boundaries and closing answers', () => {
  it('counts committed legacy writes and prompts embedded in created nodes in old-task summaries', async () => {
    const f = await fixture(async () => ({ text: 'done', calls: [] })); const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' }); await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('complete'))
    const record = JSON.parse(await readFile(join(f.dataDir, 'agent-runs', `${run.id}.json`), 'utf8'))
    record.operations = [{ state: 'complete', call: { name: 'create_node' }, result: { nodeId: 'old-node' } }]
    record.changes = [{ collection: 'nodes', id: 'old-node', path: [], after: { data: { promptDraft: '人物提示词' } } }]
    expect(budgetFallback(record)).toContain('已提交画布操作：1 项')
    expect(budgetFallback(record)).toContain('更新提示词：1 个节点')
  })
  it('does not inherit permission over nodes created in the preceding conversation turn', async () => {
    let stage = 0; let createdId = ''
    const model: AgentModel = async ({ messages }) => {
      stage++
      if (stage === 1) return call('run_canvas_command', { command: 'nodes.create', parameters: { type: 'text', name: 'Original' }, expectedRevision: 1 })
      if (stage === 2) { createdId = JSON.parse(String(messages.find(m => m.role === 'tool')!.content)).result.nodeIds[0]; return { text: `节点编号 ${createdId}`, calls: [] } }
      if (stage === 3) return call('run_canvas_command', { command: 'nodes.rename', parameters: { nodeId: createdId, name: 'Must not overwrite' }, expectedRevision: 2 })
      return { text: '需要重新选择目标', calls: [] }
    }
    const f = await fixture(model); const first = await f.runtime.agent.create(f.input, { kind: 'local-admin' }); await vi.waitFor(() => expect(f.runtime.agent.get(first.id).status).toBe('complete'))
    const next = await f.runtime.agent.create({ ...f.input, requestId: 'follow-up', expectedRevision: 2, previousRunId: first.id, prompt: '修改上一轮的节点' }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(next.id).status).toBe('partial'))
    expect((await f.runtime.workspace.getCanvasRecord('c1'))!.snapshot!.nodes[0].name).toBe('Original')
  })
  it('finishes a truncated plain answer with one tool-free continuation instead of losing the text', async () => {
    const model = vi.fn<AgentModel>().mockResolvedValueOnce({ text: '已完成第一部分，', calls: [], incomplete: true }).mockResolvedValueOnce({ text: '这是完整结尾。', calls: [] })
    const f = await fixture(model); const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('complete'))
    expect(f.runtime.agent.get(run.id).response).toBe('已完成第一部分，这是完整结尾。')
    expect(model.mock.calls[1][0].tools).toEqual([]); expect(f.runtime.jobs.list()).toHaveLength(0)
  })
  it('preserves twice-truncated answers, pauses clearly, and resumes only the remaining text', async () => {
    const model = vi.fn<AgentModel>().mockResolvedValueOnce({ text: '第一段', calls: [], incomplete: true }).mockResolvedValueOnce({ text: '第二段', calls: [], incomplete: true }).mockResolvedValue({ text: '结尾', calls: [] })
    const f = await fixture(model); const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('paused'))
    expect(f.runtime.agent.get(run.id)).toMatchObject({ response: '第一段第二段', error: { code: 'model_incomplete' } })
    expect(model).toHaveBeenCalledTimes(2)
    await f.runtime.agent.control(run.id, { requestId: 'continue', action: 'resume' })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('complete'))
    expect(f.runtime.agent.get(run.id).response).toBe('第一段第二段结尾'); expect(model.mock.calls[2][0].tools).toEqual([])
  })
  it('treats a new message in a paused task as an explicit continuation without losing the question', async () => {
    let release!: (turn: ModelTurn) => void
    const model = vi.fn<AgentModel>().mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValue({ text: '已回答补充问题', calls: [] })
    const f = await fixture(model); const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' }); await vi.waitFor(() => expect(model).toHaveBeenCalledOnce())
    await f.runtime.agent.control(run.id, { requestId: 'pause', action: 'pause' })
    await f.runtime.agent.control(run.id, { requestId: 'question', action: 'message', message: '请回答最后的问题' })
    release({ text: '过期回答', calls: [] })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('complete'))
    expect(f.runtime.agent.get(run.id).response).toBe('已回答补充问题')
    expect(model.mock.calls.at(-1)![0].messages).toContainEqual({ role: 'user', content: '请回答最后的问题' })
  })
  it('persists conversation identity and supplies the previous plain answer without inheriting tool authorization', async () => {
    const model = vi.fn<AgentModel>(async () => ({ text: '记住人物叫小林', calls: [] }))
    const f = await fixture(model)
    const first = await f.runtime.agent.create(f.input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(first.id).status).toBe('complete'))
    const next = await f.runtime.agent.create({ ...f.input, requestId: 'r2', previousRunId: first.id, prompt: '人物叫什么？' }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(next.id).status).toBe('complete'))
    expect(f.runtime.agent.get(next.id)).toMatchObject({ conversationId: 'chat-one', previousRunId: first.id })
    expect(model.mock.calls[1][0].messages).toEqual(expect.arrayContaining([{ role: 'assistant', content: '记住人物叫小林' }]))
    expect(f.runtime.jobs.list()).toHaveLength(0)
    const other = await f.runtime.agent.create({ ...f.input, requestId: 'r3', conversationId: 'chat-two' }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(other.id).status).toBe('complete'))
    expect(model.mock.calls[2][0].messages).toEqual([{ role: 'user', content: '你好' }])
  })
  it('rejects prior context from another conversation or canvas', async () => {
    const f = await fixture(async () => ({ text: '完成', calls: [] }))
    const first = await f.runtime.agent.create(f.input, { kind: 'local-admin' }); await vi.waitFor(() => expect(f.runtime.agent.get(first.id).status).toBe('complete'))
    await expect(f.runtime.agent.create({ ...f.input, requestId: 'bad-chat', conversationId: 'other', previousRunId: first.id }, { kind: 'local-admin' })).rejects.toMatchObject({ code: 'conversation_mismatch' })
    await f.runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'seed-c2', kind: 'save-canvas', expectedRevision: 0, canvas: defaultInitialCanvas('c2', 'p1', 'Other') })
    await expect(f.runtime.agent.create({ ...f.input, requestId: 'bad-canvas', canvasId: 'c2', previousRunId: first.id }, { kind: 'local-admin' })).rejects.toMatchObject({ code: 'conversation_mismatch' })
  })
  it('allows another conversation while one is waiting, and retains FIFO inside the waiting conversation', async () => {
    const f = await fixture(async ({ messages }) => String(messages.at(-1)?.content).includes('等待') ? call('ask_user', { title: '请选择', options: ['A', 'B'] }) : { text: '独立完成', calls: [] })
    const waiting = await f.runtime.agent.create({ ...f.input, prompt: '等待回答' }, { kind: 'local-admin' }); await vi.waitFor(() => expect(f.runtime.agent.get(waiting.id).status).toBe('waiting_user'))
    const same = await f.runtime.agent.create({ ...f.input, requestId: 'same-chat', prompt: '排在后面' }, { kind: 'local-admin' })
    const other = await f.runtime.agent.create({ ...f.input, requestId: 'other-chat', conversationId: 'chat-two', prompt: '独立完成' }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(other.id).status).toBe('complete'))
    expect(f.runtime.agent.get(same.id).status).toBe('queued')
  })
  it('loads the final parent answer when a queued follow-up actually starts', async () => {
    const model = vi.fn<AgentModel>(async ({ system, messages }) => {
      const current = JSON.parse(system.split('Actual current context:\n').at(-1)!).currentPrompt
      if (current === '请先确认' && messages.at(-1)?.content === '请先确认') return call('ask_user', { title: '选项', options: ['A', 'B'] })
      return { text: current === '请先确认' ? '上一个任务已经完成' : '后续答复', calls: [] }
    })
    const f = await fixture(model); const parent = await f.runtime.agent.create({ ...f.input, prompt: '请先确认' }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(parent.id).status).toBe('waiting_user'))
    const child = await f.runtime.agent.create({ ...f.input, requestId: 'follow-up', previousRunId: parent.id, prompt: '接着说' }, { kind: 'local-admin' })
    await f.runtime.agent.answer(parent.id, { requestId: 'answer', questionId: f.runtime.agent.get(parent.id).question!.id, answer: 'A' })
    await vi.waitFor(() => expect(f.runtime.agent.get(child.id).status).toBe('complete'))
    expect(model.mock.calls.at(-1)![0].messages).toContainEqual({ role: 'assistant', content: '上一个任务已经完成' })
  })
  it('preserves parent-before-child FIFO after restart even when UUID order and timestamps tie', async () => {
    const f = await fixture(async () => call('ask_user', { title: '先回答', options: ['A', 'B'] }))
    const parent = await f.runtime.agent.create({ ...f.input, prompt: 'Parent' }, { kind: 'local-admin' }); await vi.waitFor(() => expect(f.runtime.agent.get(parent.id).status).toBe('waiting_user'))
    const child = await f.runtime.agent.create({ ...f.input, requestId: 'child', previousRunId: parent.id, prompt: 'Child' }, { kind: 'local-admin' })
    await f.runtime.close(); opened.splice(opened.indexOf(f.runtime), 1)
    const ids = { parent: 'ffffffff-ffff-4fff-8fff-ffffffffffff', child: '00000000-0000-4000-8000-000000000000' }
    for (const [kind, oldId] of [['parent', parent.id], ['child', child.id]] as const) {
      const path = join(f.dataDir, 'agent-runs', `${oldId}.json`); const saved = JSON.parse(await readFile(path, 'utf8'))
      saved.run.id = ids[kind]; saved.run.createdAt = '2026-11-02T00:00:00.000Z'
      if (kind === 'child') saved.run.previousRunId = ids.parent
      await writeFile(join(f.dataDir, 'agent-runs', `${ids[kind]}.json`), JSON.stringify(saved)); await rm(path)
    }
    const model = vi.fn<AgentModel>(async ({ system }) => ({ text: system.includes('"currentPrompt":"Parent"') ? 'Parent finished' : 'Child finished', calls: [] }))
    const restored = await createGatewayRuntime({ dataDir: f.dataDir, envFile: join(f.dataDir, '.env'), env: {}, agentModel: model }); opened.push(restored)
    await restored.agent.idle()
    expect(restored.agent.get(ids.child).status).toBe('queued'); expect(model).not.toHaveBeenCalled()
    await restored.agent.answer(ids.parent, { requestId: 'answer-parent', questionId: restored.agent.get(ids.parent).question!.id, answer: 'A' })
    await vi.waitFor(() => expect(restored.agent.get(ids.child).status).toBe('complete'))
    expect(model.mock.calls.at(-1)![0].messages).toContainEqual({ role: 'assistant', content: 'Parent finished' })
  })
  it('reconciles an ambiguous write before a paused message replans, preserving receipts and undo', async () => {
    let step = 0
    const f = await fixture(async () => ++step <= 2 ? call('run_canvas_command', { command: 'nodes.create', parameters: { type: 'text', name: `Node${step}` }, expectedRevision: step }) : { text: '两项操作已保存', calls: [] })
    const apply = f.runtime.workspace.applyWorkspaceMutation.bind(f.runtime.workspace); let lost = false
    f.runtime.workspace.applyWorkspaceMutation = async mutation => { const receipt = await apply(mutation); if (mutation.operationId.startsWith('agent-op-') && !lost) { lost = true; throw new Error('lost commit response') }; return receipt }
    const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' }); await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('paused'))
    await f.runtime.agent.control(run.id, { requestId: 'follow-up', action: 'message', message: '继续并回答问题' })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('complete'))
    const saved = JSON.parse(await readFile(join(f.dataDir, 'agent-runs', `${run.id}.json`), 'utf8'))
    expect(saved.operations[0]).toMatchObject({ state: 'complete', result: { committed: true } })
    expect(saved.pendingWrite).toBeUndefined()
    await f.runtime.agent.control(run.id, { requestId: 'undo', action: 'undo' })
    expect((await f.runtime.workspace.getCanvasRecord('c1'))!.snapshot!.nodes).toHaveLength(0)
  })
  it('uses exactly one tool-free closing turn at the step limit, without raising media budgets', async () => {
    const model = vi.fn<AgentModel>(async ({ tools }) => tools.length ? call('read_canvas', {}) : { text: '已核对画布，本轮未创建节点。后续操作已暂停，可继续处理。', calls: [] })
    const f = await fixture(model); const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('paused'), { timeout: 5000 })
    expect(model).toHaveBeenCalledTimes(25)
    expect(model.mock.calls.at(-1)![0].tools).toEqual([])
    expect(f.runtime.agent.get(run.id)).toMatchObject({ error: { code: 'run_limit' }, response: expect.stringContaining('已核对画布') })
    expect(f.runtime.jobs.list()).toHaveLength(0)
    expect((await f.runtime.workspace.getCanvasRecord('c1'))!.revision).toBe(1)
  })
  it('keeps a factual closing answer if the closing model fails or asks for tools', async () => {
    const f = await fixture(async ({ tools }) => tools.length ? call('read_canvas', {}) : call('run_canvas_command', { command: 'nodes.create', parameters: { type: 'text', name: 'Forbidden' }, expectedRevision: 1 }))
    const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' }); await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('paused'), { timeout: 5000 })
    expect(f.runtime.agent.get(run.id).response).toContain('已暂停')
    expect((await f.runtime.workspace.getCanvasRecord('c1'))!.snapshot!.nodes).toHaveLength(0)
  })
  it('provides existing budget-paused runs a readable summary without executing or mutating them', async () => {
    const f = await fixture(async () => ({ text: 'done', calls: [] })); const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' }); await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('complete'))
    await f.runtime.close(); opened.splice(opened.indexOf(f.runtime), 1)
    const path = join(f.dataDir, 'agent-runs', `${run.id}.json`); const saved = JSON.parse(await readFile(path, 'utf8'))
    saved.run.status = 'paused'; saved.run.error = { code: 'run_limit', message: '已达到本轮执行预算，请检查进度后继续。' }; delete saved.run.response; saved.round = 24
    await writeFile(path, JSON.stringify(saved)); const model = vi.fn<AgentModel>(async () => ({ text: 'must not call', calls: [] }))
    const restored = await createGatewayRuntime({ dataDir: f.dataDir, envFile: join(f.dataDir, '.env'), env: {}, agentModel: model }); opened.push(restored)
    expect(restored.agent.get(run.id).response).toContain('已暂停'); expect(model).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(path, 'utf8')).run.response).toBeUndefined()
  })
})
