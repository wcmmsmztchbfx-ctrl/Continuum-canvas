// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquirePreview, storePreview, clearIdlePreviews, cacheThumbnailFromElement, getVideoPosterUrl } from './imageThumbnailCache'
afterEach(() => { clearIdlePreviews(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('derived preview ownership', () => {
  it('never revokes a live preview and releases idempotently', () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() })
    const first = storePreview('live', new Blob(['pixels']), { width: 100, height: 100 })
    const second = acquirePreview('live')!
    first.release(); first.release(); clearIdlePreviews()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(second.url).toBe('blob:preview')
    second.release(); clearIdlePreviews()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })
  it('encodes once when 20 consumers request the same preview', async () => {
    const draw = vi.fn(), encode = vi.fn((callback: BlobCallback) => callback(null))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(encode)
    const image = document.createElement('img')
    Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 600 } })
    for (let i = 0; i < 20; i++) cacheThumbnailFromElement('/twenty.png', image)
    await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(1))
  })
  it('poster lookup is pure and never creates a video', () => {
    const create = vi.spyOn(document, 'createElement')
    expect(getVideoPosterUrl('/local.mp4')).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
  })
})
