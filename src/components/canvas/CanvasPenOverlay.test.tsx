// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasPenOverlay } from './CanvasPenOverlay'

// Mock CanvasPointPreview to provide { x: 0, y: 0, zoom: 1 }
vi.mock('./CanvasSnapOverlay', () => ({
  CanvasPointPreview: ({ children }: { children: (t: { x: number; y: number; zoom: number }) => React.ReactNode }) =>
    children({ x: 0, y: 0, zoom: 1 }),
}))

describe('CanvasPenOverlay', () => {
  afterEach(cleanup)

  it('renders pen overlay SVG with crosshair cursor', () => {
    const onCommitPath = vi.fn()
    const onCancel = vi.fn()
    const screenToFlowPosition = vi.fn((pos: { x: number; y: number }) => ({ x: pos.x, y: pos.y }))

    render(
      <CanvasPenOverlay
        onCancel={onCancel}
        onCommitPath={onCommitPath}
        screenToFlowPosition={screenToFlowPosition}
      />,
    )

    const overlay = screen.getByLabelText('钢笔绘制图层')
    expect(overlay).toBeInTheDocument()
    expect(overlay.style.cursor).toBe('crosshair')
  })

  it('adds anchor points and commits open path on Enter key', () => {
    const onCommitPath = vi.fn()
    const onCancel = vi.fn()
    const screenToFlowPosition = vi.fn((pos: { x: number; y: number }) => ({ x: pos.x, y: pos.y }))

    render(
      <CanvasPenOverlay
        onCancel={onCancel}
        onCommitPath={onCommitPath}
        screenToFlowPosition={screenToFlowPosition}
      />,
    )

    const overlay = screen.getByLabelText('钢笔绘制图层')

    // Click 1st point at (50, 50)
    fireEvent.pointerDown(overlay, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(overlay, { button: 0 })

    // Move to (150, 100)
    fireEvent.pointerMove(overlay, { clientX: 150, clientY: 100 })

    // Click 2nd point at (150, 100)
    fireEvent.pointerDown(overlay, { button: 0, clientX: 150, clientY: 100 })
    fireEvent.pointerUp(overlay, { button: 0 })

    // Press Enter to commit path
    fireEvent.keyDown(window, { key: 'Enter' })

    expect(onCommitPath).toHaveBeenCalledTimes(1)
    const [committedAnchors, isClosed] = onCommitPath.mock.calls[0]
    expect(committedAnchors.length).toBe(2)
    expect(committedAnchors[0].x).toBe(50)
    expect(committedAnchors[0].y).toBe(50)
    expect(committedAnchors[1].x).toBe(150)
    expect(committedAnchors[1].y).toBe(100)
    expect(isClosed).toBe(false)
  })

  it('closes path when clicking back on start point', () => {
    const onCommitPath = vi.fn()
    const onCancel = vi.fn()
    const screenToFlowPosition = vi.fn((pos: { x: number; y: number }) => ({ x: pos.x, y: pos.y }))

    render(
      <CanvasPenOverlay
        onCancel={onCancel}
        onCommitPath={onCommitPath}
        screenToFlowPosition={screenToFlowPosition}
      />,
    )

    const overlay = screen.getByLabelText('钢笔绘制图层')

    // Click point 1 at (10, 10)
    fireEvent.pointerDown(overlay, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(overlay, { button: 0 })

    // Click point 2 at (100, 10)
    fireEvent.pointerDown(overlay, { button: 0, clientX: 100, clientY: 10 })
    fireEvent.pointerUp(overlay, { button: 0 })

    // Click point 3 at (100, 100)
    fireEvent.pointerDown(overlay, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(overlay, { button: 0 })

    // Move close to point 1 (12, 11)
    fireEvent.pointerMove(overlay, { clientX: 12, clientY: 11 })

    // Click near point 1 to close
    fireEvent.pointerDown(overlay, { button: 0, clientX: 12, clientY: 11 })

    expect(onCommitPath).toHaveBeenCalledTimes(1)
    const [committedAnchors, isClosed] = onCommitPath.mock.calls[0]
    expect(committedAnchors.length).toBe(3)
    expect(isClosed).toBe(true)
  })

  it('creates Bézier handles when dragging while placing anchor', () => {
    const onCommitPath = vi.fn()
    const onCancel = vi.fn()
    const screenToFlowPosition = vi.fn((pos: { x: number; y: number }) => ({ x: pos.x, y: pos.y }))

    render(
      <CanvasPenOverlay
        onCancel={onCancel}
        onCommitPath={onCommitPath}
        screenToFlowPosition={screenToFlowPosition}
      />,
    )

    const overlay = screen.getByLabelText('钢笔绘制图层')

    // Click 1st point at (50, 50)
    fireEvent.pointerDown(overlay, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(overlay, { button: 0 })

    // Pointer down 2nd point at (150, 150) and drag to (170, 180)
    fireEvent.pointerDown(overlay, { button: 0, clientX: 150, clientY: 150 })
    fireEvent.pointerMove(overlay, { clientX: 170, clientY: 180 })
    fireEvent.pointerUp(overlay, { button: 0 })

    // Press Enter to commit
    fireEvent.keyDown(window, { key: 'Enter' })

    expect(onCommitPath).toHaveBeenCalledTimes(1)
    const [committedAnchors] = onCommitPath.mock.calls[0]
    expect(committedAnchors[1].out).toBeDefined()
    expect(committedAnchors[1].out?.x).toBe(170)
    expect(committedAnchors[1].out?.y).toBe(180)
    expect(committedAnchors[1].in).toBeDefined()
    expect(committedAnchors[1].in?.x).toBe(130)
    expect(committedAnchors[1].in?.y).toBe(120)
  })

  it('handles Escape and Backspace shortcuts', () => {
    const onCommitPath = vi.fn()
    const onCancel = vi.fn()
    const screenToFlowPosition = vi.fn((pos: { x: number; y: number }) => ({ x: pos.x, y: pos.y }))

    render(
      <CanvasPenOverlay
        onCancel={onCancel}
        onCommitPath={onCommitPath}
        screenToFlowPosition={screenToFlowPosition}
      />,
    )

    const overlay = screen.getByLabelText('钢笔绘制图层')

    // Place 1 point
    fireEvent.pointerDown(overlay, { button: 0, clientX: 20, clientY: 20 })
    fireEvent.pointerUp(overlay, { button: 0 })

    // Backspace on 1 point cancels
    fireEvent.keyDown(window, { key: 'Backspace' })
    expect(onCancel).toHaveBeenCalledTimes(1)

    // Escape with < 2 points cancels
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})
