import { memo, useState } from 'react'
import { BookOpen, Copy, Check, Sparkles, X, Eye } from 'lucide-react'
import { Position, type NodeProps } from '@xyflow/react'

import type { CanvasFlowNode } from './mapping'
import { EditableNodeLabel } from './EditableNodeLabel'
import { NodeHandle } from './NodeHandle'
import './canvas.css'

function SkillNodeContent({
  id,
  data,
  isConnectable,
}: NodeProps<CanvasFlowNode>) {
  const [modalOpen, setModalOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const rawText = data.text || ''
  const lineCount = rawText ? rawText.split('\n').length : 0
  const charCount = rawText.length

  // Preview snippet (first 100 characters)
  const snippet = rawText
    ? rawText.replace(/^[#\s*>-]+/gm, '').trim().slice(0, 90) + (rawText.length > 90 ? '...' : '')
    : '暂无 Skill 描述内容'

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  const displayName = data.name.endsWith('-skill') ? data.name : `${data.name}-skill`

  return (
    <article
      aria-label={displayName}
      className="canvas-skill-node"
      data-node-kind="skill"
    >
      <NodeHandle
        id="target"
        isConnectable={isConnectable}
        position={Position.Left}
        type="target"
        onPointerDown={data.onConnectionPointerDown}
      />

      <div className="canvas-skill-node__header">
        <div className="canvas-skill-node__title-wrap">
          <span className="canvas-skill-node__icon">
            <Sparkles size={13} />
          </span>
          <EditableNodeLabel
            name={displayName}
            nodeId={id}
            onRename={data.onRename}
          />
        </div>
        <span className="canvas-skill-node__badge">Skill</span>
      </div>

      <div className="canvas-skill-node__body">
        <p className="canvas-skill-node__snippet" title={snippet}>
          {snippet}
        </p>

        <div className="canvas-skill-node__meta">
          <span className="canvas-skill-node__stat">
            <BookOpen size={10} />
            {lineCount} 行 · {charCount} 字
          </span>
          <button
            type="button"
            className="canvas-skill-node__view-btn nodrag nopan"
            onClick={() => setModalOpen(true)}
          >
            <Eye size={11} />
            <span>查看完整信息</span>
          </button>
        </div>
      </div>

      <NodeHandle
        id="source"
        isConnectable={isConnectable}
        position={Position.Right}
        type="source"
        onPointerDown={data.onConnectionPointerDown}
      />

      {/* Full Content Modal */}
      {modalOpen ? (
        <div
          className="canvas-skill-modal-backdrop nodrag nopan nowheel"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="canvas-skill-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={`${displayName} 详情`}
          >
            <div className="canvas-skill-modal__header">
              <div className="canvas-skill-modal__title">
                <Sparkles size={14} className="text-purple-400" />
                <span>{displayName}</span>
                <span className="canvas-skill-node__badge">Skill Markdown</span>
              </div>
              <div className="canvas-skill-modal__actions">
                <button
                  type="button"
                  className="canvas-skill-modal__action-btn"
                  onClick={handleCopy}
                  title="复制全文"
                >
                  {copied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
                  <span>{copied ? '已复制' : '复制全文'}</span>
                </button>
                <button
                  type="button"
                  className="canvas-skill-modal__close-btn"
                  onClick={() => setModalOpen(false)}
                  title="关闭"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            <div className="canvas-skill-modal__content">
              <pre className="canvas-skill-modal__markdown">{rawText || '空文件'}</pre>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  )
}

export const SkillNode = memo(SkillNodeContent)
