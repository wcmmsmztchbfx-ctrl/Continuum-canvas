import { useStore as useReactFlowStore } from '@xyflow/react'
import type { ReactNode } from 'react'

import type { SnapDistance, SnapGuide } from './smartSnapping'

export function CanvasPointPreview({
  children,
}: {
  children(transform: { x: number; y: number; zoom: number }): ReactNode
}) {
  const transform = useReactFlowStore((state) => state.transform)
  return <>{children({ x: transform[0], y: transform[1], zoom: transform[2] })}</>
}

export interface SnapOverlayProps {
  guides: SnapGuide[]
  distances: SnapDistance[]
}

export function SnapOverlay({ guides, distances }: SnapOverlayProps) {
  return (
    <CanvasPointPreview>
      {({ x, y, zoom }) => (
        <svg className="canvas-snap-overlay">
          {guides.map((guide, index) =>
            guide.axis === 'x' ? (
              <g key={`x-${index}`}>
                <line
                  x1={x + guide.value * zoom}
                  x2={x + guide.value * zoom}
                  y1={y + guide.from * zoom}
                  y2={y + guide.to * zoom}
                />
                {guide.label ? (
                  <text x={x + guide.value * zoom + 5} y={y + guide.from * zoom - 5}>
                    {guide.label}
                  </text>
                ) : null}
              </g>
            ) : (
              <g key={`y-${index}`}>
                <line
                  x1={x + guide.from * zoom}
                  x2={x + guide.to * zoom}
                  y1={y + guide.value * zoom}
                  y2={y + guide.value * zoom}
                />
                {guide.label ? (
                  <text x={x + guide.from * zoom + 5} y={y + guide.value * zoom - 5}>
                    {guide.label}
                  </text>
                ) : null}
              </g>
            ),
          )}
          {distances.map((distance, index) =>
            distance.axis === 'x' ? (
              <g key={`dx-${index}`}>
                <line
                  className="canvas-snap-distance"
                  x1={x + distance.from * zoom}
                  x2={x + distance.to * zoom}
                  y1={y + distance.cross * zoom}
                  y2={y + distance.cross * zoom}
                />
                <text
                  x={x + ((distance.from + distance.to) / 2) * zoom}
                  y={y + distance.cross * zoom - 5}
                >
                  {Math.round(distance.value)}
                </text>
              </g>
            ) : (
              <g key={`dy-${index}`}>
                <line
                  className="canvas-snap-distance"
                  x1={x + distance.cross * zoom}
                  x2={x + distance.cross * zoom}
                  y1={y + distance.from * zoom}
                  y2={y + distance.to * zoom}
                />
                <text
                  x={x + distance.cross * zoom + 5}
                  y={y + ((distance.from + distance.to) / 2) * zoom}
                >
                  {Math.round(distance.value)}
                </text>
              </g>
            ),
          )}
        </svg>
      )}
    </CanvasPointPreview>
  )
}
