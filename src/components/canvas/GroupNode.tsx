import { memo } from 'react'
import { useStore as useReactFlowStore, type NodeProps } from '@xyflow/react'

import { EditableNodeLabel } from './EditableNodeLabel'
import type { CanvasFlowNode } from './mapping'

function GroupNodeContent({ id, data }: NodeProps<CanvasFlowNode>) {
  let zoom: number
  try {
    zoom = useReactFlowStore((s) => s.transform[2])
  } catch {
    zoom = 1
  }

  const safeZoom = Math.max(0.01, zoom || 1)
  const borderWidth = Math.max(2, Math.min(40, Math.round(2 / safeZoom)))
  const borderRadius = Math.max(4, Math.min(40, Math.round(4 / safeZoom)))

  return (
    <article
      aria-label={data.name}
      className="canvas-group-node"
      style={{
        '--group-border-width': `${borderWidth}px`,
        '--group-border-radius': `${borderRadius}px`,
      } as React.CSSProperties}
    >
      <EditableNodeLabel
        name={data.name}
        nodeId={id}
        onRename={data.onRename}
      />
      <div className="canvas-group-node__frame" />
    </article>
  )
}

const StableGroupNode = memo(GroupNodeContent)

export function GroupNode(props: NodeProps<CanvasFlowNode>) {
  return <StableGroupNode {...props} />
}
