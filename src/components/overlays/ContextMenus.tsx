import { useMemo } from 'react'
import {
  Bot,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Image,
  Lock,
  Plus,
  Redo2,
  Save,
  ShieldCheck,
  Trash2,
  Undo2,
  Unlock,
  Upload,
  UserRoundPlus,
} from 'lucide-react'

import { ActionMenu } from './primitives'
import type {
  ControlledOverlayProps,
  MenuItemSpec,
  OverlayPosition,
} from './primitives'

export type BlankContextAction =
  | 'upload'
  | 'save-asset'
  | 'add-node'
  | 'undo'
  | 'redo'
  | 'paste'

export interface BlankContextMenuProps extends ControlledOverlayProps {
  onAction?: (action: BlankContextAction) => void
  position?: OverlayPosition
}

const blankContextItems: ReadonlyArray<MenuItemSpec<BlankContextAction>> = [
  { action: 'upload', icon: Upload, label: '上传' },
  { action: 'save-asset', disabled: true, icon: Save, label: '保存到我的资产' },
  { action: 'add-node', icon: Plus, label: '添加节点' },
  { action: 'undo', icon: Undo2, label: '撤销', separatorBefore: true, shortcut: 'Ctrl Z' },
  { action: 'redo', icon: Redo2, label: '重做', shortcut: 'Ctrl ⇧ Z' },
  { action: 'paste', icon: ClipboardPaste, label: '粘贴', separatorBefore: true, shortcut: 'Ctrl V' },
]

export function BlankContextMenu({
  onAction,
  onClose,
  open,
  position,
}: BlankContextMenuProps) {
  return (
    <ActionMenu
      className="blank-context-menu"
      items={blankContextItems}
      label="画布快捷菜单"
      onAction={(action) => onAction?.(action)}
      onClose={onClose}
      open={open}
      position={position}
    />
  )
}

export type NodeContextAction =
  | 'reference-to-agent'
  | 'compliance'
  | 'save-asset'
  | 'create-subject'
  | 'toggle-lock'
  | 'copy-node'
  | 'copy-image'
  | 'duplicate'
  | 'paste'
  | 'delete'
  | 'copy-to-clipboard'

export interface NodeContextMenuProps extends ControlledOverlayProps {
  isLocked?: boolean
  hasImage?: boolean
  onAction?: (action: NodeContextAction) => void
  position?: OverlayPosition
}

export function NodeContextMenu({
  isLocked = false,
  hasImage = false,
  onAction,
  onClose,
  open,
  position,
}: NodeContextMenuProps) {
  const items: ReadonlyArray<MenuItemSpec<NodeContextAction>> = useMemo(
    () => [
      { action: 'reference-to-agent', icon: Bot, label: '引用到 Agent 对话' },
      { action: 'compliance', disabled: true, icon: ShieldCheck, label: '内容合规检测', separatorBefore: true },
      { action: 'save-asset', disabled: true, icon: Save, label: '保存到我的资产' },
      { action: 'create-subject', disabled: true, icon: UserRoundPlus, label: '创建主体' },
      {
        action: 'toggle-lock',
        icon: isLocked ? Unlock : Lock,
        label: isLocked ? '解除固定' : '固定',
        separatorBefore: true,
      },
      { action: 'copy-node', icon: Copy, label: '复制节点', separatorBefore: true, shortcut: 'Ctrl C' },
      ...(hasImage
        ? ([{ action: 'copy-image', icon: Image, label: '复制图片' }] as const)
        : []),
      { action: 'duplicate', icon: CopyPlus, label: '生成副本', shortcut: 'Ctrl D' },
      { action: 'paste', icon: ClipboardPaste, label: '粘贴', shortcut: 'Ctrl V' },
      { action: 'delete', danger: true, icon: Trash2, label: '删除', separatorBefore: true, shortcut: 'Delete' },
      { action: 'copy-to-clipboard', icon: ClipboardCopy, label: '复制到剪贴板', separatorBefore: true },
    ],
    [hasImage, isLocked],
  )

  return (
    <ActionMenu
      className="node-context-menu"
      items={items}
      label="节点快捷菜单"
      onAction={(action) => onAction?.(action)}
      onClose={onClose}
      open={open}
      position={position}
    />
  )
}
