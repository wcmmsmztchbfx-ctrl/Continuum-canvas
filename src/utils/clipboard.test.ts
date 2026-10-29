// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { copyImageToClipboard, copyText } from './clipboard'

describe('clipboard utils', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('Image', class {
      onload?: () => void
      onerror?: () => void
      set src(_val: string) {
        setTimeout(() => this.onerror?.(), 0)
      }
    })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error in unit test'))
  })

  it('copies text via navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: { writeText },
    })

    await copyText('hello world')
    expect(writeText).toHaveBeenCalledWith('hello world')
  })

  it('rejects copyImageToClipboard when url is empty', async () => {
    await expect(copyImageToClipboard('')).rejects.toThrow('图片地址为空')
  })

  it('copies image to clipboard via ClipboardItem when navigator.clipboard.write is supported', async () => {
    const fakeBlob = new Blob(['png-bytes'], { type: 'image/png' })
    const write = vi.fn().mockResolvedValue(undefined)
    
    // Mock global ClipboardItem
    class MockClipboardItem {
      types: string[]
      constructor(public data: Record<string, Blob>) {
        this.types = Object.keys(data)
      }
    }
    vi.stubGlobal('ClipboardItem', MockClipboardItem)

    Object.assign(navigator, {
      clipboard: { write },
    })

    // Mock global Image in jsdom so it triggers error and falls back to fetch
    vi.stubGlobal('Image', class {
      onload?: () => void
      onerror?: () => void
      set src(_val: string) {
        setTimeout(() => this.onerror?.(), 0)
      }
    })

    // Mock fetch for direct blob fallback in tests if canvas is unavailable in jsdom
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: () => Promise.resolve(fakeBlob),
    } as unknown as Response)

    const result = await copyImageToClipboard('http://example.com/test.png')
    expect(write).toHaveBeenCalled()
    const callArg = write.mock.calls[0][0]
    expect(callArg[0]).toBeInstanceOf(MockClipboardItem)
    expect(result).toEqual({ fallback: false, format: 'binary' })
  })

  it('falls back gracefully to HTML/text when navigator.clipboard.write is unavailable (e.g. non-secure HTTP LAN)', async () => {
    Object.assign(navigator, {
      clipboard: undefined,
    })

    // Mock document.execCommand
    const execCommand = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'copy') {
        // dispatch copy event
        const event = new Event('copy', { bubbles: true, cancelable: true }) as any
        event.clipboardData = {
          setData: vi.fn(),
        }
        document.dispatchEvent(event)
        return true
      }
      return false
    })
    document.execCommand = execCommand

    const result = await copyImageToClipboard('http://192.168.1.100:4173/sample.png')
    expect(result.fallback).toBe(true)
    expect(result.format).toBe('html')
  })

  it('falls back to text copy when execCommand copy event is not supported', async () => {
    Object.assign(navigator, {
      clipboard: undefined,
    })

    const execCommand = vi.fn().mockReturnValue(false)
    document.execCommand = execCommand

    const result = await copyImageToClipboard('http://192.168.1.100:4173/sample.png')
    expect(result.fallback).toBe(true)
    expect(result.format).toBe('text')
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('converts non-PNG image blob to PNG blob via imageToPngBlob', async () => {
    const fakeJpgBlob = new Blob(['jpg-bytes'], { type: 'image/jpeg' })
    const fakePngBlob = new Blob(['png-bytes'], { type: 'image/png' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(fakeJpgBlob),
    } as unknown as Response)

    // Mock createImageBitmap
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 100, height: 100 }))

    // Mock canvas toBlob
    const origCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const el = origCreateElement(tagName)
      if (tagName === 'canvas') {
        ;(el as HTMLCanvasElement).getContext = vi.fn().mockReturnValue({
          drawImage: vi.fn(),
        }) as any
        ;(el as HTMLCanvasElement).toBlob = (callback: (b: Blob | null) => void) => callback(fakePngBlob)
      }
      return el
    })

    const { imageToPngBlob } = await import('./clipboard')
    const converted = await imageToPngBlob('http://example.com/photo.jpg')
    expect(converted.type).toBe('image/png')
  })

  it('converts blob to Data URI via blobToDataUrl', async () => {
    const { blobToDataUrl } = await import('./clipboard')
    const blob = new Blob(['hello'], { type: 'text/plain' })
    const dataUrl = await blobToDataUrl(blob)
    expect(dataUrl).toContain('data:text/plain;base64,')
  })
})

