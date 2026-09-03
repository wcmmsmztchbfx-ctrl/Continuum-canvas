import { UsersRound } from 'lucide-react'

import { AgentButton } from './AgentButton'
import { TopBarFeatureButton } from './TopBarFeatureButton'

export interface TopBarProps {
  collaborationStatus?: 'inactive' | 'enabling' | 'connecting' | 'synced' | 'offline' | 'error'
  collaborationMembers?: ReadonlyArray<{
    id: string
    displayName: string
    color: string
  }>
  onAgent?: () => void
  onCollaboration?: () => void
}

export function TopBar({
  collaborationStatus = 'inactive',
  collaborationMembers = [],
  onAgent,
  onCollaboration,
}: TopBarProps) {
  const collaborationStatusLabel = collaborationStatus === 'synced'
    ? '已同步'
    : collaborationStatus === 'offline'
      ? '离线编辑'
      : collaborationStatus === 'error'
        ? '连接失败'
        : collaborationStatus === 'inactive'
          ? '未开启'
          : '连接中'
  return (
    <header
      aria-label="画布顶部工具栏"
      className="shell-top-bar"
      data-collaboration-status={collaborationStatus}
      data-testid="top-bar"
    >
      <div className="topbar-actions">
        <TopBarFeatureButton
          className="collaboration-button"
          icon={UsersRound}
          id="collaboration-trigger"
          label="多人协作"
          onClick={onCollaboration}
        />
        {collaborationStatus !== 'inactive' ? (
          <div
            aria-label={`协作状态：${collaborationStatusLabel}`}
            className="topbar-collaboration-presence"
          >
            <span
              aria-hidden="true"
              className="topbar-collaboration-presence__status"
              data-status={collaborationStatus}
            />
            <span className="topbar-collaboration-presence__label">
              {collaborationStatusLabel}
            </span>
            <div aria-label="在线协作成员" className="topbar-collaboration-presence__avatars">
              {collaborationMembers.slice(0, 4).map((member) => (
                <span
                  data-collaboration-avatar={member.id}
                  key={member.id}
                  style={{ backgroundColor: member.color }}
                  title={member.displayName}
                >
                  {member.displayName.trim().slice(0, 1).toUpperCase() || '协'}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <AgentButton onClick={onAgent} />
      </div>
    </header>
  )
}
