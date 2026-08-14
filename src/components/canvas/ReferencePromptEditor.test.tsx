// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReferencePromptEditor } from './ReferencePromptEditor'

afterEach(cleanup)

const references = [
  {
    id: 'image-1',
    referenceAlias: 1,
    name: '人物近景',
    kind: 'image' as const,
    url: '/api/assets/11111111-1111-4111-8111-111111111111',
  },
]

const candidates = [
  ...references.map((reference) => ({
    id: reference.id,
    name: reference.name,
    url: reference.url,
    connectedAlias: reference.referenceAlias,
    kind: 'image' as const,
  })),
  {
    id: 'image-2',
    name: '薄雾院落',
    url: '/api/assets/22222222-2222-4222-8222-222222222222',
    kind: 'image' as const,
  },
]

describe('ReferencePromptEditor', () => {
  it('renders valid and invalid @ references in a synchronized visual layer', () => {
    const { container } = render(
      <ReferencePromptEditor
        candidates={candidates}
        invalidAliases={[3]}
        label="图片生成描述"
        onAttachReference={vi.fn()}
        onChange={vi.fn()}
        prompt="人物 @1 进入失效场景 @3"
        references={references}
      />,
    )

    expect(container.querySelector('.canvas-prompt-editor__mention--valid')).toHaveTextContent('@1')
    expect(container.querySelector('.canvas-prompt-editor__mention--invalid')).toHaveTextContent('@3')
    expect(screen.getByRole('combobox', { name: '图片生成描述' })).toHaveValue(
      '人物 @1 进入失效场景 @3',
    )
  })

  it('keeps the highlight layer aligned while a long prompt scrolls', () => {
    const { container } = render(
      <ReferencePromptEditor
        candidates={candidates}
        invalidAliases={[]}
        label="视频生成描述"
        onAttachReference={vi.fn()}
        onChange={vi.fn()}
        prompt={'长提示词\n'.repeat(80)}
        references={references}
      />,
    )
    const editor = screen.getByRole('combobox', { name: '视频生成描述' })
    const highlight = container.querySelector<HTMLElement>(
      '.canvas-prompt-editor__highlight > div',
    )
    Object.defineProperty(editor, 'scrollTop', { configurable: true, value: 180 })
    Object.defineProperty(editor, 'scrollLeft', { configurable: true, value: 12 })

    fireEvent.scroll(editor)

    expect(highlight).toHaveStyle({
      transform: 'translate(-12px, -180px)',
    })
  })

  it('uses the submission mention grammar for highlighting', () => {
    const { container } = render(
      <ReferencePromptEditor
        candidates={candidates}
        invalidAliases={[0]}
        label="图片生成描述"
        onAttachReference={vi.fn()}
        onChange={vi.fn()}
        prompt="foo@9 保留 @1，拒绝 @0"
        references={references}
      />,
    )

    expect(container.querySelectorAll('.canvas-prompt-editor__mention')).toHaveLength(2)
    expect(container.querySelector('.canvas-prompt-editor__mention--valid')).toHaveTextContent('@1')
    expect(container.querySelector('.canvas-prompt-editor__mention--invalid')).toHaveTextContent('@0')
  })

  it('opens a caret menu for @ and inserts an existing reference with keyboard navigation', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <ReferencePromptEditor
        candidates={candidates}
        invalidAliases={[]}
        label="视频生成描述"
        onAttachReference={vi.fn()}
        onChange={onChange}
        prompt="让 "
        references={references}
      />,
    )

    const editor = screen.getByRole('combobox', { name: '视频生成描述' })
    await user.click(editor)
    await user.type(editor, '@')
    const menu = screen.getByRole('listbox', { name: '选择参考素材' })
    expect(menu).toHaveAttribute('data-caret-menu', 'true')
    expect(within(menu).getByRole('option', { name: /人物近景/ })).toBeVisible()
    expect(within(menu).getByRole('option', { name: /薄雾院落/ })).toBeVisible()

    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    fireEvent.keyDown(editor, { key: 'ArrowUp' })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith('让 @1 ')
    expect(screen.queryByRole('listbox', { name: '选择参考素材' })).toBeNull()
  })

  it('auto-attaches an eligible image before inserting its stable alias', async () => {
    const onChange = vi.fn()
    const onAttachReference = vi.fn().mockReturnValue(2)
    const user = userEvent.setup()
    render(
      <ReferencePromptEditor
        candidates={candidates}
        invalidAliases={[]}
        label="图片生成描述"
        onAttachReference={onAttachReference}
        onChange={onChange}
        prompt="院落 "
        references={references}
      />,
    )

    const editor = screen.getByRole('combobox', { name: '图片生成描述' })
    await user.click(editor)
    await user.type(editor, '@薄')
    await user.click(screen.getByRole('option', { name: /薄雾院落/ }))

    expect(onAttachReference).toHaveBeenCalledWith('image-2')
    expect(onChange).toHaveBeenLastCalledWith('院落 @2 ')
  })

  it('marks unresolved mentions and closes the menu with Escape without changing text', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <ReferencePromptEditor
        candidates={candidates}
        invalidAliases={[3]}
        label="图片生成描述"
        onAttachReference={vi.fn()}
        onChange={onChange}
        prompt="让 @3 走进院落"
        references={references}
      />,
    )

    expect(screen.getByText('@3 已失效')).toBeVisible()
    const editor = screen.getByRole('combobox', { name: '图片生成描述' })
    await user.click(editor)
    await user.type(editor, ' @')
    expect(screen.getByRole('listbox', { name: '选择参考素材' })).toBeVisible()
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: '选择参考素材' })).toBeNull()
  })

  it('opens after punctuation, deduplicates candidates, and supports End/Home with ARIA state', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <ReferencePromptEditor
        candidates={[...candidates, { ...candidates[1] }]}
        invalidAliases={[]}
        label="图片生成描述"
        onAttachReference={vi.fn().mockReturnValue(2)}
        onChange={onChange}
        prompt="镜头，"
        references={references}
      />,
    )

    const editor = screen.getByRole('combobox', { name: '图片生成描述' })
    await user.click(editor)
    await user.type(editor, '@')
    const menu = screen.getByRole('listbox', { name: '选择参考素材' })
    expect(menu).toHaveStyle({ position: 'fixed' })
    expect(within(menu).getAllByRole('option')).toHaveLength(2)
    expect(editor).toHaveAttribute('aria-controls', menu.id)
    expect(editor).toHaveAttribute('aria-activedescendant')

    fireEvent.keyDown(editor, { key: 'End' })
    expect(within(menu).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(editor, { key: 'Home' })
    expect(within(menu).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith('镜头，@1 ')
  })
})
