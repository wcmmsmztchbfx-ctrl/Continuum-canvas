import { Plus } from 'lucide-react'
import { Handle, Position } from '@xyflow/react'

interface NodeHandleProps {
  id: 'source' | 'target'
  type: 'source' | 'target'
  position: Position.Left | Position.Right
  isConnectable: boolean
  onPointerDown?: () => void
}

export function NodeHandle({
  id,
  type,
  position,
  isConnectable,
  onPointerDown,
}: NodeHandleProps) {
  const side = position === Position.Left ? 'left' : 'right'

  return (
    <Handle
      id={id}
      type={type}
      position={position}
      isConnectable={isConnectable}
      className={`canvas-node-handle canvas-node-handle--${side}`}
      onPointerDownCapture={onPointerDown}
    >
      <span className="canvas-node-handle__hit" aria-hidden="true">
        <span className="canvas-node-handle__icon">
          <Plus size={13} strokeWidth={1.7} />
        </span>
      </span>
    </Handle>
  )
}
