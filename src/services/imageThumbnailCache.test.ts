// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  calculateImageLod,
  getFastThumbnailUrl,
  getResponsiveImageUrl,
  getVideoPosterUrl,
} from './imageThumbnailCache'

describe('zoom-based responsive image & video poster loading', () => {
  const cdnImageUrl = 'https://libtv-res.liblib.art/upload-images/abc/image.png'
  const cdnVideoUrl = 'https://libtv-res.liblib.art/upload-images/abc/video.mp4'

  describe('CDN URL boundaries', () => {
    it.each([
      'https://libtv-res.liblib.art.evil.example/image.png',
      'https://evil-libtv-res.liblib.art/image.png',
      'https://bucket.aliyuncs.com.evil.example/image.png',
      'https://notaliyuncs.com/image.png',
      'https://evil.example/libtv-res.liblib.art/image.png',
      'https://evil.example/bucket.aliyuncs.com/image.png',
      'https://evil.example/image.png?source=https://libtv-res.liblib.art/image.png',
      'https://evil.example/image.png?source=https://bucket.aliyuncs.com/image.png',
      'https://libtv-res.liblib.art@evil.example/image.png',
      'blob:https://libtv-res.liblib.art/image-id',
      'data:image/svg+xml,libtv-res.liblib.art',
      'not a URL .aliyuncs.com',
    ])('does not apply CDN transforms to %s', (url) => {
      expect(getResponsiveImageUrl(url, 0.2)).toBe(url)
      expect(getFastThumbnailUrl(url)).toBeUndefined()
      expect(getVideoPosterUrl(url, undefined, 0.2)).toBeUndefined()
    })

    it.each([
      'https://LIBTV-RES.LIBLIB.ART/image.png',
      'https://bucket.oss-cn-hangzhou.aliyuncs.com/image.png',
    ])('applies transforms to the parsed CDN hostname in %s', (url) => {
      expect(getResponsiveImageUrl(url, 0.2)).toBe(`${url}?x-oss-process=image/resize,w_360/format,webp`)
      expect(getFastThumbnailUrl(url)).toBe(`${url}?x-oss-process=image/resize,w_360/format,webp`)
      expect(getVideoPosterUrl(url, undefined, 0.2)).toBe(`${url}?x-oss-process=video/snapshot,t_500,f_jpg,w_360,m_fast`)
    })

    it('preserves signed query bytes and adds transforms before the fragment', () => {
      const url = 'https://bucket.aliyuncs.com/image.png?Signature=a%2Bb%2Fc%3D&Expires=123#frame'
      expect(getResponsiveImageUrl(url, 0.2)).toBe('https://bucket.aliyuncs.com/image.png?Signature=a%2Bb%2Fc%3D&Expires=123&x-oss-process=image/resize,w_360/format,webp#frame')
      expect(getFastThumbnailUrl(url)).toBe('https://bucket.aliyuncs.com/image.png?Signature=a%2Bb%2Fc%3D&Expires=123&x-oss-process=image/resize,w_360/format,webp#frame')
      expect(getVideoPosterUrl(url, undefined, 0.2)).toBe('https://bucket.aliyuncs.com/image.png?Signature=a%2Bb%2Fc%3D&Expires=123&x-oss-process=video/snapshot,t_500,f_jpg,w_360,m_fast#frame')
    })

    it('preserves existing OSS transforms and explicit preview URLs', () => {
      const url = 'https://bucket.aliyuncs.com/image.png?x-oss-process=image%2Fresize%2Cw_128&Signature=a%2Bb'
      expect(getResponsiveImageUrl(url, 0.2)).toBe(url)
      expect(getFastThumbnailUrl(url)).toBeUndefined()
      expect(getVideoPosterUrl(url)).toBeUndefined()
      expect(getFastThumbnailUrl(cdnImageUrl, 'blob:https://example.com/preview')).toBe('blob:https://example.com/preview')
      expect(getVideoPosterUrl(cdnVideoUrl, 'data:image/png;base64,AA==')).toBe('data:image/png;base64,AA==')
    })
  })

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
