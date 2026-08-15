import { describe, expect, it, vi } from 'vitest'

import {
  persistLocalMedia,
  transcodeImageToWebP,
  uploadAndPrepareMediaAsset,
} from './localMedia'

describe('localMedia service', () => {
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

  describe('transcodeImageToWebP', () => {
    it('preserves webp files without re-encoding', async () => {
      const webpFile = new File(['mock-webp'], 'photo.webp', {
        type: 'image/webp',
      })
      const result = await transcodeImageToWebP(webpFile)
      expect(result.file).toBe(webpFile)
      expect(result.wasTranscoded).toBe(false)
    })

    it('preserves gif files to keep animations intact', async () => {
      const gifFile = new File(['mock-gif'], 'animation.gif', {
        type: 'image/gif',
      })
      const result = await transcodeImageToWebP(gifFile)
      expect(result.file).toBe(gifFile)
      expect(result.wasTranscoded).toBe(false)
    })
  })

  describe('uploadAndPrepareMediaAsset', () => {
    it('processes image uploads and saves through uploader', async () => {
      const file = new File(['mock-png'], 'artwork.png', {
        type: 'image/png',
      })
      const uploader = {
        uploadAsset: vi.fn(async (blob: Blob, filename: string) => ({
          id: '33333333-3333-4333-8333-333333333333',
          filename,
          contentType: blob.type,
          size: blob.size,
          url: '/api/assets/33333333-3333-4333-8333-333333333333',
        })),
      }

      const result = await uploadAndPrepareMediaAsset(file, uploader)
      expect(result.kind).toBe('image')
      expect(result.assetId).toBe('33333333-3333-4333-8333-333333333333')
      expect(result.url).toBe('/api/assets/33333333-3333-4333-8333-333333333333')
      expect(result.width).toBeGreaterThan(0)
      expect(result.height).toBeGreaterThan(0)
      expect(uploader.uploadAsset).toHaveBeenCalled()
    })

    it('falls back gracefully to object URL if upload fails', async () => {
      const file = new File(['mock-png'], 'failed.png', {
        type: 'image/png',
      })
      const uploader = {
        uploadAsset: vi.fn(async () => {
          throw new Error('Network error')
        }),
      }

      const result = await uploadAndPrepareMediaAsset(file, uploader)
      expect(result.kind).toBe('image')
      expect(result.assetId).toBeUndefined()
      expect(result.url).toContain('blob:')
    })
  })
})
