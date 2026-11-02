// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { useState } from 'react'
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


describe('TextNode legacy HTML content', () => {
  it('preserves paragraph breaks, inline text, and entities as plain text', () => {
    renderNode({ text: '<p>First &amp; <strong>second</strong></p><p>Third<br>Fourth &lt;b&gt;literal&lt;/b&gt;</p>' })

    const preview = screen.getByLabelText('文本节点').querySelector('.canvas-text-node__preview')
    expect(preview?.textContent).toBe('First &amp; second\nThird\nFourth &lt;b&gt;literal&lt;/b&gt;')
    expect(preview?.querySelector('strong, b')).toBeNull()
    fireEvent.doubleClick(preview!)
    expect(screen.getByRole('textbox', { name: '文本节点内容' })).toHaveValue('First &amp; second\nThird\nFourth &lt;b&gt;literal&lt;/b&gt;')
  })

  it('keeps entity-only plain text literal after remounting', () => {
    const view = renderNode({ text: '&amp; &lt;b&gt;literal&lt;/b&gt;' })
    expect(screen.getByText('&amp; &lt;b&gt;literal&lt;/b&gt;')).toBeVisible()
    view.unmount()
    renderNode({ text: '&amp; &lt;b&gt;literal&lt;/b&gt;' })
    expect(screen.getByText('&amp; &lt;b&gt;literal&lt;/b&gt;')).toBeVisible()
  })

  it('preserves explicit empty lines between HTML paragraphs', () => {
    renderNode({ text: '<p>First</p><p><br></p><p>Third</p>' })
    const preview = screen.getByLabelText('文本节点').querySelector('.canvas-text-node__preview')
    expect(preview?.textContent).toBe('First\n\nThird')
  })

  it('keeps active markup inert and encoded markup literal', () => {
    renderNode({ text: '<p>Safe &lt;img src=x onerror=alert(1)&gt;</p><img src=x onerror="alert(1)"><script>alert(1)</script><style>p { color: red }</style>' })

    const preview = screen.getByLabelText('文本节点').querySelector('.canvas-text-node__preview')
    expect(preview?.textContent).toBe('Safe &lt;img src=x onerror=alert(1)&gt;')
    expect(preview?.querySelector('img, script, style')).toBeNull()
  })

  it.each([
    { stored: '<p>&lt;b&gt;literal&lt;/b&gt;</p>', visible: '&lt;b&gt;literal&lt;/b&gt;' },
    { stored: '<textarea><b>literal</b></textarea>', visible: '<b>literal</b>' },
  ])('preserves legacy text on blur without typing: $stored', ({ stored, visible }) => {
    function EditableCanvasText() {
      const [text, setText] = useState(stored)
      return <ReactFlowProvider><TextNode {...({
        id: 'text-a', selected: true, isConnectable: true,
        data: { name: '文本节点', mediaType: 'text', url: '', text, onTextChange: (_id: string, value: string) => setText(value) },
      } as never)} /></ReactFlowProvider>
    }
    render(<EditableCanvasText />)
    fireEvent.doubleClick(screen.getByText(visible))
    const editor = screen.getByRole('textbox', { name: '文本节点内容' })
    expect(editor).toHaveValue(visible)
    fireEvent.blur(editor)
    expect(screen.getByText(visible)).toBeVisible()
  })

  it('preserves entity spelling in saved legacy HTML after remounting', () => {
    let savedText = ''
    const view = renderNode({
      text: '<p>&lt;b&gt;literal&lt;/b&gt; &amp; &#x41; &#65;</p>',
      onTextChange: (_id, value) => { savedText = value },
    })
    fireEvent.doubleClick(screen.getByText('&lt;b&gt;literal&lt;/b&gt; &amp; &#x41; &#65;'))
    fireEvent.blur(screen.getByRole('textbox', { name: '文本节点内容' }))
    expect(savedText).toBe('&lt;b&gt;literal&lt;/b&gt; &amp; &#x41; &#65;')
    view.unmount()
    renderNode({ text: savedText })
    expect(screen.getByText('&lt;b&gt;literal&lt;/b&gt; &amp; &#x41; &#65;')).toBeVisible()
  })

  it('preserves manually typed markup and entities when the canvas echoes edits', () => {
    function EditableCanvasText() {
      const [text, setText] = useState('Initial')
      return <ReactFlowProvider><TextNode {...({
        id: 'text-a', selected: true, isConnectable: true,
        data: { name: '文本节点', mediaType: 'text', url: '', text, onTextChange: (_id: string, value: string) => setText(value) },
      } as never)} /></ReactFlowProvider>
    }
    render(<EditableCanvasText />)
    fireEvent.doubleClick(screen.getByText('Initial'))
    const editor = screen.getByRole('textbox', { name: '文本节点内容' })
    fireEvent.change(editor, { target: { value: '2 < 3 & <b>literal</b> &amp;' } })
    expect(editor).toHaveValue('2 < 3 & <b>literal</b> &amp;')
    fireEvent.blur(editor)
    expect(screen.getByText('2 < 3 & <b>literal</b> &amp;')).toBeVisible()
  })
})
