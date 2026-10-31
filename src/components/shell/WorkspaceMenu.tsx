import { ChevronDown } from 'lucide-react'
import { LibTvLogo } from './LibTvLogo'

export interface WorkspaceMenuProps {
  canvasName?: string
  collaborationRestricted?: boolean
  onClick?: () => void
  testId?: string
  workspaceName?: string
}

export function WorkspaceMenu({
  canvasName = '画布 1',
  collaborationRestricted = false,
  onClick,
  testId = 'workspace-control',
  workspaceName = '未命名工作区',
}: WorkspaceMenuProps) {
  const showCanvas = canvasName !== workspaceName

  if (collaborationRestricted) {
    return (
      <div
        aria-label={`协作画布：${workspaceName} / ${canvasName}`}
        className="workspace-menu workspace-menu--participant"
        data-testid={testId}
        title="正在参与他人发起的协作画布"
      >
        <LibTvLogo
          className="workspace-menu__mark"
          size={18}
          variant="outline"
        />
        <span className="workspace-menu__title">{workspaceName}</span>
        {showCanvas ? <><span aria-hidden="true" className="workspace-menu__divider" /><span className="workspace-menu__canvas">{canvasName}</span></> : null}
        <span className="workspace-menu__participant-tag">协作中</span>
      </div>
    )
  }

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
        size={18}
        variant="outline"
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
