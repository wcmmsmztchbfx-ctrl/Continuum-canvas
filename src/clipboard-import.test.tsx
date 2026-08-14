// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { resolveClipboardContents } from './clipboard-import'
import type { CanvasSnapshotV2 } from './model/project'
import { persistLocalMedia } from './services/localMedia'
import { gatewayClient } from './services/gatewayClient'
import { canvasStore } from './store/canvas-store'
import type { WorkspaceRepository } from './workspace'

vi.mock('./services/localMedia', () => ({
  persistLocalMedia: vi.fn(async (file: File) => ({
    assetId: `asset-${file.name}`,
    url: `/api/assets/asset-${file.name}`,
  })),
}))

const emptySnapshot = (canvasId = 'clipboard-canvas'): CanvasSnapshotV2 => ({
  version: 2,
  canvasId,
  projectId: 'clipboard-project',
  name: 'Clipboard fixture',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
})

function repositoryFor(snapshot: CanvasSnapshotV2): WorkspaceRepository {
  return {
    loadCanvas: vi.fn(async () => structuredClone(snapshot)),
    saveCanvas: vi.fn(async () => undefined),
  } as unknown as WorkspaceRepository
}

async function renderCanvas(snapshot = emptySnapshot()) {
  const view = render(
    <App
      canvasId={snapshot.canvasId}
      projectId={snapshot.projectId}
      workspaceRepository={repositoryFor(snapshot)}
    />,
  )
  await waitFor(() =>
    expect(screen.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true'),
  )
  return view
}

function pasteClipboard(data: {
  files?: File[]
  html?: string
  text?: string
}) {
  fireEvent.paste(document, {
    clipboardData: {
      files: data.files ?? [],
      items: [],
      getData: (type: string) => {
        if (type === 'text/html') return data.html ?? ''
        if (type === 'text/plain') return data.text ?? ''
        return ''
      },
    },
  })
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

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

afterEach(cleanup)

describe('clipboard media import', () => {
  it('uses rich clipboard reading for the right-click paste command', async () => {
    await renderCanvas()
    const read = vi.fn(async () => [{
      types: ['image/png'],
      getType: async () => new Blob(['image'], { type: 'image/png' }),
    }])
    const readText = vi.fn(async () => 'fallback text')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { read, readText },
    })

    fireEvent.contextMenu(document.querySelector('.react-flow__pane')!, {
      clientX: 200,
      clientY: 180,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: '粘贴' }))

    await waitFor(() => expect(persistLocalMedia).toHaveBeenCalled())
    expect(read).toHaveBeenCalledOnce()
    expect(readText).not.toHaveBeenCalled()
  })

  it('reports unsafe copied image addresses through the existing toast path', async () => {
    await renderCanvas()

    pasteClipboard({ html: '<img src="file:///C:/private/image.png">' })

    expect(await screen.findByText('剪贴板图片地址不安全')).toBeVisible()
  })

  it('recognizes a Windows Explorer image file by extension when MIME is empty', async () => {
    await renderCanvas()
    const file = new File(['png bytes'], 'explorer-image.PNG', { type: '' })

    pasteClipboard({ files: [file] })

    await waitFor(() => expect(persistLocalMedia).toHaveBeenCalledWith(file))
    expect(canvasStore.getState().snapshot.nodes).toContainEqual(
      expect.objectContaining({ type: 'image', name: 'explorer-image.PNG' }),
    )
  })

  it('imports an image embedded in copied HTML', async () => {
    await renderCanvas()
    vi.spyOn(gatewayClient, 'importAsset').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      url: '/api/assets/11111111-1111-4111-8111-111111111111',
      filename: 'copied.png',
      contentType: 'image/png',
      size: 100,
      createdAt: '2026-08-13T00:00:00.000Z',
    })

    pasteClipboard({
      html: '<p>Copied image</p><img src="https://images.example/copied.png" alt="Copied">',
    })

    await waitFor(() =>
      expect(canvasStore.getState().snapshot.nodes).toContainEqual(
        expect.objectContaining({
          type: 'image',
          data: expect.objectContaining({
            url: '/api/assets/11111111-1111-4111-8111-111111111111',
            assetId: '11111111-1111-4111-8111-111111111111',
          }),
        }),
      ),
    )
    expect(gatewayClient.importAsset).toHaveBeenCalledWith('https://images.example/copied.png')
  })

  it('imports a plain image URL as an image node', async () => {
    await renderCanvas()
    vi.spyOn(gatewayClient, 'importAsset').mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      url: '/api/assets/22222222-2222-4222-8222-222222222222',
      filename: 'reference.webp',
      contentType: 'image/webp',
      size: 100,
      createdAt: '2026-08-13T00:00:00.000Z',
    })

    pasteClipboard({ text: 'https://images.example/reference.webp' })

    await waitFor(() =>
      expect(canvasStore.getState().snapshot.nodes).toContainEqual(
        expect.objectContaining({
          type: 'image',
          data: expect.objectContaining({
            url: '/api/assets/22222222-2222-4222-8222-222222222222',
            assetId: '22222222-2222-4222-8222-222222222222',
          }),
        }),
      ),
    )
  })

  it('shows an error and leaves no hotlink node when remote persistence fails', async () => {
    await renderCanvas()
    vi.spyOn(gatewayClient, 'importAsset').mockRejectedValue(new Error('Remote import failed'))

    pasteClipboard({ text: 'https://images.example/failure.png' })

    expect(await screen.findByText('Remote import failed')).toBeVisible()
    expect(canvasStore.getState().snapshot.nodes).toHaveLength(0)
  })

  it('anchors repeated internal pastes at the last canvas pointer with a 32px cascade', async () => {
    await renderCanvas()
    const envelope = JSON.stringify({
      kind: 'libtv-canvas-nodes',
      version: 1,
      sourceCanvasId: 'another-canvas',
      nodes: [{ id: 'source', type: 'text', name: 'Source', position: { x: 10, y: 20 }, size: { width: 100, height: 80 }, data: { text: 'A', nodeKind: 'text' } }],
      edges: [],
    })

    fireEvent.contextMenu(document.querySelector('.react-flow__pane')!, { clientX: 500, clientY: 360 })
    pasteClipboard({ text: envelope })
    await waitFor(() => expect(canvasStore.getState().snapshot.nodes).toHaveLength(1))
    pasteClipboard({ text: envelope })
    await waitFor(() => expect(canvasStore.getState().snapshot.nodes).toHaveLength(2))

    expect(canvasStore.getState().snapshot.nodes.map((node) => node.position)).toEqual([
      { x: 500, y: 360 },
      { x: 532, y: 392 },
    ])
  })

  it('round-trips an internal multi-node copy with its internal edges', async () => {
    const source = emptySnapshot('source-canvas')
    source.nodes = [
      {
        id: 'text-a',
        type: 'text',
        name: 'A',
        position: { x: 0, y: 0 },
        size: { width: 240, height: 120 },
        data: { text: 'A', nodeKind: 'text' },
      },
      {
        id: 'text-b',
        type: 'text',
        name: 'B',
        position: { x: 320, y: 0 },
        size: { width: 240, height: 120 },
        data: { text: 'B', nodeKind: 'text' },
      },
    ]
    source.edges = [
      { id: 'edge-a-b', source: 'text-a', target: 'text-b', relation: 'flow' },
    ]
    let clipboardText = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async (value: string) => { clipboardText = value }),
      },
    })
    const destination = emptySnapshot('destination-canvas')
    const repository = {
      loadCanvas: vi.fn(async (canvasId: string) => structuredClone(
        canvasId === source.canvasId ? source : destination,
      )),
      saveCanvas: vi.fn(async () => undefined),
    } as unknown as WorkspaceRepository
    const sourceView = render(
      <App canvasId={source.canvasId} projectId={source.projectId} workspaceRepository={repository} />,
    )
    await waitFor(() => expect(screen.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true'))
    act(() => canvasStore.setState({ selectedNodeIds: ['text-a', 'text-b'] }))

    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await waitFor(() => expect(clipboardText).not.toBe(''))
    expect(JSON.parse(clipboardText)).toEqual(expect.objectContaining({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: 'text-a' }),
        expect.objectContaining({ id: 'text-b' }),
      ]),
      edges: [expect.objectContaining({ id: 'edge-a-b' })],
    }))
    await expect(resolveClipboardContents({ files: [], html: '', text: clipboardText }))
      .resolves.toEqual(expect.objectContaining({ kind: 'internal' }))
    sourceView.rerender(
      <App canvasId={destination.canvasId} projectId={destination.projectId} workspaceRepository={repository} />,
    )
    await waitFor(() => expect(canvasStore.getState().snapshot.nodes).toHaveLength(0))
    pasteClipboard({ text: clipboardText })

    await waitFor(() => expect(canvasStore.getState().snapshot.nodes).toHaveLength(2))
    const imported = canvasStore.getState().snapshot
    expect(imported.edges).toHaveLength(1)
    expect(new Set(imported.nodes.map((node) => node.id))).toEqual(
      new Set([imported.edges[0]!.source, imported.edges[0]!.target]),
    )
  })
})
