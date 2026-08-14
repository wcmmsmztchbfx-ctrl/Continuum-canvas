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
  it('renders CSS-animated flow without scheduling animation frames', () => {
    const requestFrame = vi.fn(() => 1)
    vi.stubGlobal('requestAnimationFrame', requestFrame)

    try {
      const { container } = render(
        <svg>
          <CanvasEdge {...edgeProps({ selected: true })} />
        </svg>,
      )

      expect(requestFrame).not.toHaveBeenCalled()
      expect(
        container.querySelectorAll(
          '.canvas-edge__flow.canvas-edge__flow--animated',
        ),
      ).toHaveLength(3)
      expect(
        Array.from(
          container.querySelectorAll<SVGPathElement>('.canvas-edge__flow--animated'),
          (path) => path.style.animationDelay,
        ),
      ).toHaveLength(3)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps an idle edge static behind a 40px interaction path', () => {
    const { container } = render(
      <svg>
        <CanvasEdge {...edgeProps()} />
      </svg>,
    )

    const hitPath = container.querySelector('.canvas-edge__interaction')
    expect(hitPath?.getAttribute('stroke-width')).toBe('40')
    expect(
      container.querySelector('.canvas-edge__path')?.getAttribute('d'),
    ).toBe('M10,20 C110,20 110,120 210,120')
    expect(container.querySelectorAll('.canvas-edge__flow')).toHaveLength(3)
  })

  it('renders three stable CSS flow paths for an incident selected node', () => {
    const { container } = render(
      <svg>
        <CanvasEdge
          {...edgeProps({ data: { linkedToSelected: true } })}
        />
      </svg>,
    )

    expect(
      container.querySelector('.canvas-edge')?.getAttribute('data-flow-active'),
    ).toBe('true')
    const flowPaths = container.querySelectorAll('.canvas-edge__flow')
    expect(flowPaths).toHaveLength(3)
    expect(
      Array.from(flowPaths, (flowPath) => flowPath.getAttribute('d')),
    ).toEqual(Array(3).fill('M10,20 C110,20 110,120 210,120'))
    expect(
      Array.from(flowPaths, (flowPath) => flowPath.getAttribute('pathLength')),
    ).toEqual(Array(3).fill('100'))
    expect(container.querySelectorAll('linearGradient')).toHaveLength(0)
    expect(
      container
        .querySelector('.canvas-edge__path')
        ?.classList.contains('canvas-edge__path--linked'),
    ).toBe(true)
  })

  it('keeps the flow layer mounted so hover never restarts its timeline', () => {
    const { container } = render(
      <svg>
        <CanvasEdge {...edgeProps()} />
      </svg>,
    )
    const flowGroup = container.querySelector('.canvas-edge__flow-group')
    const hitPath = container.querySelector('.canvas-edge__interaction')

    fireEvent.mouseEnter(hitPath!)
    fireEvent.mouseLeave(hitPath!)
    expect(container.querySelector('.canvas-edge__flow-group')).toBe(flowGroup)
    expect(container.querySelectorAll('.canvas-edge__flow')).toHaveLength(3)
  })

  it('keeps hover visual state in CSS without changing React edge state', () => {
    const { container } = render(
      <svg>
        <CanvasEdge {...edgeProps()} />
      </svg>,
    )
    const edge = container.querySelector('.canvas-edge')
    const highlight = container.querySelector('.canvas-edge__highlight')
    const flowGroup = container.querySelector('.canvas-edge__flow-group')

    expect(highlight).not.toBeNull()
    expect(edge?.getAttribute('data-flow-active')).toBe('false')

    const hitPath = container.querySelector('.canvas-edge__interaction')
    fireEvent.mouseEnter(hitPath!)
    expect(edge?.getAttribute('data-flow-active')).toBe('false')
    expect(container.querySelector('.canvas-edge__flow-group')).toBe(flowGroup)

    fireEvent.mouseLeave(hitPath!)
    expect(edge?.getAttribute('data-flow-active')).toBe('false')
  })

  it('exposes a quiet relation identity and tooltip without activating animation', () => {
    const { container } = render(
      <svg>
        <CanvasEdge
          {...edgeProps({ data: { relation: 'reference', referenceAlias: 2 } })}
        />
      </svg>,
    )

    const edge = container.querySelector('.canvas-edge')
    expect(edge?.getAttribute('data-relation')).toBe('reference')
    expect(edge?.querySelector('title')?.textContent).toBe('参考 @2')
    expect(container.querySelectorAll('.canvas-edge__flow')).toHaveLength(3)
  })

  it('does not run document-wide hit tests during pointer movement', () => {
    const originalElementFromPoint = document.elementFromPoint
    const hitTest = vi.fn(() => null)
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: hitTest,
    })

    try {
      render(
        <svg>
          <CanvasEdge {...edgeProps()} />
        </svg>,
      )

      fireEvent.pointerMove(document, { clientX: 80, clientY: 80 })
      expect(hitTest).not.toHaveBeenCalled()
    } finally {
      if (originalElementFromPoint) {
        Object.defineProperty(document, 'elementFromPoint', {
          configurable: true,
          value: originalElementFromPoint,
        })
      } else {
        delete (document as Document & { elementFromPoint?: unknown })
          .elementFromPoint
      }
    }
  })

  it('uses the stronger selected base while keeping three flow segments', () => {
    const { container } = render(
      <svg>
        <CanvasEdge {...edgeProps({ selected: true })} />
      </svg>,
    )

    expect(
      container
        .querySelector('.canvas-edge__path')
        ?.classList.contains('canvas-edge__path--selected'),
    ).toBe(true)
    expect(container.querySelectorAll('.canvas-edge__flow')).toHaveLength(3)
  })

  it('renders the measured drag preview stack', () => {
    const props = {
      fromX: 0,
      fromY: 0,
      fromPosition: Position.Right,
      toX: 240,
      toY: 120,
      toPosition: Position.Left,
    } as ConnectionLineComponentProps
    const { container } = render(
      <svg>
        <CanvasConnectionLine {...props} />
      </svg>,
    )

    expect(
      container
        .querySelector('.canvas-connection-preview__glow')
        ?.getAttribute('stroke-width'),
    ).toBe('6')
    expect(
      container
        .querySelector('.canvas-connection-preview__base')
        ?.getAttribute('stroke-width'),
    ).toBe('2')
    expect(
      container.querySelectorAll('.canvas-connection-preview__flow'),
    ).toHaveLength(3)
  })
})
