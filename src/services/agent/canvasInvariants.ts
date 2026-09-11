import type { CanvasNode, ProjectSnapshot } from '../../model/project'
import type { VerificationIssue, VerificationResult } from './agentTypes'

export type CanvasSnapshotInput = ProjectSnapshot | { nodes: CanvasNode[]; edges: Array<{ id: string; source: string; target: string; relation?: string }> }

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export function getNodeDimensions(node: CanvasNode): { width: number; height: number } {
  if (node.size?.width && node.size?.height) {
    return { width: node.size.width, height: node.size.height }
  }
  if (node.type === 'image' || node.type === 'video') {
    return { width: 360, height: 320 }
  }
  if (node.type === 'text') {
    return { width: 300, height: 160 }
  }
  if (node.type === 'group') {
    return {
      width: (node.data as { width?: number }).width || 600,
      height: (node.data as { height?: number }).height || 400,
    }
  }
  return { width: 320, height: 240 }
}

export function getNodeBoundingBox(node: CanvasNode): BoundingBox {
  const dims = getNodeDimensions(node)
  return {
    x: node.position.x,
    y: node.position.y,
    width: dims.width,
    height: dims.height,
  }
}

export function checkAABBOverlap(a: BoundingBox, b: BoundingBox, padding: number = 20): boolean {
  return (
    a.x < b.x + b.width + padding &&
    a.x + a.width + padding > b.x &&
    a.y < b.y + b.height + padding &&
    a.y + a.height + padding > b.y
  )
}

/**
 * 空间碰撞校验器：检测节点间的 AABB 重叠碰撞
 */
export function checkSpatialCollisions(
  snapshot: CanvasSnapshotInput,
  filterNodeIds?: string[],
  padding: number = 24,
): VerificationIssue[] {
  const issues: VerificationIssue[] = []
  const nodes = snapshot.nodes.filter((n) => !filterNodeIds || filterNodeIds.includes(n.id))
  const allNodes = snapshot.nodes

  for (let i = 0; i < nodes.length; i++) {
    const nodeA = nodes[i]!
    const boxA = getNodeBoundingBox(nodeA)

    for (let j = 0; j < allNodes.length; j++) {
      const nodeB = allNodes[j]!
      if (nodeA.id === nodeB.id) continue

      // 如果两个节点处于不同分组/不是同一层级，视情况而定，但同层画布节点不能重叠
      const boxB = getNodeBoundingBox(nodeB)
      if (checkAABBOverlap(boxA, boxB, padding)) {
        // 计算重叠量和建议避让偏移量
        const overlapX = Math.min(boxA.x + boxA.width + padding - boxB.x, boxB.x + boxB.width + padding - boxA.x)
        const overlapY = Math.min(boxA.y + boxA.height + padding - boxB.y, boxB.y + boxB.height + padding - boxA.y)

        // 避免重复对同一对节点报错 (仅由 id 较小的一方报出或针对 filterNodeIds)
        if (nodeA.id < nodeB.id || (filterNodeIds?.includes(nodeA.id) && !filterNodeIds?.includes(nodeB.id))) {
          const suggestedShiftX = boxB.x + boxB.width + padding
          issues.push({
            type: 'spatial_collision',
            severity: 'error',
            message: `节点「${nodeA.name}」(${nodeA.id}) 与 节点「${nodeB.name}」(${nodeB.id}) 发生空间重叠 (水平重叠 ${Math.round(overlapX)}px, 垂直重叠 ${Math.round(overlapY)}px)。`,
            nodeIds: [nodeA.id, nodeB.id],
            suggestedFix: `建议将节点「${nodeA.name}」的 X 坐标调整为 ${Math.round(suggestedShiftX)}px 以避开碰撞。`,
          })
        }
      }
    }
  }

  return issues
}

/**
 * 拓扑连通性校验器：检测连线有效性与端点完整性
 */
export function checkTopologyIntegrity(
  snapshot: CanvasSnapshotInput,
): VerificationIssue[] {
  const issues: VerificationIssue[] = []
  const nodeMap = new Map<string, CanvasNode>(snapshot.nodes.map((n) => [n.id, n]))

  // 悬空连线检查
  for (const edge of snapshot.edges) {
    const sourceExists = nodeMap.has(edge.source)
    const targetExists = nodeMap.has(edge.target)

    if (!sourceExists || !targetExists) {
      issues.push({
        type: 'dangling_edge',
        severity: 'error',
        message: `连线 (${edge.id}) 的端点丢失：起点 ${edge.source} (${sourceExists ? '存在' : '缺失'}), 终点 ${edge.target} (${targetExists ? '存在' : '缺失'})。`,
        edgeIds: [edge.id],
        suggestedFix: `移除无效连线或重新建立正确的连线端点。`,
      })
    }
  }

  return issues
}

/**
 * 内容完整性校验器：检查提示词有效性
 */
export function checkContentCompleteness(
  snapshot: CanvasSnapshotInput,
  filterNodeIds?: string[],
): VerificationIssue[] {
  const issues: VerificationIssue[] = []
  const nodes = snapshot.nodes.filter((n) => !filterNodeIds || filterNodeIds.includes(n.id))

  for (const node of nodes) {
    if (node.type === 'image' || node.type === 'video') {
      const data = node.data as { promptDraft?: string; prompt?: string }
      const prompt = data?.promptDraft?.trim() || data?.prompt?.trim()
      if (!prompt) {
        issues.push({
          type: 'empty_prompt',
          severity: 'warning',
          message: `节点「${node.name}」(${node.id}) 的生图提示词 (Prompt) 尚未填充。`,
          nodeIds: [node.id],
          suggestedFix: `调用 update_node_prompts 为该节点填充具体的画面描述提示词。`,
        })
      }
    } else if (node.type === 'text') {
      const text = (node.data as { text?: string })?.text?.trim()
      if (!text) {
        issues.push({
          type: 'empty_prompt',
          severity: 'warning',
          message: `文本节点「${node.name}」(${node.id}) 的正文内容为空。`,
          nodeIds: [node.id],
          suggestedFix: `为文本节点补充故事设定或分镜旁白内容。`,
        })
      }
    }
  }

  return issues
}

/**
 * 运行全量后置不变量校验 (Verify 阶段核心入口)
 */
export function verifyCanvasInvariants(
  snapshot: CanvasSnapshotInput,
  targetNodeIds?: string[],
): VerificationResult {
  const spatialIssues = checkSpatialCollisions(snapshot, targetNodeIds)
  const topologyIssues = checkTopologyIntegrity(snapshot)
  const contentIssues = checkContentCompleteness(snapshot, targetNodeIds)

  const allIssues = [...spatialIssues, ...topologyIssues, ...contentIssues]
  const hasErrors = allIssues.some((i) => i.severity === 'error')

  return {
    passed: !hasErrors,
    issues: allIssues,
    summary: hasErrors
      ? `检测到 ${allIssues.filter((i) => i.severity === 'error').length} 处错误与 ${allIssues.filter((i) => i.severity === 'warning').length} 处警告需自愈修正。`
      : '所有画布空间与拓扑校验均通过！',
  }
}

/**
 * 生成自愈纠错提示词 (Self-Healing Prompt)
 */
export function buildHealingPrompt(result: VerificationResult): string {
  if (result.passed && result.issues.length === 0) {
    return ''
  }

  const lines = ['【自愈反馈 (Self-Healing Required)】', '在上一步执行后，画布后置校验器检测到以下需要自愈修复的问题：']
  result.issues.forEach((issue, idx) => {
    lines.push(`${idx + 1}. [${issue.severity.toUpperCase()}] ${issue.message}`)
    if (issue.suggestedFix) {
      lines.push(`   💡 建议修复方式: ${issue.suggestedFix}`)
    }
  })
  lines.push('\n请针对上述问题调用相应的工具（如 auto_layout、create_nodes、update_node_prompts 或 connect_nodes）执行自愈纠错，直到所有不变量校验通过。')

  return lines.join('\n')
}

/**
 * 自动计算下一个安全不重叠的位置
 */
export function calculateSafeNodePosition(
  existingNodes: CanvasNode[],
  desiredPosition: { x: number; y: number },
  dimensions: { width: number; height: number } = { width: 360, height: 320 },
  padding: number = 40,
): { x: number; y: number } {
  const candidate = { ...desiredPosition }
  const box: BoundingBox = { x: candidate.x, y: candidate.y, width: dimensions.width, height: dimensions.height }

  let hasCollision = true
  let maxAttempts = 50

  while (hasCollision && maxAttempts > 0) {
    hasCollision = false
    maxAttempts--

    for (const node of existingNodes) {
      const nodeBox = getNodeBoundingBox(node)
      if (checkAABBOverlap(box, nodeBox, padding)) {
        hasCollision = true
        // 向右平移避让
        box.x = nodeBox.x + nodeBox.width + padding
        candidate.x = box.x
        break
      }
    }
  }

  return candidate
}
