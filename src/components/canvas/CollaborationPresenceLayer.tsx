import { MousePointer2 } from 'lucide-react'
import { ViewportPortal, useStore as useReactFlowStore } from '@xyflow/react'
import { useCallback, type CSSProperties } from 'react'

import type { PresenceState } from '../../contracts/collaboration'

export interface CollaborationPresenceLayerProps {
  presence: readonly PresenceState[]
}

interface RemoteNodeBox {
  nodeId: string
  x: number
  y: number
  width: number
  height: number
}

export function CollaborationPresenceLayer({
  presence,
}: CollaborationPresenceLayerProps) {
  const visiblePresence = presence.slice(0, 10)
  const nodeBoxes = useReactFlowStore(
    useCallback((state): Map<string, RemoteNodeBox> => {
      const nodeIds = new Set<string>()
      for (const remote of visiblePresence) {
        remote.selection.nodeIds.slice(0, 500).forEach((nodeId) => nodeIds.add(nodeId))
        remote.interactionPreview?.nodes.forEach(({ nodeId }) => nodeIds.add(nodeId))
        remote.lease?.nodeIds.forEach((nodeId) => nodeIds.add(nodeId))
      }
      const boxes = new Map<string, RemoteNodeBox>()
      for (const nodeId of nodeIds) {
        const node = state.nodeLookup.get(nodeId)
        if (!node) continue
        const width = node.measured.width ?? node.width ?? node.initialWidth
        const height = node.measured.height ?? node.height ?? node.initialHeight
        if (!width || !height) continue
        boxes.set(nodeId, {
          nodeId,
          x: node.internals.positionAbsolute.x,
          y: node.internals.positionAbsolute.y,
          width,
          height,
        })
      }
      return boxes
    }, [visiblePresence]),
  )

  return (
    <ViewportPortal>
      <div aria-hidden="true" className="collaboration-presence-layer">
        {visiblePresence.flatMap((remote) => remote.selection.nodeIds.slice(0, 500).map((nodeId) => {
          const box = nodeBoxes.get(nodeId)
          if (!box) return null
          return (
          <div
            className="collaboration-remote-selection"
            data-remote-member={remote.member.memberId}
            data-remote-selection={box.nodeId}
            key={`${remote.member.memberId}:${box.nodeId}`}
            style={{
              '--presence-color': remote.member.color,
              height: box.height,
              transform: `translate(${box.x}px, ${box.y}px)`,
              width: box.width,
            } as CSSProperties}
          >
            <span>{remote.member.displayName}</span>
          </div>
          )
        }))}
        {visiblePresence.flatMap((remote) => remote.interactionPreview?.nodes.map((preview) => {
          const box = nodeBoxes.get(preview.nodeId)
          if (!box) return null
          return <div
            className="collaboration-remote-preview"
            data-remote-preview={preview.nodeId}
            key={`preview:${remote.clientId}:${preview.nodeId}`}
            style={{
              '--presence-color': remote.member.color,
              height: preview.height ?? box.height,
              transform: `translate(${preview.position?.x ?? box.x}px, ${preview.position?.y ?? box.y}px)`,
              width: preview.width ?? box.width,
            } as CSSProperties}
          />
        }))}
        {visiblePresence.flatMap((remote) => remote.lease?.nodeIds.map((nodeId) => {
          const box = nodeBoxes.get(nodeId)
          if (!box) return null
          const label = remote.lease?.kind === 'resize' ? '调整大小' :
            remote.lease?.kind === 'bulk' ? '批量操作' : '移动中'
          return <div
            className="collaboration-remote-lock"
            data-remote-lock={nodeId}
            key={`lock:${remote.clientId}:${nodeId}`}
            style={{
              '--presence-color': remote.member.color,
              height: box.height,
              transform: `translate(${box.x}px, ${box.y}px)`,
              width: box.width,
            } as CSSProperties}
          ><span>{remote.member.displayName} · {label}</span></div>
        }))}
        {visiblePresence.flatMap((remote) => remote.cursor ? [(
          <div
            className="collaboration-remote-cursor"
            data-remote-cursor={remote.member.memberId}
            key={`${remote.member.memberId}:${remote.clientId}`}
            style={{
              '--presence-color': remote.member.color,
              transform: `translate(${remote.cursor.x}px, ${remote.cursor.y}px)`,
            } as CSSProperties}
          >
            <MousePointer2 aria-hidden="true" />
            <span>{remote.member.displayName}</span>
          </div>
        )] : [])}
      </div>
    </ViewportPortal>
  )
}
