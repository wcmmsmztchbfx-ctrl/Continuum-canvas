import type { Point } from '../../model/project'
import { CanvasPointPreview } from './CanvasSnapOverlay'

export function smoothPath(points: Point[]): string {
  const valid = points.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
  if (valid.length === 0) return ''
  if (valid.length === 1) return `M ${valid[0]!.x} ${valid[0]!.y} L ${valid[0]!.x + 0.1} ${valid[0]!.y + 0.1}`
  let result = `M ${valid[0]!.x} ${valid[0]!.y}`
  for (let index = 1; index < valid.length - 1; index += 1) {
    const point = valid[index]!
    const next = valid[index + 1]!
    result += ` Q ${point.x} ${point.y} ${(point.x + next.x) / 2} ${(point.y + next.y) / 2}`
  }
  const last = valid.at(-1)!
  return `${result} L ${last.x} ${last.y}`
}

export function BrushPreview({ points }: { points: Point[] }) {
  return (
    <CanvasPointPreview>
      {({ x, y, zoom }) => (
        <svg className="canvas-brush-preview">
          <g transform={`translate(${x} ${y}) scale(${zoom})`}>
            <path d={smoothPath(points)} fill="none" />
          </g>
        </svg>
      )}
    </CanvasPointPreview>
  )
}
