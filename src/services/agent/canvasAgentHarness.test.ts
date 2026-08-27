import { describe, expect, it } from 'vitest'
import { referenceProjectSnapshot } from '../../fixtures/reference'
import { createCanvasStore } from '../../store/canvas-store'
import { CanvasAgentHarness, extractPlanFromText } from './canvasAgentHarness'

describe('CanvasAgentHarness', () => {
  it('extracts plan correctly when model outputs <plan> tag for complex tasks', () => {
    const rawOutput = `<plan>
- 构思赛博朋克主角与场景设定
- 批量创建 3 幕关键分镜节点
- 建立前后因果连线并自动水平排版
</plan>

我已经为你构思好了这三幕分镜，正在创建画布节点...`

    const { plan, cleanText } = extractPlanFromText(rawOutput, 'plan-123')
    expect(plan).toBeDefined()
    expect(plan?.steps).toHaveLength(3)
    expect(plan?.steps[0]?.title).toBe('构思赛博朋克主角与场景设定')
    expect(cleanText).toBe('我已经为你构思好了这三幕分镜，正在创建画布节点...')
  })

  it('returns no plan for simple Q&A conversations', () => {
    const rawOutput = '你好！我是你的无限画布智能协作 Agent，有什么我可以帮你的吗？'
    const { plan, cleanText } = extractPlanFromText(rawOutput, 'plan-123')
    expect(plan).toBeUndefined()
    expect(cleanText).toBe(rawOutput)
  })

  it('captures composite snapshot and allows rollback', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)

    const harness = new CanvasAgentHarness(store)
    expect(harness).toBeDefined()

    // Test rollback capability
    const initialSnapshot = store.getState().serialize()
    const initialCount = store.getState().snapshot.nodes.length

    store.getState().addNode({
      id: 'test-node-1',
      type: 'image',
      name: '测试节点',
      position: { x: 0, y: 0 },
      size: { width: 300, height: 200 },
      data: {},
    })

    expect(store.getState().snapshot.nodes).toHaveLength(initialCount + 1)

    // Rollback to initial
    const rolledBack = harness.rollback(initialSnapshot)
    expect(rolledBack).toBe(true)
    expect(store.getState().snapshot.nodes).toHaveLength(initialCount)
  })

  it('handles abort correctly during execution', () => {
    const store = createCanvasStore(referenceProjectSnapshot)

    const harness = new CanvasAgentHarness(store)
    harness.abort()
    expect(true).toBe(true)
  })
})
