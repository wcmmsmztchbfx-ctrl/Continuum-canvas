// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssetManagerModal } from './AssetManagerModal'
import { assetRegistry } from '../../services/assetRegistry'

describe('AssetManagerModal', () => {
  beforeEach(() => {
    assetRegistry.clearAll()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders centered modal with tabs, empty state and upload trigger', () => {
    const onClose = vi.fn()
    const onInsertAsset = vi.fn()

    render(
      <AssetManagerModal
        onClose={onClose}
        onInsertAsset={onInsertAsset}
        open={true}
      />,
    )

    expect(screen.getByRole('dialog', { name: '资产管理' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '资产管理' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上传资产' })).toBeInTheDocument()
    expect(screen.getByText('资产库暂无资产')).toBeInTheDocument()
  })

  it('filters assets by media type tabs and search query', () => {
    assetRegistry.addAsset({ name: '测试图片A.png', type: 'image', url: '/img-a' })
    assetRegistry.addAsset({ name: '测试视频B.mp4', type: 'video', url: '/vid-b' })
    assetRegistry.addAsset({ name: '配乐C.mp3', type: 'audio', url: '/aud-c' })

    render(
      <AssetManagerModal
        onClose={vi.fn()}
        onInsertAsset={vi.fn()}
        open={true}
      />,
    )

    expect(screen.getByText('测试图片A.png')).toBeInTheDocument()
    expect(screen.getByText('测试视频B.mp4')).toBeInTheDocument()
    expect(screen.getByText('配乐C.mp3')).toBeInTheDocument()

    // Filter to Videos only
    fireEvent.click(screen.getByRole('button', { name: /视频/ }))
    expect(screen.queryByText('测试图片A.png')).not.toBeInTheDocument()
    expect(screen.getByText('测试视频B.mp4')).toBeInTheDocument()

    // Switch back to All and search
    fireEvent.click(screen.getByRole('button', { name: /全部/ }))
    const searchInput = screen.getByRole('searchbox', { name: '搜索资产' })
    fireEvent.change(searchInput, { target: { value: '配乐' } })
    expect(screen.queryByText('测试图片A.png')).not.toBeInTheDocument()
    expect(screen.getByText('配乐C.mp3')).toBeInTheDocument()
  })

  it('inserts asset into canvas when clicking "置入画布"', () => {
    const onInsertAsset = vi.fn()
    const asset = assetRegistry.addAsset({ name: '英雄立绘.png', type: 'image', url: '/hero.png' })

    render(
      <AssetManagerModal
        onClose={vi.fn()}
        onInsertAsset={onInsertAsset}
        open={true}
      />,
    )

    const insertBtn = screen.getByRole('button', { name: '置入画布' })
    fireEvent.click(insertBtn)

    expect(onInsertAsset).toHaveBeenCalledWith(expect.objectContaining({ id: asset.id, name: '英雄立绘.png' }))
  })

  it('closes dialog on Escape key and close button', () => {
    const onClose = vi.fn()
    render(
      <AssetManagerModal
        onClose={onClose}
        onInsertAsset={vi.fn()}
        open={true}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '关闭资产管理' }))
    expect(onClose).toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
