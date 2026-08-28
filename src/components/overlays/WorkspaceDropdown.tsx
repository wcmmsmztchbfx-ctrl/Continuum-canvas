import { ArrowLeft, Copy, FolderPlus, Pencil, Settings, Trash2 } from 'lucide-react'

import { ActionMenu } from './primitives'
import type {
  ControlledOverlayProps,
  MenuItemSpec,
  OverlayPosition,
} from './primitives'

export type WorkspaceAction =
  | 'home'
  | 'new'
  | 'rename'
  | 'duplicate'
  | 'delete'
  | 'settings'

export interface WorkspaceDropdownProps extends ControlledOverlayProps {
  collaborationRestricted?: boolean
  onAction: (action: WorkspaceAction) => void
  position?: OverlayPosition
  subject?: 'project' | 'canvas'
}

function workspaceItems(
  subject: 'project' | 'canvas',
  collaborationRestricted: boolean,
): ReadonlyArray<MenuItemSpec<WorkspaceAction>> {
  const noun = subject === 'canvas' ? '画布' : '项目'
  const items: ReadonlyArray<MenuItemSpec<WorkspaceAction>> = [
    { action: 'home', icon: ArrowLeft, label: '返回工作区' },
    { action: 'new', icon: FolderPlus, label: '新建项目' },
    { action: 'rename', icon: Pencil, label: `重命名${noun}` },
    { action: 'duplicate', icon: Copy, label: `复制${noun}` },
    {
      action: 'delete',
      danger: true,
      icon: Trash2,
      label: subject === 'canvas' ? '移入回收站' : '删除项目',
      separatorBefore: true,
    },
    {
      action: 'settings',
      icon: Settings,
      label: '系统设置',
      separatorBefore: true,
    },
  ]
  return collaborationRestricted
    ? items.filter((item) => item.action === 'rename')
    : items
}

export function WorkspaceDropdown({
  collaborationRestricted = false,
  subject = 'project',
  ...props
}: WorkspaceDropdownProps) {
  return (
    <ActionMenu
      {...props}
      className="workspace-dropdown"
      items={workspaceItems(subject, collaborationRestricted)}
      label="工作区菜单"
    />
  )
}
