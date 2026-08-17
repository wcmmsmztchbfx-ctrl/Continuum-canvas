// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  clearActiveCollaboration,
  getActiveCollaboration,
  setActiveCollaboration,
  subscribeActiveCollaboration,
} from './activeCollaborationStore'

describe('activeCollaborationStore', () => {
  beforeEach(() => {
    localStorage.clear()
    clearActiveCollaboration()
  })

  it('persists and retrieves active collaboration from storage', () => {
    expect(getActiveCollaboration()).toBeNull()

    const collab = {
      roomId: 'room_123',
      projectId: 'proj_1',
      canvasId: 'canvas_1',
      canvasName: '测试协作画布',
      role: 'owner' as const,
      status: 'active' as const,
      createdAt: '2026-08-17T00:00:00.000Z',
      memberCount: 2,
    }

    setActiveCollaboration(collab)
    expect(getActiveCollaboration()).toEqual(collab)

    clearActiveCollaboration()
    expect(getActiveCollaboration()).toBeNull()
  })

  it('notifies subscribers on active collaboration change', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeActiveCollaboration(listener)

    const collab = {
      roomId: 'room_456',
      projectId: 'proj_2',
      canvasId: 'canvas_2',
      canvasName: '画卷 B',
      role: 'owner' as const,
      status: 'active' as const,
      createdAt: '2026-08-17T00:00:00.000Z',
    }

    setActiveCollaboration(collab)
    expect(listener).toHaveBeenCalledWith(collab)

    clearActiveCollaboration()
    expect(listener).toHaveBeenCalledWith(null)

    unsubscribe()
    setActiveCollaboration(collab)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
