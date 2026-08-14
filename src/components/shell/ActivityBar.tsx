import { memo } from 'react'
import {
  Layers,
  FolderKanban,
  Cpu,
  Settings,
} from 'lucide-react'

export type ActivityBarTab = 'layers' | 'assets' | 'providers' | 'settings' | null

interface ActivityBarProps {
  activeTab: ActivityBarTab
  onSelectTab: (tab: ActivityBarTab) => void
  onWorkspaceClick?: () => void
}

export const ActivityBar = memo(function ActivityBar({
  activeTab,
  onSelectTab,
  onWorkspaceClick,
}: ActivityBarProps) {
  return (
    <nav aria-label="快捷侧边栏" className="shell-activity-bar">
      {/* Top Main Menu Button (Figma mark / workspace logo) */}
      <div className="shell-activity-bar__top">
        <button
          aria-label="工作区与画布菜单"
          className="shell-activity-bar__logo-btn"
          onClick={onWorkspaceClick}
          title="切换画布与工作区"
          type="button"
        >
          <svg className="shell-activity-bar__logo" viewBox="0 0 38 57" fill="none">
            <path d="M19 28.5C19 23.2533 23.2533 19 28.5 19C33.7467 19 38 23.2533 38 28.5C38 33.7467 33.7467 38 28.5 38C23.2533 38 19 33.7467 19 28.5Z" fill="#1ABCFE" />
            <path d="M0 47.5C0 42.2533 4.25329 38 9.5 38H19V47.5C19 52.7467 14.7467 57 9.5 57C4.25329 57 0 52.7467 0 47.5Z" fill="#0ACF83" />
            <path d="M19 0V19H28.5C33.7467 19 38 14.7467 38 9.5C38 4.25329 33.7467 0 28.5 0H19Z" fill="#FF7262" />
            <path d="M0 9.5C0 14.7467 4.25329 19 9.5 19H19V0H9.5C4.25329 0 0 4.25329 0 9.5Z" fill="#F24E1E" />
            <path d="M0 28.5C0 33.7467 4.25329 38 9.5 38H19V19H9.5C4.25329 19 0 23.2533 0 28.5Z" fill="#A259FF" />
          </svg>
        </button>
      </div>

      {/* Center Nav Items */}
      <div className="shell-activity-bar__items">
        <button
          aria-label="图层列表"
          className={`shell-activity-bar__item ${activeTab === 'layers' ? 'shell-activity-bar__item--active' : ''}`}
          onClick={() => onSelectTab(activeTab === 'layers' ? null : 'layers')}
          title="图层与元素树"
          type="button"
        >
          <Layers size={18} />
          <span className="shell-activity-bar__item-label">图层</span>
        </button>

        <button
          aria-label="素材库"
          className={`shell-activity-bar__item ${activeTab === 'assets' ? 'shell-activity-bar__item--active' : ''}`}
          onClick={() => onSelectTab(activeTab === 'assets' ? null : 'assets')}
          title="素材库与资产"
          type="button"
        >
          <FolderKanban size={18} />
          <span className="shell-activity-bar__item-label">素材</span>
        </button>

        <button
          aria-label="API 接入与模型管理"
          className={`shell-activity-bar__item ${activeTab === 'providers' ? 'shell-activity-bar__item--active' : ''}`}
          onClick={() => onSelectTab(activeTab === 'providers' ? null : 'providers')}
          title="API 接入与模型服务"
          type="button"
        >
          <Cpu size={18} />
          <span className="shell-activity-bar__item-label">API</span>
        </button>
      </div>

      {/* Bottom Settings */}
      <div className="shell-activity-bar__bottom">
        <button
          aria-label="偏好设置"
          className={`shell-activity-bar__item ${activeTab === 'settings' ? 'shell-activity-bar__item--active' : ''}`}
          onClick={() => onSelectTab(activeTab === 'settings' ? null : 'settings')}
          title="设置与快捷键"
          type="button"
        >
          <Settings size={18} />
          <span className="shell-activity-bar__item-label">设置</span>
        </button>
      </div>
    </nav>
  )
})
