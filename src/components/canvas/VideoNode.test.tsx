// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VideoNode } from './VideoNode'

afterEach(cleanup)

describe('VideoNode', () => {
  it('opens the generator on selection and moves capture actions into it', async () => {
    render(<ReactFlowProvider><VideoNode {...({
      id: 'video-a', selected: true, isConnectable: true,
      data: {
        name: '视频节点', mediaType: 'video', url: 'https://example.test/video.mp4',
        isSoleSelection: true, onCaptureFrame: vi.fn(),
      },
    } as never)} /></ReactFlowProvider>)

    expect(await screen.findByLabelText('视频生成描述')).toBeVisible()
    expect(screen.queryByRole('button', { name: /^生成$/ })).toBeNull()
    expect(screen.getByRole('button', { name: '截取首帧' })).toBeVisible()
    expect(screen.getByRole('button', { name: '截取当前帧' })).toBeVisible()
    expect(screen.getByRole('button', { name: '截取尾帧' })).toBeVisible()
  })

  it('hides capture actions for an empty video node', async () => {
    render(<ReactFlowProvider><VideoNode {...({
      id: 'video-empty', selected: true, isConnectable: true,
      data: { name: '空视频', mediaType: 'video', url: '', isSoleSelection: true },
    } as never)} /></ReactFlowProvider>)
    expect(await screen.findByLabelText('视频生成描述')).toBeVisible()
    expect(screen.queryByRole('button', { name: '截取当前帧' })).toBeNull()
  })

  it('renders the floating timeline scrubber with progress and mute controls when video is present', () => {
    render(<ReactFlowProvider><VideoNode {...({
      id: 'video-scrubber', selected: true, isConnectable: true,
      data: {
        name: '视频节点', mediaType: 'video', url: 'https://example.test/video.mp4',
        isSoleSelection: true,
      },
    } as never)} /></ReactFlowProvider>)

    expect(screen.getByLabelText('视频播放进度控制')).toBeVisible()
    expect(screen.getByRole('slider', { name: '播放进度' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '播放' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '静音' })).toBeInTheDocument()
    expect(screen.getByText('00:00 / 00:00')).toBeInTheDocument()
  })

  it('accurately binds the progress bar max upper bound to the actual video duration', () => {
    const { container } = render(<ReactFlowProvider><VideoNode {...({
      id: 'video-duration-test', selected: true, isConnectable: true,
      data: {
        name: '时长测试节点', mediaType: 'video', url: 'https://example.test/video-sample.mp4',
        isSoleSelection: true,
      },
    } as never)} /></ReactFlowProvider>)

    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    const video = container.querySelector('video') as HTMLVideoElement
    expect(video).not.toBeNull()

    const slider = screen.getByRole('slider', { name: '播放进度' }) as HTMLInputElement
    expect(slider).toBeDisabled()
    expect(slider.max).toBe('1')

    // Simulate metadata loaded with real video duration 15.5 seconds
    Object.defineProperty(video, 'duration', { value: 15.5, writable: true, configurable: true })
    Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true })
    fireEvent.loadedMetadata(video)

    // Progress slider max should strictly match actual video duration 15.5, not arbitrary 100
    expect(slider.max).toBe('15.5')
    expect(slider).not.toBeDisabled()
    expect(screen.getByText('00:00 / 00:15')).toBeInTheDocument()

    // Simulate seeking to 7.75 seconds
    fireEvent.change(slider, { target: { value: '7.75' } })
    expect(video.currentTime).toBe(7.75)
    expect(screen.getByText('00:07 / 00:15')).toBeInTheDocument()
  })

  it.each([0.2, 12])('remembers playback position %s and resumes when node is unmounted and remounted', (savedTime) => {
    const props = {
      id: 'video-resume-node', selected: true, isConnectable: true,
      data: {
        name: '断点续播测试', mediaType: 'video', url: 'https://example.test/resume-test.mp4',
        isSoleSelection: true,
      },
    } as never

    const { unmount, container } = render(
      <ReactFlowProvider>
        <VideoNode {...props} />
      </ReactFlowProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    const video = container.querySelector('video') as HTMLVideoElement
    expect(video).not.toBeNull()

    Object.defineProperty(video, 'duration', { value: 30, writable: true, configurable: true })
    Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true })
    fireEvent.loadedMetadata(video)

    const slider = screen.getByRole('slider', { name: '播放进度' }) as HTMLInputElement
    fireEvent.change(slider, { target: { value: String(savedTime) } })
    expect(video.currentTime).toBe(savedTime)

    // User navigates away / unmounts the node
    unmount()

    // User returns / remounts the node
    const view2 = render(
      <StrictMode><ReactFlowProvider>
        <VideoNode {...props} />
      </ReactFlowProvider></StrictMode>,
    )

    // Should retain the 12s time display
    const displayTime = '00:' + String(Math.floor(savedTime)).padStart(2, '0')
    expect(screen.getByText(displayTime + ' / 00:00')).toBeInTheDocument()

    // When playing is started, the video element is mounted and restored to 12s
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    const video2 = view2.container.querySelector('video') as HTMLVideoElement
    expect(video2).not.toBeNull()

    Object.defineProperty(video2, 'duration', { value: 30, writable: true, configurable: true })
    Object.defineProperty(video2, 'currentTime', { value: 0, writable: true, configurable: true })
    fireEvent.loadedMetadata(video2)

    expect(video2.currentTime).toBe(savedTime)
    expect(screen.getByText(displayTime + ' / 00:30')).toBeInTheDocument()
  })
})

