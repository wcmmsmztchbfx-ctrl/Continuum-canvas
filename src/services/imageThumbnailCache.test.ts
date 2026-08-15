// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  calculateImageLod,
  getFastThumbnailUrl,
  getLodImageUrl,
  getResponsiveImageUrl,
  getVideoPosterUrl,
} from './imageThumbnailCache'

describe('zoom-based responsive image & video poster loading', () => {
  const cdnImageUrl = 'https://libtv-res.liblib.art/upload-images/abc/image.png'
  const cdnVideoUrl = 'https://libtv-res.liblib.art/upload-images/abc/video.mp4'

  describe('getResponsiveImageUrl (pure zoom-based)', () => {
    it('returns original image URL when zoom > 1.5', () => {
      expect(getResponsiveImageUrl(cdnImageUrl, 1.6)).toBe(cdnImageUrl)
      expect(getResponsiveImageUrl(cdnImageUrl, 2.0)).toBe(cdnImageUrl)
    })

    it('returns webp format with w_960 when zoom <= 1.5 and > 0.35', () => {
      expect(getResponsiveImageUrl(cdnImageUrl, 1.0)).toBe(
        'https://libtv-res.liblib.art/upload-images/abc/image.png?x-oss-process=image/resize,w_960/format,webp',
      )
      expect(getResponsiveImageUrl(cdnImageUrl, 0.5)).toBe(
        'https://libtv-res.liblib.art/upload-images/abc/image.png?x-oss-process=image/resize,w_960/format,webp',
      )
    })

    it('returns webp format with w_360 thumbnail when zoom <= 0.35', () => {
      expect(getResponsiveImageUrl(cdnImageUrl, 0.2)).toBe(
        'https://libtv-res.liblib.art/upload-images/abc/image.png?x-oss-process=image/resize,w_360/format,webp',
      )
    })

    it('preserves non-CDN URLs without modification', () => {
      expect(getResponsiveImageUrl('/api/assets/1234', 0.5)).toBe('/api/assets/1234')
      expect(getResponsiveImageUrl('blob:http://localhost/5678', 2.0)).toBe('blob:http://localhost/5678')
    })
  })

  describe('getVideoPosterUrl (pure zoom-based)', () => {
    it('returns high-resolution snapshot when zoom > 1.5', () => {
      expect(getVideoPosterUrl(cdnVideoUrl, undefined, 2.0)).toBe(
        'https://libtv-res.liblib.art/upload-images/abc/video.mp4?x-oss-process=video/snapshot,t_500,f_jpg',
      )
    })

    it('returns compressed fast snapshot when zoom <= 1.5 and > 0.35', () => {
      expect(getVideoPosterUrl(cdnVideoUrl, undefined, 1.0)).toBe(
        'https://libtv-res.liblib.art/upload-images/abc/video.mp4?x-oss-process=video/snapshot,t_500,f_jpg,w_960,m_fast',
      )
    })

    it('returns thumbnail fast snapshot when zoom <= 0.35', () => {
      expect(getVideoPosterUrl(cdnVideoUrl, undefined, 0.2)).toBe(
        'https://libtv-res.liblib.art/upload-images/abc/video.mp4?x-oss-process=video/snapshot,t_500,f_jpg,w_360,m_fast',
      )
    })
  })

  describe('calculateImageLod and getFastThumbnailUrl', () => {
    it('calculates LOD purely by zoom', () => {
      expect(calculateImageLod(600, 400, 2.0)).toBe('original')
      expect(calculateImageLod(600, 400, 1.0)).toBe('medium')
      expect(calculateImageLod(600, 400, 0.2)).toBe('thumbnail')
    })

    it('returns fast thumbnail for CDN images', () => {
      expect(getFastThumbnailUrl(cdnImageUrl)).toBe(
        'https://libtv-res.liblib.art/upload-images/abc/image.png?x-oss-process=image/resize,w_360/format,webp',
      )
    })
  })
})
