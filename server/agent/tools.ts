import { AgentError } from './types.ts'
const str = { type: 'string' }; const num = { type: 'number' }; const strings = { type: 'array', items: str, maxItems: 100 }
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'function', function: { name, description, parameters: object(properties, required) } })
export const agentTools = [
  definition('read_skill', 'Read and pin a specialist Skill version.', { id: str }, ['id']),
  definition('read_canvas', 'Read a bounded page of actual nodes and canvas summary.', { offset: num, limit: num }),
  definition('read_nodes', 'Read up to 30 actual nodes and adjacent edges.', { nodeIds: strings }, ['nodeIds']),
  definition('view_image', 'View an explicitly confirmed image attachment; actual previews are included in the next model input.', { referenceId: str }, ['referenceId']),
  definition('generation_config', 'Read actual available media providers and catalog settings. No paid calls.', {}),
  definition('create_node', 'Create one image, video, text or group node; returns its actual nodeId.', {
    type: { type: 'string', enum: ['image', 'video', 'text', 'group'] }, name: str, prompt: str, text: str, x: num, y: num, width: num, height: num,
  }, ['type', 'name']),
  definition('update_node', 'Change only named fields of a previously read authorized node.', { nodeId: str, name: str, prompt: str, text: str }, ['nodeId']),
  definition('delete_nodes', 'Delete authorized nodes only when the user explicitly requested deletion.', { nodeIds: strings }, ['nodeIds']),
  definition('duplicate_node', 'Duplicate an authorized node with a new ID; does not submit generation.', { nodeId: str, name: str }, ['nodeId']),
  definition('move_nodes', 'Move only authorized node positions.', { nodes: { type: 'array', maxItems: 100, items: object({ nodeId: str, x: num, y: num }, ['nodeId', 'x', 'y']) } }, ['nodes']),
  definition('group_nodes', 'Create a group containing authorized top-level nodes.', { nodeIds: strings, name: str }, ['nodeIds', 'name']),
  definition('connect_nodes', 'Create a flow or reference edge between authorized actual node IDs.', { source: str, target: str, relation: { type: 'string', enum: ['flow', 'reference'] } }, ['source', 'target']),
  definition('remove_edge', 'Remove an edge in the authorized scope.', { edgeId: str }, ['edgeId']),
  definition('request_generation', 'Submit one real generation and wait for actual output. Only one attempt per authorized output; no paid automatic retries.', {
    nodeId: str, providerId: str, model: str, aspectRatio: str, quality: str, duration: num, referenceIds: strings,
  }, ['nodeId']),
  definition('ask_user', 'Pause for essential clarification or approval of expanded scope; no further steps until answer.', { title: str, options: { type: 'array', items: str, minItems: 2, maxItems: 6 }, multiple: { type: 'boolean' } }, ['title', 'options']),
  definition('update_plan', 'Persist the actual task plan.', { items: { type: 'array', maxItems: 20, items: object({ id: str, title: str, status: { type: 'string', enum: ['pending', 'running', 'complete', 'failed', 'skipped'] } }, ['id', 'title', 'status']) } }, ['items']),
  definition('report', 'Record a concise factual stage summary.', { text: str }, ['text']),
  definition('focus_nodes', 'Offer a location action; no browser movement is claimed.', { nodeIds: strings }, ['nodeIds']),
]

/** Validate the same bounded schema that is advertised to the model. */
export function validateToolArguments(name: string, args: unknown): void {
  const tool = agentTools.find(t => t.function.name === name)
  if (!tool) throw new AgentError(400, 'unknown_tool', '工具不存在。')
  const validate = (value: unknown, schema: Record<string, unknown>, path: string) => {
    const fail = () => { throw new AgentError(400, 'invalid_tool_arguments', `工具参数 ${path} 不符合约定格式。`) }
    if (schema.enum && !(schema.enum as unknown[]).includes(value)) fail()
    if (schema.type === 'string') { if (typeof value !== 'string' || value.length > 16000) fail() }
    else if (schema.type === 'number') { if (typeof value !== 'number' || !Number.isFinite(value)) fail() }
    else if (schema.type === 'boolean') { if (typeof value !== 'boolean') fail() }
    else if (schema.type === 'array') {
      if (!Array.isArray(value)) fail()
      const values = value as unknown[]
      if (values.length > Number(schema.maxItems ?? 100) || values.length < Number(schema.minItems ?? 0)) fail()
      values.forEach((item, index) => validate(item, schema.items as Record<string, unknown>, `${path}[${index}]`))
    } else if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
      const properties = schema.properties as Record<string, Record<string, unknown>>
      const input = value as Record<string, unknown>
      if ((schema.required as string[]).some(key => !Object.hasOwn(input, key))) fail()
      for (const [key, item] of Object.entries(input)) { if (!Object.hasOwn(properties, key)) fail(); validate(item, properties[key], `${path}.${key}`) }
    }
  }
  validate(args, tool.function.parameters, name)
}
