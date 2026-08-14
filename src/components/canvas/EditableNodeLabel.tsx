import { useEffect, useRef, useState } from 'react'

export interface EditableNodeLabelProps {
  name: string
  nodeId: string
  onRename?: (nodeId: string, name: string) => void
}

export function EditableNodeLabel({
  name,
  nodeId,
  onRename,
}: EditableNodeLabelProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const finishingRef = useRef(false)

  useEffect(() => {
    if (editing) {
      finishingRef.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    } else {
      setDraft(name)
    }
  }, [editing, name])

  const finish = (commit: boolean) => {
    if (finishingRef.current) return
    finishingRef.current = true
    setEditing(false)
    if (commit) onRename?.(nodeId, draft)
  }

  if (editing) {
    return (
      <input
        aria-label="节点名称"
        className="canvas-node-label__input nodrag nopan"
        maxLength={48}
        onBlur={() => finish(true)}
        onChange={(event) => setDraft(event.target.value)}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            finish(true)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            finish(false)
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
        ref={inputRef}
        value={draft}
      />
    )
  }

  return (
    <button
      aria-label={`重命名 ${name}`}
      className="canvas-media-node__label canvas-node-label nodrag nopan"
      onDoubleClick={(event) => {
        event.stopPropagation()
        setEditing(true)
      }}
      type="button"
    >
      {name}
    </button>
  )
}
