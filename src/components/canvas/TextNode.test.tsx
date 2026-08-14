// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { TextNode } from './TextNode'
import type { CanvasFlowNodeData } from './mapping'

afterEach(cleanup)

function renderNode(data: Partial<CanvasFlowNodeData> = {}) {
  const resolved: CanvasFlowNodeData = {
    name: '文本节点', mediaType: 'text', url: '', text: '共享正文', ...data,
  }
  return render(
    <ReactFlowProvider>
      <TextNode {...({
        id: 'text-a', data: resolved, selected: true, isConnectable: true,
      } as never)} />
    </ReactFlowProvider>,
  )
}

describe('TextNode collaboration editing', () => {
  it('uses a neutral preview contract without changing edit or lock behavior', () => {
    renderNode()
    const node = screen.getByLabelText('文本节点')
    expect(node).toHaveAttribute('data-selected', 'true')
    expect(node.querySelector('svg')).not.toBeNull()
    expect(screen.getByText('共享正文')).toBeVisible()

    const css = readFileSync(resolve(process.cwd(), 'src/components/canvas/canvas.css'), 'utf8')
    expect(css).toMatch(/\.canvas-text-node__frame\s*\{[^}]*border:\s*1px solid #3f4144/s)
    expect(css).toMatch(/\.canvas-text-node\[data-selected="true"\][^{]*\{[^}]*#74777b/s)
    expect(css).not.toMatch(/\.canvas-text-node\[data-selected="true"\][^{]*\{[^}]*#58a6ff/s)
  })

  it('stays in preview on click and enters editing only after a successful double-click lease', () => {
    const onInteractionStart = vi.fn(() => true)
    renderNode({ onInteractionStart })

    fireEvent.click(screen.getByText('共享正文'))
    expect(screen.queryByRole('textbox', { name: '文本节点内容' })).toBeNull()
    fireEvent.doubleClick(screen.getByText('共享正文'))

    expect(onInteractionStart).toHaveBeenCalledWith('text-a', 'text')
    expect(screen.getByRole('textbox', { name: '文本节点内容' })).toBeVisible()
  })

  it('releases once on blur or Escape and refuses a remotely locked edit', () => {
    const onInteractionEnd = vi.fn()
    const view = renderNode({
      onInteractionStart: vi.fn(() => true), onInteractionEnd,
    })
    fireEvent.doubleClick(screen.getByText('共享正文'))
    fireEvent.keyDown(screen.getByRole('textbox', { name: '文本节点内容' }), { key: 'Escape' })
    expect(onInteractionEnd).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('textbox', { name: '文本节点内容' })).toBeNull()

    view.rerender(
      <ReactFlowProvider>
        <TextNode {...({
          id: 'text-a', selected: true, isConnectable: true,
          data: {
            name: '文本节点', mediaType: 'text', url: '', text: '远端新值',
            lockedBy: { memberId: 'remote-b', displayName: '远端成员', color: '#d08c55', kind: 'text' },
            onInteractionStart: vi.fn(() => false), onInteractionEnd,
          },
        } as never)} />
      </ReactFlowProvider>,
    )
    fireEvent.doubleClick(screen.getByText('远端新值'))
    expect(screen.queryByRole('textbox', { name: '文本节点内容' })).toBeNull()
    expect(screen.getByText(/远端成员/)).toBeVisible()
  })

  it('offers selected empty text nodes a connected video quick action', () => {
    const onCreateConnected = vi.fn()
    renderNode({ text: '', onCreateConnected })

    fireEvent.click(screen.getByRole('button', { name: '文生视频' }))

    expect(onCreateConnected).toHaveBeenCalledWith('text-a', 'video')
  })
})
