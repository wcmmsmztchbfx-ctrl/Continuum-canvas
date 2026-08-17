import type { Point } from '../../model/project'

export interface SnapRect { id?: string; x: number; y: number; width: number; height: number; kind?: 'node' | 'frame' }
export interface SnapGuide { axis: 'x' | 'y'; value: number; from: number; to: number; label?: string }
export interface SnapDistance { axis: 'x' | 'y'; from: number; to: number; cross: number; value: number }
export interface SnapState { x?: { target: number; source: number; candidateId?: string }; y?: { target: number; source: number; candidateId?: string } }
export interface SnapResult { rect: SnapRect; guides: SnapGuide[]; distances: SnapDistance[]; state: SnapState }
export interface ResizeDirection { x: -1 | 0 | 1; y: -1 | 0 | 1 }

const anchorsX = (rect: SnapRect) => [rect.x, rect.x + rect.width / 2, rect.x + rect.width]
const anchorsY = (rect: SnapRect) => [rect.y, rect.y + rect.height / 2, rect.y + rect.height]

export function rotatedBounds(rect: SnapRect, degrees = 0): SnapRect {
  if (!degrees) return { ...rect }
  const radians = degrees * Math.PI / 180
  const width = Math.abs(rect.width * Math.cos(radians)) + Math.abs(rect.height * Math.sin(radians))
  const height = Math.abs(rect.width * Math.sin(radians)) + Math.abs(rect.height * Math.cos(radians))
  return { ...rect, x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height }
}

function nearestAxis(
  rect: SnapRect,
  source: number[],
  candidates: SnapRect[],
  axis: 'x' | 'y',
  threshold: number,
  previous?: { target: number; source: number; candidateId?: string },
) {
  const releaseThreshold = threshold + 2
  if (previous) {
    const current = source[previous.source]
    if (current !== undefined && Math.abs(previous.target - current) <= releaseThreshold) {
      const prevCandidate = candidates.find((c) => c.id === previous.candidateId)
      return { delta: previous.target - current, target: previous.target, source: previous.source, candidate: prevCandidate }
    }
  }
  let best: { delta: number; target: number; source: number; candidate: SnapRect; orthogonalDist: number } | undefined
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    const srcVal = source[sourceIndex]!
    for (const candidate of candidates) {
      const orthogonalDist = axis === 'x'
        ? Math.abs((candidate.y + candidate.height / 2) - (rect.y + rect.height / 2))
        : Math.abs((candidate.x + candidate.width / 2) - (rect.x + rect.width / 2))

      // Skip candidates that are extremely far away orthogonally (> 2000px) to prevent distant jitter
      if (orthogonalDist > 2000) continue

      const targets = axis === 'x' ? anchorsX(candidate) : anchorsY(candidate)
      for (const target of targets) {
        const delta = target - srcVal
        if (Math.abs(delta) <= threshold) {
          if (
            !best ||
            Math.abs(delta) < Math.abs(best.delta) - 0.5 ||
            (Math.abs(Math.abs(delta) - Math.abs(best.delta)) <= 0.5 && orthogonalDist < best.orthogonalDist)
          ) {
            best = { delta, target, source: sourceIndex, candidate, orthogonalDist }
          }
        }
      }
    }
  }
  return best
}

function nearestDistances(rect: SnapRect, candidates: SnapRect[]): SnapDistance[] {
  const horizontal = candidates.flatMap((item) => {
    if (item.x + item.width <= rect.x) return [{ axis: 'x' as const, from: item.x + item.width, to: rect.x, cross: Math.max(item.y, rect.y), value: rect.x - item.x - item.width }]
    if (rect.x + rect.width <= item.x) return [{ axis: 'x' as const, from: rect.x + rect.width, to: item.x, cross: Math.max(item.y, rect.y), value: item.x - rect.x - rect.width }]
    return []
  }).sort((a, b) => a.value - b.value)[0]
  const vertical = candidates.flatMap((item) => {
    if (item.y + item.height <= rect.y) return [{ axis: 'y' as const, from: item.y + item.height, to: rect.y, cross: Math.max(item.x, rect.x), value: rect.y - item.y - item.height }]
    if (rect.y + rect.height <= item.y) return [{ axis: 'y' as const, from: rect.y + rect.height, to: item.y, cross: Math.max(item.x, rect.x), value: item.y - rect.y - rect.height }]
    return []
  }).sort((a, b) => a.value - b.value)[0]
  return [horizontal, vertical].filter((value): value is SnapDistance => value !== undefined)
}

function equalGapDelta(rect: SnapRect, candidates: SnapRect[], axis: 'x' | 'y', threshold: number) {
  // Proximity filter: only consider candidates within 1200px orthogonally
  const nearby = candidates.filter((item) => {
    const dist = axis === 'x'
      ? Math.abs((item.y + item.height / 2) - (rect.y + rect.height / 2))
      : Math.abs((item.x + item.width / 2) - (rect.x + rect.width / 2))
    return dist <= 1200
  })
  const sorted = [...nearby].sort((a, b) => axis === 'x' ? a.x - b.x : a.y - b.y)
  let best: number | undefined
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const first = sorted[index]!
    const second = sorted[index + 1]!
    const firstEnd = axis === 'x' ? first.x + first.width : first.y + first.height
    const secondStart = axis === 'x' ? second.x : second.y
    const gap = secondStart - firstEnd
    if (gap < 0) continue
    const expected = secondStart + gap
    const current = axis === 'x' ? rect.x : rect.y
    const delta = expected - current
    if (Math.abs(delta) <= threshold && (best === undefined || Math.abs(delta) < Math.abs(best))) best = delta
  }
  return best
}

function cullDistantCandidates(
  rect: SnapRect,
  candidates: SnapRect[],
  proximity = 2500,
  keepIds?: (string | undefined)[],
): SnapRect[] {
  if (candidates.length <= 16) return candidates
  const minX = rect.x - proximity
  const maxX = rect.x + rect.width + proximity
  const minY = rect.y - proximity
  const maxY = rect.y + rect.height + proximity
  const keep = new Set(keepIds?.filter((id): id is string => Boolean(id)))
  return candidates.filter((c) => (
    (c.id && keep.has(c.id)) ||
    (c.x + c.width >= minX &&
      c.x <= maxX &&
      c.y + c.height >= minY &&
      c.y <= maxY)
  ))
}

export function snapRect(input: { rect: SnapRect; candidates: SnapRect[]; zoom: number; enabled: boolean; grid?: number; disable?: boolean; measure?: boolean; previous?: SnapState }): SnapResult {
  const threshold = 6 / Math.max(input.zoom, 0.01)
  const original = input.rect
  const candidates = cullDistantCandidates(
    original,
    input.candidates,
    2500 / Math.min(Math.max(input.zoom, 0.25), 1),
    [input.previous?.x?.candidateId, input.previous?.y?.candidateId],
  )
  if (input.disable) return { rect: { ...original }, guides: [], distances: input.measure ? nearestDistances(original, candidates) : [], state: {} }
  const x = input.enabled ? nearestAxis(original, anchorsX(original), candidates, 'x', threshold, input.previous?.x) : undefined
  const y = input.enabled ? nearestAxis(original, anchorsY(original), candidates, 'y', threshold, input.previous?.y) : undefined
  const gapX = input.enabled && !x ? equalGapDelta(original, candidates, 'x', threshold) : undefined
  const gapY = input.enabled && !y ? equalGapDelta(original, candidates, 'y', threshold) : undefined
  let dx = x?.delta ?? gapX ?? 0
  let dy = y?.delta ?? gapY ?? 0
  if (input.grid) {
    if (!x && gapX === undefined) dx = Math.round(original.x / input.grid) * input.grid - original.x
    if (!y && gapY === undefined) dy = Math.round(original.y / input.grid) * input.grid - original.y
  }
  const rect = { ...original, x: original.x + dx, y: original.y + dy }
  const guides: SnapGuide[] = []
  if (x) {
    const fromY = x.candidate ? Math.min(rect.y, x.candidate.y) : rect.y
    const toY = x.candidate ? Math.max(rect.y + rect.height, x.candidate.y + x.candidate.height) : rect.y + rect.height
    guides.push({ axis: 'x', value: x.target, from: fromY, to: toY })
  }
  if (y) {
    const fromX = y.candidate ? Math.min(rect.x, y.candidate.x) : rect.x
    const toX = y.candidate ? Math.max(rect.x + rect.width, y.candidate.x + y.candidate.width) : rect.x + rect.width
    guides.push({ axis: 'y', value: y.target, from: fromX, to: toX })
  }
  if (gapX !== undefined) guides.push({ axis: 'x', value: rect.x, from: rect.y, to: rect.y + rect.height, label: '等间距' })
  if (gapY !== undefined) guides.push({ axis: 'y', value: rect.y, from: rect.x, to: rect.x + rect.width, label: '等间距' })
  return {
    rect,
    guides,
    distances: input.measure ? nearestDistances(rect, input.candidates) : [],
    state: {
      ...(x ? { x: { target: x.target, source: x.source, candidateId: x.candidate?.id } } : {}),
      ...(y ? { y: { target: y.target, source: y.source, candidateId: y.candidate?.id } } : {}),
    },
  }
}

function nearestTarget(rect: SnapRect, value: number, candidates: SnapRect[], axis: 'x' | 'y', threshold: number) {
  let best: { value: number; delta: number; candidate: SnapRect; orthogonalDist: number } | undefined
  for (const candidate of candidates) {
    const orthogonalDist = axis === 'x'
      ? Math.abs((candidate.y + candidate.height / 2) - (rect.y + rect.height / 2))
      : Math.abs((candidate.x + candidate.width / 2) - (rect.x + rect.width / 2))

    if (orthogonalDist > 2000) continue

    for (const target of axis === 'x' ? anchorsX(candidate) : anchorsY(candidate)) {
      const delta = target - value
      if (Math.abs(delta) <= threshold) {
        if (
          !best ||
          Math.abs(delta) < Math.abs(best.delta) - 0.5 ||
          (Math.abs(Math.abs(delta) - Math.abs(best.delta)) <= 0.5 && orthogonalDist < best.orthogonalDist)
        ) {
          best = { value: target, delta, candidate, orthogonalDist }
        }
      }
    }
  }
  return best
}

export function snapResizeRect(input: { rect: SnapRect; direction: ResizeDirection; candidates: SnapRect[]; zoom: number; enabled: boolean; grid?: number; disable?: boolean; measure?: boolean }): SnapResult {
  const threshold = 6 / Math.max(input.zoom, 0.01)
  const rect = { ...input.rect }
  const guides: SnapGuide[] = []
  if (!input.disable) {
    for (const axis of ['x', 'y'] as const) {
      const direction = input.direction[axis]
      if (!direction) continue
      const start = rect[axis]
      const lengthKey = axis === 'x' ? 'width' : 'height'
      const movingEdge = direction < 0 ? start : start + rect[lengthKey]
      const match = input.enabled ? nearestTarget(rect, movingEdge, input.candidates, axis, threshold) : undefined
      const target = match?.value ?? (input.grid ? Math.round(movingEdge / input.grid) * input.grid : movingEdge)
      if (direction < 0) {
        const fixedEdge = start + rect[lengthKey]
        rect[axis] = Math.min(target, fixedEdge - 16)
        rect[lengthKey] = fixedEdge - rect[axis]
      } else rect[lengthKey] = Math.max(16, target - start)
      if (match) {
        const cand = match.candidate
        const from = axis === 'x' ? Math.min(rect.y, cand.y) : Math.min(rect.x, cand.x)
        const to = axis === 'x' ? Math.max(rect.y + rect.height, cand.y + cand.height) : Math.max(rect.x + rect.width, cand.x + cand.width)
        guides.push({ axis, value: target, from, to })
      }
    }
  }
  return { rect, guides, distances: input.measure ? nearestDistances(rect, input.candidates) : [], state: {} }
}

export function unionRect(rects: readonly SnapRect[]): SnapRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let x = Infinity
  let y = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]!
    if (rect.x < x) x = rect.x
    if (rect.y < y) y = rect.y
    const r = rect.x + rect.width
    const b = rect.y + rect.height
    if (r > right) right = r
    if (b > bottom) bottom = b
  }
  return { x, y, width: right - x, height: bottom - y }
}

export function deltaPoint(point: Point, dx: number, dy: number): Point { return { x: point.x + dx, y: point.y + dy } }
