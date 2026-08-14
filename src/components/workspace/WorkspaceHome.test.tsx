// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { WorkspaceManifestV1 } from '../../workspace/model'
import { WorkspaceHomeView } from './WorkspaceHome'

const manifest: WorkspaceManifestV1 = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  projects: [
    {
      projectId: 'project-a',
      name: '短片项目',
      position: { x: 80, y: 100 },
      size: { width: 620, height: 380 },
      favorite: false,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T01:00:00.000Z',
    },
  ],
  canvases: [
    {
      canvasId: 'canvas-a',
      projectId: 'project-a',
      name: '人物设定',
      position: { x: 32, y: 76 },
      nodeCount: 12,
      favorite: true,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T02:00:00.000Z',
    },
    {
      canvasId: 'canvas-b',
      projectId: 'canvas-b',
      name: '短片分镜',
      position: { x: 780, y: 160 },
      nodeCount: 4,
      favorite: false,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T03:00:00.000Z',
    },
  ],
  pendingOperations: [],
}

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: ResizeObserverStub,
  })
})

afterEach(cleanup)

describe('workspace home view', () => {
  it('renders a flat canvas-card grid ordered by most recently updated', () => {
    render(<WorkspaceHomeView manifest={manifest} />)

    for (const label of ['全部', '最近', '收藏', '回收站']) {
      expect(screen.getByRole('button', { name: label })).toBeVisible()
    }
    const cards = screen.getAllByRole('button', { name: /，\d+ 个节点$/ })
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual([
      '短片分镜，4 个节点',
      '人物设定，12 个节点',
    ])
  })

  it('renders a loaded thumbnail and falls back for canvases without one', () => {
    render(
      <WorkspaceHomeView
        manifest={manifest}
        thumbnailUrls={{ 'canvas-a': 'blob:canvas-a' }}
      />,
    )

    expect(screen.getByRole('img', { name: '人物设定预览' })).toHaveAttribute(
      'src',
      'blob:canvas-a',
    )
    expect(screen.queryByRole('img', { name: '短片分镜预览' })).toBeNull()
  })

  it('uses a regular grid without project containers or React Flow UI', () => {
    render(<WorkspaceHomeView manifest={manifest} />)

    expect(document.querySelector('.workspace-canvas-grid')).toBeVisible()
    expect(screen.queryByLabelText('项目 短片项目')).toBeNull()
    expect(document.querySelector('.react-flow')).toBeNull()
    expect(document.querySelector('.react-flow__node')).toBeNull()
  })

  it('searches canvases without exposing the legacy project grouping', () => {
    render(<WorkspaceHomeView manifest={manifest} />)

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索工作区' }), {
      target: { value: '片' },
    })

    expect(screen.getByRole('listbox', { name: '搜索结果' })).toBeVisible()
    expect(screen.getByRole('option', { name: /短片分镜/ })).toBeVisible()
    expect(screen.queryByRole('option', { name: /短片项目/ })).toBeNull()
    expect(screen.getByText('人物设定')).toBeVisible()
  })

  it('sorts canvas cards by name and creation time', () => {
    const sortableManifest: WorkspaceManifestV1 = {
      ...manifest,
      canvases: manifest.canvases.map((canvas) => ({
        ...canvas,
        name: canvas.canvasId === 'canvas-a' ? 'B canvas' : 'A canvas',
      })),
    }
    render(<WorkspaceHomeView manifest={sortableManifest} />)

    fireEvent.change(screen.getByRole('combobox', { name: '画布排序' }), {
      target: { value: 'name' },
    })
    expect(
      screen
        .getAllByRole('button', { name: /，\d+ 个节点$/ })
        .map((card) => card.getAttribute('aria-label')),
    ).toEqual(['A canvas，4 个节点', 'B canvas，12 个节点'])

    fireEvent.change(screen.getByRole('combobox', { name: '画布排序' }), {
      target: { value: 'created' },
    })
    expect(screen.getByRole('combobox', { name: '画布排序' })).toHaveValue(
      'created',
    )
  })

  it('reveals a searched canvas even when the current filter hides it', () => {
    render(<WorkspaceHomeView manifest={manifest} />)

    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    expect(screen.queryByRole('button', { name: '短片分镜，4 个节点' })).toBeNull()

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索工作区' }), {
      target: { value: '人物设定' },
    })
    fireEvent.click(screen.getByRole('option', { name: /人物设定/ }))

    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('button', { name: '人物设定，12 个节点' })).toBeVisible()
  })

  it('keeps an individually trashed project canvas reachable in the recycle bin', () => {
    const trashedManifest: WorkspaceManifestV1 = {
      ...manifest,
      canvases: manifest.canvases.map((canvas) =>
        canvas.canvasId === 'canvas-a'
          ? { ...canvas, deletedAt: '2026-07-18T04:00:00.000Z' }
          : canvas,
      ),
    }
    render(<WorkspaceHomeView manifest={trashedManifest} />)

    fireEvent.click(screen.getByRole('button', { name: '回收站' }))

    expect(
      screen.getByRole('button', { name: '人物设定，12 个节点' }),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: '恢复 人物设定' })).toBeVisible()
  })

  it('opens a canvas on double click or Enter', () => {
    const onOpenCanvas = vi.fn()
    render(
      <WorkspaceHomeView
        manifest={manifest}
        onOpenCanvas={onOpenCanvas}
      />,
    )

    const canvas = screen.getByRole('button', {
      name: '人物设定，12 个节点',
    })
    fireEvent.doubleClick(canvas)
    expect(onOpenCanvas).toHaveBeenLastCalledWith(
      expect.objectContaining({ canvasId: 'canvas-a', projectId: 'project-a' }),
    )

    canvas.focus()
    fireEvent.keyDown(canvas, { key: 'Enter' })
    expect(onOpenCanvas).toHaveBeenCalledTimes(2)
  })

  it('exposes new canvas and API actions without a project action', () => {
    const onCreateCanvas = vi.fn()
    const onApiIntegration = vi.fn()
    render(
      <WorkspaceHomeView
        manifest={manifest}
        onApiIntegration={onApiIntegration}
        onCreateCanvas={onCreateCanvas}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: '新建画布' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'API 接入' }))

    expect(screen.queryByRole('button', { name: '新建项目' })).toBeNull()
    expect(onCreateCanvas).toHaveBeenCalledOnce()
    expect(onApiIntegration).toHaveBeenCalledOnce()
  })
})
