// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

import { FloatingCollaborationBadge } from './FloatingCollaborationBadge'
import type { ActiveCollaboration } from '../../collaboration/activeCollaborationStore'

describe('FloatingCollaborationBadge', () => {
  afterEach(() => {
    cleanup()
  })

  const activeCollab: ActiveCollaboration = {
    roomId: 'room_abc',
    projectId: 'project_1',
    canvasId: 'canvas_1',
    canvasName: '主线故事板',
    role: 'owner',
    status: 'active',
    createdAt: '2026-08-17T00:00:00.000Z',
    memberCount: 3,
  }

  it('renders nothing when there is no active collaboration', () => {
    const { container } = render(
      <FloatingCollaborationBadge
        activeCollab={null}
        onNavigate={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when user is currently viewing the active collaboration canvas', () => {
    const { container } = render(
      <FloatingCollaborationBadge
        activeCollab={activeCollab}
        currentCanvasId="canvas_1"
        currentProjectId="project_1"
        onNavigate={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders badge on workspace home or other canvases and handles return navigation', () => {
    const onNavigate = vi.fn()
    render(
      <FloatingCollaborationBadge
        activeCollab={activeCollab}
        currentCanvasId="canvas_2"
        currentProjectId="project_1"
        onNavigate={onNavigate}
      />,
    )

    expect(screen.getByText('正在协作中')).toBeTruthy()
    expect(screen.getByText('主线故事板')).toBeTruthy()
    expect(screen.getByText('3 人在线')).toBeTruthy()

    const returnBtn = screen.getByRole('button', { name: /回到协作画布/i })
    fireEvent.click(returnBtn)

    expect(onNavigate).toHaveBeenCalledWith(
      '/canvas?spaceId=local&projectId=project_1&canvasId=canvas_1&collabRoom=room_abc',
    )
  })

  it('supports minimizing and expanding the floating badge', () => {
    render(
      <FloatingCollaborationBadge
        activeCollab={activeCollab}
        onNavigate={vi.fn()}
      />,
    )

    const minimizeBtn = screen.getByRole('button', { name: '最小化协作提示' })
    fireEvent.click(minimizeBtn)

    expect(screen.queryByText('回到协作画布')).toBeNull()
    const minimizedTag = screen.getByLabelText('协作中悬浮标记')
    expect(minimizedTag).toBeTruthy()

    fireEvent.click(minimizedTag)
    expect(screen.getByText('回到协作画布')).toBeTruthy()
  })
})
