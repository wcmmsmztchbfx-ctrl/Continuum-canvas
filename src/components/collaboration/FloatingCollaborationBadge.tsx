import { useState } from 'react'
import type { ActiveCollaboration } from '../../collaboration/activeCollaborationStore'
import { buildCanvasRoute } from '../../routing'

export interface FloatingCollaborationBadgeProps {
  activeCollab: ActiveCollaboration | null
  currentCanvasId?: string
  currentProjectId?: string
  onNavigate: (url: string) => void
  onCloseRoom?: (roomId: string) => Promise<void>
}

export function FloatingCollaborationBadge({
  activeCollab,
  currentCanvasId,
  currentProjectId,
  onNavigate,
}: FloatingCollaborationBadgeProps) {
  const [minimized, setMinimized] = useState(false)

  if (!activeCollab || activeCollab.status !== 'active') return null

  // If already on the collaborating canvas, do not display floating badge
  if (
    currentCanvasId === activeCollab.canvasId &&
    currentProjectId === activeCollab.projectId
  ) {
    return null
  }

  const handleReturnToCanvas = () => {
    const route = buildCanvasRoute(activeCollab.projectId, activeCollab.canvasId)
    onNavigate(`${route}&collabRoom=${encodeURIComponent(activeCollab.roomId)}`)
  }

  if (minimized) {
    return (
      <aside
        aria-label="协作中悬浮标记"
        className="floating-collab-badge floating-collab-badge-minimized"
        onClick={() => setMinimized(false)}
        title={`正在协作中：${activeCollab.canvasName}（点击展开）`}
      >
        <span className="floating-collab-pulse" />
        <span className="floating-collab-min-icon">👥</span>
      </aside>
    )
  }

  return (
    <aside
      aria-label="正在协作中"
      className="floating-collab-badge"
    >
      <div className="floating-collab-header">
        <div className="floating-collab-status">
          <span className="floating-collab-pulse" />
          <span className="floating-collab-status-text">正在协作中</span>
        </div>
        <button
          aria-label="最小化协作提示"
          className="floating-collab-minimize-btn"
          onClick={() => setMinimized(true)}
          title="最小化"
          type="button"
        >
          −
        </button>
      </div>

      <div className="floating-collab-body">
        <div className="floating-collab-canvas-title" title={activeCollab.canvasName}>
          <span className="floating-collab-canvas-icon">🎨</span>
          <span className="floating-collab-canvas-name">{activeCollab.canvasName}</span>
        </div>
        {activeCollab.memberCount !== undefined && (
          <div className="floating-collab-members">
            <span className="floating-collab-member-badge">
              {activeCollab.memberCount} 人在线
            </span>
          </div>
        )}
      </div>

      <div className="floating-collab-actions">
        <button
          className="floating-collab-return-btn"
          onClick={handleReturnToCanvas}
          type="button"
        >
          <span>回到协作画布</span>
          <span className="floating-collab-arrow">→</span>
        </button>
      </div>
    </aside>
  )
}
