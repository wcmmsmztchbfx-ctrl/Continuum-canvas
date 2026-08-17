import { memo } from 'react'
import type { NodeProps } from '@xyflow/react'

import { EditableNodeLabel } from './EditableNodeLabel'
import type { CanvasFlowNode } from './mapping'

function GroupNodeContent({ id, data }: NodeProps<CanvasFlowNode>) {
  return (
    <article aria-label={data.name} className="canvas-group-node">
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
