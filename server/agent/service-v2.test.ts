import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGatewayRuntime, type GatewayRuntime } from '../runtime.ts'
import { defaultInitialCanvas } from '../canvas-storage.ts'
import type { AgentModel, ModelTurn } from './model.ts'
import type { CanvasNode } from '../../src/model/project.ts'
import type { ProviderCatalog } from '../../src/contracts/generation.ts'

const opened: GatewayRuntime[] = []
afterEach(async () => { await Promise.all(opened.splice(0).map(r => r.close())) })
const call = (name: string, args: Record<string, unknown>): ModelTurn => ({ calls: [{ id: name, name, arguments: args }] })
const node = (id: string): CanvasNode => ({ id, type: 'text', name: id, position: { x: 0, y: 0 }, size: { width: 100, height: 80 }, data: { text: id } })
async function fixture(turns: ModelTurn[] = [], version = '2') {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-v2-'))
  const model = vi.fn<AgentModel>(async () => turns.shift() ?? { text: '完成', calls: [] })
  const runtime = await createGatewayRuntime({ dataDir, envFile: join(dataDir, '.env'), env: { CANVAS_AGENT_RUNTIME_VERSION: version }, agentModel: model }); opened.push(runtime)
  await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'seed', kind: 'save-canvas', expectedRevision: 0, canvas: { ...defaultInitialCanvas('canvas-test', 'project-test', 'Test'), nodes: [node('a'), node('b')] } })
  const input = { requestId: 'request-one', canvasId: 'canvas-test', expectedRevision: 1, prompt: '调整所选节点', attachments: [], selectedNodeIds: ['a', 'b'] }
  const read = async () => (await runtime.workspace.getCanvasRecord(input.canvasId))!
  return { runtime, input, model, dataDir, read }
}
const runCommand = (command: string, parameters: Record<string, unknown>, expectedRevision = 1, dryRun = false) => call('run_canvas_command', { command, parameters, expectedRevision, dryRun })
describe('v2 durable execution', () => {
  it('loads the new-task version flag from the existing environment file path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-v2-env-')); const envFile = join(dataDir, '.env')
    await writeFile(envFile, 'CANVAS_AGENT_RUNTIME_VERSION=2\n')
    const runtime = await createGatewayRuntime({ dataDir, envFile, env: {}, agentModel: async () => ({ calls: [], text: '配置生效' }) }); opened.push(runtime)
    await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'seed', kind: 'save-canvas', expectedRevision: 0, canvas: defaultInitialCanvas('canvas-test', 'project-test', 'Test') })
    const run = await runtime.agent.create({ requestId: 'env-test', canvasId: 'canvas-test', expectedRevision: 1, prompt: '检查画布', attachments: [] }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(runtime.agent.get(run.id).status).toBe('complete'))
    const saved = JSON.parse(await readFile(join(dataDir, 'agent-runs', `${run.id}.json`), 'utf8')); expect(saved.executionVersion).toBe(2)
  })
  it('advertises v2 tools, commits a registered command and returns verified revisions', async () => {
    const f = await fixture([runCommand('styles.text', { nodeId: 'a', typography: { fontSize: 32 } })])
    const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('complete'))
    expect(f.model.mock.calls[0][0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'run_canvas_command' }) })]))
    const actual = await f.read(); expect(actual.snapshot!.nodes[0].data).toHaveProperty('fontSize', 32)
    const receipt = JSON.parse(String(f.model.mock.calls[1][0].messages.find(m => m.role === 'tool')!.content))
    expect(receipt).toMatchObject({ committed: true, verified: true, revision: 2, affectedNodeIds: ['a'] })
    expect(receipt.operationId).toBeTruthy()
  })
  it('keeps UI receipts valid for a full 100-node authorized scope', async () => {
    const f = await fixture([...[0, 30, 60, 90].map(offset => call('read_canvas', { offset, limit: 30 })), runCommand('nodes.rename_canvas', { name: 'Large scope' }, 2)])
    const current = await f.read(); const nodes = Array.from({ length: 100 }, (_, i) => node(`long-node-${String(i).padStart(3, '0')}-${'x'.repeat(70)}`))
    await f.runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'large-scope', kind: 'save-canvas', expectedRevision: 1, canvas: { ...current.snapshot!, nodes } })
    const run = await f.runtime.agent.create({ ...f.input, expectedRevision: 2, selectedNodeIds: nodes.map(n => n.id) }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('complete'))
    const receipt = f.runtime.agent.get(run.id).events.find(e => e.toolName === 'run_canvas_command' && e.status === 'complete')!
    expect(() => JSON.parse(receipt.detail!)).not.toThrow()
    expect(JSON.parse(receipt.detail!)).toMatchObject({ committed: true, verified: true, affectedNodeCount: 100 })
  })
  it('reads typed data and bounded edge pages with layer positions', async () => {
    const f = await fixture([call('read_nodes', { nodeIds: ['a', 'b'], edgeOffset: 0, edgeLimit: 1 })])
    const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' }); await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('complete'))
    const result = JSON.parse(String(f.model.mock.calls[1][0].messages.find(m => m.role === 'tool')!.content))
    expect(result.nodes[0].data.text).toBe('a'); expect(result.order).toEqual([{ nodeId: 'a', index: 0 }, { nodeId: 'b', index: 1 }]); expect(result).toMatchObject({ totalEdges: 0, edgeOffset: 0, hasMoreEdges: false })
  })
  it('dry run leaves document, revision, undo and paid jobs untouched', async () => {
    const f = await fixture([runCommand('geometry.move', { moves: [{ nodeId: 'a', position: { x: 400, y: 50 } }] }, 1, true)])
    const before = await f.read(); const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('complete'))
    expect(await f.read()).toEqual(before); expect(f.runtime.agent.get(run.id).canUndo).toBe(false); expect(f.runtime.jobs.list()).toHaveLength(0)
  })
  it('revalidates revision and cannot expand selection by reading an unrelated node', async () => {
    const f = await fixture([call('read_nodes', { nodeIds: ['b'] }), runCommand('nodes.rename', { nodeId: 'b', name: 'Forbidden' })])
    const run = await f.runtime.agent.create({ ...f.input, selectedNodeIds: ['a'] }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('partial'))
    expect((await f.read()).revision).toBe(1)
    expect(f.runtime.agent.get(run.id).events.some(e => e.detail?.includes('node_out_of_scope'))).toBe(true)
  })
  it('pins runtime and all resources across restart and flag rollback', async () => {
    const f = await fixture([call('ask_user', { title: '选择标题', options: ['A', 'B'] })])
    const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('waiting_user'))
    const saved = JSON.parse(await readFile(join(f.dataDir, 'agent-runs', `${run.id}.json`), 'utf8'))
    expect(saved.version).toBe(2); expect(saved.executionVersion).toBe(2); expect(saved.skillPackage.digest).toMatch(/^[a-f0-9]{64}$/)
    await f.runtime.close(); opened.splice(opened.indexOf(f.runtime), 1)
    const model = vi.fn<AgentModel>(async () => ({ text: '保留版本', calls: [] }))
    const restarted = await createGatewayRuntime({ dataDir: f.dataDir, envFile: join(f.dataDir, '.env'), env: { CANVAS_AGENT_RUNTIME_VERSION: '1' }, agentModel: model }); opened.push(restarted)
    await restarted.agent.answer(run.id, { requestId: 'answer', questionId: restarted.agent.get(run.id).question!.id, answer: 'A' })
    await vi.waitFor(() => expect(restarted.agent.get(run.id).status).toBe('complete'))
    expect(model.mock.calls[0][0].system).toContain('canvas-base@2')
    const newRun = await restarted.agent.create({ ...f.input, requestId: 'legacy-new' }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(restarted.agent.get(newRun.id).status).toBe('complete'))
    expect(model.mock.calls.at(-1)![0].system).toContain('canvas-base@1')
  })
  it('rejects stale revisions after dry run and preserves a human change', async () => {
    const f = await fixture([])
    let step = 0
    f.runtime.agent.setModelForTesting(async () => {
      if (!step++) return runCommand('nodes.rename', { nodeId: 'a', name: 'Agent' }, 1, true)
      if (step === 2) {
        const current = await f.read(); const canvas = structuredClone(current.snapshot!); canvas.nodes[0].name = 'Human'
        await f.runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'human', kind: 'save-canvas', expectedRevision: current.revision, canvas })
        return runCommand('nodes.rename', { nodeId: 'a', name: 'Agent' })
      }
      return { text: '保留人工修改', calls: [] }
    })
    const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' }); await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('partial'))
    expect((await f.read()).snapshot!.nodes[0].name).toBe('Human')
  })
  it('scope-checks children when deleting a container and new edges when duplicating', async () => {
    const f = await fixture([runCommand('nodes.delete', { nodeIds: ['group'] }, 2)])
    const state = await f.read(); const snapshot = state.snapshot!
    snapshot.nodes[0].parentId = 'group'
    snapshot.nodes.push({ id: 'group', type: 'group', name: 'G', position: { x: 100, y: 80 }, size: { width: 400, height: 300 }, data: { childIds: ['a'] } })
    await f.runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'container', kind: 'save-canvas', expectedRevision: 1, canvas: snapshot })
    const run = await f.runtime.agent.create({ ...f.input, expectedRevision: 2, selectedNodeIds: ['group'] }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('partial')); expect((await f.read()).snapshot!.nodes).toHaveLength(3)
  })
  it('undo restores layer order and name while retaining later human objects and fields', async () => {
    const f = await fixture([runCommand('hierarchy.layer', { nodeId: 'a', direction: 'front' }), runCommand('nodes.rename_canvas', { name: 'Agent title' }, 2)])
    const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' }); await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('complete'))
    const state = await f.read(); expect(state.snapshot!.nodes.map(n => n.id)).toEqual(['b', 'a'])
    const snapshot = structuredClone(state.snapshot!); snapshot.nodes[0].name = 'Human'; snapshot.nodes.push(node('human'))
    await f.runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'human', kind: 'save-canvas', expectedRevision: state.revision, canvas: snapshot })
    await f.runtime.agent.control(run.id, { requestId: 'undo', action: 'undo' })
    const actual = (await f.read()).snapshot!
    expect(actual.name).toBe('Test'); expect(actual.nodes.map(n => n.id)).toEqual(['a', 'b', 'human']); expect(actual.nodes[1].name).toBe('Human')
  })
  it('recovers a lost commit response once with its receipt and no duplicate undo changes', async () => {
    const f = await fixture([runCommand('nodes.rename', { nodeId: 'a', name: 'Agent' })])
    const apply = f.runtime.workspace.applyWorkspaceMutation.bind(f.runtime.workspace)
    let lost = false
    f.runtime.workspace.applyWorkspaceMutation = async mutation => { const receipt = await apply(mutation); if (mutation.operationId.startsWith('agent-op-') && !lost) { lost = true; throw new Error('response lost') }; return receipt }
    const run = await f.runtime.agent.create(f.input, { kind: 'local-admin' }); await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('paused'))
    expect((await f.read()).revision).toBe(2)
    await f.runtime.close(); opened.splice(opened.indexOf(f.runtime), 1)
    const restored = await createGatewayRuntime({ dataDir: f.dataDir, envFile: join(f.dataDir, '.env'), env: {}, agentModel: async () => ({ text: '已恢复', calls: [] }) }); opened.push(restored)
    await restored.agent.control(run.id, { requestId: 'resume', action: 'resume' })
    await vi.waitFor(() => expect(restored.agent.get(run.id).status).toBe('complete'))
    expect((await restored.workspace.getCanvasRecord(f.input.canvasId))!.revision).toBe(2)
    const saved = JSON.parse(await readFile(join(f.dataDir, 'agent-runs', `${run.id}.json`), 'utf8'))
    expect(saved.operations[0].result).toMatchObject({ committed: true, verified: true, revision: 2 })
    expect(saved.changes.filter((c: { collection: string }) => c.collection === 'nodes')).toHaveLength(1)
  })
  it('acknowledges an applied collaboration intent after a lost checkpoint response and later human edit', async () => {
    const f = await fixture([runCommand('nodes.rename', { nodeId: 'a', name: 'Agent' })])
    const canvas = (await f.read()).snapshot!
    const owner = await f.runtime.collaboration.enableRoom({ projectId: canvas.projectId, canvasId: canvas.canvasId, snapshot: canvas, deviceId: 'owner', displayName: 'Owner' })
    const grant = f.runtime.collaboration.createAgentGrant(owner.room.roomId, owner.sessionToken)
    const checkpoint = f.runtime.collaboration.checkpointRoom.bind(f.runtime.collaboration)
    let lost = false
    f.runtime.collaboration.checkpointRoom = async id => { await checkpoint(id); if (!lost) { lost = true; throw new Error('checkpoint response lost') } }
    const run = await f.runtime.agent.create(f.input, grant); await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('paused'))
    const current = f.runtime.collaboration.exportSnapshot(owner.room.roomId); const human = structuredClone(current); human.nodes.find(n => n.id === 'b')!.name = 'Human'
    f.runtime.collaboration.applyAgentChange(grant, current, human); await checkpoint(owner.room.roomId)
    await f.runtime.agent.control(run.id, { requestId: 'resume', action: 'resume' }, grant)
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('complete'))
    const actual = f.runtime.collaboration.exportSnapshot(owner.room.roomId)
    expect(actual.nodes.map(n => n.name)).toEqual(['Agent', 'Human'])
    const saved = JSON.parse(await readFile(join(f.dataDir, 'agent-runs', `${run.id}.json`), 'utf8'))
    expect(saved.operations[0].result).toMatchObject({ committed: true, verified: true })
    expect(saved.changes.filter((c: { collection: string }) => c.collection === 'nodes')).toHaveLength(1)
  })
  it.each(['styles.text', 'hierarchy.layer', 'edges.connect'])('respects active collaboration leases for %s', async command => {
    const parameters = command === 'styles.text' ? { nodeId: 'a', typography: { fontSize: 32 } } : command === 'hierarchy.layer' ? { nodeId: 'a', direction: 'front' } : { source: 'a', target: 'b' }
    const f = await fixture([runCommand(command, parameters)])
    const canvas = (await f.read()).snapshot!
    const owner = await f.runtime.collaboration.enableRoom({ projectId: canvas.projectId, canvasId: canvas.canvasId, snapshot: canvas, deviceId: 'owner', displayName: 'Owner' })
    f.runtime.collaboration.setAgentLeaseReader(() => new Set(['a']))
    const before = f.runtime.collaboration.exportSnapshot(owner.room.roomId)
    const run = await f.runtime.agent.create(f.input, f.runtime.collaboration.createAgentGrant(owner.room.roomId, owner.sessionToken))
    await vi.waitFor(() => expect(['partial', 'paused']).toContain(f.runtime.agent.get(run.id).status))
    expect(f.runtime.collaboration.exportSnapshot(owner.room.roomId)).toEqual(before)
  })
  it('can read again and retry after an unapplied lease conflict', async () => {
    const f = await fixture([]); const canvas = (await f.read()).snapshot!
    const owner = await f.runtime.collaboration.enableRoom({ projectId: canvas.projectId, canvasId: canvas.canvasId, snapshot: canvas, deviceId: 'owner', displayName: 'Owner' })
    let leased = true; f.runtime.collaboration.setAgentLeaseReader(() => new Set(leased ? ['a'] : []))
    let round = 0
    f.runtime.agent.setModelForTesting(async () => {
      round++
      if (round === 2) { leased = false; return call('read_nodes', { nodeIds: ['a'] }) }
      if (round === 1 || round === 3) return runCommand('styles.text', { nodeId: 'a', typography: { fontSize: 32 } })
      return { text: '租约释放后已重读并完成', calls: [] }
    })
    const run = await f.runtime.agent.create(f.input, f.runtime.collaboration.createAgentGrant(owner.room.roomId, owner.sessionToken))
    await vi.waitFor(() => expect(['partial', 'complete']).toContain(f.runtime.agent.get(run.id).status))
    expect(f.runtime.collaboration.exportSnapshot(owner.room.roomId).nodes[0].data).toHaveProperty('fontSize', 32)
  })
  it('rejects stale world geometry when an uncheckpointed parent changes on the commit reread', async () => {
    const f = await fixture([]); const canvas = (await f.read()).snapshot!
    canvas.nodes[0].parentId = 'g'; canvas.nodes[0].position.x = 100
    canvas.nodes.push({ id: 'g', type: 'group', name: 'G', position: { x: 100, y: 0 }, size: { width: 400, height: 300 }, data: { childIds: ['a'] } })
    await f.runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'group-seed', kind: 'save-canvas', expectedRevision: 1, canvas })
    const owner = await f.runtime.collaboration.enableRoom({ projectId: canvas.projectId, canvasId: canvas.canvasId, snapshot: canvas, deviceId: 'owner', displayName: 'Owner' })
    const grant = f.runtime.collaboration.createAgentGrant(owner.room.roomId, owner.sessionToken)
    const exported = f.runtime.collaboration.exportSnapshot.bind(f.runtime.collaboration)
    let armed = false; let reads = 0; let turn = 0
    f.runtime.collaboration.exportSnapshot = id => {
      if (armed && ++reads === 2) {
        const before = exported(id); const human = structuredClone(before); human.nodes.find(n => n.id === 'g')!.position.x = 500
        f.runtime.collaboration.applyAgentChange(grant, before, human)
      }
      return exported(id)
    }
    f.runtime.agent.setModelForTesting(async () => {
      if (turn++) return { text: '保留人工父级移动，需重读', calls: [] }
      armed = true; return runCommand('geometry.align', { nodeIds: ['a', 'b'], alignment: 'left' }, 2)
    })
    const run = await f.runtime.agent.create({ ...f.input, expectedRevision: 2 }, grant)
    await vi.waitFor(() => expect(['partial', 'complete']).toContain(f.runtime.agent.get(run.id).status))
    const actual = exported(owner.room.roomId)
    expect(f.runtime.agent.get(run.id).status).toBe('partial')
    expect(actual.nodes.find(n => n.id === 'g')!.position.x).toBe(500)
    expect(actual.nodes.find(n => n.id === 'a')!.position.x).toBe(100)
  })
  it.each([false, true])('retains the original generation pipeline and stable request identity (stop=%s)', async stop => {
    const f = await fixture([])
    await f.runtime.providers.upsert({ id: 'agent-test', name: 'Test', adapterType: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', enabled: true, preferred: true })
    await f.runtime.providers.setSecret('agent-test', 'test-only')
    const catalog: ProviderCatalog = { providerId: 'agent-test', version: 'v1', fetchedAt: new Date().toISOString(), stale: false, models: [{ mediaType: 'image', channel: 'images', model: 'test-image', qualityOptions: [{ value: 'standard', label: 'Standard', pricing: { type: 'per_item', credits: 1 } }], aspectRatios: ['16:9'], countOptions: [1], countRange: { min: 1, max: 1, options: [1] }, durationOptions: [], modes: ['text2image'], inputLimits: { images: 4, videos: 0, audios: 0 }, raw: {} }] }
    await f.runtime.catalogs.sync('agent-test', async () => catalog)
    f.runtime.agent.setModelForTesting(async ({ messages, system }) => {
      const results = messages.filter(m => m.role === 'tool').map(m => ({ name: m.tool_call_id, value: JSON.parse(String(m.content)) }))
      const created = results.find(r => r.value.command === 'nodes.create')
      const revision = JSON.parse(system.split('Actual current context:\n').at(-1)!).revision
      if (!created) return runCommand('nodes.create', { type: 'image', name: '苹果' }, revision)
      const nodeId = created.value.result.nodeIds[0]
      if (!results.some(r => r.value.command === 'generation.prompt')) return runCommand('generation.prompt', { nodeId, prompt: '红苹果' }, revision)
      if (!results.some(r => r.name === 'request_generation')) return call('request_generation', { nodeId })
      return { text: '完成', calls: [] }
    })
    const submit = vi.fn<typeof f.runtime.submit>(async request => {
      const { job } = await f.runtime.jobs.create(request)
      await f.runtime.jobs.update(job.id, { status: 'running', createAttemptedAt: new Date().toISOString() })
      throw new Error('response lost after accepted generation')
    })
    f.runtime.submit = submit
    const run = await f.runtime.agent.create({ ...f.input, prompt: '生成一张苹果图片' }, { kind: 'local-admin' })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('waiting_generation'))
    await vi.waitFor(() => expect(f.runtime.jobs.list()).toHaveLength(1))
    const job = f.runtime.jobs.list()[0]
    expect(submit).toHaveBeenCalledTimes(1); expect(job.clientRequestId).toMatch(/^agent-/); expect(job.request).toHaveProperty('n', 1)
    if (stop) await f.runtime.agent.control(run.id, { requestId: 'stop', action: 'stop' })
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    const asset = await f.runtime.assets.save({ filename: 'apple.png', contentType: 'image/png', bytes })
    await f.runtime.jobs.update(job.id, { status: 'complete', progress: 100, outputs: [{ assetId: asset.id, url: asset.url, contentType: asset.contentType, size: asset.size }] })
    await vi.waitFor(() => expect(f.runtime.agent.get(run.id).outputs).toHaveLength(1))
    await f.runtime.agent.idle()
    const media = (await f.read()).snapshot!.nodes.find(n => n.type === 'image')!
    expect(media.data).toHaveProperty('promptDraft', '红苹果')
    if (stop) { expect(media.data).not.toHaveProperty('assetId', asset.id); expect(f.runtime.agent.get(run.id).status).toBe('stopped') }
    else { await vi.waitFor(() => expect(f.runtime.agent.get(run.id).status).toBe('complete')); expect(((await f.read()).snapshot!.nodes.find(n => n.type === 'image')!).data).toHaveProperty('assetId', asset.id) }
    expect(submit).toHaveBeenCalledTimes(1)
  })
})
