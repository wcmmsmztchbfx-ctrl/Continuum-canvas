import type { PathAnchor, Point } from '../../model/project'

/**
 * Generates an SVG path string ('d' attribute) from an array of PathAnchors.
 * Supports smooth cubic Bézier curves (C) when in/out handles are present,
 * and straight lines (L) when handles are absent.
 */
export function generateSvgPathData(anchors: PathAnchor[], closed = false): string {
  if (!anchors || anchors.length === 0) return ''
  const [first, ...rest] = anchors
  if (!first) return ''

  let d = `M ${first.x} ${first.y}`
  let previous = first

  for (const anchor of rest) {
    if (previous.out || anchor.in) {
      const outPoint = previous.out ?? { x: previous.x, y: previous.y }
      const inPoint = anchor.in ?? { x: anchor.x, y: anchor.y }
      d += ` C ${outPoint.x} ${outPoint.y} ${inPoint.x} ${inPoint.y} ${anchor.x} ${anchor.y}`
    } else {
      d += ` L ${anchor.x} ${anchor.y}`
    }
    previous = anchor
  }

  if (closed && rest.length > 0) {
    if (previous.out || first.in) {
      const outPoint = previous.out ?? { x: previous.x, y: previous.y }
      const inPoint = first.in ?? { x: first.x, y: first.y }
      d += ` C ${outPoint.x} ${outPoint.y} ${inPoint.x} ${inPoint.y} ${first.x} ${first.y} Z`
    } else {
      d += ' Z'
    }
  }

  return d
}

/**
 * Computes the bounding box of a collection of PathAnchors,
 * taking into account both the anchor positions and their in/out control handles.
 */
export function computePathBounds(
  anchors: PathAnchor[],
  minDimension = 16,
): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
  if (!anchors || anchors.length === 0) {
    return { minX: 0, minY: 0, maxX: minDimension, maxY: minDimension, width: minDimension, height: minDimension }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const includePoint = (p?: Point) => {
    if (!p) return
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }

  for (const a of anchors) {
    includePoint(a)
    includePoint(a.in)
    includePoint(a.out)
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { minX: 0, minY: 0, maxX: minDimension, maxY: minDimension, width: minDimension, height: minDimension }
  }

  const rawWidth = maxX - minX
  const rawHeight = maxY - minY
  const width = Math.max(minDimension, rawWidth)
  const height = Math.max(minDimension, rawHeight)

  return {
    minX,
    minY,
    maxX: minX + width,
    maxY: minY + height,
    width,
    height,
  }
}

/**
 * Shifts all anchor coordinates and their in/out handles relative to an origin.
 */
export function normalizePathAnchors(anchors: PathAnchor[], origin: Point): PathAnchor[] {
  return anchors.map((a) => ({
    x: a.x - origin.x,
    y: a.y - origin.y,
    in: a.in ? { x: a.in.x - origin.x, y: a.in.y - origin.y } : undefined,
    out: a.out ? { x: a.out.x - origin.x, y: a.out.y - origin.y } : undefined,
  }))
}

/**
 * Restores relative anchors to canvas flow coordinates given a node origin.
 */
export function denormalizePathAnchors(anchors: PathAnchor[], origin: Point): PathAnchor[] {
  return anchors.map((a) => ({
    x: a.x + origin.x,
    y: a.y + origin.y,
    in: a.in ? { x: a.in.x + origin.x, y: a.in.y + origin.y } : undefined,
    out: a.out ? { x: a.out.x + origin.x, y: a.out.y + origin.y } : undefined,
  }))
}

/**
 * Constrains the line from `from` to `to` to the nearest increment of `stepDegrees` (e.g. 45°).
 */
export function constrainAngle(from: Point, to: Point, stepDegrees = 45): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  if (distance === 0) return { ...to }

  const angle = Math.atan2(dy, dx)
  const stepRad = (stepDegrees * Math.PI) / 180
  const snappedAngle = Math.round(angle / stepRad) * stepRad

  return {
    x: from.x + distance * Math.cos(snappedAngle),
    y: from.y + distance * Math.sin(snappedAngle),
  }
}

/**
 * Checks if distance between p1 and p2 is within threshold.
 */
export function isNearPoint(p1: Point, p2: Point, threshold: number): boolean {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y) <= threshold
}

/**
 * Approximates distance from a point to a line segment.
 */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))
  const projX = a.x + t * dx
  const projY = a.y + t * dy
  return Math.hypot(p.x - projX, p.y - projY)
}
