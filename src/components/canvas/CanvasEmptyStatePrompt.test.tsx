// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasEmptyStatePrompt } from './CanvasEmptyStatePrompt'

afterEach(cleanup)

describe('CanvasEmptyStatePrompt', () => {
  it('renders minimalist watermark guidance text and SVG graphic', () => {
    render(<CanvasEmptyStatePrompt />)

    expect(screen.getByRole('region', { name: '空白画布操作提示' })).toBeVisible()
    expect(screen.getByText('双击空白处创建节点')).toBeVisible()
    expect(screen.getByText(/或从下方工具栏选择 · 拖入媒体文件/)).toBeVisible()
  })

  it('calls onOpenAddMenu with center coordinates when prompt is clicked', () => {
    const onOpenAddMenu = vi.fn()
    window.innerWidth = 1920
    window.innerHeight = 1080

    render(<CanvasEmptyStatePrompt onOpenAddMenu={onOpenAddMenu} />)

    fireEvent.click(screen.getByRole('region', { name: '空白画布操作提示' }))

    expect(onOpenAddMenu).toHaveBeenCalledWith({
      x: 960,
      y: 540,
    })
  })
})
