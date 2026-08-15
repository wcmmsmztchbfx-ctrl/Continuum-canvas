// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  calculateImageLod,
  getFastThumbnailUrl,
  getLodImageUrl,
} from './imageThumbnailCache'

describe('image LOD and responsive specs', () => {
  describe('calculateImageLod', () => {
    it('returns thumbnail tier when zoomed out (zoom <= 0.35) or when effective width <= 240px', () => {
      expect(calculateImageLod(600, 400, 0.2)).toBe('thumbnail')
      expect(calculateImageLod(600, 400, 0.35)).toBe('thumbnail')
      expect(calculateImageLod(200, 150, 0.5)).toBe('thumbnail')
    })

    it('returns medium tier for standard viewport zoom (0.35 < zoom <= 0.75 or effective width <= 720px)', () => {
      expect(calculateImageLod(600, 400, 0.6)).toBe('medium')
      expect(calculateImageLod(600, 400, 0.75)).toBe('medium')
    })

    it('returns high tier for 1:1 view (720px < effective width <= 1440px)', () => {
      expect(calculateImageLod(1000, 600, 1.0)).toBe('high')
      expect(calculateImageLod(1200, 800, 1.0)).toBe('high')
    })

    it('returns original tier when zoomed in close (effective width > 1440px or zoom >= 1.5)', () => {
      expect(calculateImageLod(1200, 800, 1.5)).toBe('original')
      expect(calculateImageLod(1920, 1080, 1.0)).toBe('original')
    })
  })

  describe('getLodImageUrl', () => {
    const cdnUrl = 'https://libtv-res.liblib.art/upload-images/abc/image.png'

    it('generates w_360 webp query for thumbnail tier', () => {
      const url = getLodImageUrl(cdnUrl, 'thumbnail')
      expect(url).toBe('https://libtv-res.liblib.art/upload-images/abc/image.png?x-oss-process=image/resize,w_360/format,webp')
    })

    it('generates w_720 webp query for medium tier', () => {
      const url = getLodImageUrl(cdnUrl, 'medium')
      expect(url).toBe('https://libtv-res.liblib.art/upload-images/abc/image.png?x-oss-process=image/resize,w_720/format,webp')
    })

    it('generates w_1440 webp query for high tier', () => {
      const url = getLodImageUrl(cdnUrl, 'high')
      expect(url).toBe('https://libtv-res.liblib.art/upload-images/abc/image.png?x-oss-process=image/resize,w_1440/format,webp')
    })

    it('generates format,webp for original tier', () => {
      const url = getLodImageUrl(cdnUrl, 'original')
      expect(url).toBe('https://libtv-res.liblib.art/upload-images/abc/image.png?x-oss-process=image/format,webp')
    })

    it('preserves non-CDN URLs without modification', () => {
      expect(getLodImageUrl('/api/assets/1234', 'medium')).toBe('/api/assets/1234')
      expect(getLodImageUrl('blob:http://localhost/5678', 'high')).toBe('blob:http://localhost/5678')
    })
  })

  describe('getFastThumbnailUrl', () => {
    it('returns fast 360px webp thumbnail for CDN images', () => {
      const url = getFastThumbnailUrl('https://libtv-res.liblib.art/upload/photo.png')
      expect(url).toBe('https://libtv-res.liblib.art/upload/photo.png?x-oss-process=image/resize,w_360/format,webp')
    })

    it('returns explicit thumbnail if provided', () => {
      const url = getFastThumbnailUrl('https://example.com/orig.png', 'https://example.com/thumb.webp')
      expect(url).toBe('https://example.com/thumb.webp')
    })
  })
})
