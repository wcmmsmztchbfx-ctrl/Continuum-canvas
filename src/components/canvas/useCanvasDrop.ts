import { useCallback, type DragEvent } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import {
  DEFAULT_IMAGE_GENERATION_SETTINGS,
  DEFAULT_VIDEO_GENERATION_SETTINGS,
  type CanvasNode,
} from '../../model/project'
import { createCanvasId } from '../../utils/id'
import { uploadAndPrepareMediaAsset } from '../../services/localMedia'

interface UseCanvasDropOptions {
  readOnly?: boolean
  flowInstance: ReactFlowInstance<any, any> | null
  addNode: (node: CanvasNode) => void
  selectNode: (nodeId: string) => void
}

export function useCanvasDrop({
  readOnly,
  flowInstance,
  addNode,
  selectNode,
}: UseCanvasDropOptions) {
  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      if (readOnly || !flowInstance) return
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) return
      event.preventDefault()
      event.stopPropagation()

      const dropPos = flowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })

      let offset = 0
      for (const file of files) {
        if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) continue

        const prepared = await uploadAndPrepareMediaAsset(file)
        const nodeId = createCanvasId(prepared.kind === 'image' ? 'i' : 'v')
        const pos = { x: dropPos.x + offset, y: dropPos.y + offset }
        offset += 30

        if (prepared.kind === 'image') {
          const newNode: CanvasNode = {
            id: nodeId,
            type: 'image',
            name: file.name.replace(/\.[^.]+$/, '') || '拖入图片',
            position: pos,
            size: { width: prepared.width, height: prepared.height },
            data: {
              url: prepared.url,
              assetId: prepared.assetId,
              displayMode: 'layer',
              generationSettings: DEFAULT_IMAGE_GENERATION_SETTINGS,
            },
          }
          addNode(newNode)
          selectNode(nodeId)
        } else if (prepared.kind === 'video') {
          const newNode: CanvasNode = {
            id: nodeId,
            type: 'video',
            name: file.name.replace(/\.[^.]+$/, '') || '拖入视频',
            position: pos,
            size: { width: prepared.width, height: prepared.height },
            data: {
              url: prepared.url,
              poster: prepared.posterUrl,
              assetId: prepared.assetId,
              displayMode: 'layer',
              durationSec: prepared.durationSec ?? 5,
              generationSettings: DEFAULT_VIDEO_GENERATION_SETTINGS,
            },
          }
          addNode(newNode)
          selectNode(nodeId)
        }
      }
    },
    [readOnly, flowInstance, addNode, selectNode],
  )

  return { handleDragOver, handleDrop }
}
