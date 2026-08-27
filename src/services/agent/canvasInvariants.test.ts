import { describe, expect, it } from 'vitest'
import type { CanvasSnapshotInput } from './canvasInvariants'
import {
  checkSpatialCollisions,
  checkTopologyIntegrity,
  checkContentCompleteness,
  verifyCanvasInvariants,
  buildHealingPrompt,
  calculateSafeNodePosition,
} from './canvasInvariants'

describe('canvasInvariants', () => {
  it('detects spatial collisions between overlapping nodes and suggests displacement', () => {
    const snapshot: CanvasSnapshotInput = {
      nodes: [
        {
          id: 'node-1',
          type: 'image',
          name: '分镜 1',
          position: { x: 100, y: 100 },
          size: { width: 360, height: 320 },
          data: { promptDraft: 'cyberpunk city' },
        },
        {
          id: 'node-2',
          type: 'image',
          name: '分镜 2',
          position: { x: 150, y: 120 }, // 严重重叠
          size: { width: 360, height: 320 },
          data: { promptDraft: 'flying car' },
        },
      ],
      edges: [],
    }

    const collisions = checkSpatialCollisions(snapshot)
    expect(collisions.length).toBeGreaterThan(0)
    expect(collisions[0]!.type).toBe('spatial_collision')
    expect(collisions[0]!.suggestedFix).toContain('建议将')
  })

  it('detects dangling edges and missing prompts', () => {
    const snapshot: CanvasSnapshotInput = {
      nodes: [
        {
          id: 'node-1',
          type: 'image',
          name: '分镜 1',
          position: { x: 100, y: 100 },
          size: { width: 360, height: 320 },
          data: { promptDraft: '' }, // 提示词为空
        },
      ],
      edges: [
        {
          id: 'edge-1',
          source: 'node-1',
          target: 'non-existent-node', // 悬空连线
        },
      ],
    }

    const result = verifyCanvasInvariants(snapshot)
    expect(result.passed).toBe(false)
    expect(result.issues.some((i) => i.type === 'dangling_edge')).toBe(true)
    expect(result.issues.some((i) => i.type === 'empty_prompt')).toBe(true)

    const healingPrompt = buildHealingPrompt(result)
    expect(healingPrompt).toContain('自愈反馈')
    expect(healingPrompt).toContain('端点丢失')
  })

  it('calculates safe non-overlapping positions automatically', () => {
    const existing = [
      {
        id: 'node-1',
        type: 'image' as const,
        name: '分镜 1',
        position: { x: 100, y: 100 },
        size: { width: 360, height: 320 },
        data: {},
      },
    ]

    const safePos = calculateSafeNodePosition(existing, { x: 100, y: 100 })
    expect(safePos.x).toBeGreaterThanOrEqual(100 + 360 + 40) // 避开 node-1
  })
})
