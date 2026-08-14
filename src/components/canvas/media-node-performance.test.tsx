// @vitest-environment jsdom

import type { ComponentType } from 'react'
import type { NodeProps } from '@xyflow/react'
import { ReactFlowProvider } from '@xyflow/react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ImageNode } from './ImageNode'
import type { CanvasFlowNode, CanvasFlowNodeData } from './mapping'
import { VideoNode } from './VideoNode'

function nodeProps(
  type: 'image' | 'video',
  data: CanvasFlowNodeData,
): NodeProps<CanvasFlowNode> {
  return {
    id: `${type}-performance-test`,
    type,
    data,
    width: 480,
    height: 270,
    selected: false,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
    zIndex: 0,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  }
}

describe.each([
  ['image', ImageNode],
  ['video', VideoNode],
] as const)(
  '%s node drag rendering',
  (type, NodeComponent: ComponentType<NodeProps<CanvasFlowNode>>) => {
    it('keeps the media subtree stable for position-only prop changes', () => {
      let mediaReads = 0
      const data = {
        name: `${type} node`,
        mediaType: type,
        get url() {
          mediaReads += 1
          return `https://assets.example/${type}.${type === 'image' ? 'png' : 'mp4'}`
        },
      } as CanvasFlowNodeData
      const initialProps = nodeProps(type, data)
      const view = render(
        <ReactFlowProvider>
          <NodeComponent {...initialProps} />
        </ReactFlowProvider>,
      )
      const readsAfterMount = mediaReads

      view.rerender(
        <ReactFlowProvider>
          <NodeComponent
            {...initialProps}
            dragging
            positionAbsoluteX={180}
            positionAbsoluteY={96}
          />
        </ReactFlowProvider>,
      )

      expect(mediaReads).toBe(readsAfterMount)
    })
  },
)
