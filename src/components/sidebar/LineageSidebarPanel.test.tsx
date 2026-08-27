// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CanvasEdge, CanvasNode } from '../../model/project'
import { LineageSidebarPanel } from './LineageSidebarPanel'

afterEach(cleanup)

describe('LineageSidebarPanel', () => {
  const nodes: CanvasNode[] = [
    {
      id: 'root-prompt',
      type: 'text',
      name: '咖啡包装设计',
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      data: { text: '极简日系咖啡袋' },
    },
    {
      id: 'img-derivative',
      type: 'image',
      name: '设计图 V1',
      position: { x: 200, y: 0 },
      size: { width: 100, height: 100 },
      data: {
        url: 'https://example.test/img1.png',
        generation: { sourceNodeId: 'root-prompt', status: 'succeeded', prompt: '日系极简咖啡包装' },
      },
    },
  ]

  const edges: CanvasEdge[] = [
    { id: 'e1', source: 'root-prompt', target: 'img-derivative', relation: 'flow' },
  ]

  it('renders lineage trees and stats correctly', () => {
    render(
      <LineageSidebarPanel
        edges={edges}
        nodes={nodes}
        onNotify={vi.fn()}
        onSelect={vi.fn()}
        selectedIds={[]}
      />,
    )

    expect(screen.getByText('AI 演化谱系')).toBeInTheDocument()
    expect(screen.getByText('咖啡包装设计')).toBeInTheDocument()
    expect(screen.getByText('设计图 V1')).toBeInTheDocument()
    expect(screen.getByText('1 个演化分支')).toBeInTheDocument()
  })

  it('excludes isolated standalone nodes that have no lineage connections', () => {
    const nodesWithIsolated: CanvasNode[] = [
      ...nodes,
      {
        id: 'isolated-node',
        type: 'image',
        name: '孤立的未连接图片',
        position: { x: 500, y: 500 },
        size: { width: 100, height: 100 },
        data: { url: '' },
      },
    ]

    render(
      <LineageSidebarPanel
        edges={edges}
        nodes={nodesWithIsolated}
        onNotify={vi.fn()}
        onSelect={vi.fn()}
        selectedIds={[]}
      />,
    )

    expect(screen.queryByText('孤立的未连接图片')).not.toBeInTheDocument()
  })

  it('filters nodes based on search query', () => {
    render(
      <LineageSidebarPanel
        edges={edges}
        nodes={nodes}
        onNotify={vi.fn()}
        onSelect={vi.fn()}
        selectedIds={[]}
      />,
    )

    const searchInput = screen.getByPlaceholderText('搜索节点名称或 Prompt...')
    fireEvent.change(searchInput, { target: { value: '设计图' } })

    expect(screen.getByText('设计图 V1')).toBeInTheDocument()
  })

  it('triggers onSelect and onFocusNode when clicking a node item', () => {
    const onSelect = vi.fn()
    const onFocusNode = vi.fn()

    render(
      <LineageSidebarPanel
        edges={edges}
        nodes={nodes}
        onFocusNode={onFocusNode}
        onNotify={vi.fn()}
        onSelect={onSelect}
        selectedIds={[]}
      />,
    )

    fireEvent.click(screen.getByText('设计图 V1'))
    expect(onSelect).toHaveBeenCalledWith('img-derivative')
    expect(onFocusNode).toHaveBeenCalledWith('img-derivative')
  })
})
