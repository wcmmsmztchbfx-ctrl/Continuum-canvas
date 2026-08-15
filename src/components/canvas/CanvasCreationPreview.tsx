import type { Point } from '../../model/project'
import type { SnapRect } from './smartSnapping'
import { CanvasPointPreview } from './CanvasSnapOverlay'

export interface CreationPreviewState {
  tool: 'frame' | 'shape' | 'text'
  start: Point
  current: Point
  constrained: boolean
  rect?: SnapRect
}

export function CreationPreview({ preview }: { preview: CreationPreviewState }) {
  return (
    <CanvasPointPreview>
      {({ x, y, zoom }) => {
        const dx = preview.current.x - preview.start.x
        const dy = preview.current.y - preview.start.y
        let width = Math.abs(dx)
        let height = Math.abs(dy)
        if (preview.constrained && preview.tool !== 'text') {
          width = height = Math.max(width, height)
        }
        const rect = preview.rect ?? {
          x: dx < 0 ? preview.start.x - width : preview.start.x,
          y: dy < 0 ? preview.start.y - height : preview.start.y,
          width,
          height,
        }
        return (
          <div
            className={`canvas-creation-preview canvas-creation-preview--${preview.tool}`}
            style={{
              left: x + rect.x * zoom,
              top: y + rect.y * zoom,
              width: Math.max(1, rect.width * zoom),
              height: Math.max(1, rect.height * zoom),
            }}
          >
            <span>
              {Math.round(rect.width)} × {Math.round(rect.height)}
            </span>
          </div>
        )
      }}
    </CanvasPointPreview>
  )
}
