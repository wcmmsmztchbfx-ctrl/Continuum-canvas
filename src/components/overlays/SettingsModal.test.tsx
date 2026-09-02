// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from './SettingsModal'

describe('SettingsModal', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders settings modal with 4 lightweight tabs', () => {
    render(<SettingsModal open onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: '系统设置' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /存储与路径/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /界面语言/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /启动与通用/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /关于与更新/ })).toBeInTheDocument()
  })

  it('allows switching tabs and updating output path', async () => {
    const notify = vi.fn()
    render(<SettingsModal open onClose={vi.fn()} onNotify={notify} />)

    const input = screen.getByLabelText('本地产出保存路径') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'D:/MyImages' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(localStorage.getItem('continuum_custom_output_path')).toBe('D:/MyImages')
    expect(notify).toHaveBeenCalledWith('本地输出目录已更新', 'success')
  })

  it('switches language and persists to localStorage', async () => {
    const notify = vi.fn()
    render(<SettingsModal open onClose={vi.fn()} onNotify={notify} />)

    fireEvent.click(screen.getByRole('tab', { name: /界面语言/ }))
    const enOption = screen.getByText('English (United States)')
    fireEvent.click(enOption)

    expect(localStorage.getItem('continuum_language')).toBe('en-US')
    expect(notify).toHaveBeenCalledWith('Switched to English', 'success')
  })

  it('switches between host mode and solo mode and persists to localStorage', async () => {
    const notify = vi.fn()
    render(<SettingsModal open onClose={vi.fn()} onNotify={notify} />)

    fireEvent.click(screen.getByRole('tab', { name: /启动与通用/ }))
    const hostOption = screen.getByText('主机模式 (多人协作)')
    fireEvent.click(hostOption)

    expect(localStorage.getItem('continuum_app_mode')).toBe('host')
    expect(notify).toHaveBeenCalledWith('已切换为主机模式：进入画布将自动开启多人协作', 'success')

    const soloOption = screen.getByText('个人模式 (单人创作)')
    fireEvent.click(soloOption)

    expect(localStorage.getItem('continuum_app_mode')).toBe('solo')
    expect(notify).toHaveBeenCalledWith('已切换为个人模式：进入画布无需输入昵称，不开启多人协作', 'success')
  })

  it('toggles auto open browser setting', async () => {
    const notify = vi.fn()
    render(<SettingsModal open onClose={vi.fn()} onNotify={notify} />)

    fireEvent.click(screen.getByRole('tab', { name: /启动与通用/ }))
    const toggle = screen.getByRole('switch')
    fireEvent.click(toggle)

    expect(localStorage.getItem('continuum_auto_open_browser')).toBe('false')
    expect(notify).toHaveBeenCalledWith('已关闭启动自动打开浏览器', 'info')
  })

  it('clears temporary cache and shows success notification', async () => {
    const notify = vi.fn()
    global.fetch = vi.fn().mockImplementation((url, options) => {
      if (options?.method === 'POST' && String(url).includes('/clear-cache')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, freedFormatted: '45.2 MB' }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            storagePath: '/test/data',
            totalCacheFormatted: '45.2 MB',
            fileCount: 12,
          }),
      })
    })

    render(<SettingsModal open onClose={vi.fn()} onNotify={notify} />)

    const clearBtn = screen.getByRole('button', { name: /一键清理临时缓存/ })
    fireEvent.click(clearBtn)

    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('临时缓存已清理，释放了 45.2 MB 空间', 'success')
    })
  })
})
