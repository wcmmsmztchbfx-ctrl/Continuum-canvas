import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ImagePlus } from 'lucide-react'
import { parsePromptReferenceMentions } from '../../model/project'

export type PromptReferenceKind = 'image' | 'video' | 'audio'

export interface PromptReference {
  id: string
  referenceAlias: number
  name: string
  kind: PromptReferenceKind
  url?: string
  poster?: string
  broken?: boolean
}

export interface PromptReferenceCandidate {
  id: string
  name: string
  kind: PromptReferenceKind
  url?: string
  poster?: string
  connectedAlias?: number
}

interface MentionRange {
  start: number
  end: number
  query: string
}

interface Point {
  x: number
  y: number
}

export interface ReferencePromptEditorProps {
  candidates: PromptReferenceCandidate[]
  invalidAliases: number[]
  label: string
  onAttachReference: (sourceNodeId: string) => Promise<number | undefined>
  onChange: (prompt: string) => void
  placeholder?: string
  prompt: string
  references: PromptReference[]
}

function mentionAtCaret(value: string, caret: number): MentionRange | null {
  const before = value.slice(0, caret)
  const match = before.match(/@([^\s@]*)$/u)
  if (!match) return null
  return {
    start: caret - (match[1]?.length ?? 0) - 1,
    end: caret,
    query: match[1] ?? '',
  }
}

function caretAnchor(textarea: HTMLTextAreaElement, caret: number): Point {
  const bounds = textarea.getBoundingClientRect()
  const styles = window.getComputedStyle(textarea)
  const mirror = document.createElement('div')
  const copiedProperties = [
    'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing',
    'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'boxSizing', 'textAlign', 'textIndent', 'textTransform', 'wordSpacing',
  ] as const
  Object.assign(mirror.style, {
    position: 'fixed',
    visibility: 'hidden',
    pointerEvents: 'none',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    overflow: 'hidden',
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
  })
  for (const property of copiedProperties) {
    mirror.style[property] = styles[property]
  }
  mirror.append(document.createTextNode(textarea.value.slice(0, caret)))
  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  mirror.append(marker)
  document.body.append(mirror)
  mirror.scrollTop = textarea.scrollTop
  mirror.scrollLeft = textarea.scrollLeft
  const markerBounds = marker.getBoundingClientRect()
  mirror.remove()
  if (markerBounds.left === 0 && markerBounds.top === 0) {
    return { x: bounds.left + 12, y: bounds.top + 28 }
  }
  return { x: markerBounds.left, y: markerBounds.bottom }
}

function clampedMenuPosition(anchor: Point, menu: HTMLElement | null): CSSProperties {
  const margin = 8
  const topbarSafeArea = 64
  const dockSafeArea = 76
  const bounds = menu?.getBoundingClientRect()
  const width = bounds?.width || 300
  const height = bounds?.height || 220
  const maximumLeft = Math.max(margin, window.innerWidth - width - margin)
  const maximumBottom = Math.max(topbarSafeArea, window.innerHeight - dockSafeArea)
  const below = anchor.y + 8
  const top = below + height <= maximumBottom
    ? below
    : Math.max(topbarSafeArea, anchor.y - height - 8)
  return {
    position: 'fixed',
    left: Math.max(margin, Math.min(anchor.x, maximumLeft)),
    top,
  }
}

function highlightedPrompt(
  value: string,
  validAliases: ReadonlySet<number>,
  invalidAliases: ReadonlySet<number>,
): ReactNode[] {
  const result: ReactNode[] = []
  let offset = 0
  for (const mention of parsePromptReferenceMentions(value)) {
    const start = mention.index
    if (start > offset) result.push(value.slice(offset, start))
    const alias = mention.alias
    const validity = invalidAliases.has(alias) || !validAliases.has(alias)
      ? 'invalid'
      : 'valid'
    result.push(
      <span
        className={`canvas-prompt-editor__mention canvas-prompt-editor__mention--${validity}`}
        key={`${start}-${mention.token}`}
      >
        {mention.token}
      </span>,
    )
    offset = start + mention.token.length
  }
  if (offset < value.length) result.push(value.slice(offset))
  if (value.endsWith('\n')) result.push(' ')
  return result
}

export function ReferencePromptEditor({
  candidates,
  invalidAliases,
  label,
  onAttachReference,
  onChange,
  placeholder,
  prompt,
  references,
}: ReferencePromptEditorProps) {
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const highlightRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()
  const [draft, setDraft] = useState(prompt)
  const [mention, setMention] = useState<MentionRange | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ position: 'fixed' })
  const validAliases = useMemo(
    () => new Set(references.map((reference) => reference.referenceAlias)),
    [references],
  )
  const invalidAliasSet = useMemo(() => new Set(invalidAliases), [invalidAliases])

  useEffect(() => setDraft(prompt), [prompt])

  const connectedAliases = useMemo(
    () => new Map(references.map((reference) => [reference.id, reference.referenceAlias])),
    [references],
  )
  const filteredCandidates = useMemo(() => {
    const query = mention?.query.trim().toLocaleLowerCase() ?? ''
    const unique = new Map<string, PromptReferenceCandidate>()
    for (const candidate of candidates) {
      if (!unique.has(candidate.id)) unique.set(candidate.id, candidate)
    }
    return [...unique.values()]
      .map((candidate) => ({
        ...candidate,
        connectedAlias:
          candidate.connectedAlias ?? connectedAliases.get(candidate.id),
      }))
      .filter((candidate) =>
        query ? candidate.name.toLocaleLowerCase().includes(query) : true,
      )
      .sort((left, right) =>
        Number(right.connectedAlias !== undefined) -
          Number(left.connectedAlias !== undefined) ||
        left.name.localeCompare(right.name, 'zh-CN'),
      )
  }, [candidates, connectedAliases, mention?.query])

  useEffect(() => setActiveIndex(0), [mention?.query])
  useEffect(() => {
    if (activeIndex < filteredCandidates.length) return
    setActiveIndex(Math.max(0, filteredCandidates.length - 1))
  }, [activeIndex, filteredCandidates.length])

  useLayoutEffect(() => {
    if (!mention || !editorRef.current) return
    const update = () => {
      if (!editorRef.current) return
      const anchor = caretAnchor(editorRef.current, mention.end)
      setMenuStyle(clampedMenuPosition(anchor, menuRef.current))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [draft, mention])

  const updateDraft = (value: string, caret?: number) => {
    setDraft(value)
    onChange(value)
    const resolvedCaret = caret ?? value.length
    setMention(mentionAtCaret(value, resolvedCaret))
  }

  const chooseCandidate = async (candidate: PromptReferenceCandidate) => {
    if (!mention) return
    const alias =
      candidate.connectedAlias ??
      connectedAliases.get(candidate.id) ??
      await onAttachReference(candidate.id)
    if (!alias) return
    const next = `${draft.slice(0, mention.start)}@${alias} ${draft.slice(mention.end)}`
    const caret = mention.start + String(alias).length + 2
    setDraft(next)
    onChange(next)
    setMention(null)
    requestAnimationFrame(() => {
      editorRef.current?.focus()
      editorRef.current?.setSelectionRange(caret, caret)
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mention) return
    if (event.key === 'Escape') {
      event.preventDefault()
      setMention(null)
      return
    }
    if (filteredCandidates.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((current) =>
        (current + direction + filteredCandidates.length) % filteredCandidates.length,
      )
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActiveIndex(event.key === 'Home' ? 0 : filteredCandidates.length - 1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      void chooseCandidate(filteredCandidates[activeIndex]!)
    }
  }

  const activeOptionId = mention && filteredCandidates[activeIndex]
    ? `${menuId}-option-${activeIndex}`
    : undefined

  const menu = mention ? (
    <div
      aria-label="选择参考素材"
      className="canvas-mention-menu"
      data-caret-menu="true"
      id={menuId}
      ref={menuRef}
      role="listbox"
      style={menuStyle}
    >
      {filteredCandidates.length > 0 ? (
        filteredCandidates.map((candidate, index) => (
          <button
            aria-selected={activeIndex === index}
            className="canvas-mention-menu__option"
            id={`${menuId}-option-${index}`}
            key={candidate.id}
            onClick={() => void chooseCandidate(candidate)}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActiveIndex(index)}
            role="option"
            type="button"
          >
            <span className="canvas-mention-menu__thumb">
              {candidate.url || candidate.poster ? (
                <img alt="" draggable={false} src={candidate.poster || candidate.url} />
              ) : (
                <ImagePlus aria-hidden="true" size={15} />
              )}
            </span>
            <span>{candidate.name}</span>
            <small>
              {candidate.connectedAlias
                ? `@${candidate.connectedAlias}`
                : '连接并引用'}
            </small>
          </button>
        ))
      ) : (
        <p>没有匹配的参考节点</p>
      )}
    </div>
  ) : null

  return (
    <div className="canvas-prompt-editor">
      <div className="canvas-prompt-editor__surface">
        <div aria-hidden="true" className="canvas-prompt-editor__highlight">
          <div ref={highlightRef}>
            {highlightedPrompt(draft, validAliases, invalidAliasSet)}
          </div>
        </div>
        <textarea
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          aria-controls={mention ? menuId : undefined}
          aria-expanded={Boolean(mention)}
          aria-haspopup="listbox"
          aria-invalid={invalidAliases.length > 0 || undefined}
          aria-label={label}
          className="canvas-node-generator__prompt"
          onChange={(event) =>
            updateDraft(event.target.value, event.target.selectionStart)
          }
          onClick={(event) => {
            const editor = event.currentTarget
            setMention(mentionAtCaret(editor.value, editor.selectionStart))
          }}
          onKeyDown={handleKeyDown}
          onScroll={() => {
            if (!editorRef.current) return
            if (highlightRef.current) {
              highlightRef.current.style.transform = `translate(${-editorRef.current.scrollLeft}px, ${-editorRef.current.scrollTop}px)`
            }
            if (mention) {
              setMenuStyle(clampedMenuPosition(
                caretAnchor(editorRef.current, mention.end),
                menuRef.current,
              ))
            }
          }}
          placeholder={placeholder}
          ref={editorRef}
          role="combobox"
          value={draft}
        />
      </div>
      {invalidAliases.length > 0 ? (
        <div className="canvas-prompt-editor__invalid" role="status">
          {invalidAliases.map((alias) => (
            <span key={alias}>@{alias} 已失效</span>
          ))}
        </div>
      ) : null}
      {menu ? createPortal(menu, document.body) : null}
    </div>
  )
}
