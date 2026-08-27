import type { PresenceState } from '../../contracts/collaboration'

export interface CanvasCollaborationOverlaysProps {
  collaborationLockNotice?: string
  collaborationFollowingMemberId?: string
  collaborationPresence?: readonly PresenceState[]
  onStopFollowing?: () => void
}

export function CanvasCollaborationOverlays({
  collaborationLockNotice,
  collaborationFollowingMemberId,
  collaborationPresence,
  onStopFollowing,
}: CanvasCollaborationOverlaysProps) {
  return (
    <>
      {collaborationLockNotice ? (
        <div className="collaboration-lock-notice" role="status">
          {collaborationLockNotice}
        </div>
      ) : null}
      {collaborationFollowingMemberId ? (
        <div className="collaboration-following-pill" role="status">
          <span className="collaboration-following-dot" />
          <span>
            正在跟随{' '}
            <strong>
              {collaborationPresence?.find(
                (r) => r.member.memberId === collaborationFollowingMemberId,
              )?.member.displayName || '协作者'}
            </strong>{' '}
            的视角
          </span>
          <button
            aria-label="退出跟随"
            className="collaboration-following-exit"
            onClick={onStopFollowing}
            type="button"
          >
            退出跟随 (Esc)
          </button>
        </div>
      ) : null}
    </>
  )
}
