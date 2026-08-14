import { describe, expect, it } from 'vitest'

import type { CanvasFlowEdge } from './mapping'
import { mergeStableEdges } from './stableEdges'

function edge(
  id: string,
  overrides: Partial<CanvasFlowEdge> = {},
): CanvasFlowEdge {
  return {
    id,
    source: `${id}-source`,
    target: `${id}-target`,
    type: 'canvas',
    data: { relation: 'flow', linkedToSelected: false },
    ...overrides,
  }
}

describe('mergeStableEdges', () => {
  it('preserves edge and array references when content is unchanged', () => {
    const current = [edge('first'), edge('second')]
    const incoming = current.map((candidate) => ({
      ...candidate,
      data: { ...candidate.data },
    }))

    const merged = mergeStableEdges(current, incoming)

    expect(merged).toBe(current)
    expect(merged[0]).toBe(current[0])
    expect(merged[1]).toBe(current[1])
  })

  it('replaces only the edge whose content changed', () => {
    const current = [edge('first'), edge('second')]
    const incoming = [
      { ...current[0]!, data: { ...current[0]!.data } },
      {
        ...current[1]!,
        data: { ...current[1]!.data, linkedToSelected: true },
      },
    ]

    const merged = mergeStableEdges(current, incoming)

    expect(merged).not.toBe(current)
    expect(merged[0]).toBe(current[0])
    expect(merged[1]).toBe(incoming[1])
  })
})
