import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { PathAnchor, PathNode, Point } from '../../model/project'
import { CanvasPointPreview } from './CanvasSnapOverlay'
import {
  computePathBounds,
  denormalizePathAnchors,
  distanceToSegment,
  generateSvgPathData,
  isNearPoint,
  normalizePathAnchors,
} from './pathUtils'

export interface CanvasPathEditorOverlayProps {
  node: PathNode
  onUpdateNode: (
    changes: { position?: Point; size?: { width: number; height: number }; data?: Record<string, unknown> },
    commit?: boolean,
  ) => void
  onExit: () => void
  screenToFlowPosition: (clientPos: { x: number; y: number }) => Point
}

export function CanvasPathEditorOverlay({
  node,
  onUpdateNode,
  onExit,
  screenToFlowPosition,
}: CanvasPathEditorOverlayProps) {
  // Convert relative anchors to absolute flow coordinates for interactive editing
  const [anchors, setAnchors] = useState<PathAnchor[]>(() =>
    denormalizePathAnchors(node.data.anchors, node.position),
  )
  const [selectedAnchorIndex, setSelectedAnchorIndex] = useState<number | null>(null)
  const draggingTarget = useRef<{ type: 'anchor' | 'in' | 'out'; index: number } | null>(null)
  const dragLastPos = useRef<Point | null>(null)
  const hasMoved = useRef(false)
  const altPressed = useRef(false)

  // Sync if node prop externally changed and not dragging
  useEffect(() => {
    if (!draggingTarget.current) {
      setAnchors(denormalizePathAnchors(node.data.anchors, node.position))
    }
  }, [node.data.anchors, node.position])

  // Finish and commit on exit
  const finishEditing = () => {
    if (anchors.length < 2) {
      onExit()
      return
    }
    const bounds = computePathBounds(anchors, 16)
    const normalized = normalizePathAnchors(anchors, { x: bounds.minX, y: bounds.minY })
    onUpdateNode(
      {
        position: { x: bounds.minX, y: bounds.minY },
        size: { width: bounds.width, height: bounds.height },
        data: {
          ...node.data,
          anchors: normalized,
        },
      },
      true,
    )
    onExit()
  }

  // Keyboard shortcuts: Delete, Enter, Escape, Alt
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        altPressed.current = true
      } else if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault()
        finishEditing()
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (selectedAnchorIndex !== null && anchors.length > 2) {
          e.preventDefault()
          const next = anchors.filter((_, idx) => idx !== selectedAnchorIndex)
          setAnchors(next)
          setSelectedAnchorIndex(null)
          const bounds = computePathBounds(next, 16)
          const normalized = normalizePathAnchors(next, { x: bounds.minX, y: bounds.minY })
          onUpdateNode(
            {
              position: { x: bounds.minX, y: bounds.minY },
              size: { width: bounds.width, height: bounds.height },
              data: { ...node.data, anchors: normalized },
            },
            true,
          )
        }
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        altPressed.current = false
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [anchors, selectedAnchorIndex, node, onUpdateNode])

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    hasMoved.current = false

    // 1. Check if clicking an existing control handle
    if (selectedAnchorIndex !== null && anchors[selectedAnchorIndex]) {
      const activeAnchor = anchors[selectedAnchorIndex]!
      if (activeAnchor.out && isNearPoint(flowPos, activeAnchor.out, 8)) {
        event.preventDefault()
        event.stopPropagation()
        draggingTarget.current = { type: 'out', index: selectedAnchorIndex }
        dragLastPos.current = flowPos
        return
      }
      if (activeAnchor.in && isNearPoint(flowPos, activeAnchor.in, 8)) {
        event.preventDefault()
        event.stopPropagation()
        draggingTarget.current = { type: 'in', index: selectedAnchorIndex }
        dragLastPos.current = flowPos
        return
      }
    }

    // 2. Check if clicking an anchor vertex
    for (let i = 0; i < anchors.length; i++) {
      if (isNearPoint(flowPos, anchors[i]!, 8)) {
        event.preventDefault()
        event.stopPropagation()
        setSelectedAnchorIndex(i)
        draggingTarget.current = { type: 'anchor', index: i }
        dragLastPos.current = flowPos
        return
      }
    }

    // 3. Check if clicking on an edge segment to insert a new anchor
    for (let i = 0; i < anchors.length - (node.data.closed ? 0 : 1); i++) {
      const p1 = anchors[i]!
      const p2 = anchors[(i + 1) % anchors.length]!
      if (distanceToSegment(flowPos, p1, p2) <= 6) {
        event.preventDefault()
        event.stopPropagation()
        const newAnchor: PathAnchor = { x: flowPos.x, y: flowPos.y }
        const next = [...anchors]
        next.splice(i + 1, 0, newAnchor)
        setAnchors(next)
        setSelectedAnchorIndex(i + 1)
        draggingTarget.current = { type: 'anchor', index: i + 1 }
        dragLastPos.current = flowPos
        return
      }
    }

    // Otherwise click was on background: deselect anchor
    setSelectedAnchorIndex(null)
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!draggingTarget.current || !dragLastPos.current) return
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const { type, index } = draggingTarget.current
    const targetAnchor = anchors[index]
    if (!targetAnchor) return
    hasMoved.current = true

    setAnchors((prev) => {
      const next = [...prev]
      const current = { ...next[index]! }

      if (type === 'anchor') {
        const dx = flowPos.x - dragLastPos.current!.x
        const dy = flowPos.y - dragLastPos.current!.y
        current.x += dx
        current.y += dy
        if (current.out) {
          current.out = { x: current.out.x + dx, y: current.out.y + dy }
        }
        if (current.in) {
          current.in = { x: current.in.x + dx, y: current.in.y + dy }
        }
      } else if (type === 'out') {
        current.out = { x: flowPos.x, y: flowPos.y }
        if (!altPressed.current) {
          // Mirrored in handle
          const dx = flowPos.x - current.x
          const dy = flowPos.y - current.y
          current.in = { x: current.x - dx, y: current.y - dy }
        }
      } else if (type === 'in') {
        current.in = { x: flowPos.x, y: flowPos.y }
        if (!altPressed.current) {
          // Mirrored out handle
          const dx = flowPos.x - current.x
          const dy = flowPos.y - current.y
          current.out = { x: current.x - dx, y: current.y - dy }
        }
      }

      next[index] = current
      return next
    })

    dragLastPos.current = flowPos
  }

  const handlePointerUp = () => {
    if (draggingTarget.current) {
      if (hasMoved.current) {
        // Save throttled snapshot to store only if moved
        const bounds = computePathBounds(anchors, 16)
        const normalized = normalizePathAnchors(anchors, { x: bounds.minX, y: bounds.minY })
        onUpdateNode(
          {
            position: { x: bounds.minX, y: bounds.minY },
            size: { width: bounds.width, height: bounds.height },
            data: { ...node.data, anchors: normalized },
          },
          false,
        )
      }
      draggingTarget.current = null
      dragLastPos.current = null
      hasMoved.current = false
    }
  }

  return (
    <CanvasPointPreview>
      {({ x, y, zoom }) => {
        const selectedAnchor =
          selectedAnchorIndex !== null ? anchors[selectedAnchorIndex] : null

        return (
          <svg
            aria-label="矢量编辑模式图层"
            className="canvas-path-editor-overlay"
            onDoubleClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              finishEditing()
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'auto',
              cursor: 'default',
              zIndex: 36,
            }}
          >
            <g transform={`translate(${x} ${y}) scale(${zoom})`}>
              {/* Path outline */}
              <path
                d={generateSvgPathData(anchors, node.data.closed)}
                fill={node.data.closed ? (node.data.fill || 'transparent') : 'none'}
                opacity={node.data.opacity}
                stroke={node.data.stroke || '#0d99ff'}
                strokeDasharray={node.data.strokeStyle === 'dashed' ? '4 4' : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={Math.max(1.5, node.data.strokeWidth)}
              />

              {/* Selected anchor control handles */}
              {selectedAnchor && (
                <>
                  {selectedAnchor.out && (
                    <>
                      <line
                        stroke="#0d99ff"
                        strokeWidth={1 / zoom}
                        x1={selectedAnchor.x}
                        x2={selectedAnchor.out.x}
                        y1={selectedAnchor.y}
                        y2={selectedAnchor.out.y}
                      />
                      <circle
                        className="canvas-path-editor__handle"
                        cx={selectedAnchor.out.x}
                        cy={selectedAnchor.out.y}
                        fill="#ffffff"
                        r={3.5 / zoom}
                        stroke="#0d99ff"
                        strokeWidth={1.5 / zoom}
                        style={{ cursor: 'pointer' }}
                      />
                    </>
                  )}
                  {selectedAnchor.in && (
                    <>
                      <line
                        stroke="#0d99ff"
                        strokeWidth={1 / zoom}
                        x1={selectedAnchor.x}
                        x2={selectedAnchor.in.x}
                        y1={selectedAnchor.y}
                        y2={selectedAnchor.in.y}
                      />
                      <circle
                        className="canvas-path-editor__handle"
                        cx={selectedAnchor.in.x}
                        cy={selectedAnchor.in.y}
                        fill="#ffffff"
                        r={3.5 / zoom}
                        stroke="#0d99ff"
                        strokeWidth={1.5 / zoom}
                        style={{ cursor: 'pointer' }}
                      />
                    </>
                  )}
                </>
              )}

              {/* All Anchor Vertices */}
              {anchors.map((a, idx) => {
                const isSelected = idx === selectedAnchorIndex
                return (
                  <rect
                    className="canvas-path-editor__vertex"
                    fill={isSelected ? '#0d99ff' : '#ffffff'}
                    height={7 / zoom}
                    key={idx}
                    stroke="#0d99ff"
                    strokeWidth={1.5 / zoom}
                    style={{ cursor: 'move' }}
                    width={7 / zoom}
                    x={a.x - 3.5 / zoom}
                    y={a.y - 3.5 / zoom}
                  />
                )
              })}
            </g>
          </svg>
        )
      }}
    </CanvasPointPreview>
  )
}
