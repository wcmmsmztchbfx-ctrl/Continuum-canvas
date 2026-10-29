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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WorkspaceSyncStatus', () => {
  it.each([
    ['saving', '保存中'], ['synced', '已同步'], ['pending', '已保存到本地，等待同步'],
    ['conflict', '存在冲突'], ['error', '保存失败'],
  ] as const)('reports the %s phase without implying a remote save', (phase, label) => {
    const { service } = syncService({ phase, pendingCount: phase === 'synced' ? 0 : 1 })
    render(<WorkspaceSyncStatus service={service} />)
    expect(screen.getByRole('status')).toHaveTextContent(label)
    if (phase !== 'synced') expect(screen.queryByText('已同步')).toBeNull()
  })

  it('subscribes to state updates and stops the service on unmount', () => {
    const fixture = syncService()
    const view = render(<WorkspaceSyncStatus service={fixture.service} />)
    expect(fixture.service.start).toHaveBeenCalledOnce()
    expect(screen.getByRole('status')).toHaveTextContent('2 项待同步')
    act(() => fixture.publish({ phase: 'synced', pendingCount: 0 }))
    expect(screen.getByRole('status')).toHaveTextContent('已同步')
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
    fireEvent.click(screen.getByRole('button', { name: '重试同步' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('网络未连接')
    expect(service.retry).toHaveBeenCalledOnce()
    expect(screen.getByRole('status')).toHaveTextContent('已保存到本地，等待同步')
    expect(screen.queryByText('已同步')).toBeNull()
    expect(screen.getByRole('button', { name: '重试同步' })).toBeEnabled()
    act(() => fixture.publish({ phase: 'synced', pendingCount: 0 }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows service error details and permits recovery actions', () => {
    const { service } = syncService({ phase: 'error', pendingCount: 1, message: '本地存储空间不足' })
    render(<WorkspaceSyncStatus service={service} />)
    expect(screen.getByRole('status')).toHaveTextContent('本地存储空间不足')
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
})
