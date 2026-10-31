// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceSyncService, WorkspaceSyncState } from '../../persistence/workspaceSyncState'
import { WorkspaceSyncStatus } from './WorkspaceSyncStatus'

function syncService(initial: WorkspaceSyncState = { phase: 'pending', pendingCount: 2 }) {
  let state = initial
  const listeners = new Set<() => void>()
  const dispose = vi.fn()
  const unsubscribe = vi.fn()
  const service: WorkspaceSyncService = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener); unsubscribe() }
    },
    start: vi.fn(() => dispose),
    retry: vi.fn(async () => undefined),
    exportRecovery: vi.fn(async () => '{"local":"recovery"}'),
    resolveConflict: vi.fn(async () => undefined),
  }
  return {
    service, dispose, unsubscribe,
    publish(next: WorkspaceSyncState) { state = next; listeners.forEach((listener) => listener()) },
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WorkspaceSyncStatus', () => {
  const openDetails = async () => fireEvent.click(await screen.findByRole('button', { name: '查看保存详情' }))

  it('stays hidden when saved and coalesces quick saves without flashing', () => {
    vi.useFakeTimers()
    const fixture = syncService({ phase: 'synced', pendingCount: 0 })
    render(<WorkspaceSyncStatus service={fixture.service} />)
    expect(screen.queryByRole('complementary')).toBeNull()
    for (let i = 0; i < 3; i++) {
      act(() => fixture.publish({ phase: 'pending', pendingCount: 1 }))
      act(() => fixture.publish({ phase: 'saving', pendingCount: 1 }))
      act(() => vi.advanceTimersByTime(150))
      expect(screen.queryByRole('complementary')).toBeNull()
      act(() => fixture.publish({ phase: 'synced', pendingCount: 0 }))
      act(() => vi.advanceTimersByTime(1000))
      expect(screen.queryByRole('complementary')).toBeNull()
    }
    expect(fixture.service.start).toHaveBeenCalledOnce()
  })

  it('shows a sustained save, keeps failed saves visible through retries, and hides after success', () => {
    vi.useFakeTimers()
    const fixture = syncService({ phase: 'saving', pendingCount: 1 })
    render(<WorkspaceSyncStatus service={fixture.service} />)
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getByRole('status')).toHaveTextContent('保存中')
    act(() => fixture.publish({ phase: 'pending', pendingCount: 1 }))
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByRole('status')).toHaveTextContent('待同步')
    act(() => fixture.publish({ phase: 'saving', pendingCount: 1 }))
    expect(screen.getByRole('status')).toHaveTextContent('保存中')
    act(() => fixture.publish({ phase: 'error', pendingCount: 1 }))
    expect(screen.getByRole('status')).toHaveTextContent('保存失败')
    act(() => fixture.publish({ phase: 'synced', pendingCount: 0 }))
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it.each([
    ['saving', '保存中'], ['pending', '待同步'], ['conflict', '保存冲突'], ['error', '保存失败'],
  ] as const)('reports the %s phase compactly without implying a remote save', async (phase, label) => {
    const { service } = syncService({ phase, pendingCount: 1 })
    render(<WorkspaceSyncStatus service={service} />)
    expect(await screen.findByRole('status')).toHaveTextContent(label)
    expect(screen.queryByRole('button', { name: '重试同步' })).toBeNull()
    expect(screen.queryByText('已同步')).toBeNull()
  })

  it('subscribes to state updates and stops the service on unmount', async () => {
    const fixture = syncService()
    const view = render(<WorkspaceSyncStatus service={fixture.service} />)
    expect(fixture.service.start).toHaveBeenCalledOnce()
    await openDetails()
    expect(screen.getByRole('dialog', { name: '保存详情' })).toHaveTextContent('2 项待同步')
    act(() => fixture.publish({ phase: 'synced', pendingCount: 0 }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: '重试同步' })).toBeNull()
    view.unmount()
    expect(fixture.dispose).toHaveBeenCalledOnce()
    expect(fixture.unsubscribe).toHaveBeenCalled()
  })

  it('retains a failed retry as pending and clears its error once synchronization recovers', async () => {
    const fixture = syncService()
    const { service } = fixture
    vi.mocked(service.retry).mockRejectedValue(new Error('网络未连接'))
    render(<WorkspaceSyncStatus service={service} />)
    await openDetails()
    fireEvent.click(screen.getByRole('button', { name: '重试同步' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('网络未连接')
    expect(service.retry).toHaveBeenCalledOnce()
    expect(screen.getByRole('dialog')).toHaveTextContent('已保存到本地，等待同步')
    expect(screen.queryByText('已同步')).toBeNull()
    expect(screen.getByRole('button', { name: '重试同步' })).toBeEnabled()
    act(() => fixture.publish({ phase: 'synced', pendingCount: 0 }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps error details behind a compact trigger and permits recovery actions', async () => {
    const { service } = syncService({ phase: 'error', pendingCount: 1, message: '本地存储空间不足' })
    render(<WorkspaceSyncStatus service={service} />)
    expect(screen.queryByText('本地存储空间不足')).toBeNull()
    await openDetails()
    expect(screen.getByRole('dialog')).toHaveTextContent('本地存储空间不足')
    expect(screen.getByRole('button', { name: '重试同步' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '导出本地恢复文件' })).toBeEnabled()
  })

  it('preserves a conflict as a copy and reloads only after it completes', async () => {
    const { service } = syncService({ phase: 'conflict', pendingCount: 1 })
    let resolve!: () => void
    vi.mocked(service.resolveConflict).mockImplementation(() => new Promise<void>((done) => { resolve = done }))
    const reloadPage = vi.fn()
    const confirm = vi.spyOn(window, 'confirm')
    render(<WorkspaceSyncStatus service={service} reloadPage={reloadPage} />)
    await openDetails()
    fireEvent.click(screen.getByRole('button', { name: '保留为副本' }))
    expect(service.resolveConflict).toHaveBeenCalledWith('copy')
    expect(confirm).not.toHaveBeenCalled()
    expect(reloadPage).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '重新载入服务器版本' })).toBeDisabled()
    await act(async () => resolve())
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it.each([false, true])('requires explicit confirmation before replacing local changes: %s', async (confirmed) => {
    const { service } = syncService({ phase: 'conflict', pendingCount: 1 })
    const reloadPage = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(confirmed)
    render(<WorkspaceSyncStatus service={service} reloadPage={reloadPage} />)
    await openDetails()
    fireEvent.click(screen.getByRole('button', { name: '重新载入服务器版本' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('覆盖本地未同步修改'))
    if (confirmed) {
      await waitFor(() => expect(reloadPage).toHaveBeenCalledOnce())
      expect(service.resolveConflict).toHaveBeenCalledWith('reload')
    } else {
      expect(service.resolveConflict).not.toHaveBeenCalled()
      expect(reloadPage).not.toHaveBeenCalled()
    }
  })

  it('does not reload after a failed conflict resolution', async () => {
    const { service } = syncService({ phase: 'conflict', pendingCount: 1 })
    vi.mocked(service.resolveConflict).mockRejectedValue(new Error('服务器仍不可用'))
    const reloadPage = vi.fn()
    render(<WorkspaceSyncStatus service={service} reloadPage={reloadPage} />)
    await openDetails()
    fireEvent.click(screen.getByRole('button', { name: '保留为副本' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('服务器仍不可用')
    expect(reloadPage).not.toHaveBeenCalled()
  })

  it('ignores a late conflict completion after unmount', async () => {
    const { service } = syncService({ phase: 'conflict', pendingCount: 1 })
    let resolve!: () => void
    vi.mocked(service.resolveConflict).mockImplementation(() => new Promise<void>((done) => { resolve = done }))
    const reloadPage = vi.fn()
    const view = render(<WorkspaceSyncStatus service={service} reloadPage={reloadPage} />)
    await openDetails()
    fireEvent.click(screen.getByRole('button', { name: '保留为副本' }))
    view.unmount()
    await act(async () => resolve())
    expect(reloadPage).not.toHaveBeenCalled()
  })

  it('downloads the service recovery JSON and releases the download URL', async () => {
    const { service } = syncService()
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:workspace-recovery')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const downloads: Array<{ href: string; download: string }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      downloads.push({ href: this.href, download: this.download })
    })
    render(<WorkspaceSyncStatus service={service} />)
    await openDetails()
    fireEvent.click(screen.getByRole('button', { name: '导出本地恢复文件' }))
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]).toEqual({ href: 'blob:workspace-recovery', download: 'continuum-workspace-recovery.json' })
    const blob = createObjectURL.mock.calls[0]![0] as Blob
    expect(blob.type).toBe('application/json')
    const contents = await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.readAsText(blob)
    })
    expect(contents).toBe('{"local":"recovery"}')
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:workspace-recovery'))
  })

  it('closes details with Escape or an outside click without dismissing the failure indicator', async () => {
    const { service } = syncService({ phase: 'error', pendingCount: 1 })
    render(<WorkspaceSyncStatus service={service} />)
    await openDetails()
    expect(screen.getByRole('dialog')).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: '查看保存详情' })).toHaveFocus()
    await openDetails()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('保存失败')
  })
})
