import { describe, expect, it } from 'vitest'
import { createElement } from 'react'

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
  it('treats editor elements as opaque values without traversing cyclic React owners', () => {
    const editor = () => {
      const owner: { current?: unknown } = {}
      owner.current = owner
      return { ...createElement('section', null, 'Editor'), _owner: owner }
    }
    const previous = [node('a'), node('b')]
    previous[0]!.data.imageEditorContent = editor()
    const incoming = [node('a'), node('b')]
    incoming[0]!.data.imageEditorContent = editor()

    const next = stabilizeProjectedNodes(previous, incoming)

    expect(next[0]).toBe(incoming[0])
    expect(next[1]).toBe(previous[1])
    expect(stabilizeProjectedNodes(next, [...next])).toBe(next)
  })

  it('keeps fresh editor callbacks even when the rendered element shape is unchanged', () => {
    const previous = [node('a')]
    previous[0]!.data.imageEditorContent = createElement('button', { onClick: () => 'old-version' }, 'Save')
    const incoming = [node('a')]
    incoming[0]!.data.imageEditorContent = createElement('button', { onClick: () => 'new-version' }, 'Save')

    expect(stabilizeProjectedNodes(previous, incoming)[0]).toBe(incoming[0])
  })

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

  it('updates a node immediately when its references change without recreating unaffected nodes', () => {
    const nodeA = node('a')
    const nodeBWithoutRefs = node('b')
    const previous = [nodeA, nodeBWithoutRefs]

    const nodeBWithRefs: CanvasFlowNode = {
      ...node('b'),
      data: {
        ...nodeBWithoutRefs.data,
        references: [
          { id: 'a', referenceAlias: 1, name: 'a.png', kind: 'image', url: 'blob:img-a' },
        ],
      },
    }
    const incoming = [node('a'), nodeBWithRefs]

    const next = stabilizeProjectedNodes(previous, incoming)

    expect(next[0]).toBe(previous[0])
    expect(next[1]).not.toBe(previous[1])
    expect(next[1]!.data.references).toEqual([
      { id: 'a', referenceAlias: 1, name: 'a.png', kind: 'image', url: 'blob:img-a' },
    ])
  })
})
