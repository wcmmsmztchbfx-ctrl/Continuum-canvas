import type { Point } from '../../model/project'
import { CanvasPointPreview } from './CanvasSnapOverlay'

export function smoothPath(points: Point[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`
  let result = `M ${points[0]!.x} ${points[0]!.y}`
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index]!
    const next = points[index + 1]!
    result += ` Q ${point.x} ${point.y} ${(point.x + next.x) / 2} ${(point.x + next.y) / 2}`
  }
  const last = points.at(-1)!
  return `${result} L ${last.x} ${last.y}`
}

export function BrushPreview({ points }: { points: Point[] }) {
  return (
    <CanvasPointPreview>
      {({ x, y, zoom }) => (
        <svg className="canvas-brush-preview">
          <g transform={`translate(${x} ${y}) scale(${zoom})`}>
            <path d={smoothPath(points)} />
          </g>
        </svg>
      )}
    </CanvasPointPreview>
  )
}
