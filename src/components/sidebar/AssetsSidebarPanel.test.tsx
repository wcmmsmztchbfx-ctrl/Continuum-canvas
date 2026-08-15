// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssetsSidebarPanel } from './AssetsSidebarPanel'
import { assetRegistry } from '../../services/assetRegistry'

describe('AssetsSidebarPanel', () => {
  beforeEach(() => {
    assetRegistry.clearAll()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders asset list and allows clicking to insert into canvas', () => {
    const onInsertAsset = vi.fn()
    const asset = assetRegistry.addAsset({
      name: '场景概念图.png',
      type: 'image',
      url: '/scene.png',
    })

    render(<AssetsSidebarPanel onInsertAsset={onInsertAsset} />)

    expect(screen.getByText('资产库')).toBeInTheDocument()
    expect(screen.getByText('场景概念图.png')).toBeInTheDocument()

    const card = screen.getByText('场景概念图.png')
    fireEvent.click(card)

    expect(onInsertAsset).toHaveBeenCalledWith(
      expect.objectContaining({ id: asset.id, name: '场景概念图.png' }),
    )
  })

  it('filters assets by search and media tabs', () => {
    assetRegistry.addAsset({ name: '人物.png', type: 'image', url: '/char.png' })
    assetRegistry.addAsset({ name: '片头.mp4', type: 'video', url: '/intro.mp4' })

    render(<AssetsSidebarPanel onInsertAsset={vi.fn()} />)

    expect(screen.getByText('人物.png')).toBeInTheDocument()
    expect(screen.getByText('片头.mp4')).toBeInTheDocument()

    // Filter to videos
    fireEvent.click(screen.getByRole('button', { name: /视频/ }))
    expect(screen.queryByText('人物.png')).not.toBeInTheDocument()
    expect(screen.getByText('片头.mp4')).toBeInTheDocument()
  })
})
