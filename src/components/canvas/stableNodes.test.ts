import { describe, expect, it, vi } from 'vitest'

import type { CanvasFlowNode } from './mapping'
import { mergeStableNodes } from './stableNodes'

function node(id: string, name = id): CanvasFlowNode {
  return {
    id,
    type: 'text',
    position: { x: 0, y: 0 },
    data: { name, mediaType: 'text', url: '', onRename: vi.fn() },
  }
}

describe('mergeStableNodes', () => {
  it('preserves nodes when only runtime callback identities change', () => {
    const current = [node('first'), node('second')]
    const incoming = current.map((candidate) => ({
      ...candidate,
      data: { ...candidate.data, onRename: vi.fn() },
    }))

    const merged = mergeStableNodes(current, incoming)

    expect(merged).toBe(current)
    expect(merged[0]).toBe(current[0])
    expect(merged[1]).toBe(current[1])
  })

  it('replaces only the node whose visible content changed', () => {
    const current = [node('first'), node('second')]
    const incoming = [
      { ...current[0]!, data: { ...current[0]!.data, onRename: vi.fn() } },
      { ...current[1]!, data: { ...current[1]!.data, name: 'changed', onRename: vi.fn() } },
    ]

    const merged = mergeStableNodes(current, incoming)

    expect(merged).not.toBe(current)
    expect(merged[0]).toBe(current[0])
    expect(merged[1]).toBe(incoming[1])
  })
})
