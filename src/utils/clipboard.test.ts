import { describe, expect, it, vi, beforeEach } from 'vitest'
import { copyImageToClipboard, copyText, imageToPngBlob } from './clipboard'

describe('clipboard utils', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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

    // Mock fetch for direct blob fallback in tests if canvas is unavailable in jsdom
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: () => Promise.resolve(fakeBlob),
    } as unknown as Response)

    await copyImageToClipboard('http://example.com/test.png')
    expect(write).toHaveBeenCalled()
    const callArg = write.mock.calls[0][0]
    expect(callArg[0]).toBeInstanceOf(MockClipboardItem)
  })
})
