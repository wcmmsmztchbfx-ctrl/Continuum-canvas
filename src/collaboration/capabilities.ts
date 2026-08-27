import type { CollaborationControllerState } from './controller'

export interface CollaborationCapabilities {
  canEdit: boolean
  canPublish: boolean
  canManageApi: boolean
  canManageMembers: boolean
}

export function collaborationCapabilities(
  state: CollaborationControllerState,
): CollaborationCapabilities {
  if (!state.session || state.session.role === 'owner') {
    const isOwnerConnecting = state.session?.role === 'owner' && (state.status === 'connecting' || state.status === 'enabling')
    return {
      canEdit: !isOwnerConnecting,
      canPublish: state.status === 'synced' || state.status === 'inactive' || !state.session,
      canManageApi: true,
      canManageMembers: true,
    }
  }
  if (state.session.role === 'editor') {
    return {
      canEdit: state.status === 'synced' || state.status === 'offline',
      canPublish: state.status === 'synced',
      canManageApi: false,
      canManageMembers: false,
    }
  }
  return { canEdit: false, canPublish: false, canManageApi: false, canManageMembers: false }
}
