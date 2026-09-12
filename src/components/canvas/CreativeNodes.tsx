import { memo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { NodeResizer, useStore as useReactFlowStore, type NodeProps } from '@xyflow/react'

import type { FrameNode as FrameModel, PathNode as PathModel, ShapeNode as ShapeModel } from '../../model/project'
import type { CanvasFlowNode } from './mapping'
import { EditableNodeLabel } from './EditableNodeLabel'
import {
  computeAppearanceStyles,
  NOISE_SVG_DATA_URI,
  TEXTURE_DOTS_DATA_URI,
} from './effectStyleUtils'


function pathData(node: PathModel): string {
  const [first, ...rest] = node.data.anchors
  if (!first) return ''
  if (node.data.kind === 'brush' && rest.length > 1) {
    let result = `M ${first.x} ${first.y}`
    for (let index = 0; index < rest.length - 1; index += 1) {
      const point = rest[index]!
      const next = rest[index + 1]!
      result += ` Q ${point.x} ${point.y} ${(point.x + next.x) / 2} ${(point.y + next.y) / 2}`
    }
    const last = rest.at(-1)!
    return `${result} L ${last.x} ${last.y}`
  }
  let result = `M ${first.x} ${first.y}`
  let previous = first
  for (const anchor of rest) {
    if (previous.out || anchor.in) {
      const out = previous.out ?? { x: previous.x, y: previous.y }
      const incoming = anchor.in ?? { x: anchor.x, y: anchor.y }
      result += ` C ${out.x} ${out.y} ${incoming.x} ${incoming.y} ${anchor.x} ${anchor.y}`
    } else result += ` L ${anchor.x} ${anchor.y}`
    previous = anchor
  }
  return node.data.closed ? `${result} Z` : result
}

function SelectionChrome({ id, data, node, selected }: { id: string; data: CanvasFlowNode['data']; node: FrameModel | ShapeModel; selected: boolean }) {
  const [previewRotation, setPreviewRotation] = useState(node.data.rotation ?? 0)
  const previewRotationRef = useRef(previewRotation)
  const rotating = useRef(false)
  let zoom = 1
  try {
    zoom = useReactFlowStore((s) => s.transform[2])
  } catch {
    zoom = 1
  }
  const scale = Math.min(3.5, Math.max(0.5, 1 / (zoom || 1)))
  const startRotation = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const root = event.currentTarget.closest('.react-flow__node')
    const visual = event.currentTarget.closest('.canvas-frame-node, .canvas-shape-node') as HTMLElement | null
    const bounds = root?.getBoundingClientRect()
    if (!bounds) return
    rotating.current = true
    const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
    const move = (moveEvent: PointerEvent) => {
      if (!rotating.current) return
      let degrees = Math.atan2(moveEvent.clientY - center.y, moveEvent.clientX - center.x) * 180 / Math.PI + 90
      if (moveEvent.shiftKey) degrees = Math.round(degrees / 15) * 15
      previewRotationRef.current = Math.round(degrees)
      setPreviewRotation(previewRotationRef.current)
      if (visual) visual.style.transform = `rotate(${previewRotationRef.current}deg)`
    }
    const end = () => {
      rotating.current = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      data.onCreativeChange?.(id, { rotation: previewRotationRef.current })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end, { once: true })
  }
  if (!selected) return null
  return <>
    <button
      aria-label="旋转"
      className="creative-rotation-handle nodrag nopan"
      onPointerDown={startRotation}
      style={{
        transform: `translateX(-50%) scale(${scale})`,
        top: `calc(-16px - 18px * ${scale})`,
        transformOrigin: 'bottom center',
      }}
      type="button"
    />
    <span
      className="creative-size-label"
      style={{
        transform: `translateX(-50%) scale(${scale})`,
        top: `calc(100% + 8px * ${scale})`,
        transformOrigin: 'top center',
      }}
    >
      {Math.round(node.size.width)} × {Math.round(node.size.height)}{previewRotation ? ` · ${previewRotation}°` : ''}
    </span>
  </>
}

function resizer(id: string, data: CanvasFlowNode['data'], selected: boolean) {
  let latest: { x: number; y: number; width: number; height: number } | undefined
  const modifiers = (event: { sourceEvent?: MouseEvent | TouchEvent }) => {
    const source = event.sourceEvent
    return { ctrlKey: source instanceof MouseEvent ? source.ctrlKey : false, altKey: source instanceof MouseEvent ? source.altKey : false }
  }
  return <NodeResizer color="#0d99ff" handleClassName="creative-resize-handle" isVisible={selected} keepAspectRatio={false} lineClassName="creative-resize-line" minHeight={16} minWidth={16} onResizeEnd={(_event, geometry) => { const finalGeometry = latest ?? geometry; latest = undefined; data.onCreativeChange?.(id, { size: { width: finalGeometry.width, height: finalGeometry.height }, position: { x: finalGeometry.x, y: finalGeometry.y } }) }} shouldResize={(event, geometry) => { latest = data.onCreativeResizeSnap?.(id, geometry, modifiers(event)) ?? geometry; Object.assign(geometry, latest); return true }} />
}

function FrameNodeContent({ id, data, selected }: NodeProps<CanvasFlowNode>) {
  const node = data.node
  let zoom = 1
  try {
    zoom = useReactFlowStore((s) => s.transform[2])
  } catch {
    zoom = 1
  }
  if (!node || node.type !== 'frame') return null

  const appearance = computeAppearanceStyles(node.data)

  return (
    <article
      className="canvas-frame-node"
      style={{
        ...appearance.style,
        filter: undefined,
        position: 'relative',
        overflow: 'hidden',
        transform: `rotate(${node.data.rotation ?? 0}deg)`,
        '--resizer-scale': Math.min(1.35, Math.max(1, 1 / (zoom || 1))),
      } as React.CSSProperties}
    >
      {appearance.style.filter && (
        <div
          className="canvas-frame-node__blur-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            background: appearance.style.background,
            filter: appearance.style.filter,
            pointerEvents: 'none',
          }}
        />
      )}
      {appearance.hasNoise && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `url("${NOISE_SVG_DATA_URI}")`,
            pointerEvents: 'none',
            opacity: 0.6,
          }}
        />
      )}
      {appearance.hasTexture && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `url("${TEXTURE_DOTS_DATA_URI}")`,
            pointerEvents: 'none',
            opacity: 0.45,
          }}
        />
      )}
      {appearance.hasShader && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(135deg, rgba(99,102,241,0.25) 0%, rgba(168,85,247,0.25) 50%, rgba(236,72,153,0.25) 100%)',
            pointerEvents: 'none',
            mixBlendMode: 'overlay',
          }}
        />
      )}
      {resizer(id, data, selected)}
      <EditableNodeLabel name={data.name} nodeId={id} onRename={data.onRename} />
      <SelectionChrome data={data} id={id} node={node} selected={selected} />
    </article>
  )
}

export const FrameNode = memo(FrameNodeContent)

function ShapeNodeContent({ id, data, selected }: NodeProps<CanvasFlowNode>) {
  const node = data.node as ShapeModel | undefined
  let zoom = 1
  try {
    zoom = useReactFlowStore((s) => s.transform[2])
  } catch {
    zoom = 1
  }
  if (!node || node.type !== 'shape') return null

  const appearance = computeAppearanceStyles(node.data)
  const primaryFill = appearance.fills.find((f) => f.enabled)?.color ?? (node.data.fill || 'transparent')
  const primaryStroke = appearance.strokes.find((s) => s.enabled)?.color ?? (node.data.stroke || 'none')
  const strokeWidth = appearance.strokes.find((s) => s.enabled)?.width ?? (node.data.strokeWidth || 0)
  const strokeDash = appearance.strokes.find((s) => s.enabled)?.style === 'dashed' ? '4 4' : undefined

  const isEllipse = node.data.kind === 'ellipse'
  const isLine = node.data.kind === 'line' || node.data.kind === 'arrow'
  const borderRadius = isEllipse
    ? '50%'
    : (node.data.kind === 'rounded-rectangle' || node.data.radius ? `${node.data.radius ?? 0}px` : undefined)

  // For 2D closed shapes (rectangle, rounded-rectangle, ellipse):
  // Outside, inside, and center strokes are rendered via CSS box-shadow/outline on the outer container.
  // This guarantees:
  // 1. Outside strokes radiate 100% outward without eating into the shape's fill area.
  // 2. SVG viewBox bounds never clip thick outside strokes.
  // 3. Ellipses produce smooth, vector-perfect outside strokes with border-radius: 50%.
  // For open lines/arrows, stroke is rendered directly on the SVG line.
  const svgStroke = isLine ? primaryStroke : 'none'
  const svgStrokeWidth = isLine ? strokeWidth : 0
  const svgStrokeDash = isLine ? strokeDash : undefined

  const style = {
    fill: primaryFill,
    stroke: svgStroke,
    strokeWidth: svgStrokeWidth,
    strokeDasharray: svgStrokeDash,
    opacity: node.data.opacity,
  }

  return (
    <div
      className="canvas-creative-node canvas-shape-node"
      style={{
        transform: `rotate(${node.data.rotation ?? 0}deg)`,
        borderRadius,
        boxShadow: !isLine ? appearance.style.boxShadow : undefined,
        outline: !isLine ? appearance.style.outline : undefined,
        outlineOffset: !isLine ? appearance.style.outlineOffset : undefined,
        '--resizer-scale': Math.min(1.35, Math.max(1, 1 / (zoom || 1))),
      } as React.CSSProperties}
    >
      {resizer(id, data, selected)}
      <div
        className="canvas-shape-node__content"
        style={{
          width: '100%',
          height: '100%',
          borderRadius,
          filter: appearance.style.filter,
        }}
      >
        <svg
          aria-label={data.name}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%', overflow: 'visible' }}
          viewBox="0 0 100 100"
        >
          {isEllipse ? (
            <ellipse cx="50" cy="50" rx="50" ry="50" style={style} />
          ) : isLine ? (
            <line
              markerEnd={node.data.kind === 'arrow' ? 'url(#canvas-arrow)' : undefined}
              style={style}
              x1="1"
              x2="99"
              y1="99"
              y2="1"
            />
          ) : (
            <rect
              height="100"
              rx={node.data.kind === 'rounded-rectangle' || node.data.radius ? node.data.radius ?? 0 : 0}
              style={style}
              width="100"
              x="0"
              y="0"
            />
          )}
          <defs>
            <marker
              id="canvas-arrow"
              markerHeight="8"
              markerWidth="8"
              orient="auto"
              refX="7"
              refY="4"
            >
              <path d="M0,0 L8,4 L0,8 Z" fill={primaryStroke} />
            </marker>
          </defs>
        </svg>
      </div>
      <SelectionChrome data={data} id={id} node={node} selected={selected} />
    </div>
  )
}

export const ShapeNode = memo(ShapeNodeContent)

function PathNodeContent({ data, selected }: NodeProps<CanvasFlowNode>) {
  const node = data.node as PathModel | undefined
  if (!node || node.type !== 'path') return null

  const appearance = computeAppearanceStyles(node.data)
  const primaryFill = appearance.fills.find((f) => f.enabled)?.color ?? (node.data.closed ? (node.data.fill || 'transparent') : 'none')
  const primaryStroke = appearance.strokes.find((s) => s.enabled)?.color ?? (node.data.stroke || 'currentColor')
  const strokeWidth = appearance.strokes.find((s) => s.enabled)?.width ?? (node.data.strokeWidth || 1)
  const strokeDash = appearance.strokes.find((s) => s.enabled)?.style === 'dashed' ? '4 4' : undefined

  return (
    <div
      className="canvas-creative-node canvas-path-node"
      style={{
        opacity: node.data.opacity,
        transform: (node.data as { rotation?: number }).rotation
          ? `rotate(${(node.data as { rotation?: number }).rotation}deg)`
          : undefined,
      }}
    >
      <NodeResizer
        color="#0d99ff"
        isVisible={selected && !data.editingVector}
        minHeight={16}
        minWidth={16}
      />
      <div
        className="canvas-path-node__content"
        style={{
          width: '100%',
          height: '100%',
          filter: appearance.style.filter,
        }}
      >
        <svg
          aria-label={data.name}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%', overflow: 'visible' }}
          viewBox={`0 0 ${node.size.width} ${node.size.height}`}
        >
          <path
            d={pathData(node)}
            fill={node.data.closed ? primaryFill : 'none'}
            stroke={primaryStroke}
            strokeDasharray={strokeDash}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={strokeWidth}
          />
        </svg>
      </div>
    </div>
  )
}

export const PathNode = memo(PathNodeContent)
