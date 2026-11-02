import type { StoreApi } from 'zustand/vanilla'
import type { CanvasNode, CanvasEdge, Point } from '../../model/project'
import type { CanvasStoreState } from '../../store/types'
import { createCanvasId } from '../../utils/id'
import { sizeForAspectRatio } from '../../components/canvas/mediaGeometry'
import type {
  AgentAutoLayoutInput,
  AgentConnectNodesInput,
  AgentCreateNodeInput,
  AgentDeleteNodesInput,
  AgentTriggerGenerationInput,
  AgentUpdatePromptInput,
  CanvasAgentAction,
} from './agentTypes'
import { calculateSafeNodePosition, checkSpatialCollisions } from './canvasInvariants'

export class CanvasAgentExecutor {
  private readonly store: StoreApi<CanvasStoreState>

  constructor(store: StoreApi<CanvasStoreState>) {
    this.store = store
  }

  /**
   * 捕获画布复合快照，供整组 Agent 任务一键原子撤销 (Rollback)
   */
  captureSnapshot(): string {
    return this.store.getState().serialize()
  }

  /**
   * 回滚画布到指定快照
   */
  rollback(serializedSnapshot: string): boolean {
    try {
      this.store.getState().restore(serializedSnapshot)
      return true
    } catch (err) {
      console.error('Failed to rollback canvas snapshot:', err)
      return false
    }
  }

  /**
   * 聚焦视口到目标节点区域并选中
   */
  focusOnNodes(nodeIds: string[]): void {
    if (nodeIds.length === 0) return
    const state = this.store.getState()
    const targetNodes = state.snapshot.nodes.filter((n) => nodeIds.includes(n.id))
    if (targetNodes.length === 0) return

    // 选中受影响节点
    state.selectNode(targetNodes[0]!.id)

    // 计算包围盒
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of targetNodes) {
      minX = Math.min(minX, node.position.x)
      minY = Math.min(minY, node.position.y)
      maxX = Math.max(maxX, node.position.x + node.size.width)
      maxY = Math.max(maxY, node.position.y + node.size.height)
    }

    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2

    // 平滑平移视口
    state.setViewport({
      x: -centerX + 500,
      y: -centerY + 350,
      zoom: Math.min(1, Math.max(0.4, 800 / Math.max(maxX - minX + 200, maxY - minY + 200))),
    })
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CanvasAgentAction> {
    const actionId = createCanvasId('e')

    switch (toolName) {
      case 'create_nodes':
        return this.handleCreateNodes(actionId, args as unknown as { nodes: AgentCreateNodeInput[] })
      case 'connect_nodes':
        return this.handleConnectNodes(actionId, args as unknown as { connections: AgentConnectNodesInput[] })
      case 'update_node_settings':
      case 'update_node_prompts':
        return this.handleUpdateNodeSettings(actionId, args as unknown as { updates: AgentUpdatePromptInput[] })
      case 'delete_nodes':
        return this.handleDeleteNodes(actionId, args as unknown as AgentDeleteNodesInput)
      case 'auto_layout':
        return this.handleAutoLayout(actionId, args as unknown as AgentAutoLayoutInput)
      case 'trigger_generation':
        return this.handleTriggerGeneration(actionId, args as unknown as AgentTriggerGenerationInput)
      case 'inspect_canvas':
        return this.handleInspectCanvas(actionId, args as unknown as { nodeIds?: string[]; checkCollisions?: boolean })
      default:
        return {
          id: actionId,
          type: 'create_nodes',
          title: '未知指令',
          summary: `无法识别的工具调用：${toolName}`,
          status: 'failed',
        }
    }
  }

  private handleCreateNodes(
    actionId: string,
    input: { nodes: AgentCreateNodeInput[] },
  ): CanvasAgentAction {
    const rawNodes = input.nodes || []
    if (rawNodes.length === 0) {
      return {
        id: actionId,
        type: 'create_nodes',
        title: '创建节点',
        summary: '未提供任何有效节点数据',
        status: 'failed',
      }
    }

    const state = this.store.getState()
    const currentSnapshot = state.snapshot
    const existingNodes = currentSnapshot.nodes

    // 计算放置锚点
    let anchorX = 0
    let anchorY = 0
    if (existingNodes.length > 0) {
      let maxX = -Infinity
      let avgY = 0
      for (const node of existingNodes) {
        maxX = Math.max(maxX, node.position.x + node.size.width)
        avgY += node.position.y
      }
      anchorX = maxX + 100
      anchorY = avgY / existingNodes.length
    }

    const newNodes: CanvasNode[] = []
    const nodeIdMap = new Map<string, string>() // 支持相对引用

    let currentX = anchorX
    for (let index = 0; index < rawNodes.length; index += 1) {
      const item = rawNodes[index]!
      const prefix =
        item.type === 'image'
          ? 'i'
          : item.type === 'video'
            ? 'v'
            : item.type === 'text'
              ? 't'
              : 'g'
      const nodeId = item.id || createCanvasId(prefix)
      if (item.id) nodeIdMap.set(item.id, nodeId)

      // 联动计算画幅比例与尺寸
      let width: number
      let height: number
      if (item.size && item.size.width > 0 && item.size.height > 0) {
        width = item.size.width
        height = item.size.height
      } else if (item.aspectRatio) {
        const calculated = sizeForAspectRatio(item.aspectRatio)
        width = calculated.width
        height = calculated.height
      } else {
        if (item.type === 'image') { width = 384; height = 216 }
        else if (item.type === 'video') { width = 480; height = 270 }
        else if (item.type === 'text') { width = 320; height = 180 }
        else { width = 640; height = 480 }
      }

      let position: Point
      if (item.position) {
        position = calculateSafeNodePosition([...existingNodes, ...newNodes], item.position, { width, height }, 30)
      } else if (item.relativeToNodeId) {
        const refId = nodeIdMap.get(item.relativeToNodeId) || item.relativeToNodeId
        const refNode = existingNodes.find((n: CanvasNode) => n.id === refId) || newNodes.find((n: CanvasNode) => n.id === refId)
        if (refNode) {
          const dir = item.direction || 'right'
          let rawPos: Point
          if (dir === 'right') rawPos = { x: refNode.position.x + refNode.size.width + 80, y: refNode.position.y }
          else if (dir === 'bottom') rawPos = { x: refNode.position.x, y: refNode.position.y + refNode.size.height + 80 }
          else if (dir === 'top') rawPos = { x: refNode.position.x, y: refNode.position.y - height - 80 }
          else rawPos = { x: refNode.position.x - width - 80, y: refNode.position.y }

          position = calculateSafeNodePosition([...existingNodes, ...newNodes], rawPos, { width, height }, 30)
        } else {
          position = calculateSafeNodePosition([...existingNodes, ...newNodes], { x: currentX, y: anchorY }, { width, height }, 30)
          currentX = position.x + width + 80
        }
      } else {
        position = calculateSafeNodePosition([...existingNodes, ...newNodes], { x: currentX, y: anchorY }, { width, height }, 30)
        currentX = position.x + width + 80
      }

      const baseNode = {
        id: nodeId,
        name: item.name || `${item.type} 节点`,
        position,
        size: { width, height },
      }

      if (item.type === 'image') {
        newNodes.push({
          ...baseNode,
          type: 'image',
          data: {
            url: '',
            promptDraft: item.prompt || '',
            generationSettings: {
              kind: 'image',
              aspectRatio: item.aspectRatio || '16:9',
              quality: item.quality || item.resolution || '1K',
              resolution: item.resolution || item.quality || '1K',
              count: 1,
            },
          },
        })
      } else if (item.type === 'video') {
        newNodes.push({
          ...baseNode,
          type: 'video',
          data: {
            url: '',
            promptDraft: item.prompt || '',
            generationSettings: {
              kind: 'video',
              aspectRatio: item.aspectRatio || '16:9',
              resolution: item.resolution || '720p',
              durationSec: item.durationSec || 5,
              generateAudio: false,
              count: 1,
            },
          },
        })
      } else if (item.type === 'text') {
        newNodes.push({
          ...baseNode,
          type: 'text',
          data: {
            text: item.text || item.prompt || '',
            url: '',
          },
        })
      } else {
        newNodes.push({
          ...baseNode,
          type: 'group',
          data: { childIds: [] },
        })
      }
    }

    // 原子批量写入画布
    const originX = Math.min(...newNodes.map((n: CanvasNode) => n.position.x))
    const originY = Math.min(...newNodes.map((n: CanvasNode) => n.position.y))
    const createdIds = state.pasteImportedGraph({
      nodes: newNodes,
      edges: [],
      anchor: { x: originX, y: originY },
    })

    const finalNodeIds = createdIds.length > 0 ? createdIds : newNodes.map((n: CanvasNode) => n.id)

    // 挂载真实参考关系 (Real Reference & @1 Binding)
    for (let i = 0; i < rawNodes.length; i++) {
      const item = rawNodes[i]!
      const createdId = finalNodeIds[i]
      if (createdId && item.referenceNodeIds && item.referenceNodeIds.length > 0) {
        for (const refSourceId of item.referenceNodeIds) {
          const actualSourceId = nodeIdMap.get(refSourceId) || refSourceId
          state.attachReference(createdId, actualSourceId)
        }
      }
    }

    this.focusOnNodes(finalNodeIds)

    return {
      id: actionId,
      type: 'create_nodes',
      title: '创建节点',
      summary: `已在画布中创建 ${newNodes.length} 个节点（${newNodes.map((n: CanvasNode) => n.name).join('、')}）`,
      details: {
        nodeIds: finalNodeIds,
      },
      status: 'success',
    }
  }

  private handleConnectNodes(
    actionId: string,
    input: { connections: AgentConnectNodesInput[] },
  ): CanvasAgentAction {
    const rawConns = input.connections || []
    if (rawConns.length === 0) {
      return {
        id: actionId,
        type: 'connect_nodes',
        title: '建立连线',
        summary: '未提供连线数据',
        status: 'failed',
      }
    }

    const state = this.store.getState()
    const edgesToAdd: CanvasEdge[] = []
    let refCount = 0

    for (const conn of rawConns) {
      if (conn.relation === 'reference') {
        state.attachReference(conn.targetNodeId, conn.sourceNodeId)
        refCount += 1
      } else {
        edgesToAdd.push({
          id: createCanvasId('e'),
          source: conn.sourceNodeId,
          target: conn.targetNodeId,
          relation: conn.relation || 'flow',
          referenceAlias: conn.referenceAlias,
        })
      }
    }

    for (const edge of edgesToAdd) {
      state.addEdge(edge)
    }

    return {
      id: actionId,
      type: 'connect_nodes',
      title: '建立连线',
      summary: refCount > 0
        ? `已建立 ${refCount} 处真实参考引用与 ${edgesToAdd.length} 条逻辑连线`
        : `已在节点之间成功建立 ${edgesToAdd.length} 条逻辑连线`,
      details: {
        edgeIds: edgesToAdd.map((e: CanvasEdge) => e.id),
      },
      status: 'success',
    }
  }

  private handleUpdateNodeSettings(
    actionId: string,
    input: { updates: AgentUpdatePromptInput[] },
  ): CanvasAgentAction {
    const updates = input.updates || []
    if (updates.length === 0) {
      return {
        id: actionId,
        type: 'update_node_settings',
        title: '修改节点配置',
        summary: '未提供配置更新项',
        status: 'failed',
      }
    }

    const state = this.store.getState()
    let count = 0
    const touchedNodeIds: string[] = []

    for (const update of updates) {
      touchedNodeIds.push(update.nodeId)
      const targetNode = state.snapshot.nodes.find((n) => n.id === update.nodeId)

      if (update.prompt !== undefined) {
        state.updateGenerationPrompt(update.nodeId, update.prompt)
        count += 1
      }
      if (update.text !== undefined) {
        state.updateTextNode(update.nodeId, update.text)
        count += 1
      }
      if (update.name !== undefined) {
        state.renameNode(update.nodeId, update.name)
      }

      // 更新画幅比例、分辨率、时长与尺寸联动
      if (
        (update.aspectRatio || update.resolution || update.quality || update.durationSec) &&
        targetNode &&
        (targetNode.type === 'image' || targetNode.type === 'video')
      ) {
        if (targetNode.type === 'image') {
          const prev = targetNode.data.generationSettings
          const nextSettings = {
            kind: 'image' as const,
            aspectRatio: update.aspectRatio || prev?.aspectRatio || '16:9',
            quality: update.quality || update.resolution || prev?.quality || '1K',
            resolution: update.resolution || update.quality || prev?.resolution || '1K',
            count: prev?.count || 1,
            ...(prev || {}),
            ...(update.aspectRatio ? { aspectRatio: update.aspectRatio } : {}),
            ...(update.resolution ? { resolution: update.resolution } : {}),
            ...(update.quality ? { quality: update.quality } : {}),
          }
          state.updateGenerationSettings(update.nodeId, nextSettings)
          count += 1
        } else if (targetNode.type === 'video') {
          const prev = targetNode.data.generationSettings
          const nextSettings = {
            kind: 'video' as const,
            aspectRatio: update.aspectRatio || prev?.aspectRatio || '16:9',
            resolution: update.resolution || prev?.resolution || '720p',
            durationSec: update.durationSec || prev?.durationSec || 5,
            generateAudio: prev?.generateAudio || false,
            count: prev?.count || 1,
            ...(prev || {}),
            ...(update.aspectRatio ? { aspectRatio: update.aspectRatio } : {}),
            ...(update.resolution ? { resolution: update.resolution } : {}),
            ...(update.durationSec ? { durationSec: update.durationSec } : {}),
          }
          state.updateGenerationSettings(update.nodeId, nextSettings)
          count += 1
        }
      }

      // 挂载参考节点
      if (update.referenceNodeIds && update.referenceNodeIds.length > 0) {
        for (const refSourceId of update.referenceNodeIds) {
          state.attachReference(update.nodeId, refSourceId)
        }
        count += 1
      }
    }

    this.focusOnNodes(touchedNodeIds)

    return {
      id: actionId,
      type: 'update_node_settings',
      title: '修改节点配置',
      summary: `已为 ${count} 处节点完成参数与提示词更新`,
      details: {
        nodeIds: touchedNodeIds,
      },
      status: 'success',
    }
  }

  private handleDeleteNodes(
    actionId: string,
    input: AgentDeleteNodesInput,
  ): CanvasAgentAction {
    const nodeIds = input.nodeIds || []
    if (nodeIds.length === 0) {
      return {
        id: actionId,
        type: 'delete_nodes',
        title: '删除节点',
        summary: '未指定要删除的节点',
        status: 'failed',
      }
    }

    const state = this.store.getState()
    state.deleteNodes(nodeIds)

    return {
      id: actionId,
      type: 'delete_nodes',
      title: '删除节点',
      summary: `已从画布中移除 ${nodeIds.length} 个节点`,
      details: { nodeIds },
      status: 'success',
    }
  }

  private handleAutoLayout(
    actionId: string,
    input: AgentAutoLayoutInput,
  ): CanvasAgentAction {
    const state = this.store.getState()
    const allNodes = state.snapshot.nodes
    const targetNodes = input.nodeIds
      ? allNodes.filter((n: CanvasNode) => input.nodeIds!.includes(n.id))
      : allNodes

    if (targetNodes.length === 0) {
      return {
        id: actionId,
        type: 'auto_layout',
        title: '画布排版',
        summary: '画布上没有需要排版的节点',
        status: 'failed',
      }
    }

    let startX = 100
    let startY = 100
    if (targetNodes[0]) {
      startX = targetNodes[0].position.x
      startY = targetNodes[0].position.y
    }

    if (input.strategy === 'grid') {
      const cols = Math.ceil(Math.sqrt(targetNodes.length))
      const movements = targetNodes.map((node: CanvasNode, idx: number) => {
        const row = Math.floor(idx / cols)
        const col = idx % cols
        return {
          id: node.id,
          positionAbsolute: { x: startX + col * 440, y: startY + row * 340 },
        }
      })
      state.moveNodesInHierarchy(movements)
    } else {
      // storyboard_horizontal or tree
      const movements = targetNodes.map((node: CanvasNode, idx: number) => ({
        id: node.id,
        positionAbsolute: { x: startX + idx * (node.size.width + 80), y: startY },
      }))
      state.moveNodesInHierarchy(movements)
    }

    this.focusOnNodes(targetNodes.map((n) => n.id))

    return {
      id: actionId,
      type: 'auto_layout',
      title: '智能排版',
      summary: `已按照 ${input.strategy === 'grid' ? '整齐网格' : '分镜故事流'} 策略完成节点重排`,
      details: {
        nodeIds: targetNodes.map((n) => n.id),
      },
      status: 'success',
    }
  }

  private handleInspectCanvas(
    actionId: string,
    input: { nodeIds?: string[]; checkCollisions?: boolean },
  ): CanvasAgentAction {
    const state = this.store.getState()
    const snapshot = state.snapshot
    const collisions = input.checkCollisions !== false ? checkSpatialCollisions(snapshot, input.nodeIds) : []

    const inspectedNodes = snapshot.nodes
      .filter((n) => !input.nodeIds || input.nodeIds.includes(n.id))
      .map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        position: n.position,
        prompt: (n.data as { promptDraft?: string; text?: string })?.promptDraft || (n.data as { text?: string })?.text,
      }))

    return {
      id: actionId,
      type: 'inspect_canvas',
      title: '探测画布',
      summary: `已扫描画布 ${inspectedNodes.length} 个节点，检测到 ${collisions.length} 处空间重叠`,
      details: {
        nodes: inspectedNodes,
        collisions,
        edgeCount: snapshot.edges.length,
      },
      status: 'success',
    }
  }

  private handleTriggerGeneration(
    actionId: string,
    input: AgentTriggerGenerationInput,
  ): CanvasAgentAction {
    return {
      id: actionId,
      type: 'trigger_generation',
      title: '生成任务确认',
      summary: `Agent 建议为 ${input.nodeIds.length} 个节点执行生图任务`,
      status: 'requires_confirmation',
      requiresConfirmation: true,
      payload: { ...input },
    }
  }
}
