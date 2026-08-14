// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { EditableNodeLabel } from './EditableNodeLabel'

describe('EditableNodeLabel', () => {
  it('commits a renamed node with Enter', () => {
    const onRename = vi.fn()
    render(
      <EditableNodeLabel
        name="图片节点 9"
        nodeId="image-9"
        onRename={onRename}
      />,
    )

    fireEvent.doubleClick(
      screen.getByRole('button', { name: '重命名 图片节点 9' }),
    )
    const input = screen.getByRole('textbox', { name: '节点名称' })
    fireEvent.change(input, { target: { value: '院落主镜头' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRename).toHaveBeenCalledOnce()
    expect(onRename).toHaveBeenCalledWith('image-9', '院落主镜头')
  })

  it('cancels with Escape and limits input to 48 characters', () => {
    const onRename = vi.fn()
    render(
      <EditableNodeLabel
        name="视频节点"
        nodeId="video-1"
        onRename={onRename}
      />,
    )

    fireEvent.doubleClick(
      screen.getByRole('button', { name: '重命名 视频节点' }),
    )
    const input = screen.getByRole('textbox', { name: '节点名称' })
    expect(input.getAttribute('maxlength')).toBe('48')
    fireEvent.change(input, { target: { value: '未保存名称' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '重命名 视频节点' })).toBeTruthy()
  })
})
