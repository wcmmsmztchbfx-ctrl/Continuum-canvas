// Test-only upstreams. Loaded exclusively by the isolated E2E gateway.
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const origin = 'https://agent-fixture.example'
const call = (name, args, id = name) => ({ calls: [{ id, name, arguments: args }] })
export async function agentFixtureModel({ system, messages, signal, hasImages, tools }) {
  const prompt = messages.find(message => message.role === 'user' && typeof message.content === 'string')?.content ?? ''
  const results = messages.filter(message => message.role === 'tool').map(message => ({
    id: message.tool_call_id, value: JSON.parse(String(message.content)),
  }))
  const v2 = tools.some(tool => tool.function.name === 'run_canvas_command')
  if (v2 && prompt.includes('新版画布操作验收')) {
    const context = JSON.parse(system.split('Actual current context:\n').at(-1))
    const execute = (command, parameters, id) => call('run_canvas_command', { command, parameters, expectedRevision: context.revision }, id)
    if (!results.length) return call('list_canvas_commands', {}, 'fixture-discovery')
    if (!results.some(r => r.id === 'fixture-description')) return call('describe_canvas_command', { command: 'nodes.create' }, 'fixture-description')
    const created = results.find(r => r.id === 'fixture-v2-create')
    if (!created) return execute('nodes.create', { type: 'text', name: '新版标题', text: '画布操作验收', position: { x: 120, y: 140 } }, 'fixture-v2-create')
    if (!created.value.committed || !created.value.verified) throw new Error('V2 creation did not produce a verified receipt')
    if (!results.some(r => r.id === 'fixture-v2-style')) return execute('styles.text', { nodeId: created.value.result.nodeIds[0], typography: { fontSize: 32, textAlign: 'center' } }, 'fixture-v2-style')
    if (!results.some(r => r.id === 'fixture-v2-readback')) return call('read_nodes', { nodeIds: created.value.result.nodeIds }, 'fixture-v2-readback')
    return { text: '已创建标题、设置样式并回读核验', calls: [] }
  }
  if (prompt.includes('检查引用')) {
    const count = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url').length
    if (hasImages !== (count > 0)) throw new Error('Fixture image metadata did not match actual image inputs')
    return { text: `已查看 ${count} 张引用图片`, calls: [] }
  }
  if (prompt.includes('缓慢') && results.length === 0) await delay(3000, undefined, { signal })
  if (prompt.includes('澄清') && !results.some(result => result.id === 'fixture-question')) {
    return call('ask_user', { title: '想要哪种苹果？', options: ['写实水果', '扁平插画'] }, 'fixture-question')
  }
  const created = results.find(result => result.id === 'fixture-create')
  if (!created) return call('create_node', { type: 'image', name: 'Agent 苹果', prompt: '一颗红苹果，干净背景' }, 'fixture-create')
  if (!created.value.nodeId) throw new Error('create_node did not return its actual node ID')
  if (prompt.includes('只写提示词')) return { text: '已创建苹果节点并写入提示词', calls: [] }
  if (!results.some(result => result.id === 'fixture-generation')) {
    return call('request_generation', { nodeId: created.value.nodeId }, 'fixture-generation')
  }
  return { text: '已生成 1 张苹果图片', calls: [] }
}

export async function createAgentFixtureOptions() {
  const bytes = await readFile(new URL('../tests/fixtures/test-assets/sample-image.png', import.meta.url))
  const catalog = {
    providerId: 'aistartlab', version: 'e2e-agent-v1', fetchedAt: new Date().toISOString(), stale: false,
    models: [{ mediaType: 'image', channel: 'images', model: 'e2e-image', title: 'E2E Image',
      qualityOptions: [{ value: 'standard', label: 'Standard', pricing: { type: 'per_item', credits: 1 } }],
      aspectRatios: ['1:1', '16:9'], countOptions: [1], countRange: { min: 1, max: 1, options: [1] }, durationOptions: [], modes: ['text2image', 'image2image'],
      inputLimits: { images: 4, videos: 0, audios: 0 }, raw: {} }],
  }
  const status = taskId => ({ taskId, status: 3, progress: 100, outputs: [`${origin}/output.png`] })
  return {
    agentModel: agentFixtureModel,
    adapterFactory: () => ({
      testConnection: async () => {}, syncCatalog: async () => catalog,
      presignReference: async () => ({ fileKey: 'fixture-reference', uploadUrl: `${origin}/upload`, method: 'PUT', headers: {}, expiresAt: Date.now() + 60_000 }),
      uploadReference: async () => {}, completeReference: async () => ({ url: `${origin}/reference.png` }),
      createGeneration: async request => `fixture-${request.clientRequestId}`,
      getGenerationStatus: async taskIds => taskIds.map(status), getGenerationDetail: async taskId => status(taskId),
    }),
    lookup: async hostname => {
      if (hostname !== 'agent-fixture.example') throw new Error('External E2E DNS is disabled')
      return [{ address: '93.184.216.34', family: 4 }]
    },
    pinnedFetcher: async url => {
      if (new URL(url).origin !== origin) throw new Error('External E2E fetch is disabled')
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) } })
    },
  }
}
