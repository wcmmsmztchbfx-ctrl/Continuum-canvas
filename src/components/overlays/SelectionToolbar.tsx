import {
  Archive,
  Copy,
  CopyPlus,
  Group,
  LayoutGrid,
  MessageSquarePlus,
  Ungroup,
} from 'lucide-react'

export type SelectionAction =
  | 'layout'
  | 'save-assets'
  | 'duplicate'
  | 'copy'
  | 'group'
  | 'ungroup'
  | 'add-chat'

export interface SelectionToolbarProps {
  grouped: boolean
  onAction: (action: SelectionAction) => void
  open: boolean
}

export function SelectionToolbar({
  grouped,
  onAction,
  open,
}: SelectionToolbarProps) {
  if (!open) return null

  const GroupIcon = grouped ? Ungroup : Group
  const groupLabel = grouped ? '解组' : '打组'

  return (
    <div
      aria-label="所选节点操作"
      className="overlay-surface selection-toolbar nodrag nopan"
      role="toolbar"
    >
      <button
        aria-label="整理选区"
        className="selection-toolbar__icon-only"
        onClick={() => onAction('layout')}
        title="整理选区"
        type="button"
      >
        <LayoutGrid aria-hidden="true" focusable="false" />
      </button>
      <span aria-hidden="true" className="selection-toolbar__divider" />
      <button
        aria-label="保存到资产"
        onClick={() => onAction('save-assets')}
        title="保存到资产"
        type="button"
      >
        <Archive aria-hidden="true" focusable="false" />
        <span>保存到资产</span>
      </button>
      <button
        aria-label="创建副本"
        onClick={() => onAction('duplicate')}
        title="创建副本"
        type="button"
      >
        <CopyPlus aria-hidden="true" focusable="false" />
        <span>创建副本</span>
      </button>
      <span aria-hidden="true" className="selection-toolbar__divider" />
      <button
        aria-label="复制"
        className="selection-toolbar__icon-only"
        onClick={() => onAction('copy')}
        title="复制"
        type="button"
      >
        <Copy aria-hidden="true" focusable="false" />
      </button>
      <span aria-hidden="true" className="selection-toolbar__divider" />
      <button
        aria-label={groupLabel}
        className="selection-toolbar__group"
        data-attention={!grouped ? 'true' : undefined}
        onClick={() => onAction(grouped ? 'ungroup' : 'group')}
        title={groupLabel}
        type="button"
      >
        <GroupIcon aria-hidden="true" focusable="false" />
        <span>{groupLabel}</span>
      </button>
      <span aria-hidden="true" className="selection-toolbar__divider" />
      <button
        aria-label="添加到 Chat"
        disabled
        title="添加到 Chat 暂未接入"
        type="button"
      >
        <MessageSquarePlus aria-hidden="true" focusable="false" />
        <span>添加到 Chat</span>
      </button>
    </div>
  )
}
