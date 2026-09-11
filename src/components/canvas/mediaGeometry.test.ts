import { describe, expect, it } from 'vitest'

import {
  materiallyDifferentRatio,
  ratioStringFromDimensions,
  resizeAroundCenter,
  sizeForAspectRatio,
} from './mediaGeometry'

describe('media aspect-ratio geometry', () => {
  it.each([
    ['16:9', { width: 480, height: 270 }],
    ['9:16', { width: 270, height: 480 }],
    ['1:1', { width: 360, height: 360 }],
    ['3:4', { width: 312, height: 416 }],
    ['4:3', { width: 416, height: 312 }],
  ])('maps %s to a stable visual area', (ratio, expected) => {
    expect(sizeForAspectRatio(ratio)).toEqual(expected)
  })

  it('bounds extreme ratios without changing the center', () => {
    const size = sizeForAspectRatio('100:1')
    expect(size.width).toBeLessThanOrEqual(640)
    expect(size.height).toBeGreaterThanOrEqual(120)

    expect(resizeAroundCenter(
      { x: 100, y: 200 },
      { width: 480, height: 270 },
      { width: 270, height: 480 },
    )).toEqual({
      position: { x: 205, y: 95 },
      size: { width: 270, height: 480 },
    })
  })

  it('resolves standard aspect ratio strings from dimensions', () => {
    expect(ratioStringFromDimensions(864, 1152)).toBe('3:4')
    expect(ratioStringFromDimensions(768, 1024)).toBe('3:4')
    expect(ratioStringFromDimensions(1920, 1080)).toBe('16:9')
    expect(ratioStringFromDimensions(1080, 1920)).toBe('9:16')
    expect(ratioStringFromDimensions(1024, 1024)).toBe('1:1')
  })

  it('correctly checks materially different ratio for adaptive and fixed ratios', () => {
    expect(materiallyDifferentRatio('adaptive', 864, 1152)).toBe(true)
    expect(materiallyDifferentRatio('3:4', 864, 1152)).toBe(false)
    expect(materiallyDifferentRatio('1:1', 864, 1152)).toBe(true)
  })
})
