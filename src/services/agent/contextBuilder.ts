import type { ProjectSnapshot } from '../../model/project'
import type { CatalogModel, ProviderCatalog, ProviderMetadata } from '../../contracts/generation'

export interface CanvasContextPayload {
  systemPrompt: string
  canvasSummary: string
  referencedNodesDetail?: string
}

export function buildAgentContext(options: {
  snapshot: ProjectSnapshot
  selectedNodeIds: string[]
  referencedNodeIds?: string[]
  provider?: ProviderMetadata
  catalog?: ProviderCatalog
}): CanvasContextPayload {
  const { snapshot, selectedNodeIds, referencedNodeIds, provider, catalog } = options

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

  const referencedIds = new Set(referencedNodeIds ?? [])
  let referencedNodesDetail = ''

  if (referencedIds.size > 0) {
    const referencedNodes = snapshot.nodes.filter((n) => referencedIds.has(n.id))
    if (referencedNodes.length > 0) {
      const details = referencedNodes.map((node, index) => {
        const nodeData = node.data as unknown as Record<string, unknown>
        const fullPrompt =
          node.type === 'image' || node.type === 'video'
            ? node.data.promptDraft || node.data.generation?.prompt || ''
            : ''
        const fullText =
          node.type === 'text'
            ? node.data.text || ''
            : ''
        const mediaUrl = typeof nodeData.url === 'string' ? nodeData.url : undefined
        const posterUrl = typeof nodeData.poster === 'string' ? nodeData.poster : undefined
        const settings = (nodeData.generationSettings ?? {}) as Record<string, unknown>
        const upstreamEdges = snapshot.edges.filter((e) => e.target === node.id)
        const downstreamEdges = snapshot.edges.filter((e) => e.source === node.id)

        const upstreamDesc =
          upstreamEdges.length > 0
            ? upstreamEdges
                .map((e) => {
                  const src = snapshot.nodes.find((n) => n.id === e.source)
                  return `「${src ? src.name : e.source}」(${e.relation || 'flow'})`
                })
                .join(', ')
            : '无'

        const downstreamDesc =
          downstreamEdges.length > 0
            ? downstreamEdges
                .map((e) => {
                  const tgt = snapshot.nodes.find((n) => n.id === e.target)
                  return `「${tgt ? tgt.name : e.target}」(${e.relation || 'flow'})`
                })
                .join(', ')
            : '无'

        const lines: string[] = [
          `[重点引用 #${index + 1}] 节点「${node.name}」:`,
          `  - 基础信息: ID="${node.id}", 类型="${node.type}", 尺寸=${node.size.width}x${node.size.height}, 坐标=(${Math.round(node.position.x)}, ${Math.round(node.position.y)})`,
        ]

        if (fullPrompt) {
          lines.push(`  - 完整生成提示词 (未截断): "${fullPrompt}"`)
        }
        if (fullText) {
          lines.push(`  - 完整正文内容 (Markdown/规范全文):\n${fullText}`)
        }
        if (mediaUrl) {
          lines.push(`  - 素材图片/视频 URL: "${mediaUrl}"`)
        }
        if (posterUrl) {
          lines.push(`  - 视频封面 URL: "${posterUrl}"`)
        }
        if (Object.keys(settings).length > 0) {
          lines.push(
            `  - 生成规格参数: 模型=${settings.model || '默认'}, 比例=${settings.aspectRatio || '默认'}, 分辨率=${settings.quality || settings.resolution || '默认'}, 时长=${settings.durationSec ? settings.durationSec + 's' : '默认'}`,
          )
        }
        lines.push(`  - 图谱关联拓扑: 来源上游=[${upstreamDesc}], 流向游下游=[${downstreamDesc}]`)

        return lines.join('\n')
      })

      const hasReferencedImages = referencedNodes.some((n) => {
        const nodeData = n.data as unknown as Record<string, unknown> | undefined
        return (
          (n.type === 'image' && typeof nodeData?.url === 'string' && nodeData.url.trim().length > 0) ||
          (n.type === 'video' && typeof nodeData?.poster === 'string' && nodeData.poster.trim().length > 0)
        )
      })

      let visionGuidance = ''
      if (hasReferencedImages) {
        visionGuidance = `\n\n【多模态视觉感知说明】\n用户引用的图片素材已作为视觉图像数据（Vision Input）直接传入当前对话。你可以直接看到图片的完整视觉像素画面（包括主体外观、细节、构图、光影与色彩风格等）。当用户询问“这个图片是什么”或要求基于图片进行创作时，请直接基于你看到的真实视觉画面进行准确、生动的解答与创作，严禁声称自己无法读取图片像素！`
      }

      referencedNodesDetail = `\n\n【用户显式引用的重点节点深度详情（核心关注）】\n用户在本次提问中特别引用了以下节点，请优先围绕这些节点的内容、画面提示词、生成参数与上下文拓扑进行深度分析、润色、回答或执行衍生构建：\n${details.join('\n\n')}${visionGuidance}`
    }
  }

  const canvasSummary = `【当前画布状态】
画布名称: ${snapshot.name || '未命名画布'}
节点数量: ${snapshot.nodes.length}
选中焦点节点数: ${selectedNodeIds.length}${referencedIds.size > 0 ? `\n用户显式引用节点数: ${referencedIds.size}` : ''}
${modelInfo}

节点列表:
${JSON.stringify(nodeSummaries, null, 2)}

连线拓扑:
${JSON.stringify(edgeSummaries, null, 2)}${referencedNodesDetail}`

  return { systemPrompt, canvasSummary, referencedNodesDetail }
}
