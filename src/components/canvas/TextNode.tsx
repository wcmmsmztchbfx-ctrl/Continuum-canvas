import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Clapperboard } from 'lucide-react'
import { NodeResizer, Position, type NodeProps } from '@xyflow/react'

import { sanitizeTextHtml } from '../../utils/richText'
import type { CanvasFlowNode } from './mapping'
import { EditableNodeLabel } from './EditableNodeLabel'
import { NodeHandle } from './NodeHandle'

export function TextNode({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<CanvasFlowNode>) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(data.text ?? '')
  const [lockMessage, setLockMessage] = useState<string>()
  const finishingRef = useRef(false)
  const handledLeaseLoss = useRef(data.interactionLeaseLost)
  const resizeGranted = useRef(false)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const autoStarted = useRef(false)
  const showDetails = selected && data.isSoleSelection !== false
  const model = data.node?.type === 'text' ? data.node : undefined
  const plain = model?.data.presentation === 'plain'
  const autoWidth = model?.data.autoWidth ?? false

  useEffect(() => {
    setText(data.text ?? '')
    if (editorRef.current && !editing) {
      editorRef.current.innerHTML = data.text ?? ''
    }
  }, [data.text, editing])

  useEffect(() => {
    if (
      data.interactionLeaseLost === undefined ||
      data.interactionLeaseLost === handledLeaseLoss.current
    ) return
    handledLeaseLoss.current = data.interactionLeaseLost
    if (!editing) return
    setEditing(false)
    setText(data.text ?? '')
    setLockMessage(data.lockedBy ? `${data.lockedBy.displayName} 正在编辑` : '编辑锁已失效')
  }, [data.interactionLeaseLost, data.lockedBy, data.text, editing])

  const startEditing = () => {
    if (editing) return
    if (data.lockedBy || data.onInteractionStart?.(id, 'text') === false) {
      setLockMessage(`${data.lockedBy?.displayName ?? '其他成员'} 正在编辑`)
      return
    }
    finishingRef.current = false
    setLockMessage(undefined)
    setEditing(true)
  }

  const finishEditing = () => {
    if (!editing || finishingRef.current) return
    finishingRef.current = true
    if (editorRef.current) {
      editorRef.current.querySelectorAll('[data-active-span]').forEach((el) => {
        el.removeAttribute('data-active-span')
      })
      const cleanHtml = editorRef.current.innerHTML
      setText(cleanHtml)
      data.onTextChange?.(id, cleanHtml)
    }
    setEditing(false)
    data.onInteractionEnd?.(id, 'text')
  }

  useEffect(() => {
    if (!plain || !selected || autoStarted.current || editing) return
    if (data.lockedBy || data.onInteractionStart?.(id, 'text') === false) return
    autoStarted.current = true
    finishingRef.current = false
    setLockMessage(undefined)
    setEditing(true)
  }, [data, editing, id, plain, selected])

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!plain || !editor) return
    editor.style.height = '0px'
    editor.style.height = `${Math.max(42, editor.scrollHeight)}px`
    if (autoWidth) {
      const measure = document.createElement('span')
      measure.style.cssText = `position:fixed;visibility:hidden;white-space:pre;font:${model?.data.fontWeight ?? 500} ${model?.data.fontSize ?? 24}px ${model?.data.fontFamily ?? 'sans-serif'}`
      measure.innerHTML = text || '输入文字'
      document.body.append(measure)
      const width = Math.min(640, Math.max(80, measure.getBoundingClientRect().width + 8))
      measure.remove()
      data.onResize?.(id, { width, height: Math.max(42, editor.scrollHeight) })
    }
  }, [autoWidth, data, id, model?.data.fontFamily, model?.data.fontSize, model?.data.fontWeight, plain, text])

  return (
    <article
      aria-label={data.name}
      className={`canvas-media-node canvas-text-node${plain ? ' canvas-text-node--plain' : ''}`}
      data-node-kind="text"
      data-editing={editing || undefined}
      data-locked={Boolean(data.lockedBy) || undefined}
      data-selected={selected || undefined}
    >
      <NodeResizer
        isVisible={showDetails}
        minWidth={plain ? 40 : 220}
        minHeight={plain ? 24 : 220}
        lineClassName="canvas-node-resizer__line"
        handleClassName="canvas-node-resizer__handle"
        onResizeStart={() => {
          resizeGranted.current = data.onResizeStart?.(id) ?? true
        }}
        shouldResize={() => resizeGranted.current}
        onResize={(_event, { width, height }) => {
          if (resizeGranted.current) data.onResizePreview?.(id, { width, height })
        }}
        onResizeEnd={(_event, { width, height }) =>
          resizeGranted.current ? data.onResize?.(id, { width, height }) : undefined
        }
      />
      {!plain ? <EditableNodeLabel
        name={data.name}
        nodeId={id}
        onRename={data.onRename}
      /> : null}
      {!plain ? <NodeHandle
        id="target"
        type="target"
        position={Position.Left}
        isConnectable={isConnectable}
      /> : null}
      <div className="canvas-media-node__frame canvas-text-node__frame">
        {editing ? (
          <div
            aria-label="文本节点内容"
            autoFocus
            className="canvas-text-node__editor nodrag nowheel"
            contentEditable
            role="textbox"
            suppressContentEditableWarning
            ref={(node) => {
              editorRef.current = node
              if (node && !node.dataset.initialized) {
                node.dataset.initialized = 'true'
                node.innerHTML = text || ''
              }
            }}
            style={{
              fontSize: `${model?.data.fontSize ?? 14}px`,
              fontWeight: model?.data.fontWeight ?? 400,
              lineHeight: model?.data.lineHeight ?? 1.5,
              letterSpacing: model?.data.letterSpacing !== undefined ? `${model.data.letterSpacing}px` : undefined,
              color: model?.data.color ?? '#ffffff',
              textAlign: model?.data.textAlign ?? 'left',
              fontFamily: model?.data.fontFamily ?? 'inherit',
              outline: 0,
              minHeight: '100%',
              width: '100%',
              boxSizing: 'border-box',
              padding: '4px 6px',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
            }}
            onInput={(event) => {
              const nextText = event.currentTarget.innerHTML
              setText(nextText)
              data.onTextChange?.(id, nextText)
            }}
            onBlur={finishEditing}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                finishEditing()
              }
            }}
          />
        ) : showDetails && !text.trim() && data.onCreateConnected ? (
          <div
            className="canvas-text-node__empty canvas-text-node__preview"
            onDoubleClick={(event) => {
              event.stopPropagation()
              startEditing()
            }}
          >
            <span>从文字开始</span>
            <div className="canvas-text-node__actions">
              <button
                className="nodrag"
                onClick={(event) => {
                  event.stopPropagation()
                  data.onCreateConnected?.(id, 'video')
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                type="button"
              >
                <Clapperboard aria-hidden="true" size={15} />
                文生视频
              </button>
            </div>
          </div>
        ) : (
          <div
            className="canvas-text-node__preview"
            onDoubleClick={(event) => {
              event.stopPropagation()
              startEditing()
            }}
            style={{
              fontSize: `${model?.data.fontSize ?? 14}px`,
              fontWeight: model?.data.fontWeight ?? 400,
              lineHeight: model?.data.lineHeight ?? 1.5,
              letterSpacing: model?.data.letterSpacing !== undefined ? `${model.data.letterSpacing}px` : undefined,
              color: model?.data.color ?? '#ffffff',
              textAlign: model?.data.textAlign ?? 'left',
              fontFamily: model?.data.fontFamily ?? 'inherit',
              cursor: 'text',
              width: '100%',
              height: '100%',
              padding: '4px 6px',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
            }}
          >
            {/<[a-z][\s\S]*>/i.test(text) ? (
              <div style={{ margin: 0, width: '100%', color: 'inherit', font: 'inherit', display: 'inline' }} dangerouslySetInnerHTML={{ __html: sanitizeTextHtml(text) }} />
            ) : (
              <span style={{ margin: 0, width: '100%', color: 'inherit', font: 'inherit' }}>
                {text || '文本节点'}
              </span>
            )}
          </div>
        )}
        {lockMessage ? <p className="canvas-node-lock-message" role="status">{lockMessage}</p> : null}
      </div>
      {!plain ? <NodeHandle
        id="source"
        type="source"
        position={Position.Right}
        isConnectable={isConnectable}
      /> : null}
    </article>
  )
}
