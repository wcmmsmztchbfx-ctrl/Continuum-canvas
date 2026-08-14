import { describe, expect, it } from 'vitest'

import {
  resizeAroundCenter,
  sizeForAspectRatio,
} from './mediaGeometry'

describe('media aspect-ratio geometry', () => {
  it.each([
    ['16:9', { width: 480, height: 270 }],
    ['9:16', { width: 270, height: 480 }],
    ['1:1', { width: 360, height: 360 }],
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
})
