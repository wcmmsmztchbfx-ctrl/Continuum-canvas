import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Clapperboard } from 'lucide-react'
import { NodeResizer, Position, useStore as useReactFlowStore, type NodeProps } from '@xyflow/react'

import type { CanvasFlowNode } from './mapping'
import { EditableNodeLabel } from './EditableNodeLabel'
import { NodeHandle } from './NodeHandle'
import { computeAppearanceStyles } from './effectStyleUtils'

const TEXT_BLOCK_ELEMENTS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI',
  'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL',
])
const NON_TEXT_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'])

function htmlToPlainText(value: string): string {
  if (!value || !/<[a-z][\s\S]*>/i.test(value)) return value
  if (typeof DOMParser === 'undefined') return value

  // Preserve legacy entity spelling so saving extracted text cannot turn encoded
  // literal markup into tags on the next load. Only extracted text reaches React.
  const parsed = new DOMParser().parseFromString(value.replace(/&/g, '&amp;'), 'text/html')
  let text = ''
  let blockBreak = false
  const append = (value: string) => {
    if (!value) return
    if (blockBreak && text && !text.endsWith('\n') && !value.startsWith('\n')) text += '\n'
    blockBreak = false
    text += value
  }
  const visit = (node: ChildNode) => {
    if (node.nodeType === 3) {
      append(node.textContent ?? '')
      return
    }
    if (node.nodeType !== 1) return
    const element = node as Element
    if (NON_TEXT_ELEMENTS.has(element.tagName)) return
    if (element.tagName === 'BR') {
      if (blockBreak && text && !text.endsWith('\n')) text += '\n'
      append('\n')
      return
    }
    const block = TEXT_BLOCK_ELEMENTS.has(element.tagName)
    if (block) blockBreak = true
    element.childNodes.forEach(visit)
    if (block) blockBreak = true
  }
  parsed.body.childNodes.forEach(visit)
  return text
}

let measureCanvas: HTMLCanvasElement | null = null
let measureCtx: CanvasRenderingContext2D | null = null

function measureTextWidth(text: string, font: string): number {
  if (typeof document === 'undefined') return 120
  if (!measureCanvas) {
    measureCanvas = document.createElement('canvas')
    measureCtx = measureCanvas.getContext('2d')
  }
  if (measureCtx) {
    measureCtx.font = font
    return measureCtx.measureText(text).width
  }
  return 120
}

function useCaretPosition(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  text: string,
  editing: boolean,
) {
  const [caret, setCaret] = useState<{ x: number; y: number; height: number; visible: boolean }>({
    x: 0,
    y: 0,
    height: 20,
    visible: false,
  })

  const updateCaret = useCallback(() => {
    const el = textareaRef.current
    if (!el || !editing || typeof document === 'undefined') {
      setCaret((prev) => (prev.visible ? { ...prev, visible: false } : prev))
      return
    }
    const { selectionStart, selectionEnd } = el
    if (selectionStart !== selectionEnd) {
      setCaret((prev) => (prev.visible ? { ...prev, visible: false } : prev))
      return
    }

    try {
      const computed = window.getComputedStyle(el)
      const mirror = document.createElement('div')
      const properties = [
        'boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight',
        'lineHeight', 'letterSpacing', 'textAlign', 'whiteSpace', 'wordBreak',
        'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
        'borderLeftWidth', 'borderRightWidth', 'borderTopWidth', 'borderBottomWidth',
      ] as const
      properties.forEach((prop) => {
        mirror.style[prop as any] = computed[prop as any]
      })

      mirror.style.position = 'absolute'
      mirror.style.top = '-9999px'
      mirror.style.left = '-9999px'
      mirror.style.visibility = 'hidden'
      mirror.style.overflow = 'hidden'
      mirror.style.height = 'auto'

      const textBefore = el.value.slice(0, selectionStart)
      mirror.textContent = textBefore

      const span = document.createElement('span')
      span.textContent = '\u200b'
      mirror.appendChild(span)

      document.body.appendChild(mirror)
      const spanRect = span.getBoundingClientRect()
      const mirrorRect = mirror.getBoundingClientRect()
      const x = spanRect.left - mirrorRect.left - el.scrollLeft
      const y = spanRect.top - mirrorRect.top - el.scrollTop
      const height = spanRect.height || parseFloat(computed.fontSize || '14') * 1.5
      document.body.removeChild(mirror)

      setCaret({ x, y, height, visible: true })
    } catch {
      setCaret((prev) => (prev.visible ? { ...prev, visible: false } : prev))
    }
  }, [editing, textareaRef])

  useEffect(() => {
    if (!editing) return
    updateCaret()
  }, [editing, text, updateCaret])

  return { caret, updateCaret }
}

function TextNodeContent({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<CanvasFlowNode>) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(() => htmlToPlainText(data.text ?? ''))
  const [lockMessage, setLockMessage] = useState<string>()
  const lastEditedText = useRef<string | undefined>(undefined)
  const finishingRef = useRef(false)
  const handledLeaseLoss = useRef(data.interactionLeaseLost)
  const resizeGranted = useRef(false)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const autoStarted = useRef(false)
  const showDetails = selected && data.isSoleSelection !== false
  const model = data.node?.type === 'text' ? data.node : undefined
  const plain = model?.data.presentation === 'plain'
  const autoWidth = model?.data.autoWidth ?? false
  const { caret, updateCaret } = useCaretPosition(editorRef, text, editing)

  useEffect(() => {
    const incoming = data.text ?? ''
    setText(incoming === lastEditedText.current ? incoming : htmlToPlainText(incoming))
  }, [data.text])

  useEffect(() => {
    if (
      data.interactionLeaseLost === undefined ||
      data.interactionLeaseLost === handledLeaseLoss.current
    ) return
    handledLeaseLoss.current = data.interactionLeaseLost
    if (!editing) return
    setEditing(false)
    const incoming = data.text ?? ''
    setText(incoming === lastEditedText.current ? incoming : htmlToPlainText(incoming))
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
    setEditing(false)
    const editor = editorRef.current
    if (editor && plain) {
      const font = `${model?.data.fontWeight ?? 500} ${model?.data.fontSize ?? 24}px ${model?.data.fontFamily ?? 'sans-serif'}`
      const measuredWidth = measureTextWidth(text || '输入文字', font)
      const width = autoWidth ? Math.min(640, Math.max(80, measuredWidth + 8)) : (model?.size.width ?? 180)
      const height = Math.max(42, editor.scrollHeight)
      data.onResize?.(id, { width, height })
    }
    lastEditedText.current = text
    data.onTextChange?.(id, text, true)
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
      const font = `${model?.data.fontWeight ?? 500} ${model?.data.fontSize ?? 24}px ${model?.data.fontFamily ?? 'sans-serif'}`
      const measuredWidth = measureTextWidth(text || '输入文字', font)
      const width = Math.min(640, Math.max(80, measuredWidth + 8))
      editor.style.width = `${width}px`
      if (!editing) {
        data.onResize?.(id, { width, height: Math.max(42, editor.scrollHeight) })
      }
    }
  }, [autoWidth, data, editing, id, model?.data.fontFamily, model?.data.fontSize, model?.data.fontWeight, plain, text])

  let zoom: number
  try {
    zoom = useReactFlowStore((s) => s.transform[2])
  } catch {
    zoom = 1
  }

  const appearance = computeAppearanceStyles((model?.data || {}) as Parameters<typeof computeAppearanceStyles>[0])

  return (
    <article
      aria-label={data.name}
      className={`canvas-media-node canvas-text-node${plain ? ' canvas-text-node--plain' : ''}`}
      data-node-kind="text"
      data-editing={editing || undefined}
      data-locked={Boolean(data.lockedBy) || undefined}
      data-selected={selected || undefined}
      style={{
        opacity: model?.data.opacity !== undefined ? model?.data.opacity : undefined,
        transform: model?.data.rotation ? `rotate(${model.data.rotation}deg)` : undefined,
        '--resizer-scale': Math.min(1.35, Math.max(1, 1 / (zoom || 1))),
      } as React.CSSProperties}
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
        onResize={(_event, { width, height, x, y }) => {
          if (resizeGranted.current) data.onResizePreview?.(id, { width, height }, { x, y })
        }}
        onResizeEnd={(_event, { width, height, x, y }) =>
          resizeGranted.current ? data.onResize?.(id, { width, height }, { x, y }) : undefined
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
      <div
        className="canvas-media-node__frame canvas-text-node__frame"
        style={{
          borderRadius: appearance.style.borderRadius,
          boxShadow: appearance.style.boxShadow,
          outline: appearance.style.outline,
          outlineOffset: appearance.style.outlineOffset,
          background: appearance.style.background,
          filter: appearance.style.filter,
          backdropFilter: appearance.style.backdropFilter,
          WebkitBackdropFilter: appearance.style.WebkitBackdropFilter,
        }}
      >
        {editing ? (
          <>
          <textarea
            aria-label="文本节点内容"
            autoFocus
            className="canvas-text-node__editor nodrag nowheel"
            ref={editorRef}
            style={{
              fontSize: `${model?.data.fontSize ?? 14}px`,
              fontWeight: model?.data.fontWeight ?? 400,
              lineHeight: model?.data.lineHeight ?? 1.5,
              letterSpacing: model?.data.letterSpacing !== undefined ? `${model.data.letterSpacing}px` : undefined,
              color: model?.data.color ?? '#ffffff',
              textAlign: model?.data.textAlign ?? 'left',
              fontFamily: model?.data.fontFamily ?? 'inherit',
              caretColor: '#0d99ff',
              padding: '6px 8px',
              width: '100%',
              height: '100%',
              boxSizing: 'border-box',
              resize: 'none',
              border: 0,
              outline: 0,
              background: 'transparent',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
            }}
            value={text}
            onClick={updateCaret}
            onKeyUp={updateCaret}
            onSelect={updateCaret}
            onScroll={updateCaret}
            onChange={(event) => {
              const nextText = event.target.value
              lastEditedText.current = nextText
              setText(nextText)
              data.onTextChange?.(id, nextText, false)
            }}
            onBlur={finishEditing}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                finishEditing()
              }
            }}
          />
          {caret.visible ? (
            <div
              aria-hidden="true"
              className="canvas-text-node__thick-caret"
              style={{
                left: `${caret.x}px`,
                top: `${caret.y}px`,
                height: `${caret.height}px`,
              }}
            />
          ) : null}
        </>
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
              padding: '6px 8px',
              boxSizing: 'border-box',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
            }}
          >
            <p style={{ margin: 0, width: '100%', color: 'inherit', font: 'inherit', lineHeight: 'inherit', letterSpacing: 'inherit' }}>
              {text || '文本节点'}
            </p>
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

export const TextNode = memo(TextNodeContent)
