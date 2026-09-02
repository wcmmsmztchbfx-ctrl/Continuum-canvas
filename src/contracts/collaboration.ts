import type * as Y from 'yjs'

import type { Point, Viewport } from '../model/project.ts'

export const COLLABORATIVE_CANVAS_DOCUMENT_VERSION = 1 as const
export const COLLABORATION_ROOM_METADATA_VERSION = 1 as const
export const COLLABORATION_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
export const COLLABORATION_MAX_SERVER_MESSAGE_BYTES = 17 * 1024 * 1024
export const COLLABORATION_MAX_CLIENT_MESSAGE_BYTES = COLLABORATION_MAX_SERVER_MESSAGE_BYTES

export type CollaborationRole = 'owner' | 'editor' | 'viewer'

export type CollaborationOperationMode = 'solo' | 'host'

export interface CollaborationScopeStatus {
  projectId: string
  canvasId: string
  mode: CollaborationOperationMode
  active: boolean
  roomId?: string
}

export interface TunnelStatus {
  enabled: boolean
  mode: 'auto' | 'custom'
  status: 'stopped' | 'downloading' | 'starting' | 'running' | 'error'
  downloadProgress?: number
  publicUrl?: string
  customUrl?: string
  error?: string
}

export type CollaborationConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'offline'
  | 'disconnected'
  | 'error'

export interface CollaborationSession {
  roomId: string
  canvasId: string
  projectId: string
  memberId: string
  displayName: string
  role: CollaborationRole
  status: CollaborationConnectionStatus
}

export interface CollaborationRoomMetadata {
  version: typeof COLLABORATION_ROOM_METADATA_VERSION
  roomId: string
  canvasId: string
  projectId: string
  ownerId: string
  createdAt: string
  updatedAt: string
}

export interface CollaborationMember {
  id: string
  displayName: string
  role: CollaborationRole
  removed: boolean
}

export interface CollaborationInvite {
  id: string
  role: Exclude<CollaborationRole, 'owner'>
  createdAt: string
  revoked: boolean
}

export interface CollaborationRoom {
  roomId: string
  canvasId: string
  projectId: string
  ownerId: string
  createdAt: string
  updatedAt: string
  enabled: boolean
  members: CollaborationMember[]
  invites: CollaborationInvite[]
}

export interface EnableCollaborationRoomResponse {
  room: CollaborationRoom
  session: CollaborationSession
  recoverySecret: string
}

export interface CreateCollaborationInviteResponse {
  invite: CollaborationInvite
  secret: string
}

export type CollaborationInteractionKind =
  | 'idle'
  | 'dragging'
  | 'resizing'
  | 'editing-text'
  | 'editing-generation'

export interface CollaborationInteraction {
  kind: CollaborationInteractionKind
  nodeIds: string[]
}

export interface PresenceState {
  clientId: number
  member: {
    memberId: string
    displayName: string
    color: string
    role: CollaborationRole
  }
  cursor: Point | null
  selection: { nodeIds: string[] }
  viewport?: Viewport
  interaction?: CollaborationInteraction
  interactionPreview?: InteractionPreview
  lease?: NodeLease
}

export interface InteractionPreview {
  kind: 'drag' | 'resize'
  coordinateSpace?: 'canvas-absolute'
  nodes: Array<{
    nodeId: string
    position?: Point
    width?: number
    height?: number
  }>
}

export type NodeLeaseKind =
  | 'drag'
  | 'resize'
  | 'text'
  | 'settings'
  | 'bulk'

export interface NodeLease {
  leaseId: string
  nodeIds: string[]
  memberId: string
  kind: NodeLeaseKind
  startedAt: number
  heartbeatAt: number
  expiresAt: number
  confirmed: boolean
}

export interface PersonalUndoState {
  canUndo: boolean
  canRedo: boolean
}

export interface CollaborativeCanvasDocumentV1 {
  version: typeof COLLABORATIVE_CANVAS_DOCUMENT_VERSION
  doc: Y.Doc
  localOrigin: object
  undoManager: Y.UndoManager
  transact(callback: () => void): void
  destroy(): void
}
