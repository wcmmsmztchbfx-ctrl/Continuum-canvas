import { describe, expect, it } from 'vitest'
import { rotatedBounds, snapRect, snapResizeRect, unionRect } from './smartSnapping'

describe('smart snapping geometry', () => {
  it('snaps matching edges in screen-space threshold', () => {
    const result = snapRect({ rect: { x: 94, y: 30, width: 50, height: 50 }, candidates: [{ x: 150, y: 0, width: 50, height: 50 }], zoom: 1, enabled: true })
    expect(result.rect.x).toBe(100)
    expect(result.guides[0]).toMatchObject({ axis: 'x', value: 150 })
  })
  it('uses object alignment before grid alignment', () => {
    const result = snapRect({ rect: { x: 94, y: 13, width: 50, height: 20 }, candidates: [{ x: 150, y: 100, width: 30, height: 30 }], zoom: 1, enabled: true, grid: 12 })
    expect(result.rect.x).toBe(100)
    expect(result.rect.y).toBe(12)
  })
  it('temporarily disables snapping while retaining measurements', () => {
    const result = snapRect({ rect: { x: 94, y: 0, width: 50, height: 50 }, candidates: [{ x: 150, y: 0, width: 50, height: 50 }], zoom: 1, enabled: true, disable: true, measure: true })
    expect(result.rect.x).toBe(94)
    expect(result.guides).toEqual([])
    expect(result.distances).not.toEqual([])
  })
  it('computes rotated axis-aligned bounds and multi-selection union', () => {
    const rotated = rotatedBounds({ x: 0, y: 0, width: 100, height: 50 }, 90)
    expect(rotated.width).toBeCloseTo(50)
    expect(rotated.height).toBeCloseTo(100)
    expect(unionRect([{ x: 0, y: 5, width: 10, height: 10 }, { x: 20, y: 0, width: 5, height: 30 }])).toEqual({ x: 0, y: 0, width: 25, height: 30 })
  })
  it('keeps a previous snap for the release hysteresis', () => {
    const result = snapRect({ rect: { x: 92, y: 0, width: 50, height: 50 }, candidates: [], zoom: 1, enabled: true, previous: { x: { target: 150, source: 2 } } })
    expect(result.rect.x).toBe(100)
  })
  it('snaps only the active resize edge', () => {
    const result = snapResizeRect({ rect: { x: 10, y: 10, width: 187, height: 100 }, direction: { x: 1, y: 0 }, candidates: [{ x: 200, y: 0, width: 100, height: 100 }], zoom: 1, enabled: true })
    expect(result.rect).toMatchObject({ x: 10, width: 190, height: 100 })
    expect(result.guides).toHaveLength(1)
  })
  it('snaps to equal gap when inserting between two nodes', () => {
    // Node A: x=0, width=50 (ends at 50)
    // Node B: x=150, width=50 (starts at 150)
    // Available gap between A and B = 100
    // Dragged node has width=40. Target equal gap = (100 - 40) / 2 = 30
    // Target x = 50 + 30 = 80
    const result = snapRect({
      rect: { x: 82, y: 0, width: 40, height: 50 },
      candidates: [
        { x: 0, y: 0, width: 50, height: 50 },
        { x: 150, y: 0, width: 50, height: 50 },
      ],
      zoom: 1,
      enabled: true,
    })
    expect(result.rect.x).toBe(80)
    expect(result.guides[0]?.label).toBe('30px')
    expect(result.distances).toHaveLength(2)
  })
  it('snaps to equal gap when appending or prepending', () => {
    // Node A: 0..50, Node B: 70..120 (gap = 20)
    // Dragged node: width=50. Append target = 120 + 20 = 140
    const appendResult = snapRect({
      rect: { x: 138, y: 0, width: 50, height: 50 },
      candidates: [
        { x: 0, y: 0, width: 50, height: 50 },
        { x: 70, y: 0, width: 50, height: 50 },
      ],
      zoom: 1,
      enabled: true,
    })
    expect(appendResult.rect.x).toBe(140)

    // Prepend target = 0 - 20 - 50 = -70
    const prependResult = snapRect({
      rect: { x: -68, y: 0, width: 50, height: 50 },
      candidates: [
        { x: 0, y: 0, width: 50, height: 50 },
        { x: 70, y: 0, width: 50, height: 50 },
      ],
      zoom: 1,
      enabled: true,
    })
    expect(prependResult.rect.x).toBe(-70)
  })
  it('maintains bounded adaptive threshold under extreme zooms without runaway snapping', () => {
    // Under extreme zoom out (zoom=0.05), threshold is clamped to 24px
    const zoomOut = snapRect({
      rect: { x: 70, y: 0, width: 50, height: 50 },
      candidates: [{ x: 100, y: 0, width: 50, height: 50 }],
      zoom: 0.05,
      enabled: true,
    })
    // Candidate start (100) to Rect center (95): delta = 5, within 24px clamped threshold
    expect(zoomOut.rect.x).toBe(75)

    // Under extreme zoom in (zoom=4), threshold is clamped to min 3px
    const zoomIn = snapRect({
      rect: { x: 96, y: 0, width: 50, height: 50 },
      candidates: [{ x: 150, y: 0, width: 50, height: 50 }],
      zoom: 4,
      enabled: true,
    })
    // 150 - (96 + 50) = 4 delta, which exceeds 3px threshold -> no runaway snapping!
    expect(zoomIn.rect.x).toBe(96)
  })
})
