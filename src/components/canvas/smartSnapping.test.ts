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
})
