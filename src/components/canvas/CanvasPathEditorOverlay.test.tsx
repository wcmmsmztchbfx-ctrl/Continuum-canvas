// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasPathEditorOverlay } from './CanvasPathEditorOverlay'
import type { PathNode } from '../../model/project'

// Mock CanvasPointPreview to provide { x: 0, y: 0, zoom: 1 }
vi.mock('./CanvasSnapOverlay', () => ({
  CanvasPointPreview: ({ children }: { children: (t: { x: number; y: number; zoom: number }) => React.ReactNode }) =>
    children({ x: 0, y: 0, zoom: 1 }),
}))

describe('CanvasPathEditorOverlay', () => {
  afterEach(cleanup)

  const mockNode: PathNode = {
    id: 'path-1',
    type: 'path',
    name: '路径 1',
    position: { x: 100, y: 100 },
    size: { width: 200, height: 150 },
    data: {
      kind: 'pen',
      anchors: [
        { x: 0, y: 0, out: { x: 40, y: 0 } },
        { x: 100, y: 100, in: { x: 60, y: 100 }, out: { x: 140, y: 100 } },
        { x: 200, y: 50 },
      ],
      closed: false,
      fill: 'transparent',
      stroke: '#0d99ff',
      strokeWidth: 2,
      opacity: 1,
    },
  }

  it('renders path editor overlay and anchor vertices', () => {
    const onUpdateNode = vi.fn()
    const onExit = vi.fn()
    const screenToFlowPosition = vi.fn((pos: { x: number; y: number }) => ({ x: pos.x, y: pos.y }))

    render(
      <CanvasPathEditorOverlay
        node={mockNode}
        onExit={onExit}
        onUpdateNode={onUpdateNode}
        screenToFlowPosition={screenToFlowPosition}
      />,
    )

    const overlay = screen.getByLabelText('矢量编辑模式图层')
    expect(overlay).toBeInTheDocument()

    // 3 vertices should be rendered as rect elements with cursor: move
    const vertices = overlay.querySelectorAll('.canvas-path-editor__vertex')
    expect(vertices.length).toBe(3)
  })

  it('selects an anchor on click and displays its Bézier handles', () => {
    const onUpdateNode = vi.fn()
    const onExit = vi.fn()
    const screenToFlowPosition = vi.fn((pos: { x: number; y: number }) => ({ x: pos.x, y: pos.y }))

    render(
      <CanvasPathEditorOverlay
        node={mockNode}
        onExit={onExit}
        onUpdateNode={onUpdateNode}
        screenToFlowPosition={screenToFlowPosition}
      />,
    )

    const overlay = screen.getByLabelText('矢量编辑模式图层')

    // Click on the 2nd anchor: origin (100, 100) + relative (100, 100) = (200, 200)
    fireEvent.pointerDown(overlay, { button: 0, clientX: 200, clientY: 200 })
    fireEvent.pointerUp(overlay, { button: 0 })

    // Handles should now be visible for the 2nd anchor (has both in and out handles)
    const handles = overlay.querySelectorAll('.canvas-path-editor__handle')
    expect(handles.length).toBe(2)
  })

  it('moves anchor vertex on drag and updates node', () => {
    const onUpdateNode = vi.fn()
    const onExit = vi.fn()
    const screenToFlowPosition = vi.fn((pos: { x: number; y: number }) => ({ x: pos.x, y: pos.y }))

    render(
      <CanvasPathEditorOverlay
        node={mockNode}
        onExit={onExit}
        onUpdateNode={onUpdateNode}
        screenToFlowPosition={screenToFlowPosition}
      />,
    )

    const overlay = screen.getByLabelText('矢量编辑模式图层')

    // Pointer down on 3rd anchor: (100+200, 100+50) = (300, 150)
    fireEvent.pointerDown(overlay, { button: 0, clientX: 300, clientY: 150 })
    // Drag to (350, 180)
    fireEvent.pointerMove(overlay, { clientX: 350, clientY: 180 })
    fireEvent.pointerUp(overlay, { button: 0 })

    expect(onUpdateNode).toHaveBeenCalled()
  })

  it('deletes selected anchor when pressing Backspace or Delete', () => {
    const onUpdateNode = vi.fn()
    const onExit = vi.fn()
    const screenToFlowPosition = vi.fn((pos: { x: number; y: number }) => ({ x: pos.x, y: pos.y }))

    render(
      <CanvasPathEditorOverlay
        node={mockNode}
        onExit={onExit}
        onUpdateNode={onUpdateNode}
        screenToFlowPosition={screenToFlowPosition}
      />,
    )

    const overlay = screen.getByLabelText('矢量编辑模式图层')

    // Select 3rd anchor: (300, 150)
    fireEvent.pointerDown(overlay, { button: 0, clientX: 300, clientY: 150 })
    fireEvent.pointerUp(overlay, { button: 0 })

    // Press Delete
    fireEvent.keyDown(window, { key: 'Delete' })

    expect(onUpdateNode).toHaveBeenCalledTimes(1)
    const updatedAnchors = (onUpdateNode.mock.calls[0][0].data as { anchors: unknown[] }).anchors
    expect(updatedAnchors.length).toBe(2)
  })

  it('exits and commits on Escape key or double click', () => {
    const onUpdateNode = vi.fn()
    const onExit = vi.fn()
    const screenToFlowPosition = vi.fn((pos: { x: number; y: number }) => ({ x: pos.x, y: pos.y }))

    render(
      <CanvasPathEditorOverlay
        node={mockNode}
        onExit={onExit}
        onUpdateNode={onUpdateNode}
        screenToFlowPosition={screenToFlowPosition}
      />,
    )

    // Press Escape
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onUpdateNode).toHaveBeenCalled()
    expect(onExit).toHaveBeenCalledTimes(1)
  })
})
