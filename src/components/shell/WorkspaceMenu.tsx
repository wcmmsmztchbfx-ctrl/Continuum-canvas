import { ChevronDown } from 'lucide-react'
import { LibTvLogo } from './LibTvLogo'

export interface WorkspaceMenuProps {
  canvasName?: string
  onClick?: () => void
  testId?: string
  workspaceName?: string
}

export function WorkspaceMenu({
  canvasName = '画布 1',
  onClick,
  testId = 'workspace-control',
  workspaceName = '未命名工作区',
}: WorkspaceMenuProps) {
  const showCanvas = canvasName !== workspaceName
  return (
    <button
      aria-haspopup="menu"
      aria-label={`打开工作区菜单：${workspaceName} / ${canvasName}`}
      className="workspace-menu"
      data-testid={testId}
      data-tooltip="工作区与画布"
      onClick={onClick}
      title="工作区与画布"
      type="button"
    >
      <LibTvLogo
        className="workspace-menu__mark"
        size={17}
      />
      <span className="workspace-menu__title">{workspaceName}</span>
      {showCanvas ? <><span aria-hidden="true" className="workspace-menu__divider" /><span className="workspace-menu__canvas">{canvasName}</span></> : null}
      <ChevronDown
        aria-hidden="true"
        className="workspace-menu__chevron"
        focusable="false"
      />
    </button>
  )
}
