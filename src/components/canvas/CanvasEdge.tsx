import {
  getBezierPath,
  type ConnectionLineComponentProps,
  type EdgeProps,
} from '@xyflow/react'

import type { CanvasFlowEdge } from './mapping'

const FLOW_PATH_COUNT = 3
const FLOW_DURATION_MS = 2800

function FlowPaths({
  className,
  path,
}: {
  className: string
  path: string
}) {
  const globalPhase = -(Date.now() % FLOW_DURATION_MS)
  return (
    <g className="canvas-edge__flow-group">
      {Array.from({ length: FLOW_PATH_COUNT }, (_, index) => (
        <path
          aria-hidden="true"
          className={`${className} canvas-edge__flow--animated`}
          d={path}
          fill="none"
          key={index}
          pathLength={100}
          style={{
            animationDelay: `${globalPhase - index * (FLOW_DURATION_MS / FLOW_PATH_COUNT)}ms`,
          }}
        />
      ))}
    </g>
  )
}

export function CanvasEdge({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  // 40px 命中带：快速划过连线时鼠标事件更容易落在带内，避免高亮/粒子触发不了
  interactionWidth = 40,
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
      : flowActive
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
      <FlowPaths className="canvas-edge__flow" path={path} />
    </g>
  )
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
      <FlowPaths
        className="canvas-connection-preview__flow"
        path={path}
      />
    </g>
  )
}
