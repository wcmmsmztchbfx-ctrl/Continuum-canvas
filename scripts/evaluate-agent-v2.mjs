// Explicit opt-in real model evaluation. Source configuration is read only;
// all canvases, tasks and generation stores live in a temporary directory.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createGatewayRuntime } from '../server/runtime.ts'
import { AgentConfigStore } from '../server/agent-config-store.ts'
import { configuredModel } from '../server/agent/model.ts'
import { loadGatewayEnvironment } from '../server/config.ts'
import { defaultInitialCanvas } from '../server/canvas-storage.ts'

const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const source = option('--source')
const output = option('--output')
if (!source || !output) throw new Error('Usage: node scripts/evaluate-agent-v2.mjs --source /absolute/project --output /absolute/report.json')
const temporary = await mkdtemp(join(tmpdir(), 'continuum-real-agent-eval-'))
const report = { kind: 'real-model', startedAt: new Date().toISOString(), status: 'blocked', cases: [], reason: '' }
let runtime
try {
  const configDir = join(temporary, 'configuration'); await mkdir(configDir)
  let records = '[]'
  try { records = await readFile(join(resolve(source), 'data/agent-providers.json'), 'utf8') } catch { /* no configuration */ }
  await writeFile(join(configDir, 'agent-providers.json'), records)
  const loaded = await loadGatewayEnvironment({ rootDir: resolve(source) })
  const config = await AgentConfigStore.open({ dataDir: configDir, env: loaded.env })
  const provider = config.getPreferred()?.secretConfigured ? config.getPreferred() : config.listPublic().find(p => p.enabled && p.secretConfigured)
  if (!provider?.enabled || !provider.secretConfigured) report.reason = 'No configured Agent model. No external request was made.'
  else {
    report.provider = { id: provider.id, model: provider.model }
    const real = configuredModel(config); let trace = []
    runtime = await createGatewayRuntime({ dataDir: join(temporary, 'runtime'), envFile: join(temporary, 'runtime.env'), env: { CANVAS_AGENT_RUNTIME_VERSION: '2' }, agentModel: async input => {
      const turn = await real(input); trace.push({ tools: turn.calls.map(c => ({ name: c.name, arguments: c.arguments })) }); return turn
    } })
    const text = (id, x, width = 100) => ({ id, type: 'text', name: id, position: { x, y: 0 }, size: { width, height: 80 }, data: { text: id, nodeKind: 'text' } })
    const seed = [text('a', 0), text('b', 240, 140), text('c', 600)]
    const cases = [
      { id: 'distribution', prompt: '把已选的 a、b、c 横向等距，固定 a 和 c 的位置，按节点实际宽度计算相邻空隙。', nodes: seed, check: s => s.nodes.map(n => n.position.x).join(',') === '0,280,600' },
      { id: 'typography', prompt: '把已选文字 a 的字号设为 32，居中对齐。保留文字内容和其它节点。', nodes: seed, check: s => s.nodes[0].data.fontSize === 32 && s.nodes[0].data.textAlign === 'center' && s.nodes[0].data.text === 'a' && s.nodes[1].position.x === 240 },
      { id: 'create-and-connect', prompt: '创建一个名为「画框」的 frame、一个名为「标题」内容为「夏日」的文字节点。把标题移入画框，保持标题世界坐标，并用 flow 线从标题连接到已选节点 a。', nodes: seed, check: s => { const title = s.nodes.find(n => n.name === '标题'); const frame = s.nodes.find(n => n.name === '画框'); return title?.type === 'text' && frame?.type === 'frame' && title.parentId === frame.id && s.edges.some(e => e.source === title.id && e.target === 'a') } },
      { id: 'reference-without-generation', prompt: '把已选图片 ref-a 设为 ref-b 的第一张引用，将 ref-b 提示词设为「红苹果，参考 @1」。只改配置，不要生成。', nodes: ['ref-a', 'ref-b'].map(id => ({ ...text(id, 0), type: 'image', data: { url: '' } })), check: s => s.edges.some(e => e.source === 'ref-a' && e.target === 'ref-b' && e.referenceAlias === 1) && s.nodes.find(n => n.id === 'ref-b').data.promptDraft === '红苹果，参考 @1' },
    ]
    for (const item of cases) {
      trace = []; const canvasId = `eval-${item.id}`
      await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: `seed-${item.id}`, kind: 'save-canvas', expectedRevision: 0, canvas: { ...defaultInitialCanvas(canvasId, 'eval', item.id), nodes: item.nodes } })
      const run = await runtime.agent.create({ requestId: item.id, canvasId, expectedRevision: 1, selectedNodeIds: item.nodes.map(n => n.id), attachments: [], prompt: `只编辑画布，不要生成或提交任何媒体任务。${item.prompt}` }, { kind: 'local-admin' })
      const deadline = Date.now() + 180_000
      while (['queued', 'running'].includes(runtime.agent.get(run.id).status) && Date.now() < deadline) await delay(250)
      const result = runtime.agent.get(run.id); const state = await runtime.workspace.getCanvasRecord(canvasId)
      const names = trace.flatMap(t => t.tools.map(c => c.name))
      const mechanism = names.includes('list_canvas_commands') && names.includes('describe_canvas_command') && names.includes('read_nodes') && runtime.jobs.list().length === 0
      let passed = result.status === 'complete' && item.check(state.snapshot) && mechanism
      // Exercise conditional undo on real model changes after a human addition.
      const human = text(`human-${item.id}`, 1200)
      await runtime.workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: `human-${item.id}`, kind: 'save-canvas', expectedRevision: state.revision, canvas: { ...state.snapshot, nodes: [...state.snapshot.nodes, human] } })
      await runtime.agent.control(run.id, { requestId: `undo-${item.id}`, action: 'undo' })
      const undone = await runtime.workspace.getCanvasRecord(canvasId)
      const retainedHuman = undone.snapshot.nodes.some(n => n.id === human.id)
      passed &&= retainedHuman
      report.cases.push({ id: item.id, status: passed ? 'passed' : 'failed', taskStatus: result.status, retainedHuman, trace, events: result.events, snapshot: state.snapshot })
    }
    report.status = report.cases.every(c => c.status === 'passed') ? 'passed' : 'failed'
  }
} catch (error) { report.status = 'failed'; report.reason = String(error?.message ?? 'Evaluation failed') }
finally {
  await runtime?.close(); await rm(temporary, { recursive: true, force: true })
  report.finishedAt = new Date().toISOString()
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, output: resolve(output), reason: report.reason }))
  process.exitCode = report.status === 'passed' ? 0 : report.status === 'blocked' ? 2 : 1
}
