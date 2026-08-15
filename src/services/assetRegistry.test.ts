// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { assetRegistry } from './assetRegistry'
import type { CanvasNode } from '../model/project'

describe('assetRegistry service', () => {
  beforeEach(() => {
    assetRegistry.clearAll()
  })

  it('adds and lists assets with type and project filtering', () => {
    const asset1 = assetRegistry.addAsset({
      name: '测试图片.png',
      type: 'image',
      url: '/api/assets/img-1',
      projectId: 'proj-1',
      size: 1024,
    })

    const asset2 = assetRegistry.addAsset({
      name: '测试视频.mp4',
      type: 'video',
      url: '/api/assets/vid-1',
      size: 20480,
    })

    const all = assetRegistry.listAssets()
    expect(all).toHaveLength(2)
    expect(all[0].name).toBe('测试视频.mp4')

    const imagesOnly = assetRegistry.listAssets({ type: 'image' })
    expect(imagesOnly).toHaveLength(1)
    expect(imagesOnly[0].id).toBe(asset1.id)

    const projOnly = assetRegistry.listAssets({ projectId: 'proj-1' })
    expect(projOnly).toHaveLength(2) // Global assets + project assets
  })

  it('searches assets by name and tags', () => {
    assetRegistry.addAsset({
      name: '主角肖像_final.png',
      type: 'image',
      url: '/api/assets/img-1',
      tags: ['角色', '立绘'],
    })
    assetRegistry.addAsset({
      name: '背景_森林.png',
      type: 'image',
      url: '/api/assets/img-2',
      tags: ['场景'],
    })

    const searchRole = assetRegistry.listAssets({ query: '角色' })
    expect(searchRole).toHaveLength(1)
    expect(searchRole[0].name).toBe('主角肖像_final.png')

    const searchForest = assetRegistry.listAssets({ query: '森林' })
    expect(searchForest).toHaveLength(1)
    expect(searchForest[0].name).toBe('背景_森林.png')
  })

  it('registers canvas image and video nodes directly into the asset library', () => {
    const imgNode: CanvasNode = {
      id: 'node-img-1',
      type: 'image',
      name: '我的立绘',
      position: { x: 100, y: 100 },
      size: { width: 400, height: 400 },
      data: { url: '/assets/sample.png' },
    }

    const saved = assetRegistry.registerNodeAsAsset(imgNode, 'p1')
    expect(saved).not.toBeNull()
    expect(saved?.name).toBe('我的立绘')
    expect(saved?.type).toBe('image')
    expect(saved?.url).toBe('/assets/sample.png')

    const list = assetRegistry.listAssets()
    expect(list).toHaveLength(1)
  })

  it('deletes assets in bulk', () => {
    const a1 = assetRegistry.addAsset({ name: '1.png', type: 'image', url: '/1' })
    const a2 = assetRegistry.addAsset({ name: '2.png', type: 'image', url: '/2' })
    const a3 = assetRegistry.addAsset({ name: '3.png', type: 'image', url: '/3' })

    assetRegistry.deleteAssets([a1.id, a2.id])
    const remaining = assetRegistry.listAssets()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(a3.id)
  })
})
