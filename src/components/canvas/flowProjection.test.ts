import { describe, expect, it } from 'vitest'

import type { CanvasFlowEdge, CanvasFlowNode } from './mapping'
import { stabilizeProjectedEdges, stabilizeProjectedNodes } from './flowProjection'

function node(id: string, x = 0): CanvasFlowNode {
  return {
    id, type: 'image', position: { x, y: 0 }, data: {
      name: id, mediaType: 'image', url: '',
      node: { id, type: 'image', name: id, position: { x, y: 0 }, size: { width: 10, height: 10 }, data: { url: '' } },
      onRename: () => undefined,
    },
  }
}

function edge(id: string, linkedToSelected = false): CanvasFlowEdge {
  return { id, source: 'a', target: 'b', type: 'canvas', data: { relation: 'flow', linkedToSelected } }
}

describe('flow projection stability', () => {
  it('keeps unchanged node data and callback identity when model wrappers are recreated', () => {
    const previous = [node('a'), node('b')]
    const incoming = [node('a'), node('b', 20)]
    incoming[0]!.data.node = previous[0]!.data.node

    const next = stabilizeProjectedNodes(previous, incoming)

    expect(next[0]).toBe(previous[0])
    expect(next[0]!.data).toBe(previous[0]!.data)
    expect(next[1]).not.toBe(previous[1])
  })

  it('replaces only an edge whose decoration changed', () => {
    const previous = [edge('ab'), { ...edge('bc'), source: 'b', target: 'c' }]
    const incoming = [edge('ab', true), { ...edge('bc'), source: 'b', target: 'c' }]

    const next = stabilizeProjectedEdges(previous, incoming)

    expect(next[0]).not.toBe(previous[0])
    expect(next[1]).toBe(previous[1])
  })
})
