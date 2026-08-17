import { memo } from 'react'
import {
  AudioLines,
  Box,
  Clapperboard,
  ScrollText,
  Video,
} from 'lucide-react'
import { Position, type NodeProps } from '@xyflow/react'

import type { CanvasFlowNode } from './mapping'
import { EditableNodeLabel } from './EditableNodeLabel'
import { NodeHandle } from './NodeHandle'

function SpecialNodeContent({
  id,
  data,
  type,
  selected,
  isConnectable,
}: NodeProps<CanvasFlowNode>) {
  const nodeKind = type ?? 'script'
  const showDetails = selected && data.isSoleSelection !== false
  const Icon =
    nodeKind === 'audio'
      ? AudioLines
      : nodeKind === 'director'
        ? Box
        : nodeKind === 'video-clip'
          ? Clapperboard
          : ScrollText

  return (
    <article
      aria-label={data.name}
      className={`canvas-special-node canvas-special-node--${nodeKind}`}
      data-node-kind={nodeKind}
    >
      <EditableNodeLabel
        name={data.name}
        nodeId={id}
        onRename={data.onRename}
      />
      <NodeHandle
        id="target"
        isConnectable={isConnectable}
        position={Position.Left}
        type="target"
      />
      <div className="canvas-special-node__frame">
        <Icon aria-hidden="true" className="canvas-special-node__icon" />
        {nodeKind === 'director' ? (
          <>
            <p>在3D空间中搭建场景并进行多视角截图</p>
            <button className="nodrag nopan" type="button">打开导演台</button>
          </>
        ) : nodeKind === 'video-clip' ? (
          <>
            <p>空空如也，请连接视频节点后操作</p>
            <Video aria-hidden="true" className="canvas-special-node__secondary-icon" />
          </>
        ) : nodeKind === 'audio' ? (
          showDetails ? (
            <textarea
              aria-label="音频节点内容"
              className="canvas-special-node__editor nodrag nowheel"
              onChange={(event) => data.onTextChange?.(id, event.target.value)}
              placeholder="描述需要生成的音乐或声音"
              value={data.text ?? ''}
            />
          ) : (
            <p>{data.text || '描述需要生成的音乐或声音'}</p>
          )
        ) : showDetails ? (
          <textarea
            aria-label="脚本节点内容"
            className="canvas-special-node__editor nodrag nowheel"
            onChange={(event) => data.onTextChange?.(id, event.target.value)}
            placeholder="新建脚本内容"
            value={data.text ?? ''}
          />
        ) : (
          <p>{data.text || '新建脚本内容'}</p>
        )}
      </div>
      <NodeHandle
        id="source"
        isConnectable={isConnectable}
        position={Position.Right}
        type="source"
      />
    </article>
  )
}

export const SpecialNode = memo(SpecialNodeContent)
