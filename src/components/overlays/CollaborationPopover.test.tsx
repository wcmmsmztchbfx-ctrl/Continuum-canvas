/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TunnelStatus } from '../../contracts/collaboration'
import { CollaborationPopover } from './CollaborationPopover'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({}) }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
const stopped: TunnelStatus = { enabled: false, mode: 'auto', status: 'stopped' }
const base = { open: true, onClose: vi.fn(), state: { status: 'inactive' as const, inviteLinks: {} } }

it('shows a local-only save warning and owner retry action for a failed collaboration checkpoint', async () => {
  const retry = vi.fn().mockResolvedValue(undefined)
  const exportDraft = vi.fn()
  const room = { roomId: 'room-a', canvasId: 'canvas-a', projectId: 'project-a', ownerId: 'owner-a',
    createdAt: '2026-10-31T00:00:00.000Z', updatedAt: '2026-10-31T00:00:00.000Z',
    enabled: true, members: [], invites: [] }
  const session = { roomId: 'room-a', canvasId: 'canvas-a', projectId: 'project-a',
    memberId: 'owner-a', displayName: 'Owner', role: 'owner' as const, status: 'connected' as const }
  const state = { status: 'offline' as const, failure: 'persistence' as const,
    error: '服务端保存失败，当前修改仅保留在本机。', inviteLinks: {}, room, session }
  const view = render(<CollaborationPopover open onClose={vi.fn()} onRetryPersistence={retry}
    onExportLocalDraft={exportDraft} state={state} />)
  expect(screen.getByText('保存失败')).toBeVisible()
  expect(screen.getByRole('alert')).toHaveTextContent('仅保留在本机')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '导出本地副本' })) })
  expect(exportDraft).toHaveBeenCalledOnce()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试保存' })) })
  expect(retry).toHaveBeenCalledOnce()

  view.rerender(<CollaborationPopover open onClose={vi.fn()} onRetryPersistence={retry}
    onExportLocalDraft={exportDraft}
    state={{ ...state, status: 'synced', error: '正在确认本机修改已保存。' }} />)
  expect(screen.getByText('补存中')).toBeVisible()

  view.rerender(<CollaborationPopover open onClose={vi.fn()} onRetryPersistence={retry}
    onExportLocalDraft={exportDraft}
    state={{ ...state, session: { ...session, role: 'editor', memberId: 'editor-a' } }} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新连接' })) })
  expect(retry).toHaveBeenCalledTimes(2)

  view.rerender(<CollaborationPopover open onClose={vi.fn()} onRetryPersistence={retry}
    onExportLocalDraft={exportDraft}
    state={{ ...state, session: { ...session, role: 'viewer', memberId: 'viewer-a' } }} />)
  expect(screen.queryByRole('button', { name: '重试保存' })).toBeNull()
})

it('polls real progress while the initial download request is still pending', async () => {
  vi.useFakeTimers()
  let finish!: (value: TunnelStatus) => void
  const getStatus = vi.fn().mockResolvedValue(stopped)
  const start = vi.fn(() => new Promise<TunnelStatus>(resolve => { finish = resolve }))
  render(<CollaborationPopover {...base} onGetTunnelStatus={getStatus} onStartTunnel={start} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: '远程互联网', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: /开启远程通道/ }))
  getStatus.mockResolvedValue({ ...stopped, enabled: true, status: 'downloading', downloadProgress: 38 })
  await act(async () => { await vi.advanceTimersByTimeAsync(1800) })
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '38')
  const failed: TunnelStatus = { ...stopped, status: 'error', error: '组件下载未完成，请检查网络后重试。' }
  getStatus.mockResolvedValue(failed)
  await act(async () => { finish(failed) })
  expect(screen.getByRole('button', { name: '重试下载 / 连接' })).toBeEnabled()
})

it('handles a rejected request and can retry without an unhandled rejection', async () => {
  const start = vi.fn().mockRejectedValueOnce(new Error('private-proxy-address')).mockResolvedValueOnce({ ...stopped, enabled: true, status: 'starting' })
  render(<CollaborationPopover {...base} onStartTunnel={start} />)
  fireEvent.click(screen.getByRole('button', { name: '远程互联网', exact: true }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /开启远程通道/ })) })
  expect(screen.getByRole('alert')).toHaveTextContent('无法连接到后端，请稍后重试。')
  expect(screen.queryByText('private-proxy-address')).not.toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试下载 / 连接' })) })
  expect(start).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
