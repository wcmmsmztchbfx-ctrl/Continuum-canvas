import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { NodeResizer, type NodeProps } from '@xyflow/react'

import type { FrameNode as FrameModel, PathNode as PathModel, ShapeNode as ShapeModel } from '../../model/project'
import type { CanvasFlowNode } from './mapping'
import { EditableNodeLabel } from './EditableNodeLabel'

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
    <button aria-label="旋转" className="creative-rotation-handle nodrag nopan" onPointerDown={startRotation} type="button" />
    <span className="creative-size-label">{Math.round(node.size.width)} × {Math.round(node.size.height)}{previewRotation ? ` · ${previewRotation}°` : ''}</span>
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

export function FrameNode({ id, data, selected }: NodeProps<CanvasFlowNode>) {
  const node = data.node
  if (!node || node.type !== 'frame') return null
  return <article className="canvas-frame-node" style={{ background: node.data.fill, borderColor: node.data.stroke, borderWidth: node.data.strokeWidth, transform: `rotate(${node.data.rotation ?? 0}deg)` }}>
    {resizer(id, data, selected)}
    <EditableNodeLabel name={data.name} nodeId={id} onRename={data.onRename} />
    <SelectionChrome data={data} id={id} node={node} selected={selected} />
  </article>
}

export function ShapeNode({ id, data, selected }: NodeProps<CanvasFlowNode>) {
  const node = data.node as ShapeModel | undefined
  if (!node || node.type !== 'shape') return null
  const style = { fill: node.data.fill, stroke: node.data.stroke, strokeWidth: node.data.strokeWidth, opacity: node.data.opacity }
  const line = node.data.kind === 'line' || node.data.kind === 'arrow'
  return <div className="canvas-creative-node canvas-shape-node" style={{ transform: `rotate(${node.data.rotation ?? 0}deg)` }}>
    {resizer(id, data, selected)}
    <svg aria-label={data.name} preserveAspectRatio="none" viewBox="0 0 100 100">
      {node.data.kind === 'ellipse' ? <ellipse cx="50" cy="50" rx="49" ry="49" style={style} /> : line ? <line markerEnd={node.data.kind === 'arrow' ? 'url(#canvas-arrow)' : undefined} style={style} x1="1" x2="99" y1="99" y2="1" /> : <rect height="98" rx={node.data.kind === 'rounded-rectangle' || node.data.radius ? node.data.radius ?? 0 : 0} style={style} width="98" x="1" y="1" />}
      <defs><marker id="canvas-arrow" markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4"><path d="M0,0 L8,4 L0,8 Z" fill={node.data.stroke} /></marker></defs>
    </svg>
    <SelectionChrome data={data} id={id} node={node} selected={selected} />
  </div>
}

export function PathNode({ data, selected }: NodeProps<CanvasFlowNode>) {
  const node = data.node as PathModel | undefined
  if (!node || node.type !== 'path') return null
  return <div className="canvas-creative-node">
    <NodeResizer color="#0d99ff" isVisible={selected} minHeight={16} minWidth={16} />
    <svg aria-label={data.name} preserveAspectRatio="none" viewBox={`0 0 ${node.size.width} ${node.size.height}`}><path d={pathData(node)} fill={node.data.closed ? node.data.fill : 'none'} opacity={node.data.opacity} stroke={node.data.stroke} strokeLinecap="round" strokeLinejoin="round" strokeWidth={node.data.strokeWidth} /></svg>
  </div>
}
