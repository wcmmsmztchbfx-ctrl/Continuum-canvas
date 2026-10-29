// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CanvasNode } from '../../model/project'
import { LayersPanel } from './LayersPanel'

describe('LayersPanel', () => {
  afterEach(cleanup)

  const sampleNodes: CanvasNode[] = [
    {
      id: 'node-1',
      name: 'Layer 1',
      type: 'image',
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      data: { url: '' },
    },
    {
      id: 'node-2',
      name: 'Layer 2',
      type: 'image',
      position: { x: 100, y: 0 },
      size: { width: 100, height: 100 },
      data: { url: '' },
    },
    {
      id: 'node-3',
      name: 'Layer 3',
      type: 'text',
      position: { x: 200, y: 0 },
      size: { width: 100, height: 100 },
      data: { text: 'Hello' },
    },
  ]

  it('handles single click selection', () => {
    const onSelect = vi.fn()
    const { getByText } = render(
      <LayersPanel
        nodes={sampleNodes}
        onOpenChange={vi.fn()}
        onRename={vi.fn()}
        onReorder={vi.fn()}
        onSelect={onSelect}
        onToggleHidden={vi.fn()}
        onToggleLocked={vi.fn()}
        open
        selectedIds={[]}
      />,
    )

    fireEvent.click(getByText('Layer 1'))
    expect(onSelect).toHaveBeenCalledWith('node-1', { additive: false, range: false })
  })

  it('computes rangeIds based on visible order when shift-clicked', () => {
    const onSelect = vi.fn()
    const { getByText, rerender } = render(
      <LayersPanel
        nodes={sampleNodes}
        onOpenChange={vi.fn()}
        onRename={vi.fn()}
        onReorder={vi.fn()}
        onSelect={onSelect}
        onToggleHidden={vi.fn()}
        onToggleLocked={vi.fn()}
        open
        selectedIds={['node-3']}
      />,
    )

    // In LayersPanel, top-level nodes are reversed: Layer 3, Layer 2, Layer 1
    // First select Layer 3
    fireEvent.click(getByText('Layer 3'))
    expect(onSelect).toHaveBeenLastCalledWith('node-3', { additive: false, range: false })

    rerender(
      <LayersPanel
        nodes={sampleNodes}
        onOpenChange={vi.fn()}
        onRename={vi.fn()}
        onReorder={vi.fn()}
        onSelect={onSelect}
        onToggleHidden={vi.fn()}
        onToggleLocked={vi.fn()}
        open
        selectedIds={['node-3']}
      />,
    )

    // Shift click Layer 1 (bottom in visible list)
    fireEvent.click(getByText('Layer 1'), { shiftKey: true })

    expect(onSelect).toHaveBeenLastCalledWith('node-1', {
      additive: false,
      range: true,
      rangeIds: ['node-3', 'node-2', 'node-1'],
    })
  })
})
