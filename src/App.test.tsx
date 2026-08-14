// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { canvasStore } from './store/canvas-store'
import type { CanvasSnapshotV2 } from './model/project'
import type { WorkspaceRepository } from './workspace'

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
beforeEach(() => localStorage.clear())

describe('canvas application integration', () => {
  it('queues a thumbnail only after a canvas save and flushes it on leave', async () => {
    const document: CanvasSnapshotV2 = {
      version: 2,
      canvasId: 'canvas-thumbnail',
      projectId: 'project-thumbnail',
      name: '缩略图画布',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      comments: [],
    }
    const repository = {
      loadCanvas: vi.fn(async () => document),
      saveCanvas: vi.fn(async () => undefined),
    } as unknown as WorkspaceRepository
    const thumbnailService = {
      schedule: vi.fn(),
      flush: vi.fn(async () => undefined),
    }
    const view = render(
      <App
        canvasId={document.canvasId}
        projectId={document.projectId}
        workspaceRepository={repository}
        thumbnailService={thumbnailService}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true'))

    canvasStore.getState().addNode({
      id: 'thumbnail-text', type: 'text', name: '新文字',
      position: { x: 0, y: 0 }, size: { width: 200, height: 80 },
      data: { text: '已修改' },
    })
    await waitFor(() => expect(repository.saveCanvas).toHaveBeenCalled())
    await waitFor(() => expect(thumbnailService.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ canvasId: document.canvasId }),
    ))

    view.unmount()
    expect(thumbnailService.flush).toHaveBeenCalledWith(document.canvasId)
  })

  it('never restores or starts collaboration from a stale canvas load', async () => {
    let resolveA!: (value: CanvasSnapshotV2) => void
    let resolveB!: (value: CanvasSnapshotV2) => void
    const a = new Promise<CanvasSnapshotV2>((resolve) => { resolveA = resolve })
    const b = new Promise<CanvasSnapshotV2>((resolve) => { resolveB = resolve })
    const repository = {
      loadCanvas: vi.fn((id: string) => id === 'canvas-a' ? a : b),
      saveCanvas: vi.fn(async () => undefined),
    } as unknown as WorkspaceRepository
    const snapshot = (canvasId: string, name: string): CanvasSnapshotV2 => ({
      version: 2, canvasId, projectId: 'project-shared', name,
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
    })
    const view = render(<App canvasId="canvas-a" projectId="project-shared" workspaceRepository={repository} />)
    view.rerender(<App canvasId="canvas-b" projectId="project-shared" workspaceRepository={repository} />)
    resolveA(snapshot('canvas-a', 'Stale A'))
    await Promise.resolve(); await Promise.resolve()
    expect(canvasStore.getState().snapshot.name).not.toBe('Stale A')
    resolveB(snapshot('canvas-b', 'Current B'))
    await waitFor(() => expect(canvasStore.getState().snapshot.name).toBe('Current B'))
    expect(screen.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  })
  it('uses the durable save queue and never persists uploaded media as data URLs', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8')

    expect(source).toContain('defaultProjectPersistenceQueue')
    expect(source).toContain('persistLocalMedia(file)')
    expect(source).not.toContain('FileReader')
    expect(source).not.toContain('readAsDataURL')
  })

  it('renders the complete reference shell and canvas dataset', async () => {
    render(<App />)

    expect(screen.getByTestId('app-shell')).toBeVisible()
    expect(screen.getByRole('button', { name: /未命名工作区/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: '故事板' })).toBeNull()
    expect(screen.getByRole('button', { name: '选择 V' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('canvas-workspace')).toBeVisible()
  })

  it('opens primary menus and closes them with Escape', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /未命名工作区/ }))
    expect(screen.getByRole('menu', { name: '工作区菜单' })).toBeVisible()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: '工作区菜单' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '上传媒体 U' }))
    expect(screen.getByRole('menu', { name: '添加节点' })).toBeVisible()
  })

  it('opens add-node at a blank-pane double click and exits it on right click', async () => {
    render(<App />)
    await waitFor(() =>
      expect(screen.getByTestId('app-shell')).toHaveAttribute(
        'data-hydrated',
        'true',
      ),
    )
    const pane = document.querySelector('.react-flow__pane')
    expect(pane).not.toBeNull()

    fireEvent.doubleClick(pane!, { clientX: 420, clientY: 260 })
    const addMenu = screen.getByRole('menu', { name: '添加节点' })
    expect(addMenu).toBeVisible()
    expect(addMenu).toHaveStyle({ left: '420px', top: '260px' })

    fireEvent.contextMenu(pane!, { clientX: 520, clientY: 320 })
    expect(screen.queryByRole('menu', { name: '添加节点' })).toBeNull()
    expect(screen.getByRole('menu', { name: '画布快捷菜单' })).toBeVisible()
  })

  it('uses the first blank-canvas action only to dismiss an open context menu', async () => {
    render(<App />)
    await waitFor(() =>
      expect(screen.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true'),
    )
    const pane = document.querySelector('.react-flow__pane')!

    fireEvent.contextMenu(pane, { clientX: 400, clientY: 240 })
    expect(screen.getByRole('menu', { name: '画布快捷菜单' })).toBeVisible()
    fireEvent.click(pane)
    expect(screen.queryByRole('menu', { name: '画布快捷菜单' })).toBeNull()

    fireEvent.contextMenu(pane, { clientX: 400, clientY: 240 })
    fireEvent.doubleClick(pane, { clientX: 420, clientY: 260 })
    expect(screen.queryByRole('menu', { name: '画布快捷菜单' })).toBeNull()
    expect(screen.queryByRole('menu', { name: '添加节点' })).toBeNull()

    fireEvent.contextMenu(pane, { clientX: 400, clientY: 240 })
    fireEvent.click(pane, { clientX: 420, clientY: 260 })
    fireEvent.doubleClick(pane, { clientX: 420, clientY: 260 })
    expect(screen.queryByRole('menu', { name: '添加节点' })).toBeNull()

    fireEvent.contextMenu(pane, { clientX: 400, clientY: 240 })
    fireEvent.contextMenu(pane, { clientX: 410, clientY: 250 })
    expect(screen.queryByRole('menu', { name: '画布快捷菜单' })).toBeNull()
    fireEvent.contextMenu(pane, { clientX: 420, clientY: 260 })
    expect(screen.getByRole('menu', { name: '画布快捷菜单' })).toBeVisible()
  })

  it('supports gateway-backed API, real collaboration entry, and Agent shells', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '打开 API 接入' }))
    expect(screen.getByRole('dialog', { name: 'API 接入' })).toBeVisible()
    expect(screen.getByText('尚未添加供应商')).toBeVisible()
    expect(screen.getByRole('button', { name: '快速测试' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '同步配置' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '打开多人协作' }))
    expect(screen.queryByRole('dialog', { name: 'API 接入' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '多人协作' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: '协作昵称' })).toBeVisible()
    expect(screen.queryByPlaceholderText('输入邮箱或成员账号')).toBeNull()

    expect(screen.queryByText('会员中心')).toBeNull()
    expect(screen.queryByRole('button', { name: '分享' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭多人协作' }))

    fireEvent.click(screen.getByRole('button', { name: /Agent/ }))
    expect(screen.getByRole('complementary', { name: 'Agent' })).toBeVisible()
  })

  it('persists connection visibility preferences locally', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '隐藏节点连线' }))
    expect(
      JSON.parse(localStorage.getItem('libtv.ui-preferences.v1') ?? '{}'),
    ).toMatchObject({ hideConnections: true })

    fireEvent.click(screen.getByRole('button', { name: '显示节点连线' }))
    expect(
      JSON.parse(localStorage.getItem('libtv.ui-preferences.v1') ?? '{}'),
    ).toMatchObject({ hideConnections: false })
  })

  it('resizes and persists the layers sidebar within the viewport limit', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '展开图层' }))
    const shell = screen.getByTestId('app-shell')
    const resizeHandle = screen.getByRole('separator', { name: '调整图层侧栏宽度' })

    fireEvent.mouseDown(resizeHandle, { button: 0, clientX: 240 })
    fireEvent.mouseMove(window, { clientX: 700 })
    expect(shell).toHaveStyle({ '--layers-sidebar-width': '560px' })

    fireEvent.mouseUp(window, { clientX: 700 })
    expect(
      JSON.parse(localStorage.getItem('libtv.ui-preferences.v1') ?? '{}'),
    ).toMatchObject({ layersWidth: 560 })
  })

  it('opens generation history from the bottom status bar', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '历史记录' }))
    expect(screen.getByRole('dialog', { name: /生成历史/ })).toBeVisible()
  })

  it('stops resizing the layers sidebar on pointer cancellation and window blur', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '展开图层' }))
    const shell = screen.getByTestId('app-shell')
    const resizeHandle = screen.getByRole('separator', { name: '调整图层侧栏宽度' })

    fireEvent.mouseDown(resizeHandle, { button: 0, clientX: 240 })
    fireEvent.mouseMove(window, { clientX: 360 })
    fireEvent.mouseUp(window)
    fireEvent.mouseMove(window, { clientX: 500 })
    expect(shell).toHaveStyle({ '--layers-sidebar-width': '360px' })

    fireEvent.mouseDown(resizeHandle, { button: 0, clientX: 360 })
    fireEvent.mouseMove(window, { clientX: 420 })
    fireEvent.blur(window)
    fireEvent.mouseMove(window, { clientX: 520 })
    expect(shell).toHaveStyle({ '--layers-sidebar-width': '420px' })
  })

  it('keeps the layers sidebar mounted so its open and close states can animate', () => {
    render(<App />)

    const sidebar = screen.getByTestId('layers-sidebar')
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(screen.getByRole('button', { name: '展开图层' }))
    expect(sidebar).toHaveAttribute('aria-hidden', 'false')
    fireEvent.click(screen.getAllByRole('button', { name: '收起图层' })[1])
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('layers-sidebar')).toBeInTheDocument()
  })

  it('keeps the canvas selectable while opening node tools', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '上传媒体 U' }))
    expect(screen.getByTestId('canvas-workspace')).toHaveAttribute(
      'data-canvas-mode',
      'select',
    )
  })

  it('opens project generation history from the add-node menu', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '上传媒体 U' }))
    fireEvent.click(
      screen.getByRole('menuitem', { name: '从生成历史选择' }),
    )
    expect(screen.getByRole('dialog', { name: '生成历史' })).toBeVisible()
  })

  it('gates editing through hydration and confirms project deletion', async () => {
    render(<App />)
    const shell = screen.getByTestId('app-shell')

    expect(shell).toHaveAttribute('data-hydrated', 'false')
    expect(shell).toHaveAttribute('inert')
    await waitFor(() => {
      expect(shell).toHaveAttribute('data-hydrated', 'true')
      expect(shell).not.toHaveAttribute('inert')
    })

    fireEvent.click(screen.getByRole('button', { name: /未命名工作区/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除项目' }))
    expect(screen.getByRole('dialog', { name: '删除当前项目？' })).toBeVisible()
  })

  it('switches between brush tool and select tool via B and V keyboard shortcuts', async () => {
    render(<App />)
    const shell = screen.getByTestId('app-shell')
    await waitFor(() => {
      expect(shell).toHaveAttribute('data-hydrated', 'true')
    })

    const workspace = screen.getByTestId('canvas-workspace')
    expect(workspace).toHaveAttribute('data-active-tool', 'select')

    // Press 'b' to activate brush mode
    fireEvent.keyDown(document, { key: 'b' })
    expect(workspace).toHaveAttribute('data-active-tool', 'brush')

    // Press 'v' to return to select mode
    fireEvent.keyDown(document, { key: 'v' })
    expect(workspace).toHaveAttribute('data-active-tool', 'select')
  })

  it('triggers undo and redo via bottom toolbar buttons and keyboard shortcuts', async () => {
    render(<App />)
    const shell = screen.getByTestId('app-shell')
    await waitFor(() => {
      expect(shell).toHaveAttribute('data-hydrated', 'true')
    })

    const initialNodesCount = canvasStore.getState().snapshot.nodes.length

    // Add a node
    canvasStore.getState().addNode({
      id: 'test-undo-node-1',
      type: 'text',
      name: '测试文本',
      position: { x: 100, y: 100 },
      size: { width: 200, height: 100 },
      data: { text: 'Hello Undo' },
    })
    expect(canvasStore.getState().snapshot.nodes.length).toBe(initialNodesCount + 1)

    // Click undo in bottom toolbar
    const undoButton = screen.getByRole('button', { name: /撤销/ })
    fireEvent.click(undoButton)
    expect(canvasStore.getState().snapshot.nodes.length).toBe(initialNodesCount)

    // Click redo in bottom toolbar
    const redoButton = screen.getByRole('button', { name: /重做/ })
    fireEvent.click(redoButton)
    expect(canvasStore.getState().snapshot.nodes.length).toBe(initialNodesCount + 1)

    // Test Ctrl+Z shortcut
    fireEvent.keyDown(document, { ctrlKey: true, key: 'z' })
    expect(canvasStore.getState().snapshot.nodes.length).toBe(initialNodesCount)

    // Test Ctrl+Shift+Z shortcut
    fireEvent.keyDown(document, { ctrlKey: true, shiftKey: true, key: 'z' })
    expect(canvasStore.getState().snapshot.nodes.length).toBe(initialNodesCount + 1)
  })

  it('restores node positions when undoing node move and layout', async () => {
    render(<App />)
    const shell = screen.getByTestId('app-shell')
    await waitFor(() => {
      expect(shell).toHaveAttribute('data-hydrated', 'true')
    })

    canvasStore.getState().addNode({
      id: 'move-node-1',
      type: 'text',
      name: 'Text 1',
      position: { x: 100, y: 100 },
      size: { width: 200, height: 100 },
      data: { text: '1' },
    })
    canvasStore.getState().addNode({
      id: 'move-node-2',
      type: 'text',
      name: 'Text 2',
      position: { x: 400, y: 100 },
      size: { width: 200, height: 100 },
      data: { text: '2' },
    })

    // Move node 1
    canvasStore.getState().moveNodes([{ id: 'move-node-1', position: { x: 600, y: 400 } }])
    expect(canvasStore.getState().snapshot.nodes.find((n) => n.id === 'move-node-1')?.position.x).toBe(600)

    // Undo move via Ctrl+Z
    fireEvent.keyDown(document, { ctrlKey: true, key: 'z' })
    expect(canvasStore.getState().snapshot.nodes.find((n) => n.id === 'move-node-1')?.position.x).toBe(100)

    // Redo move via Ctrl+Shift+Z
    fireEvent.keyDown(document, { ctrlKey: true, shiftKey: true, key: 'z' })
    expect(canvasStore.getState().snapshot.nodes.find((n) => n.id === 'move-node-1')?.position.x).toBe(600)

    // Layout nodes
    canvasStore.getState().layoutNodes(['move-node-1', 'move-node-2'])

    // Undo layout via button
    const undoButton = screen.getByRole('button', { name: /撤销/ })
    fireEvent.click(undoButton)
    expect(canvasStore.getState().snapshot.nodes.find((n) => n.id === 'move-node-1')?.position.x).toBe(600)
    expect(canvasStore.getState().snapshot.nodes.find((n) => n.id === 'move-node-2')?.position.x).toBe(400)
  })
})
