// @vitest-environment jsdom

import {
  Position,
  type ConnectionLineComponentProps,
  type EdgeProps,
} from '@xyflow/react'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasConnectionLine, CanvasEdge } from './CanvasEdge'
import type { CanvasFlowEdge } from './mapping'

function edgeProps(
  overrides: Partial<EdgeProps<CanvasFlowEdge>> = {},
): EdgeProps<CanvasFlowEdge> {
  return {
    id: 'edge-test',
    source: 'source-node',
    target: 'target-node',
    sourceX: 10,
    sourceY: 20,
    targetX: 210,
    targetY: 120,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    selected: false,
    animated: false,
    deletable: true,
    selectable: true,
    data: {},
    ...overrides,
  }
}

describe('CanvasEdge', () => {
  it('renders a selected path without extra particle layers or animation frames', () => {
    const requestFrame = vi.fn(() => 1)
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    try {
      const { container } = render(<svg><CanvasEdge {...edgeProps({ selected: true })} /></svg>)
      expect(requestFrame).not.toHaveBeenCalled()
      expect(container.querySelector('.canvas-edge')?.getAttribute('data-flow-active')).toBe('true')
      expect(container.querySelectorAll('.canvas-edge__path--selected')).toHaveLength(1)
      expect(container.querySelectorAll('.canvas-edge__flow')).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps idle edges static with a screen-sized hit area at every zoom', () => {
    const { container } = render(<svg><CanvasEdge {...edgeProps()} /></svg>)
    const hitPath = container.querySelector('.canvas-edge__interaction')
    expect(hitPath?.getAttribute('stroke-width')).toBe('16')
    expect(hitPath?.getAttribute('vector-effect')).toBe('non-scaling-stroke')
    expect(container.querySelector('.canvas-edge__path')?.getAttribute('d')).toBe('M10,20 C110,20 110,120 210,120')
    expect(container.querySelector('.canvas-edge')?.getAttribute('data-flow-active')).toBe('false')
    expect(container.querySelectorAll('.canvas-edge__flow')).toHaveLength(0)
  })

  it('animates incident edges when a single node is selected', () => {
    const { container } = render(<svg><CanvasEdge {...edgeProps({ data: { linkedToSelected: true } })} /></svg>)
    expect(container.querySelector('.canvas-edge')?.getAttribute('data-flow-active')).toBe('true')
    expect(container.querySelector('.canvas-edge__path--linked')).not.toBeNull()
    expect(container.querySelectorAll('.canvas-edge__flow')).toHaveLength(0)
  })

  it('keeps hover in CSS without activating animation or document hit tests', () => {
    const hitTest = vi.fn()
    const original = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hitTest })
    try {
      const { container } = render(<svg><CanvasEdge {...edgeProps()} /></svg>)
      const edge = container.querySelector('.canvas-edge')
      const path = container.querySelector('.canvas-edge__path')
      fireEvent.mouseEnter(container.querySelector('.canvas-edge__interaction')!)
      fireEvent.pointerMove(document, { clientX: 80, clientY: 80 })
      expect(edge?.getAttribute('data-flow-active')).toBe('false')
      expect(container.querySelector('.canvas-edge__path')).toBe(path)
      expect(hitTest).not.toHaveBeenCalled()
      fireEvent.mouseLeave(container.querySelector('.canvas-edge__interaction')!)
      expect(edge?.getAttribute('data-flow-active')).toBe('false')
    } finally {
      if (original) Object.defineProperty(document, 'elementFromPoint', original)
      else delete (document as Document & { elementFromPoint?: unknown }).elementFromPoint
    }
  })

  it('preserves relation identity and its tooltip', () => {
    const { container } = render(<svg><CanvasEdge {...edgeProps({ data: { relation: 'reference', referenceAlias: 2 } })} /></svg>)
    const edge = container.querySelector('.canvas-edge')
    expect(edge?.getAttribute('data-relation')).toBe('reference')
    expect(edge?.querySelector('title')?.textContent).toBe('参考 @2')
  })

  it('keeps the connection drag preview static', () => {
    const props = { fromX: 0, fromY: 0, fromPosition: Position.Right, toX: 240, toY: 120, toPosition: Position.Left } as ConnectionLineComponentProps
    const { container } = render(<svg><CanvasConnectionLine {...props} /></svg>)
    expect(container.querySelector('.canvas-connection-preview__base')).not.toBeNull()
    expect(container.querySelectorAll('.canvas-connection-preview__flow')).toHaveLength(0)
  })
})
