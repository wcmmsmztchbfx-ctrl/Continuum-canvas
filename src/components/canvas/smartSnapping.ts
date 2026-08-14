import type { Point } from '../../model/project'

export interface SnapRect { id?: string; x: number; y: number; width: number; height: number; kind?: 'node' | 'frame' }
export interface SnapGuide { axis: 'x' | 'y'; value: number; from: number; to: number; label?: string }
export interface SnapDistance { axis: 'x' | 'y'; from: number; to: number; cross: number; value: number }
export interface SnapState { x?: { target: number; source: number }; y?: { target: number; source: number } }
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

function nearestAxis(source: number[], candidates: SnapRect[], axis: 'x' | 'y', threshold: number, previous?: { target: number; source: number }) {
  const releaseThreshold = threshold + 2
  if (previous) {
    const current = source[previous.source]
    if (current !== undefined && Math.abs(previous.target - current) <= releaseThreshold) {
      return { delta: previous.target - current, target: previous.target, source: previous.source }
    }
  }
  let best: { delta: number; target: number; source: number } | undefined
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    for (const candidate of candidates) {
      const targets = axis === 'x' ? anchorsX(candidate) : anchorsY(candidate)
      for (const target of targets) {
        const delta = target - source[sourceIndex]!
        if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, target, source: sourceIndex }
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
  const sorted = [...candidates].sort((a, b) => axis === 'x' ? a.x - b.x : a.y - b.y)
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

export function snapRect(input: { rect: SnapRect; candidates: SnapRect[]; zoom: number; enabled: boolean; grid?: number; disable?: boolean; measure?: boolean; previous?: SnapState }): SnapResult {
  const threshold = 6 / Math.max(input.zoom, 0.01)
  const original = input.rect
  if (input.disable) return { rect: { ...original }, guides: [], distances: input.measure ? nearestDistances(original, input.candidates) : [], state: {} }
  const x = input.enabled ? nearestAxis(anchorsX(original), input.candidates, 'x', threshold, input.previous?.x) : undefined
  const y = input.enabled ? nearestAxis(anchorsY(original), input.candidates, 'y', threshold, input.previous?.y) : undefined
  const gapX = input.enabled && !x ? equalGapDelta(original, input.candidates, 'x', threshold) : undefined
  const gapY = input.enabled && !y ? equalGapDelta(original, input.candidates, 'y', threshold) : undefined
  let dx = x?.delta ?? gapX ?? 0
  let dy = y?.delta ?? gapY ?? 0
  if (input.grid) {
    if (!x && gapX === undefined) dx = Math.round(original.x / input.grid) * input.grid - original.x
    if (!y && gapY === undefined) dy = Math.round(original.y / input.grid) * input.grid - original.y
  }
  const rect = { ...original, x: original.x + dx, y: original.y + dy }
  const guides: SnapGuide[] = []
  if (x) guides.push({ axis: 'x', value: x.target, from: Math.min(rect.y, ...input.candidates.map((item) => item.y)), to: Math.max(rect.y + rect.height, ...input.candidates.map((item) => item.y + item.height)) })
  if (y) guides.push({ axis: 'y', value: y.target, from: Math.min(rect.x, ...input.candidates.map((item) => item.x)), to: Math.max(rect.x + rect.width, ...input.candidates.map((item) => item.x + item.width)) })
  if (gapX !== undefined) guides.push({ axis: 'x', value: rect.x, from: rect.y, to: rect.y + rect.height, label: '等间距' })
  if (gapY !== undefined) guides.push({ axis: 'y', value: rect.y, from: rect.x, to: rect.x + rect.width, label: '等间距' })
  return { rect, guides, distances: input.measure ? nearestDistances(rect, input.candidates) : [], state: { ...(x ? { x: { target: x.target, source: x.source } } : {}), ...(y ? { y: { target: y.target, source: y.source } } : {}) } }
}

function nearestTarget(value: number, candidates: SnapRect[], axis: 'x' | 'y', threshold: number) {
  let best: { value: number; delta: number } | undefined
  for (const candidate of candidates) {
    for (const target of axis === 'x' ? anchorsX(candidate) : anchorsY(candidate)) {
      const delta = target - value
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { value: target, delta }
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
      const match = input.enabled ? nearestTarget(movingEdge, input.candidates, axis, threshold) : undefined
      const target = match?.value ?? (input.grid ? Math.round(movingEdge / input.grid) * input.grid : movingEdge)
      if (direction < 0) {
        const fixedEdge = start + rect[lengthKey]
        rect[axis] = Math.min(target, fixedEdge - 16)
        rect[lengthKey] = fixedEdge - rect[axis]
      } else rect[lengthKey] = Math.max(16, target - start)
      if (match) {
        const starts = input.candidates.map((item) => axis === 'x' ? item.y : item.x)
        const ends = input.candidates.map((item) => axis === 'x' ? item.y + item.height : item.x + item.width)
        guides.push({ axis, value: target, from: Math.min(axis === 'x' ? rect.y : rect.x, ...starts), to: Math.max(axis === 'x' ? rect.y + rect.height : rect.x + rect.width, ...ends) })
      }
    }
  }
  return { rect, guides, distances: input.measure ? nearestDistances(rect, input.candidates) : [], state: {} }
}

export function unionRect(rects: readonly SnapRect[]): SnapRect {
  const x = Math.min(...rects.map((rect) => rect.x))
  const y = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x, y, width: right - x, height: bottom - y }
}

export function deltaPoint(point: Point, dx: number, dy: number): Point { return { x: point.x + dx, y: point.y + dy } }
