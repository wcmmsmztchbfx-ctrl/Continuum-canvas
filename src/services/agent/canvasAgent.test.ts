// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { referenceProjectSnapshot } from '../../fixtures/reference'
import { createCanvasStore } from '../../store/canvas-store'
import { CanvasAgentExecutor } from './canvasExecutor'
import { buildAgentContext } from './contextBuilder'

describe('Canvas Copilot Agent Engine', () => {
  it('builds system prompt and captures focused node IDs in context', () => {
    const context = buildAgentContext({
      snapshot: referenceProjectSnapshot,
      selectedNodeIds: [referenceProjectSnapshot.nodes[0]!.id],
    })

    expect(context.systemPrompt).toContain('Continuum Canvas Copilot')
    expect(context.canvasSummary).toContain('节点数量:')
    expect(context.canvasSummary).toContain('focused')
  })

  it('extracts untruncated prompt, specs and topology for referenced nodes', () => {
    const targetNodeId = referenceProjectSnapshot.nodes[0]!.id
    const context = buildAgentContext({
      snapshot: referenceProjectSnapshot,
      selectedNodeIds: [],
      referencedNodeIds: [targetNodeId],
    })

    expect(context.canvasSummary).toContain('用户显式引用的重点节点深度详情')
    expect(context.canvasSummary).toContain(targetNodeId)
    expect(context.canvasSummary).toContain('图谱关联拓扑')
    expect(context.referencedNodesDetail).toContain(targetNodeId)
  })

  it('creates nodes atomically and allows one-step undo rollback', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const executor = new CanvasAgentExecutor(store)

    const initialCount = store.getState().snapshot.nodes.length

    const action = await executor.executeToolCall('create_nodes', {
      nodes: [
        { type: 'image', name: 'Agent 分镜 1', prompt: 'cyberpunk street' },
        { type: 'image', name: 'Agent 分镜 2', prompt: 'neon lights', relativeToNodeId: 'Agent 分镜 1', direction: 'right' },
      ],
    })

    expect(action.status).toBe('success')
    expect(store.getState().snapshot.nodes.length).toBe(initialCount + 2)

    // Ctrl+Z undo
    store.getState().undo()
    expect(store.getState().snapshot.nodes.length).toBe(initialCount)
  })

  it('connects nodes with story flow relations', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const executor = new CanvasAgentExecutor(store)

    const nodeA = store.getState().snapshot.nodes[0]!.id
    const nodeB = store.getState().snapshot.nodes[1]!.id

    const action = await executor.executeToolCall('connect_nodes', {
      connections: [
        { sourceNodeId: nodeA, targetNodeId: nodeB, relation: 'flow' },
      ],
    })

    expect(action.status).toBe('success')
    expect(store.getState().snapshot.edges.some((e) => e.source === nodeA && e.target === nodeB && e.relation === 'flow')).toBe(true)
  })

  it('updates prompts and text content for existing nodes', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const executor = new CanvasAgentExecutor(store)

    const targetNode = store.getState().snapshot.nodes[0]!

    const action = await executor.executeToolCall('update_node_prompts', {
      updates: [
        { nodeId: targetNode.id, prompt: 'enhanced movie prompt with anamorphic flare' },
      ],
    })

    expect(action.status).toBe('success')
    const updated = store.getState().snapshot.nodes.find((n) => n.id === targetNode.id)
    expect(updated?.data.promptDraft).toBe('enhanced movie prompt with anamorphic flare')
  })

  it('creates node with real reference attachment and aspect ratio dimensions', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const executor = new CanvasAgentExecutor(store)

    const sourceNode = store.getState().snapshot.nodes[0]!

    const action = await executor.executeToolCall('create_nodes', {
      nodes: [
        {
          type: 'image',
          name: '车内特写',
          prompt: '@1 奢华车内爱马仕香水特写',
          aspectRatio: '9:16',
          quality: '2K',
          referenceNodeIds: [sourceNode.id],
        },
      ],
    })

    expect(action.status).toBe('success')
    const createdNode = store.getState().snapshot.nodes.find((n) => n.name === '车内特写')
    expect(createdNode).toBeDefined()
    expect(createdNode?.size.height).toBeGreaterThan(createdNode?.size.width || 0)
    expect(createdNode?.data.generationSettings?.aspectRatio).toBe('9:16')
    expect(createdNode?.data.generationSettings?.quality).toBe('2K')

    // Verify real reference edge
    const refEdge = store.getState().snapshot.edges.find(
      (e) => e.target === createdNode?.id && e.source === sourceNode.id && e.relation === 'reference',
    )
    expect(refEdge).toBeDefined()
    expect(refEdge?.referenceAlias).toBe(1)
  })

  it('updates node aspect ratio, resolution and adapts canvas dimensions via update_node_settings', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const executor = new CanvasAgentExecutor(store)

    const targetNode = store.getState().snapshot.nodes[0]!

    const action = await executor.executeToolCall('update_node_settings', {
      updates: [
        {
          nodeId: targetNode.id,
          aspectRatio: '1:1',
          resolution: '4K',
        },
      ],
    })

    expect(action.status).toBe('success')
    const updated = store.getState().snapshot.nodes.find((n) => n.id === targetNode.id)
    expect(updated?.data.generationSettings?.aspectRatio).toBe('1:1')
    expect(updated?.data.generationSettings?.resolution).toBe('4K')
    expect(updated?.size.width).toBe(360)
    expect(updated?.size.height).toBe(360)
  })

  it('creates skill node and director node, and connects them with skill relation', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const executor = new CanvasAgentExecutor(store)

    const createAction = await executor.executeToolCall('create_nodes', {
      nodes: [
        {
          id: 'skill-custom-1',
          type: 'skill',
          name: '镜头节奏',
          text: '# 节奏要求\n快剪推拉',
        },
        {
          id: 'dir-custom-1',
          type: 'director',
          name: '电影导演台',
        },
      ],
    })

    expect(createAction.status).toBe('success')
    const skillNode = store.getState().snapshot.nodes.find((n) => n.id === 'skill-custom-1')
    expect(skillNode).toBeDefined()
    expect(skillNode?.name).toBe('镜头节奏-skill')
    expect(skillNode?.type).toBe('text')
    expect(skillNode?.data.nodeKind).toBe('skill')

    const dirNode = store.getState().snapshot.nodes.find((n) => n.id === 'dir-custom-1')
    expect(dirNode).toBeDefined()
    expect(dirNode?.type).toBe('group')
    expect(dirNode?.data.nodeKind).toBe('director')

    // Connect skill -> director
    const connectAction = await executor.executeToolCall('connect_nodes', {
      connections: [
        {
          sourceNodeId: 'skill-custom-1',
          targetNodeId: 'dir-custom-1',
          relation: 'skill',
        },
      ],
    })

    expect(connectAction.status).toBe('success')
    const skillEdge = store.getState().snapshot.edges.find(
      (e) => e.source === 'skill-custom-1' && e.target === 'dir-custom-1' && e.relation === 'skill',
    )
    expect(skillEdge).toBeDefined()
  })

  it('handles request_plan_confirmation returning actionable options and confirmation state', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const executor = new CanvasAgentExecutor(store)

    const action = await executor.executeToolCall('request_plan_confirmation', {
      title: '电影短片视觉渲染方案',
      description: '已规划 3 组分镜，建议使用 Seedance 2.5 极速模型进行 1080P 渲染。',
      targetNodeIds: ['node-1', 'node-2'],
      options: [
        { id: 'opt-model-25', label: 'Seedance 2.5 (极速优惠)', category: 'model', defaultSelected: true },
        { id: 'opt-res-1080p', label: '1080P 高清成片', category: 'resolution', defaultSelected: true },
      ],
      estimatedCost: '预估消耗 12 算力积分',
    })

    expect(action.type).toBe('request_plan_confirmation')
    expect(action.status).toBe('requires_confirmation')
    expect(action.requiresConfirmation).toBe(true)
    expect(action.planOptions?.length).toBe(2)
    expect(action.details?.targetNodeIds).toEqual(['node-1', 'node-2'])
  })
})

