import type { ProjectSnapshot } from '../../model/project'
import type { CatalogModel, ProviderCatalog, ProviderMetadata } from '../../contracts/generation'

export interface CanvasContextPayload {
  systemPrompt: string
  canvasSummary: string
}

export function buildAgentContext(options: {
  snapshot: ProjectSnapshot
  selectedNodeIds: string[]
  provider?: ProviderMetadata
  catalog?: ProviderCatalog
}): CanvasContextPayload {
  const { snapshot, selectedNodeIds, provider, catalog } = options

  const focusedIds = new Set(selectedNodeIds)
  const nodeSummaries = snapshot.nodes.map((node) => {
    const isFocused = focusedIds.has(node.id)
    const prompt =
      node.type === 'image' || node.type === 'video'
        ? node.data.promptDraft || node.data.generation?.prompt || ''
        : node.type === 'text'
          ? node.data.text || ''
          : ''
    const status =
      node.type === 'image' || node.type === 'video'
        ? node.data.generation?.status || (node.data.url ? 'ready' : 'draft')
        : 'ready'

    return {
      id: node.id,
      name: node.name,
      type: node.type,
      position: node.position,
      size: node.size,
      status,
      prompt: prompt ? prompt.slice(0, 200) : undefined,
      focused: isFocused ? true : undefined,
    }
  })

  const edgeSummaries = snapshot.edges.map((edge) => ({
    id: edge.id,
    from: edge.source,
    to: edge.target,
    relation: edge.relation,
  }))

  const modelInfo = catalog?.models
    ? `当前可用生图/生视频模型：${catalog.models.map((m: CatalogModel) => m.title || m.label || m.model).join(', ')}`
    : provider
      ? `当前配置的生成供应商：${provider.name} (${provider.adapterType})`
      : '尚未配置生图供应商'

  const systemPrompt = `你是一个强大的无限画布智能协作 Agent（Continuum Canvas Copilot）。
你的职责是作为用户的创意合伙人与分镜导演，根据用户的自然语言需求，直接自主地在画布上创建、修改、编排节点与连线。

【你的核心能力与工具】
1. create_nodes：在画布上创建新节点（图片 image、视频 video、文本 text、画框 group）。
   - 支持指定画幅比例 aspectRatio ('16:9', '9:16', '1:1', '4:3', '3:4', '21:9')、分辨率 resolution/quality ('1K', '2K', '4K', '720p', '1080p')、视频时长 durationSec (5, 10)。
   - 支持真实参考引用：若要基于已有节点（如香水图、人物图）生成新节点，请传入 referenceNodeIds: [已有节点ID]，并在 prompt 中自然使用 @1 引用代号，系统会自动建立真实参考槽位并挂载缩略图。
2. update_node_settings / update_node_prompts：修改已有节点的画幅比例、分辨率、时长、提示词或参考节点。
3. connect_nodes：在节点之间建立逻辑连线（"flow" 分镜故事流、"output" 衍生生成、"reference" 真实参考引用）。
4. delete_nodes：删除用户要求移除的废弃节点。
5. auto_layout：智能重排布局（如 "storyboard_horizontal" 水平故事流）。
6. trigger_generation：当用户明确要求"开始生成"或"立即生图"时，触发生成任务。

【画布操作准则与执行规范】
- 真实参考与复用：
  * 当用户说“基于这个/某图生成新图”、“保持一致生成特写”时，通过 create_nodes 的 referenceNodeIds 传入源节点 ID，并在 prompt 开头或正文中写上 @1（例如 "@1 爱马仕香水瓶置于豪华轿车中央扶手箱..."），系统会自动挂载真实参考槽位并建立 reference 连线。
- 精准配置参数：
  * 若用户提到“竖版”、“手机短视频”、“9:16”，设置 aspectRatio: '9:16'；
  * 若用户提到“方形”、“头像”、“1:1”，设置 aspectRatio: '1:1'；
  * 若用户提到“高清”、“2K”、“4K”，设置 quality/resolution: '2K' / '4K'；
  * 若用户提到“5秒”、“10秒”，设置 durationSec: 5 或 10；
  * 修改已有节点时使用 update_node_settings。
- 精准直达：
  * 单张图片、人物或场景创建时，仅创建该节点，严禁擅自与画布已有无关节点建立非必要的连线。
- 语言风格：使用中文回复，简练高级、直奔主题，避免无意义的客套或重复解释。`

  const canvasSummary = `【当前画布状态】
画布名称: ${snapshot.name || '未命名画布'}
节点数量: ${snapshot.nodes.length}
选中焦点节点数: ${selectedNodeIds.length}
${modelInfo}

节点列表:
${JSON.stringify(nodeSummaries, null, 2)}

连线拓扑:
${JSON.stringify(edgeSummaries, null, 2)}`

  return { systemPrompt, canvasSummary }
}
