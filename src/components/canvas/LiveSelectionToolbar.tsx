import { useCallback, useEffect, useRef, useState } from 'react'
import { NodeToolbar, Position, useStore as useReactFlowStore } from '@xyflow/react'

import { SelectionToolbar, type SelectionAction } from '../overlays/SelectionToolbar'
import { placeSelectionToolbar, selectionUnionBounds } from './selectionGeometry'

export interface LiveSelectionToolbarProps {
  grouped: boolean
  nodeIds: string[]
  onAction?: (action: SelectionAction) => void
}

function sameSelectionBounds(
  left: ReturnType<typeof selectionUnionBounds>,
  right: ReturnType<typeof selectionUnionBounds>,
) {
  return (
    left?.left === right?.left &&
    left?.top === right?.top &&
    left?.width === right?.width &&
    left?.height === right?.height
  )
}

export function LiveSelectionToolbar({
  grouped,
  nodeIds,
  onAction,
}: LiveSelectionToolbarProps) {
  const selectionBounds = useReactFlowStore(
    useCallback(
      (state) => {
        const rectangles = nodeIds.flatMap((nodeId) => {
          const node = state.nodeLookup.get(nodeId)
          if (!node) return []
          return [
            {
              x: node.internals.positionAbsolute.x,
              y: node.internals.positionAbsolute.y,
              width: node.measured.width ?? node.width ?? node.initialWidth ?? 0,
              height: node.measured.height ?? node.height ?? node.initialHeight ?? 0,
            },
          ]
        })
        return selectionUnionBounds(rectangles, {
          x: state.transform[0],
          y: state.transform[1],
          zoom: state.transform[2],
        })
      },
      [nodeIds],
    ),
    sameSelectionBounds,
  )
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const [toolbarSize, setToolbarSize] = useState({ width: 480, height: 40 })
  const [screenSize, setScreenSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))

  useEffect(() => {
    const bounds = toolbarRef.current?.getBoundingClientRect()
    if (!bounds?.width || !bounds.height) return
    setToolbarSize((prev) =>
      prev.width === bounds.width && prev.height === bounds.height
        ? prev
        : { width: bounds.width, height: bounds.height },
    )
  }, [grouped, nodeIds])

  useEffect(() => {
    const updateScreenSize = () => {
      setScreenSize({ width: window.innerWidth, height: window.innerHeight })
    }
    window.addEventListener('resize', updateScreenSize)
    return () => window.removeEventListener('resize', updateScreenSize)
  }, [])

  if (!selectionBounds) return null
  const placement = placeSelectionToolbar(
    selectionBounds,
    toolbarSize,
    screenSize,
  )

  return (
    <NodeToolbar
      className="canvas-selection-node-toolbar"
      isVisible
      nodeId={nodeIds}
      position={Position.Top}
      style={{
        transform: `translate(${placement.left}px, ${placement.top}px)`,
      }}
    >
      <div
        className="canvas-selection-toolbar-anchor"
        data-node-ids={nodeIds.join(',')}
        data-placement={placement.placement}
        data-testid="selection-toolbar-anchor"
        ref={toolbarRef}
      >
        <SelectionToolbar
          grouped={grouped}
          onAction={(action) => onAction?.(action)}
          open
        />
      </div>
    </NodeToolbar>
  )
}
