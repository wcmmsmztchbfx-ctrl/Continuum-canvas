import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const origin = (process.env.CANVAS_AGENT_API_ORIGIN || 'http://127.0.0.1:4173').replace(/\/$/, '')
const token = process.env.CANVAS_AGENT_TOKEN || ''
const defaultCanvasId = process.env.CANVAS_ID || ''

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

const tools = [
  { name: 'canvas_get_context', description: '读取画布、revision、节点和连线。', inputSchema: { type: 'object', properties: { canvasId: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' } } } } },
  { name: 'canvas_find_nodes', description: '按名称、类型或正文关键词查找画布节点。', inputSchema: { type: 'object', properties: { canvasId: { type: 'string' }, query: { type: 'string' }, kind: { type: 'string' } } } },
  { name: 'canvas_create_nodes', description: '原子批量创建画布节点，支持 alias 供同批后续操作引用。', inputSchema: { type: 'object', required: ['nodes'], properties: { canvasId: { type: 'string' }, operationId: { type: 'string' }, baseRevision: { type: 'number' }, nodes: { type: 'array', items: { type: 'object' } } } } },
  { name: 'canvas_update_nodes', description: '原子批量更新节点名称、正文、提示词、位置、尺寸或生成参数。', inputSchema: { type: 'object', required: ['updates'], properties: { canvasId: { type: 'string' }, operationId: { type: 'string' }, baseRevision: { type: 'number' }, updates: { type: 'array', items: { type: 'object' } } } } },
  { name: 'canvas_connect_nodes', description: '建立 flow、output、reference 或 skill 连线。', inputSchema: { type: 'object', required: ['connections'], properties: { canvasId: { type: 'string' }, operationId: { type: 'string' }, baseRevision: { type: 'number' }, connections: { type: 'array', items: { type: 'object' } } } } },
  { name: 'canvas_delete_nodes', description: '删除节点；令牌必须包含 canvas:delete。', inputSchema: { type: 'object', required: ['nodeIds'], properties: { canvasId: { type: 'string' }, operationId: { type: 'string' }, baseRevision: { type: 'number' }, nodeIds: { type: 'array', items: { type: 'string' } } } } },
  { name: 'canvas_auto_layout', description: '对指定节点执行横向分镜、网格或树形布局。', inputSchema: { type: 'object', required: ['strategy'], properties: { canvasId: { type: 'string' }, operationId: { type: 'string' }, baseRevision: { type: 'number' }, strategy: { enum: ['storyboard_horizontal', 'grid', 'tree'] }, nodeIds: { type: 'array', items: { type: 'string' } } } } },
  { name: 'workflow_stage_for_approval', description: '登记候选完整文案及批准后的导演台参数，等待用户选择。', inputSchema: { type: 'object', required: ['canvasId', 'projectId', 'candidates', 'settings'], properties: { canvasId: { type: 'string' }, projectId: { type: 'string' }, candidates: { type: 'array', items: { type: 'object' } }, referenceNodeIds: { type: 'array', items: { type: 'string' } }, skillNodeIds: { type: 'array', items: { type: 'string' } }, settings: { type: 'object' } } } },
  { name: 'workflow_approve', description: '提交用户通过的文案节点；后端将自动并行启动独立导演台。', inputSchema: { type: 'object', required: ['workflowId', 'approvedNodeIds'], properties: { workflowId: { type: 'string' }, approvedNodeIds: { type: 'array', items: { type: 'string' } } } } },
  { name: 'workflow_get', description: '读取工作流、导演任务、选项和所有交付物。', inputSchema: { type: 'object', required: ['workflowId'], properties: { workflowId: { type: 'string' } } } },
  { name: 'workflow_wait', description: '等待工作流发生变化或到达需要用户输入/终态。', inputSchema: { type: 'object', required: ['workflowId'], properties: { workflowId: { type: 'string' }, afterUpdatedAt: { type: 'string' }, timeoutMs: { type: 'number' } } } },
  { name: 'director_answer', description: '回答导演台返回的结构化确认选项。', inputSchema: { type: 'object', required: ['runId', 'value'], properties: { runId: { type: 'string' }, optionId: { type: 'string' }, value: { type: 'string' } } } },
  { name: 'director_retry', description: '按原始参数幂等重试失败的导演任务。', inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' } } } },
]

async function api(path: string, init: RequestInit = {}) {
  if (!token) throw new Error('CANVAS_AGENT_TOKEN is required')
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((payload as any)?.error?.message || `Canvas API returned HTTP ${response.status}`)
  return payload
}

function canvasId(args: Record<string, unknown>) {
  const value = typeof args.canvasId === 'string' && args.canvasId ? args.canvasId : defaultCanvasId
  if (!value) throw new Error('canvasId or CANVAS_ID is required')
  return value
}

async function callTool(name: string, args: Record<string, unknown>) {
  const id = name.startsWith('canvas_') ? canvasId(args) : ''
  if (name === 'canvas_get_context') {
    const query = Array.isArray(args.nodeIds) ? (args.nodeIds as string[]).map((nodeId) => `nodeId=${encodeURIComponent(nodeId)}`).join('&') : ''
    return api(`/api/agent/v1/canvases/${encodeURIComponent(id)}${query ? `?${query}` : ''}`)
  }
  if (name === 'canvas_find_nodes') {
    const result = await api(`/api/agent/v1/canvases/${encodeURIComponent(id)}`) as any
    const query = String(args.query ?? '').toLowerCase()
    const kind = typeof args.kind === 'string' ? args.kind : undefined
    return { revision: result.revision, nodes: result.canvas.nodes.filter((node: any) => (!kind || node.type === kind || node.data?.nodeKind === kind) && (!query || `${node.name}\n${node.data?.text ?? ''}\n${node.data?.promptDraft ?? ''}`.toLowerCase().includes(query))) }
  }
  if (['canvas_create_nodes', 'canvas_update_nodes', 'canvas_connect_nodes', 'canvas_delete_nodes', 'canvas_auto_layout'].includes(name)) {
    let operations: unknown[]
    if (name === 'canvas_create_nodes') operations = (args.nodes as any[]).map((node) => ({ type: 'node.create', alias: node.alias, node }))
    else if (name === 'canvas_update_nodes') operations = (args.updates as any[]).map((item) => ({ type: 'node.update', nodeId: item.nodeId, patch: item.patch ?? item }))
    else if (name === 'canvas_connect_nodes') operations = (args.connections as any[]).map((edge) => ({ type: 'edge.create', alias: edge.alias, edge }))
    else if (name === 'canvas_delete_nodes') operations = (args.nodeIds as string[]).map((nodeId) => ({ type: 'node.delete', nodeId }))
    else operations = [{ type: 'layout.apply', strategy: args.strategy, nodeIds: args.nodeIds }]
    return api(`/api/agent/v1/canvases/${encodeURIComponent(id)}/operations`, { method: 'POST', body: JSON.stringify({ operationId: args.operationId ?? randomUUID(), baseRevision: args.baseRevision, operations }) })
  }
  if (name === 'workflow_stage_for_approval') return api('/api/agent/v1/workflows', { method: 'POST', body: JSON.stringify(args) })
  if (name === 'workflow_approve') return api(`/api/agent/v1/workflows/${encodeURIComponent(String(args.workflowId))}/approve`, { method: 'POST', body: JSON.stringify({ approvedNodeIds: args.approvedNodeIds }) })
  if (name === 'workflow_get') return api(`/api/agent/v1/workflows/${encodeURIComponent(String(args.workflowId))}`)
  if (name === 'workflow_wait') {
    const query = new URLSearchParams({ timeoutMs: String(args.timeoutMs ?? 30_000) })
    if (typeof args.afterUpdatedAt === 'string') query.set('afterUpdatedAt', args.afterUpdatedAt)
    return api(`/api/agent/v1/workflows/${encodeURIComponent(String(args.workflowId))}/wait?${query}`)
  }
  if (name === 'director_answer') return api(`/api/agent/v1/director-runs/${encodeURIComponent(String(args.runId))}/answer`, { method: 'POST', body: JSON.stringify({ optionId: args.optionId, value: args.value }) })
  if (name === 'director_retry') return api(`/api/agent/v1/director-runs/${encodeURIComponent(String(args.runId))}/retry`, { method: 'POST', body: '{}' })
  throw new Error(`Unknown tool: ${name}`)
}

function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', async (line) => {
  let request: JsonRpcRequest
  try { request = JSON.parse(line) } catch { return }
  if (request.id === undefined) return
  try {
    if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'continuum-canvas', version: '1.0.0' } } })
    else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools } })
    else if (request.method === 'tools/call') {
      const params = request.params ?? {}
      const result = await callTool(String(params.name ?? ''), isRecord(params.arguments) ? params.arguments : {})
      send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result } })
    } else send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
  } catch (error) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Canvas MCP operation failed' } })
  }
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
