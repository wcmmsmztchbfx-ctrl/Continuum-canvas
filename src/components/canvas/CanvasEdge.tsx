import { memo } from 'react'
import {
  getBezierPath,
  type ConnectionLineComponentProps,
  type EdgeProps,
} from '@xyflow/react'

import type { CanvasFlowEdge } from './mapping'

function CanvasEdgeContent({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  // Keep edges easy to pick even when the canvas is zoomed out.
  interactionWidth = 16,
  selected,
  data,
}: EdgeProps<CanvasFlowEdge>) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  const linked = Boolean(data?.linkedToSelected)
  const relation = data?.relation ?? 'flow'
  const flowActive = Boolean(selected || linked)
  const relationTitle =
    relation === 'reference'
      ? `参考${data?.referenceAlias ? ` @${data.referenceAlias}` : ''}`
      : relation === 'output'
        ? '生成结果'
        : '节点连接'
  const baseClassName = [
    'react-flow__edge-path',
    'canvas-edge__path',
    selected
      ? 'canvas-edge__path--selected'
      : linked
        ? 'canvas-edge__path--linked'
        : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <g
      className="canvas-edge"
      data-flow-active={flowActive}
      data-relation={relation}
    >
      <title>{relationTitle}</title>
      <path
        className="react-flow__edge-interaction canvas-edge__interaction"
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={interactionWidth}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="canvas-edge__highlight"
        d={path}
        fill="none"
      />
      <path
        className={baseClassName}
        d={path}
        fill="none"
        markerEnd={markerEnd}
      />
    </g>
  )
}

const StableCanvasEdge = memo(CanvasEdgeContent)

export function CanvasEdge(props: EdgeProps<CanvasFlowEdge>) {
  return <StableCanvasEdge {...props} />
}

export function CanvasConnectionLine({
  fromX,
  fromY,
  fromPosition,
  toX,
  toY,
  toPosition,
}: ConnectionLineComponentProps) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  })

  return (
    <g className="canvas-connection-preview">
      <path
        className="canvas-connection-preview__glow"
        d={path}
        fill="none"
        stroke="rgba(100, 180, 255, 0.4)"
        strokeWidth={6}
      />
      <path
        className="canvas-connection-preview__base"
        d={path}
        fill="none"
        strokeWidth={2}
      />
    </g>
  )
}
