// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InspectorPanel } from './InspectorPanel'
import { createCanvasStore } from '../../store/canvas-store'

const mockSnapshot = {
  id: 'test',
  name: '测试画布',
  projectId: 'p1',
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
}

describe('InspectorPanel', () => {
  afterEach(cleanup)

  it('renders "无" avatar bubble when there are no collaborators and no nickname', () => {
    const store = createCanvasStore(mockSnapshot)
    const onOpenCollaboration = vi.fn()

    render(
      <InspectorPanel
        onOpenCollaboration={onOpenCollaboration}
        store={store}
      />,
    )

    expect(screen.getByText('无')).toBeInTheDocument()
    fireEvent.click(screen.getByText('无'))
    expect(onOpenCollaboration).toHaveBeenCalled()
  })

  it('renders multiple colored avatar bubbles when there are collaborators', () => {
    const store = createCanvasStore(mockSnapshot)
    const members = [
      { id: '1', displayName: '张三', color: '#10b981' },
      { id: '2', displayName: '李四', color: '#f59e0b' },
    ]

    render(
      <InspectorPanel
        collaborationMembers={members}
        store={store}
      />,
    )

    expect(screen.getByText('张')).toBeInTheDocument()
    expect(screen.getByText('李')).toBeInTheDocument()
  })

  it('renders resize handle and triggers onStartResize', () => {
    const store = createCanvasStore(mockSnapshot)
    const onStartResize = vi.fn()

    render(
      <InspectorPanel
        onStartResize={onStartResize}
        store={store}
      />,
    )

    const handle = screen.getByLabelText('调整属性面板宽度')
    expect(handle).toBeInTheDocument()
    fireEvent.mouseDown(handle, { button: 0, clientX: 500 })
    expect(onStartResize).toHaveBeenCalled()
  })

  it('renders design options for a single shape node: transform, opacity, fill, stroke, and effects', () => {
    const shapeNode = {
      id: 'shape-1',
      type: 'shape' as const,
      name: '矩形 1',
      position: { x: 100, y: 200 },
      size: { width: 300, height: 150 },
      data: {
        kind: 'rectangle' as const,
        fill: '#3b82f6',
        stroke: '#1e3a8a',
        strokeWidth: 2,
        strokeStyle: 'solid' as const,
        opacity: 0.8,
        blur: 0,
      },
    }
    const store = createCanvasStore({
      ...mockSnapshot,
      nodes: [shapeNode],
    })
    store.getState().selectNode('shape-1')

    render(<InspectorPanel store={store} />)

    // Position & Transform
    expect(screen.getByText('变换 (Transform)')).toBeInTheDocument()
    expect(screen.getByLabelText('X 坐标')).toHaveValue(100)
    expect(screen.getByLabelText('Y 坐标')).toHaveValue(200)
    expect(screen.getByLabelText('宽度')).toHaveValue(300)
    expect(screen.getByLabelText('高度')).toHaveValue(150)

    // Opacity
    expect(screen.getByText('透明度 (Opacity)')).toBeInTheDocument()
    expect(screen.getByLabelText('透明度百分比')).toHaveValue(80)

    // Fill
    expect(screen.getByText('填充 (Fill)')).toBeInTheDocument()
    expect(screen.getByLabelText('填充颜色十六进制')).toHaveValue('#3b82f6')

    // Stroke
    expect(screen.getByText('描边 (Stroke)')).toBeInTheDocument()
    expect(screen.getByLabelText('描边颜色十六进制')).toHaveValue('#1e3a8a')
    expect(screen.getByLabelText('描边线宽')).toHaveValue(2)
    expect(screen.getByLabelText('实线描边')).toBeInTheDocument()
    expect(screen.getByLabelText('虚线描边')).toBeInTheDocument()

    // Effects
    expect(screen.getByText('效果 (Effects)')).toBeInTheDocument()
    expect(screen.queryByLabelText(/设置 .* 参数/)).not.toBeInTheDocument()

    // Switch stroke to dashed
    fireEvent.click(screen.getByLabelText('虚线描边'))
    expect((store.getState().snapshot.nodes[0].data as { strokeStyle?: string }).strokeStyle).toBe('dashed')

    // Add effect via +
    fireEvent.click(screen.getByLabelText('添加效果'))
    fireEvent.click(screen.getByText('投影'))

    // Expect drop-shadow added to store and displayed in list
    expect(screen.getAllByText('投影').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Drop Shadow').length).toBeGreaterThan(0)
    const nodeData = store.getState().snapshot.nodes[0].data as { effects?: Array<{ type: string }> }
    expect(nodeData.effects?.some((e) => e.type === 'drop-shadow')).toBe(true)
  })

  it('renders multi-selection batch controls for opacity and fill', () => {
    const node1 = {
      id: 'node-1',
      type: 'shape' as const,
      name: '矩形 1',
      position: { x: 50, y: 50 },
      size: { width: 100, height: 100 },
      data: {
        kind: 'rectangle' as const,
        fill: '#ff0000',
        stroke: '#000000',
        strokeWidth: 1,
        opacity: 0.5,
      },
    }
    const node2 = {
      id: 'node-2',
      type: 'frame' as const,
      name: '画框 1',
      position: { x: 200, y: 200 },
      size: { width: 400, height: 300 },
      data: {
        fill: '#00ff00',
        opacity: 0.5,
      },
    }
    const store = createCanvasStore({
      ...mockSnapshot,
      nodes: [node1, node2],
    })
    store.getState().selectNode('node-1')
    store.getState().selectNode('node-2', true)

    render(<InspectorPanel store={store} />)

    expect(screen.getByText('已选中 2 个对象')).toBeInTheDocument()
    expect(screen.getByLabelText('批量透明度百分比')).toHaveValue(50)
    expect(screen.getByLabelText('批量填充颜色十六进制')).toBeInTheDocument()
    expect(screen.getByText('编组选中图层')).toBeInTheDocument()

    // Change batch opacity
    const opacityInput = screen.getByLabelText('批量透明度百分比')
    fireEvent.change(opacityInput, { target: { value: '90' } })
    fireEvent.blur(opacityInput)

    expect((store.getState().snapshot.nodes[0].data as { opacity?: number }).opacity).toBe(0.9)
    expect((store.getState().snapshot.nodes[1].data as { opacity?: number }).opacity).toBe(0.9)
  })

  it('renders path specific controls (edit vector and closed toggle) for a path node', () => {
    const pathNode = {
      id: 'path-1',
      type: 'path' as const,
      name: '路径 1',
      position: { x: 50, y: 80 },
      size: { width: 100, height: 100 },
      data: {
        kind: 'pen' as const,
        anchors: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
        closed: false,
        fill: '#ff0000',
        stroke: '#ffffff',
        strokeWidth: 2,
        opacity: 1,
      },
    }
    const store = createCanvasStore({
      ...mockSnapshot,
      nodes: [pathNode],
    })
    store.getState().selectNode('path-1')
    const onStartVectorEdit = vi.fn()

    render(
      <InspectorPanel
        isEditingVector={false}
        onStartVectorEdit={onStartVectorEdit}
        store={store}
      />,
    )

    expect(screen.getByText('路径 (Path)')).toBeInTheDocument()
    const editBtn = screen.getByLabelText('编辑路径')
    expect(editBtn).toBeInTheDocument()
    fireEvent.click(editBtn)
    expect(onStartVectorEdit).toHaveBeenCalledWith('path-1')

    // Test closed toggle
    const closedSwitch = screen.getByLabelText('路径闭合开关') as HTMLInputElement
    expect(closedSwitch.checked).toBe(false)
    fireEvent.click(closedSwitch)
    expect((store.getState().snapshot.nodes[0].data as { closed?: boolean }).closed).toBe(true)
  })

  it('supports multi-fill layering and toggling fill visibility', () => {
    const shapeNode = {
      id: 'shape-fill-test',
      type: 'shape' as const,
      name: '矩形多填充',
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      data: {
        kind: 'rectangle' as const,
        fill: '#ff0000',
        opacity: 1,
      },
    }
    const store = createCanvasStore({
      ...mockSnapshot,
      nodes: [shapeNode],
    })
    store.getState().selectNode('shape-fill-test')

    render(<InspectorPanel store={store} />)

    // Initially 1 fill
    expect(screen.getByLabelText('填充颜色十六进制')).toHaveValue('#ff0000')

    // Click add fill layer
    const addFillBtn = screen.getByLabelText('添加填充图层')
    fireEvent.click(addFillBtn)

    const updatedNode = store.getState().snapshot.nodes[0]
    const fills = (updatedNode.data as { fills?: Array<{ id: string; color: string; enabled: boolean }> }).fills
    expect(fills).toHaveLength(2)
    expect(screen.getByLabelText('填充颜色十六进制 2')).toBeInTheDocument()

    // Toggle eye to disable fill
    const eyeBtns = screen.getAllByTitle('隐藏填充')
    expect(eyeBtns.length).toBeGreaterThan(0)
    fireEvent.click(eyeBtns[0])

    const disabledNode = store.getState().snapshot.nodes[0]
    const updatedFills = (disabledNode.data as { fills?: Array<{ id: string; color: string; enabled: boolean }> }).fills
    expect(updatedFills?.[0].enabled).toBe(false)
  })

  it('supports multi-stroke layering and toggling stroke visibility', () => {
    const shapeNode = {
      id: 'shape-stroke-test',
      type: 'shape' as const,
      name: '矩形多描边',
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      data: {
        kind: 'rectangle' as const,
        stroke: '#000000',
        strokeWidth: 2,
        opacity: 1,
      },
    }
    const store = createCanvasStore({
      ...mockSnapshot,
      nodes: [shapeNode],
    })
    store.getState().selectNode('shape-stroke-test')

    render(<InspectorPanel store={store} />)

    expect(screen.getByLabelText('描边颜色十六进制')).toHaveValue('#000000')

    // Click add stroke layer
    const addStrokeBtn = screen.getByLabelText('添加描边图层')
    fireEvent.click(addStrokeBtn)

    const updatedNode = store.getState().snapshot.nodes[0]
    const strokes = (updatedNode.data as { strokes?: Array<{ id: string; color: string; enabled: boolean }> }).strokes
    expect(strokes).toHaveLength(2)
    expect(screen.getByLabelText('描边颜色十六进制 2')).toBeInTheDocument()

    // Toggle eye to disable stroke
    const eyeBtns = screen.getAllByTitle('隐藏描边')
    expect(eyeBtns.length).toBeGreaterThan(0)
    fireEvent.click(eyeBtns[0])

    const disabledNode = store.getState().snapshot.nodes[0]
    const updatedStrokes = (disabledNode.data as { strokes?: Array<{ id: string; color: string; enabled: boolean }> }).strokes
    expect(updatedStrokes?.[0].enabled).toBe(false)
  })

  it('opens Figma 8-effects dropdown menu and adds effects with parameter popover', () => {
    const shapeNode = {
      id: 'shape-effects-test',
      type: 'shape' as const,
      name: '矩形效果测试',
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      data: {
        kind: 'rectangle' as const,
        fill: '#333333',
        opacity: 1,
      },
    }
    const store = createCanvasStore({
      ...mockSnapshot,
      nodes: [shapeNode],
    })
    store.getState().selectNode('shape-effects-test')

    render(<InspectorPanel store={store} />)

    // Click add effect button (+)
    const addEffectBtn = screen.getByLabelText('添加效果')
    fireEvent.click(addEffectBtn)

    // All 8 Figma effects should be in the dropdown with Chinese and English names
    expect(screen.getAllByText('内阴影').length).toBeGreaterThan(0)
    expect(screen.getByText('投影')).toBeInTheDocument()
    expect(screen.getByText('图层模糊')).toBeInTheDocument()
    expect(screen.getByText('背景模糊')).toBeInTheDocument()
    expect(screen.getByText('噪点颗粒')).toBeInTheDocument()
    expect(screen.getByText('材质纹理')).toBeInTheDocument()
    expect(screen.getByText('拟态玻璃')).toBeInTheDocument()
    expect(screen.getByText('动态着色器')).toBeInTheDocument()
    expect(screen.queryByText('测试')).not.toBeInTheDocument()

    // Click "内阴影"
    fireEvent.click(screen.getByText('内阴影'))

    // Expect inner-shadow added to store
    const nodeAfter = store.getState().snapshot.nodes[0]
    const effects = (nodeAfter.data as { effects?: Array<{ type: string; enabled: boolean }> }).effects
    expect(effects?.some((e) => e.type === 'inner-shadow')).toBe(true)

    // Expect popover to be opened with title "内阴影" and subtitle "Inner Shadow"
    expect(screen.getByText('模糊 (Blur)')).toBeInTheDocument()
    expect(screen.getByText('扩散 (Spread)')).toBeInTheDocument()

    // Test tuning a parameter in the popover
    const blurInput = screen.getByLabelText('模糊半径')
    fireEvent.change(blurInput, { target: { value: '24' } })
    fireEvent.blur(blurInput)

    const nodeTuned = store.getState().snapshot.nodes[0]
    const tunedEff = (nodeTuned.data as { effects?: Array<{ type: string; blur?: number }> }).effects?.find(
      (e) => e.type === 'inner-shadow'
    )
    expect(tunedEff?.blur).toBe(24)

    // Close popover
    const closeBtn = screen.getByLabelText('关闭参数面板')
    fireEvent.click(closeBtn)
  })

  it('allows deleting the only stroke and changing stroke alignment (outside, center, inside)', () => {
    const textNode = {
      id: 'text-1',
      type: 'text' as const,
      name: '文本 1',
      position: { x: 50, y: 50 },
      size: { width: 200, height: 60 },
      data: {
        text: '测试文本',
        stroke: '#ff0000',
        strokeWidth: 4,
        strokeStyle: 'solid' as const,
        strokePosition: 'outside' as const,
      },
    }
    const store = createCanvasStore({
      ...mockSnapshot,
      nodes: [textNode],
    })
    store.getState().selectNode('text-1')

    render(<InspectorPanel store={store} />)

    expect(screen.getByText('描边 (Stroke)')).toBeInTheDocument()
    expect(screen.getByLabelText('外部描边')).toBeInTheDocument()
    expect(screen.getByLabelText('居中描边')).toBeInTheDocument()
    expect(screen.getByLabelText('内部描边')).toBeInTheDocument()

    // Switch to inside
    fireEvent.click(screen.getByLabelText('内部描边'))
    const afterInside = store.getState().snapshot.nodes[0].data as { strokePosition?: string; strokes?: Array<{ position?: string }> }
    expect(afterInside.strokePosition).toBe('inside')
    expect(afterInside.strokes?.[0].position).toBe('inside')

    // Switch to center
    fireEvent.click(screen.getByLabelText('居中描边'))
    const afterCenter = store.getState().snapshot.nodes[0].data as { strokePosition?: string }
    expect(afterCenter.strokePosition).toBe('center')

    // Delete the only stroke
    const deleteStrokeBtn = screen.getByLabelText('删除描边')
    expect(deleteStrokeBtn).toBeInTheDocument()
    fireEvent.click(deleteStrokeBtn)

    // Store should have 0 width and empty strokes
    const afterDelete = store.getState().snapshot.nodes[0].data as { stroke?: string; strokeWidth?: number; strokes?: unknown[] }
    expect(afterDelete.strokeWidth).toBe(0)
    expect(afterDelete.stroke).toBeUndefined()
    expect(afterDelete.strokes).toEqual([])

    // Stroke section should STILL be rendered with "+" button
    expect(screen.getByText('描边 (Stroke)')).toBeInTheDocument()
    expect(screen.getByLabelText('添加描边图层')).toBeInTheDocument()
  })
})


