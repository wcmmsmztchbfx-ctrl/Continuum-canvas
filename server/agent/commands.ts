import { createCanvasStore } from '../../src/store/canvas-store.ts'
import { absolutePositions } from '../../src/store/storeHelpers.ts'
import { parseCanvasSnapshot, DEFAULT_IMAGE_GENERATION_SETTINGS, DEFAULT_VIDEO_GENERATION_SETTINGS } from '../../src/model/project.ts'
import type { CanvasNode, CanvasSnapshotV2, MediaGenerationSettings, NodeSize, PathAnchor, Point } from '../../src/model/project.ts'
import type { CanvasStoreState } from '../../src/store/types.ts'
import { AgentError } from './types.ts'
import { array, boolean, bounded, enumeration, identifier, number, object, string, validateCommandSchema, type Schema } from './command-schema.ts'

type Args = Record<string, unknown>
export interface CommandContext { assets?: Record<string, { id: string; url: string; contentType: string }>; timestamp?: string }
type Handler = (state: CanvasStoreState, args: Args, id: string, context: CommandContext) => unknown
interface Command {
  name: string; group: string; description: string; parameters: Schema
  limits: string[]; examples: Args[]; verification: string[]; run: Handler
}
const registry = new Map<string, Command>()
const point = object({ x: number, y: number }, ['x', 'y'])
const size = object({ width: bounded(1, 16384), height: bounded(1, 16384) }, ['width', 'height'])
const nodeIds = array(identifier, 1)
const anchor = object({ x: number, y: number, in: point, out: point }, ['x', 'y'])
const anchors = array(anchor, 2, 1000)
const unit = bounded(0, 1)
const nonnegative = bounded(0, 16384)
const shadow = object({ x: number, y: number, blur: nonnegative, color: string }, ['x', 'y', 'blur', 'color'])
const fill = object({ id: identifier, color: string, opacity: unit, enabled: boolean }, ['id', 'color', 'enabled'])
const stroke = object({ id: identifier, color: string, width: nonnegative, style: enumeration('solid', 'dashed'), opacity: unit, enabled: boolean, position: enumeration('outside', 'center', 'inside') }, ['id', 'color', 'width', 'enabled'])
const effect = object({ id: identifier, type: enumeration('drop-shadow', 'inner-shadow', 'layer-blur', 'background-blur', 'noise', 'texture', 'glass', 'shader'), enabled: boolean, x: number, y: number, blur: nonnegative, spread: number, color: string, radius: nonnegative, intensity: nonnegative, specular: nonnegative, tint: string, preset: string }, ['id', 'type', 'enabled'])
const commonStyles = {
  fills: array(fill), strokes: array(stroke), effects: array(effect), opacity: unit,
  stroke: string, strokeWidth: nonnegative, strokeStyle: enumeration('solid', 'dashed'),
  strokePosition: enumeration('outside', 'center', 'inside'), blur: nonnegative, shadow,
}
const styleProperties = { ...commonStyles, fill: string, radius: nonnegative, objectFit: enumeration('cover', 'contain', 'fill') }
const typography = { text: string, fontFamily: string, fontSize: bounded(1, 4096), fontWeight: bounded(1, 1000), color: string, textAlign: enumeration('left', 'center', 'right'), lineHeight: bounded(0.1, 100), letterSpacing: number, autoWidth: boolean, presentation: enumeration('plain', 'workflow-card') }
const settings = object({ kind: enumeration('image', 'video'), providerId: string, catalogVersion: string, channel: { type: ['string', 'number'], maxLength: 256 }, model: string, mode: string, quality: string, resolution: string, aspectRatio: string, count: bounded(1, 16), durationSec: bounded(1, 3600), generateAudio: boolean }, ['kind', 'resolution', 'aspectRatio', 'count'])
function register(name: string, description: string, properties: Record<string, Schema>, required: string[], example: Args, run: Handler, limits: string[] = []) {
  registry.set(name, { name, group: name.startsWith('path.') ? 'styles' : name.split('.')[0], description, parameters: object(properties, required),
    limits: ['仅初始选区与本任务新建节点；先 read_nodes；完整影响集均需授权。', ...limits], examples: [example], verification: ['read_nodes 回读受影响节点的实际字段、parentId 和关联边；对照回执修订号。'], run })
}
function target(s: CanvasStoreState, id: unknown, types?: CanvasNode['type'][]): CanvasNode {
  const node = s.snapshot.nodes.find(n => n.id === id)
  if (!node) throw new AgentError(409, 'node_missing', '目标节点不存在。')
  if (types && !types.includes(node.type)) throw new AgentError(400, 'unsupported_node_type', '该操作不支持此节点类型。')
  return node
}
function targets(s: CanvasStoreState, ids: unknown): CanvasNode[] { return (ids as string[]).map(id => target(s, id)) }
function dataPatch(s: CanvasStoreState, id: unknown, data: Args) { s.patchNode(String(id), { data }) }
function uniqueLayers(style: Args) {
  for (const key of ['fills', 'strokes', 'effects']) if (Array.isArray(style[key])) {
    const ids = (style[key] as Args[]).map(x => x.id)
    if (new Set(ids).size !== ids.length) throw new AgentError(400, 'duplicate_layer_id', '样式层编号重复。')
  }
}

register('nodes.create', '创建实际类型节点，不生成媒体；坐标与尺寸单位 px。', { type: enumeration('image', 'video', 'text', 'group', 'frame', 'shape', 'path'), name: identifier, position: point, size, text: string, variant: enumeration('audio', 'script', 'skill', 'director', 'video-clip'), anchors, closed: boolean }, ['type', 'name'], { type: 'text', name: '标题', text: '你好', position: { x: 0, y: 0 } }, (s, a, id) => {
  const kind = a.type as CanvasNode['type']
  if (a.variant && !(kind === 'text' ? ['audio', 'script', 'skill'] : kind === 'group' ? ['director', 'video-clip'] : []).includes(String(a.variant))) throw new AgentError(400, 'unsupported_variant', '卡片变体与节点类型不匹配。')
  if ((a.anchors || a.closed !== undefined) && kind !== 'path') throw new AgentError(400, 'unsupported_node_type', '锚点仅适用于路径。')
  if (a.text !== undefined && kind !== 'text') throw new AgentError(400, 'unsupported_node_type', '文字仅适用于文字节点。')
  const defaults: Record<CanvasNode['type'], NodeSize> = { image: { width: 320, height: 240 }, video: { width: 320, height: 240 }, text: { width: 160, height: 42 }, group: { width: 520, height: 360 }, frame: { width: 640, height: 420 }, shape: { width: 220, height: 150 }, path: { width: 100, height: 100 } }
  const data = kind === 'image' ? { url: '', generationSettings: { ...DEFAULT_IMAGE_GENERATION_SETTINGS } } : kind === 'video' ? { url: '', generationSettings: { ...DEFAULT_VIDEO_GENERATION_SETTINGS } } : kind === 'text' ? { text: a.text ?? '', nodeKind: a.variant ?? 'text', presentation: a.variant ? 'workflow-card' : 'plain', fontFamily: 'Noto Sans SC', fontSize: 24, fontWeight: 500, color: '#f4f4f4', lineHeight: 1.4, autoWidth: true } : kind === 'group' ? { childIds: [], nodeKind: a.variant ?? 'group' } : kind === 'frame' ? { childIds: [], fill: 'rgba(24,24,24,0.12)', stroke: '#777', strokeWidth: 1, rotation: 0 } : kind === 'shape' ? { kind: 'rectangle', fill: '#d9d9d9', stroke: '#8c8c8c', strokeWidth: 1, opacity: 1, radius: 0, rotation: 0 } : { kind: 'pen', anchors: a.anchors ?? [{ x: 0, y: 0 }, { x: 100, y: 100 }], closed: a.closed ?? false, stroke: '#f4f4f4', strokeWidth: 2 }
  s.addNode({ id, type: kind, name: a.name, position: a.position ?? { x: 0, y: 0 }, size: a.size ?? defaults[kind], data } as CanvasNode)
  return { nodeIds: [id] }
}, ['Agent 默认尺寸独立于手工入口：image/video 320×240；text 160×42；group 520×360；frame 640×420；shape 220×150；path 100×100。'])
register('nodes.rename', '修改节点名称。', { nodeId: identifier, name: identifier }, ['nodeId', 'name'], { nodeId: 'a', name: '标题' }, (s, a) => { target(s, a.nodeId); s.renameNode(String(a.nodeId), String(a.name)) })
register('nodes.delete', '删除节点；未删除的容器子节点按原规则释放并保持世界坐标。', { nodeIds }, ['nodeIds'], { nodeIds: ['a'] }, (s, a) => { targets(s, a.nodeIds); s.deleteNodes(a.nodeIds as string[]) })
register('nodes.duplicate', '按现有复制规则复制节点、分组后代与关联边；不生成媒体。', { nodeIds }, ['nodeIds'], { nodeIds: ['a'] }, (s, a) => { targets(s, a.nodeIds); return { nodeIds: s.duplicateNodes(a.nodeIds as string[]) } })
register('geometry.move', '设置父级局部坐标，单位 px。', { moves: array(object({ nodeId: identifier, position: point }, ['nodeId', 'position']), 1) }, ['moves'], { moves: [{ nodeId: 'a', position: { x: 40, y: 80 } }] }, (s, a) => {
  const moves = a.moves as { nodeId: string; position: Point }[]; moves.forEach(m => target(s, m.nodeId)); s.moveNodes(moves.map(m => ({ id: m.nodeId, position: m.position })))
})
register('geometry.resize', '设置尺寸，可同时设置局部坐标；不会改变父级。', { nodeId: identifier, size, position: point }, ['nodeId', 'size'], { nodeId: 'a', size: { width: 200, height: 100 } }, (s, a) => { target(s, a.nodeId); s.resizeNode(String(a.nodeId), a.size as NodeSize, a.position as Point | undefined) })
register('geometry.rotate', '设置旋转角度，单位 degree；group/path 无独立旋转字段。', { nodeId: identifier, rotation: bounded(-36000, 36000) }, ['nodeId', 'rotation'], { nodeId: 'a', rotation: 30 }, (s, a) => { target(s, a.nodeId, ['image', 'video', 'text', 'frame', 'shape']); dataPatch(s, a.nodeId, { rotation: a.rotation }) })
register('geometry.layout', '复用原智能网格算法；横纵间距固定 48px，保持包围盒中心。', { nodeIds }, ['nodeIds'], { nodeIds: ['a', 'b'] }, (s, a) => { targets(s, a.nodeIds); s.layoutNodes(a.nodeIds as string[]) })
register('geometry.align', '按未旋转世界包围盒对齐；left/right/top/bottom/center-x/center-y。', { nodeIds, alignment: enumeration('left', 'right', 'top', 'bottom', 'center-x', 'center-y') }, ['nodeIds', 'alignment'], { nodeIds: ['a', 'b'], alignment: 'left' }, (s, a) => {
  const nodes = targets(s, a.nodeIds); const world = absolutePositions(s.snapshot.nodes)
  const axis = ['top', 'bottom', 'center-y'].includes(String(a.alignment)) ? 'y' : 'x'
  const extent = (n: CanvasNode) => axis === 'x' ? n.size.width : n.size.height
  const low = Math.min(...nodes.map(n => world.get(n.id)![axis])); const high = Math.max(...nodes.map(n => world.get(n.id)![axis] + extent(n)))
  s.moveNodes(nodes.map(n => { const previous = world.get(n.id)![axis]; const next = ['left', 'top'].includes(String(a.alignment)) ? low : ['right', 'bottom'].includes(String(a.alignment)) ? high - extent(n) : (low + high - extent(n)) / 2
    return { id: n.id, position: { ...n.position, [axis]: n.position[axis] + next - previous } } }))
}, ['同一命令不能同时选择祖先与后代。'])
register('geometry.distribute', '按世界坐标排列，固定首尾，将中间空隙等分；允许负间距。', { nodeIds, axis: enumeration('x', 'y') }, ['nodeIds', 'axis'], { nodeIds: ['a', 'b', 'c'], axis: 'x' }, (s, a) => {
  const nodes = targets(s, a.nodeIds); if (nodes.length < 3) throw new AgentError(400, 'too_few_nodes', '等距至少需要三个节点。')
  const axis = a.axis as 'x' | 'y'; const world = absolutePositions(s.snapshot.nodes)
  nodes.sort((a, b) => world.get(a.id)![axis] - world.get(b.id)![axis] || a.id.localeCompare(b.id))
  const extent = (n: CanvasNode) => axis === 'x' ? n.size.width : n.size.height
  const end = nodes.at(-1)!; const start = world.get(nodes[0].id)![axis]
  const gap = (world.get(end.id)![axis] + extent(end) - start - nodes.reduce((v, n) => v + extent(n), 0)) / (nodes.length - 1)
  let cursor = start; const moves = nodes.map(n => { const p = cursor; cursor += extent(n) + gap; return { id: n.id, position: { ...n.position, [axis]: n.position[axis] + p - world.get(n.id)![axis] } } }); s.moveNodes(moves)
}, ['至少三个节点；不可同时选择祖先与后代。'])
register('hierarchy.group', '按手工编组规则创建分组，保留 40px padding 与 60px 标题区。', { nodeIds, name: identifier }, ['nodeIds', 'name'], { nodeIds: ['a', 'b'], name: '分组' }, (s, a, id) => { const nodes = targets(s, a.nodeIds); if (nodes.length < 2 || nodes.some(n => n.parentId)) throw new AgentError(400, 'invalid_group', '编组需要至少两个顶层节点。'); s.groupNodes(a.nodeIds as string[], id, String(a.name)); return { nodeIds: [id] } })
register('hierarchy.ungroup', '解组并释放子节点，清理原容器连线。', { nodeIds }, ['nodeIds'], { nodeIds: ['group-id'] }, (s, a) => { (a.nodeIds as string[]).forEach(id => target(s, id, ['group'])); s.ungroupNodes(a.nodeIds as string[]) })
register('hierarchy.reparent', '更改父级并保持世界坐标；省略 parentId 释放到根。index 为同级插入位置。', { nodeIds, parentId: identifier, index: bounded(0, 100000) }, ['nodeIds'], { nodeIds: ['a'], parentId: 'frame-id' }, (s, a) => { targets(s, a.nodeIds); if (a.parentId) target(s, a.parentId, ['group', 'frame']); if (!s.reparentNodes(a.nodeIds as string[], a.parentId as string | undefined, a.index as number | undefined)) throw new AgentError(400, 'invalid_hierarchy', '父级无效或产生循环。') })
register('hierarchy.layer', '在当前同级中置顶或置底。', { nodeId: identifier, direction: enumeration('front', 'back') }, ['nodeId', 'direction'], { nodeId: 'a', direction: 'front' }, (s, a) => { target(s, a.nodeId); s.moveNodeLayer(String(a.nodeId), a.direction as 'front' | 'back') })
register('hierarchy.reorder', '相对另一个节点排序或移入容器，保持世界坐标。', { nodeIds, targetId: identifier, placement: enumeration('before', 'after', 'inside') }, ['nodeIds', 'targetId', 'placement'], { nodeIds: ['a'], targetId: 'b', placement: 'after' }, (s, a) => { targets(s, a.nodeIds); target(s, a.targetId); if (!s.reorderNodes(a.nodeIds as string[], String(a.targetId), a.placement as 'before' | 'after' | 'inside')) throw new AgentError(400, 'invalid_hierarchy', '排序无效。') })
register('nodes.rename_canvas', '修改画布名称，不改变相机。需要任务初始选区或本任务新建节点作为授权锚点。', { name: identifier }, ['name'], { name: '分镜草案' }, (s, a) => s.renameCanvas(String(a.name)))
register('styles.set', '按实际节点类型更新明确样式字段；数组整体替换，空数组覆盖旧字段回退。', { nodeId: identifier, style: object(styleProperties) }, ['nodeId', 'style'], { nodeId: 'a', style: { opacity: 0.8 } }, (s, a) => {
  const node = target(s, a.nodeId, ['image', 'video', 'text', 'frame', 'shape', 'path']); const style = a.style as Args
  const supported = { ...commonStyles, ...(['frame', 'shape', 'path'].includes(node.type) ? { fill: string } : {}), ...(['image', 'video', 'shape'].includes(node.type) ? { radius: nonnegative } : {}), ...(['image', 'video'].includes(node.type) ? { objectFit: string } : {}) }
  validateCommandSchema(style, object(supported)); uniqueLayers(style); dataPatch(s, a.nodeId, style)
}, ['group 不支持样式；radius 仅 image/video/shape；fill 仅 frame/shape/path；objectFit 仅 image/video。'])
register('styles.text', '更新文字及文字排版字段。', { nodeId: identifier, typography: object(typography) }, ['nodeId', 'typography'], { nodeId: 'a', typography: { fontSize: 32, textAlign: 'center' } }, (s, a) => { target(s, a.nodeId, ['text']); dataPatch(s, a.nodeId, a.typography as Args) })
register('styles.flags', '设置锁定与可见性；解锁仍限本任务授权节点。', { nodeId: identifier, locked: boolean, visible: boolean }, ['nodeId'], { nodeId: 'a', visible: false }, (s, a) => { const node = target(s, a.nodeId); const legacy: Args = {}; if ('locked' in node.data && a.locked !== undefined) legacy.locked = a.locked; if ('hidden' in node.data && a.visible !== undefined) legacy.hidden = !a.visible; if (Object.keys(legacy).length) dataPatch(s, node.id, legacy); if (a.locked !== undefined) s.setNodeLocked(node.id, a.locked as boolean); if (a.visible !== undefined) s.setNodeVisibility(node.id, a.visible as boolean) })
register('styles.shape', '更新形状类型与圆角。', { nodeId: identifier, kind: enumeration('rectangle', 'rounded-rectangle', 'ellipse', 'line', 'arrow'), radius: nonnegative }, ['nodeId', 'kind'], { nodeId: 'shape-id', kind: 'ellipse' }, (s, a) => { target(s, a.nodeId, ['shape']); dataPatch(s, a.nodeId, { kind: a.kind, ...(a.radius !== undefined ? { radius: a.radius } : {}) }) })
register('path.set', '更新路径锚点（节点局部 px）、闭合状态与 pen/brush 类型。', { nodeId: identifier, anchors, closed: boolean, kind: enumeration('pen', 'brush') }, ['nodeId', 'anchors', 'closed'], { nodeId: 'path-id', anchors: [{ x: 0, y: 0 }, { x: 100, y: 80 }], closed: false }, (s, a) => { target(s, a.nodeId, ['path']); dataPatch(s, a.nodeId, { anchors: a.anchors as PathAnchor[], closed: a.closed, ...(a.kind ? { kind: a.kind } : {}) }) })
register('edges.connect', '连接两个现有节点；不设置或改写媒体引用。', { source: identifier, target: identifier, relation: enumeration('flow', 'output') }, ['source', 'target'], { source: 'a', target: 'b', relation: 'flow' }, (s, a, id) => { target(s, a.source); target(s, a.target); if (a.source === a.target) throw new AgentError(400, 'self_edge', '不能连接自身。'); s.addEdge({ id: id.replace('agent-node-', 'agent-edge-'), source: String(a.source), target: String(a.target), relation: (a.relation ?? 'flow') as 'flow' | 'output' }) })
register('edges.remove', '移除指定连线；引用线移除会整理别名与提示词。', { edgeIds: array(identifier, 1) }, ['edgeIds'], { edgeIds: ['edge-id'] }, (s, a) => { for (const id of a.edgeIds as string[]) if (!s.snapshot.edges.some(e => e.id === id)) throw new AgentError(409, 'edge_missing', '连线不存在。'); s.deleteEdges(a.edgeIds as string[]) })
register('references.attach', '为图片/视频目标附加图片/视频引用，复用真实数字 @别名规则。', { source: identifier, target: identifier }, ['source', 'target'], { source: 'image-a', target: 'image-b' }, (s, a) => { target(s, a.source, ['image', 'video']); target(s, a.target, ['image', 'video']); const edge = s.attachReference(String(a.target), String(a.source)); if (!edge) throw new AgentError(400, 'invalid_reference', '引用关系无效。'); return { edgeId: edge.id, referenceAlias: edge.referenceAlias } })
register('references.detach', '移除引用并压紧剩余别名、改写目标提示词。', { source: identifier, target: identifier }, ['source', 'target'], { source: 'image-a', target: 'image-b' }, (s, a) => { target(s, a.source); target(s, a.target); s.detachReference(String(a.target), String(a.source)) })
register('assets.associate', '关联已有稳定素材身份；后端校验素材实际存在且类型匹配，不上传、不编辑媒体。', { nodeId: identifier, assetId: identifier }, ['nodeId', 'assetId'], { nodeId: 'image-a', assetId: 'asset-id' }, (s, a, id, context) => {
  const node = target(s, a.nodeId, ['image', 'video', 'text']); const asset = context.assets?.[String(a.assetId)]
  const expected = node.type === 'image' ? 'image/' : node.type === 'video' ? 'video/' : node.type === 'text' && node.data.nodeKind === 'audio' ? 'audio/' : undefined
  if (!asset || !expected || !asset.contentType.startsWith(expected)) throw new AgentError(400, 'asset_type_mismatch', '素材不存在或类型与节点不匹配。')
  if ((node.type === 'image' || node.type === 'video') && node.data.generation?.status === 'generating') throw new AgentError(409, 'node_busy', '生成中的媒体不能替换素材。')
  if (node.type === 'image') s.addImageVersion(node.id, { id: id.replace('agent-node-', 'agent-version-'), url: asset.url, assetId: asset.id, createdAt: context.timestamp ?? '1970-01-01T00:00:00.000Z', label: '素材关联', ...(node.data.activeVersionId ? { sourceVersionId: node.data.activeVersionId } : {}) })
  else dataPatch(s, node.id, { assetId: asset.id, url: asset.url, ...(node.type === 'video' ? { poster: undefined, durationSec: undefined, hasAudio: undefined } : {}) })
  if (node.type === 'image') dataPatch(s, node.id, { thumbnailUrl: undefined })
  return { assetId: asset.id }
}, ['适配层解析 assetId，客户端或模型不能传入任意 url；图片沿用现有版本追加规则。'])
register('assets.image_version', '切换图片已有版本；不创建浏览器编辑结果。', { nodeId: identifier, versionId: identifier }, ['nodeId', 'versionId'], { nodeId: 'image-a', versionId: 'version-id' }, (s, a) => { const node = target(s, a.nodeId, ['image']); if (node.type !== 'image' || !node.data.versions?.some(v => v.id === a.versionId)) throw new AgentError(409, 'version_missing', '图片版本不存在。'); s.setImageVersion(node.id, String(a.versionId)) })
register('generation.prompt', '只更新图片/视频提示词，不隐式生成。', { nodeId: identifier, prompt: string }, ['nodeId', 'prompt'], { nodeId: 'image-a', prompt: '一颗红苹果，参考 @1' }, (s, a) => { target(s, a.nodeId, ['image', 'video']); s.updateGenerationPrompt(String(a.nodeId), String(a.prompt)) })
register('generation.settings', '更新完整图片/视频生成配置，沿用现有比例尺寸规则；不隐式生成。', { nodeId: identifier, settings }, ['nodeId', 'settings'], { nodeId: 'image-a', settings: { kind: 'image', quality: 'standard', resolution: '2K', aspectRatio: '1:1', count: 1 } }, (s, a) => {
  const node = target(s, a.nodeId, ['image', 'video']); const value = a.settings as Args
  if (value.kind !== node.type || !Number.isInteger(value.count)) throw new AgentError(400, 'invalid_settings', '生成类型或数量无效。')
  const properties = { ...settings.properties! }; for (const key of node.type === 'image' ? ['durationSec', 'generateAudio'] : ['quality']) delete properties[key]
  validateCommandSchema(value, object(properties, node.type === 'image' ? ['kind', 'quality', 'resolution', 'aspectRatio', 'count'] : ['kind', 'resolution', 'aspectRatio', 'count', 'durationSec', 'generateAudio']))
  s.updateGenerationSettings(node.id, value as unknown as MediaGenerationSettings)
}, ['需先 generation_config 查询真实模型目录。正式生成仍调用 request_generation，沿用预算和稳定请求身份。'])

export function listCanvasCommands() { return [...registry.values()].map(c => ({ name: c.name, group: c.group, description: c.description })) }
export function describeCanvasCommand(name: string) {
  const command = registry.get(name)
  if (!command) throw new AgentError(400, 'unknown_canvas_command', '画布命令不存在。')
  return { name, description: command.description, parameters: structuredClone(command.parameters), units: 'position/size/path: px; rotation: degree; opacity: 0..1', limits: command.limits, examples: structuredClone(command.examples), verification: command.verification, validate: (args: unknown) => validateCommandSchema(args, command.parameters) }
}
export function computeCanvasCommand(snapshot: CanvasSnapshotV2, name: string, args: Args, operationId: string, context: CommandContext = {}) {
  describeCanvasCommand(name).validate(args)
  const store = createCanvasStore({ ...structuredClone(snapshot), version: 1 })
  // World-coordinate layout of an ancestor and descendant together is ambiguous.
  if (name === 'geometry.align' || name === 'geometry.distribute') {
    const selected = new Set(args.nodeIds as string[])
    for (const n of targets(store.getState(), args.nodeIds)) {
      let parent = n.parentId
      while (parent) { if (selected.has(parent)) throw new AgentError(400, 'nested_layout', '请分开操作容器与其后代。'); parent = target(store.getState(), parent).parentId }
    }
  }
  const result = registry.get(name)!.run(store.getState(), structuredClone(args), `agent-node-${operationId}`, context)
  const after = { ...snapshot, ...store.getState().snapshot, version: snapshot.version }
  return { snapshot: parseCanvasSnapshot(JSON.stringify(after)), result: result ?? {} }
}
