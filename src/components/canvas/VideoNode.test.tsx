// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VideoNode } from './VideoNode'

afterEach(cleanup)

describe('VideoNode', () => {
  it('opens the generator immediately and moves capture actions into it', () => {
    render(<ReactFlowProvider><VideoNode {...({
      id: 'video-a', selected: true, isConnectable: true,
      data: {
        name: '视频节点', mediaType: 'video', url: 'https://example.test/video.mp4',
        isSoleSelection: true, onCaptureFrame: vi.fn(),
      },
    } as never)} /></ReactFlowProvider>)

    expect(screen.getByLabelText('视频生成描述')).toBeVisible()
    expect(screen.queryByRole('button', { name: /^生成$/ })).toBeNull()
    expect(screen.getByRole('button', { name: '截取首帧' })).toBeVisible()
    expect(screen.getByRole('button', { name: '截取当前帧' })).toBeVisible()
    expect(screen.getByRole('button', { name: '截取尾帧' })).toBeVisible()
  })

  it('hides capture actions for an empty video node', () => {
    render(<ReactFlowProvider><VideoNode {...({
      id: 'video-empty', selected: true, isConnectable: true,
      data: { name: '空视频', mediaType: 'video', url: '', isSoleSelection: true },
    } as never)} /></ReactFlowProvider>)
    expect(screen.getByLabelText('视频生成描述')).toBeVisible()
    expect(screen.queryByRole('button', { name: '截取当前帧' })).toBeNull()
  })
})
