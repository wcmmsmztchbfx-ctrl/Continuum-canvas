import { describe, expect, it } from 'vitest'
import {
  computePathBounds,
  constrainAngle,
  denormalizePathAnchors,
  distanceToSegment,
  generateSvgPathData,
  isNearPoint,
  normalizePathAnchors,
} from './pathUtils'

describe('pathUtils', () => {
  it('generates SVG path data for straight lines', () => {
    const anchors = [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: 200, y: 100 },
    ]
    expect(generateSvgPathData(anchors, false)).toBe('M 0 0 L 100 50 L 200 100')
    expect(generateSvgPathData(anchors, true)).toBe('M 0 0 L 100 50 L 200 100 Z')
  })

  it('generates SVG path data for cubic Bézier curves', () => {
    const anchors = [
      { x: 0, y: 0, out: { x: 30, y: 40 } },
      { x: 100, y: 100, in: { x: 70, y: 80 } },
    ]
    expect(generateSvgPathData(anchors, false)).toBe('M 0 0 C 30 40 70 80 100 100')
  })

  it('computes accurate bounding box for anchors with control handles', () => {
    const anchors = [
      { x: 50, y: 50, in: { x: 20, y: 30 }, out: { x: 80, y: 90 } },
      { x: 200, y: 150, out: { x: 250, y: 180 } },
    ]
    const bounds = computePathBounds(anchors, 16)
    expect(bounds.minX).toBe(20)
    expect(bounds.minY).toBe(30)
    expect(bounds.maxX).toBe(250)
    expect(bounds.maxY).toBe(180)
    expect(bounds.width).toBe(230)
    expect(bounds.height).toBe(150)
  })

  it('normalizes and denormalizes anchors correctly', () => {
    const anchors = [
      { x: 100, y: 150, out: { x: 120, y: 160 } },
      { x: 200, y: 250 },
    ]
    const origin = { x: 50, y: 50 }
    const normalized = normalizePathAnchors(anchors, origin)
    expect(normalized[0]).toEqual({ x: 50, y: 100, out: { x: 70, y: 110 } })
    expect(normalized[1]).toEqual({ x: 150, y: 200 })

    const restored = denormalizePathAnchors(normalized, origin)
    expect(restored).toEqual(anchors)
  })

  it('constrains angle to 45 degree increments', () => {
    const from = { x: 0, y: 0 }
    // Almost horizontal to the right
    const toHorizontal = { x: 100, y: 10 }
    const snappedH = constrainAngle(from, toHorizontal, 45)
    expect(Math.round(snappedH.y)).toBe(0)
    expect(Math.round(snappedH.x)).toBeCloseTo(100, -1)

    // Almost 45 degrees
    const to45 = { x: 95, y: 105 }
    const snapped45 = constrainAngle(from, to45, 45)
    expect(Math.round(snapped45.x)).toBe(Math.round(snapped45.y))
  })

  it('calculates point-to-point and point-to-segment distance', () => {
    expect(isNearPoint({ x: 10, y: 10 }, { x: 12, y: 11 }, 5)).toBe(true)
    expect(isNearPoint({ x: 10, y: 10 }, { x: 20, y: 20 }, 5)).toBe(false)

    const dist = distanceToSegment({ x: 50, y: 10 }, { x: 0, y: 0 }, { x: 100, y: 0 })
    expect(Math.round(dist)).toBe(10)
  })
})
