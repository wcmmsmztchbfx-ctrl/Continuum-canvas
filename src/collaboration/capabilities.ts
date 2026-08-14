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
  if (state.status === 'inactive' && !state.session) {
    return { canEdit: true, canPublish: true, canManageApi: true, canManageMembers: true }
  }
  if (!state.session) {
    return { canEdit: false, canPublish: false, canManageApi: false, canManageMembers: false }
  }
  if (state.status === 'offline') {
    return {
      canEdit: state.session.role === 'owner' || state.session.role === 'editor',
      canPublish: false,
      canManageApi: false,
      canManageMembers: false,
    }
  }
  if (state.status !== 'synced') {
    return { canEdit: false, canPublish: false, canManageApi: false, canManageMembers: false }
  }
  if (state.session.role === 'owner') {
    return { canEdit: true, canPublish: true, canManageApi: true, canManageMembers: true }
  }
  if (state.session.role === 'editor') {
    return { canEdit: true, canPublish: true, canManageApi: false, canManageMembers: false }
  }
  return { canEdit: false, canPublish: false, canManageApi: false, canManageMembers: false }
}
