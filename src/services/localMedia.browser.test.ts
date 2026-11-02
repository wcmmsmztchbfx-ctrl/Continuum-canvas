// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { extractVideoMetadata } from './localMedia'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function observeVideo() {
  const createElement = document.createElement.bind(document)
  let video: HTMLVideoElement | undefined
  vi.spyOn(document, 'createElement').mockImplementation((tag, options) => {
    const element = createElement(tag, options)
    if (tag === 'video') video = element as HTMLVideoElement
    return element
  })
  // jsdom does not implement media decoding or canvas drawing.
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  return () => video!
}

describe('local video metadata URL boundary', () => {
  it('rejects non-blob sources without binding them to the video', async () => {
    vi.useFakeTimers()
    const video = observeVideo()
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL() { return 'javascript:alert(1)' }
      static revokeObjectURL = revokeObjectURL
    })

    const pending = extractVideoMetadata(new File(['video'], 'clip.mp4', { type: 'video/mp4' }))
    expect(video().getAttribute('src')).toBeNull()
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toEqual({})
    expect(revokeObjectURL).toHaveBeenCalledWith('javascript:alert(1)')
  })

  it('extracts dimensions and poster for local blobs and releases the media source', async () => {
    const video = observeVideo()
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL() { return 'blob:https://canvas.example/local-video' }
      static revokeObjectURL = revokeObjectURL
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D)
    const poster = new Blob(['poster'], { type: 'image/webp' })
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(poster))

    const pending = extractVideoMetadata(new File(['video'], 'clip.mp4', { type: 'video/mp4' }))
    expect(video().src).toBe('blob:https://canvas.example/local-video')
    Object.defineProperties(video(), {
      videoWidth: { value: 1920 }, videoHeight: { value: 1080 }, duration: { value: 5.7 },
    })
    video().dispatchEvent(new Event('loadeddata'))

    await expect(pending).resolves.toEqual({ blob: poster, width: 1920, height: 1080, durationSec: 6 })
    expect(video().getAttribute('src')).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:https://canvas.example/local-video')
  })

  it('releases a local video URL when decoding fails', async () => {
    const video = observeVideo()
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL() { return 'blob:https://canvas.example/bad-video' }
      static revokeObjectURL = revokeObjectURL
    })
    const pending = extractVideoMetadata(new File(['broken'], 'clip.mp4', { type: 'video/mp4' }))
    video().dispatchEvent(new Event('error'))
    await expect(pending).resolves.toEqual({})
    expect(video().getAttribute('src')).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:https://canvas.example/bad-video')
  })
})
