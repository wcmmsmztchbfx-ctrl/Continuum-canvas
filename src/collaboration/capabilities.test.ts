import { describe, expect, it } from 'vitest'

import type { CollaborationControllerState } from './controller'
import { collaborationCapabilities } from './capabilities'

function state(
  status: CollaborationControllerState['status'],
  role?: 'owner' | 'editor' | 'viewer',
): CollaborationControllerState {
  return {
    status,
    inviteLinks: {},
    session: role ? {
      roomId: 'room-a', canvasId: 'canvas-a', projectId: 'project-a',
      memberId: `${role}-a`, displayName: role, role, status: 'connected',
    } : undefined,
  }
}

describe('collaborationCapabilities', () => {
  it('keeps single-user canvases writable and allows local API management', () => {
    expect(collaborationCapabilities(state('inactive'))).toEqual({
      canEdit: true, canPublish: true, canManageApi: true, canManageMembers: true,
    })
    expect(collaborationCapabilities(state('connecting', 'owner'))).toEqual({
      canEdit: false, canPublish: false, canManageApi: true, canManageMembers: true,
    })
  })

  it('derives dynamic owner, editor, and viewer capabilities only after sync', () => {
    expect(collaborationCapabilities(state('synced', 'owner'))).toEqual({
      canEdit: true, canPublish: true, canManageApi: true, canManageMembers: true,
    })
    expect(collaborationCapabilities(state('synced', 'editor'))).toEqual({
      canEdit: true, canPublish: true, canManageApi: false, canManageMembers: false,
    })
    expect(collaborationCapabilities(state('synced', 'viewer'))).toEqual({
      canEdit: false, canPublish: false, canManageApi: false, canManageMembers: false,
    })
  })

  it('keeps offline owners and editors locally editable while restricting remote collaborator API management', () => {
    expect(collaborationCapabilities(state('offline', 'owner'))).toEqual({
      canEdit: true, canPublish: false, canManageApi: true, canManageMembers: true,
    })
    expect(collaborationCapabilities(state('offline', 'editor'))).toEqual({
      canEdit: true, canPublish: false, canManageApi: false, canManageMembers: false,
    })
    expect(collaborationCapabilities(state('offline', 'viewer'))).toEqual({
      canEdit: false, canPublish: false, canManageApi: false, canManageMembers: false,
    })
  })
})
