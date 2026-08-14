import { describe, expect, it, vi } from 'vitest'

import { persistLocalMedia } from './localMedia'

describe('persistLocalMedia', () => {
  it('uploads the original blob and returns only a stable local asset reference', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'frame.png', {
      type: 'image/png',
    })
    const uploadAsset = vi.fn(async () => ({
      id: '11111111-1111-4111-8111-111111111111',
      filename: 'frame.png',
      contentType: 'image/png',
      size: 3,
      url: '/api/assets/11111111-1111-4111-8111-111111111111',
      createdAt: '2026-07-16T00:00:00.000Z',
    }))

    await expect(persistLocalMedia(file, { uploadAsset })).resolves.toEqual({
      assetId: '11111111-1111-4111-8111-111111111111',
      url: '/api/assets/11111111-1111-4111-8111-111111111111',
    })
    expect(uploadAsset).toHaveBeenCalledWith(file, 'frame.png')
    expect(uploadAsset.mock.calls[0]?.[0]).toBe(file)
  })

  it('rejects an uploader response that could persist a remote URL', async () => {
    const file = new File(['x'], 'frame.png', { type: 'image/png' })
    const uploadAsset = vi.fn(async () => ({
      id: '22222222-2222-4222-8222-222222222222',
      url: 'https://unsafe.example/result.png',
    }))

    await expect(persistLocalMedia(file, { uploadAsset })).rejects.toThrow(
      'stable local asset',
    )
  })
})
