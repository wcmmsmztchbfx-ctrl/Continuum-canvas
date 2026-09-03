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
    expect(screen.getByText('高斯模糊 (Blur)')).toBeInTheDocument()
    expect(screen.getByText('外投影 (Drop Shadow)')).toBeInTheDocument()

    // Switch stroke to dashed
    fireEvent.click(screen.getByLabelText('虚线描边'))
    expect((store.getState().snapshot.nodes[0].data as { strokeStyle?: string }).strokeStyle).toBe('dashed')

    // Switch blur on
    const blurSwitch = screen.getByLabelText('高斯模糊开关')
    fireEvent.click(blurSwitch)
    expect((store.getState().snapshot.nodes[0].data as { blur?: number }).blur).toBe(8)
    expect(screen.getByLabelText('模糊半径数值')).toBeInTheDocument()

    // Switch shadow on
    const shadowSwitch = screen.getByLabelText('外投影开关')
    fireEvent.click(shadowSwitch)
    expect((store.getState().snapshot.nodes[0].data as { shadow?: unknown }).shadow).toBeDefined()
    expect(screen.getByLabelText('阴影 X 偏移')).toBeInTheDocument()
    expect(screen.getByLabelText('阴影 Y 偏移')).toBeInTheDocument()
    expect(screen.getByLabelText('阴影模糊半径')).toBeInTheDocument()
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
})
