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
  comments: [],
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
})
