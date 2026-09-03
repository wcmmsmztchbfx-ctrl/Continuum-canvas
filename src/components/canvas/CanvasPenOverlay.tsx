import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { PathAnchor, Point } from '../../model/project'
import { CanvasPointPreview } from './CanvasSnapOverlay'
import { constrainAngle, generateSvgPathData, isNearPoint } from './pathUtils'

export interface CanvasPenOverlayProps {
  onCommitPath: (anchors: PathAnchor[], closed: boolean) => void
  onCancel: () => void
  screenToFlowPosition: (clientPos: { x: number; y: number }) => Point
}

export function CanvasPenOverlay({
  onCommitPath,
  onCancel,
  screenToFlowPosition,
}: CanvasPenOverlayProps) {
  const [anchors, setAnchors] = useState<PathAnchor[]>([])
  const [currentPointer, setCurrentPointer] = useState<Point | null>(null)
  const [isNearStart, setIsNearStart] = useState(false)
  const isDraggingHandle = useRef(false)
  const shiftPressed = useRef(false)
  const dragStartPoint = useRef<Point | null>(null)

  // Global key listener for Shift, Enter, Escape, Backspace
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        shiftPressed.current = true
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (anchors.length >= 2) {
          onCommitPath(anchors, false)
        } else {
          onCancel()
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (anchors.length >= 2) {
          onCommitPath(anchors, false)
        } else {
          onCancel()
        }
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        setAnchors((prev) => {
          if (prev.length <= 1) {
            onCancel()
            return []
          }
          return prev.slice(0, -1)
        })
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        shiftPressed.current = false
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [anchors, onCommitPath, onCancel])

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()

    const rawFlowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY })

    // Check if clicking near the start anchor to close
    if (anchors.length >= 2 && isNearPoint(rawFlowPos, anchors[0], 14)) {
      onCommitPath(anchors, true)
      return
    }

    let nextPoint = rawFlowPos
    if (shiftPressed.current && anchors.length > 0) {
      nextPoint = constrainAngle(anchors[anchors.length - 1], rawFlowPos, 45)
    }

    dragStartPoint.current = nextPoint
    isDraggingHandle.current = true

    setAnchors((prev) => [...prev, { x: nextPoint.x, y: nextPoint.y }])
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rawFlowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY })

    // Check snapping to start anchor
    if (anchors.length >= 2) {
      setIsNearStart(isNearPoint(rawFlowPos, anchors[0], 14))
    } else {
      setIsNearStart(false)
    }

    let nextPoint = rawFlowPos
    if (shiftPressed.current && anchors.length > 0) {
      const origin = dragStartPoint.current ?? anchors[anchors.length - 1]
      nextPoint = constrainAngle(origin, rawFlowPos, 45)
    }

    setCurrentPointer(nextPoint)

    // If dragging to pull out Bézier handle
    if (isDraggingHandle.current && anchors.length > 0) {
      setAnchors((prev) => {
        const lastIdx = prev.length - 1
        const last = prev[lastIdx]!
        const dx = nextPoint.x - last.x
        const dy = nextPoint.y - last.y

        // Mirrored in/out handles
        const outHandle: Point = { x: last.x + dx, y: last.y + dy }
        const inHandle: Point = { x: last.x - dx, y: last.y - dy }

        const updated: PathAnchor = {
          ...last,
          out: outHandle,
          in: inHandle,
        }

        const next = [...prev]
        next[lastIdx] = updated
        return next
      })
    }
  }

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()

    if (isDraggingHandle.current && anchors.length > 0) {
      setAnchors((prev) => {
        const lastIdx = prev.length - 1
        const last = prev[lastIdx]!
        if (last.out && isNearPoint(last, last.out, 3)) {
          // If barely moved, treat as sharp corner point without handles
          const next = [...prev]
          next[lastIdx] = { x: last.x, y: last.y }
          return next
        }
        return prev
      })
    }

    isDraggingHandle.current = false
    dragStartPoint.current = null
  }

  return (
    <CanvasPointPreview>
      {({ x, y, zoom }) => {
        // Calculate dynamic rubber-band path to cursor
        let rubberBandD = ''
        if (anchors.length > 0 && currentPointer && !isDraggingHandle.current) {
          const last = anchors[anchors.length - 1]
          const target = isNearStart && anchors.length >= 2 ? anchors[0] : currentPointer

          if (last.out || (isNearStart && anchors[0].in)) {
            const outP = last.out ?? { x: last.x, y: last.y }
            const inP = (isNearStart && anchors[0].in) ? anchors[0].in : target
            rubberBandD = `M ${last.x} ${last.y} C ${outP.x} ${outP.y} ${inP.x} ${inP.y} ${target.x} ${target.y}`
          } else {
            rubberBandD = `M ${last.x} ${last.y} L ${target.x} ${target.y}`
          }
        }

        return (
          <svg
            aria-label="钢笔绘制图层"
            className="canvas-pen-overlay"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'auto',
              cursor: 'crosshair',
              zIndex: 35,
            }}
          >
            <g transform={`translate(${x} ${y}) scale(${zoom})`}>
              {/* 1. Committed segments so far */}
              {anchors.length > 0 && (
                <path
                  d={generateSvgPathData(anchors, false)}
                  fill="none"
                  stroke="#0d99ff"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2 / zoom}
                />
              )}

              {/* 2. Rubber-band preview to cursor */}
              {rubberBandD && (
                <path
                  d={rubberBandD}
                  fill="none"
                  opacity={0.8}
                  stroke="#0d99ff"
                  strokeDasharray={`${4 / zoom} ${4 / zoom}`}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5 / zoom}
                />
              )}

              {/* 3. Anchor points and control handles */}
              {anchors.map((a, idx) => (
                <g key={idx}>
                  {a.out && (
                    <>
                      <line
                        stroke="#0d99ff"
                        strokeWidth={1 / zoom}
                        x1={a.x}
                        x2={a.out.x}
                        y1={a.y}
                        y2={a.out.y}
                      />
                      <circle
                        cx={a.out.x}
                        cy={a.out.y}
                        fill="#ffffff"
                        r={3 / zoom}
                        stroke="#0d99ff"
                        strokeWidth={1.5 / zoom}
                      />
                    </>
                  )}
                  {a.in && (
                    <>
                      <line
                        stroke="#0d99ff"
                        strokeWidth={1 / zoom}
                        x1={a.x}
                        x2={a.in.x}
                        y1={a.y}
                        y2={a.in.y}
                      />
                      <circle
                        cx={a.in.x}
                        cy={a.in.y}
                        fill="#ffffff"
                        r={3 / zoom}
                        stroke="#0d99ff"
                        strokeWidth={1.5 / zoom}
                      />
                    </>
                  )}
                  {/* Square anchor vertex */}
                  <rect
                    fill={idx === 0 && isNearStart ? '#10b981' : '#ffffff'}
                    height={7 / zoom}
                    stroke={idx === 0 && isNearStart ? '#059669' : '#0d99ff'}
                    strokeWidth={1.5 / zoom}
                    width={7 / zoom}
                    x={a.x - 3.5 / zoom}
                    y={a.y - 3.5 / zoom}
                  />
                </g>
              ))}

              {/* 4. Start point close indicator halo */}
              {isNearStart && anchors.length >= 2 && (
                <circle
                  cx={anchors[0].x}
                  cy={anchors[0].y}
                  fill="none"
                  r={9 / zoom}
                  stroke="#10b981"
                  strokeDasharray={`${3 / zoom} ${2 / zoom}`}
                  strokeWidth={2 / zoom}
                />
              )}
            </g>
          </svg>
        )
      }}
    </CanvasPointPreview>
  )
}
