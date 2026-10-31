import { useMemo } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { StoreApi } from 'zustand/vanilla'
import type { CanvasStoreState } from '../../../store/types'
import { createCanvasContentIndex } from '../../../model/canvasContentIndex'
import type { ImageNode } from '../../../model/project'
import type { AgentImageSource } from '../../../services/agent/agentRuntimeClient'

/** Camera changes reuse node identities and never rerender the chat or refetch previews. */
export function useSelectedAgentImages(store: StoreApi<CanvasStoreState>): AgentImageSource[] {
  const nodes = useStore(store, useShallow(state => {
    if (!state.selectedNodeIds.length) return []
    const index = createCanvasContentIndex(state.snapshot.nodes, state.snapshot.edges)
    return state.selectedNodeIds.map(id => index.nodeById.get(id)).filter((node): node is ImageNode => node?.type === 'image' && !!node.data.url)
  }))
  return useMemo(() => nodes.map(node => ({ nodeId: node.id, name: node.name, url: node.data.url, assetId: node.data.assetId, width: node.size.width, height: node.size.height })), [nodes])
}
