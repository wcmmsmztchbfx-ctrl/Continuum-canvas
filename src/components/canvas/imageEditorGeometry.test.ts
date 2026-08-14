import { describe, expect, it } from 'vitest'

import { calculateImageEditorGeometry } from './imageEditorGeometry'

describe('image editor geometry', () => {
  it.each([
    ['large landscape', 3000, 1500, undefined, 0, { width: 1400, height: 700 }],
    ['large portrait', 1500, 3000, undefined, 0, { width: 700, height: 1400 }],
    ['small image', 800, 600, undefined, 0, { width: 800, height: 600 }],
    ['rotated landscape', 3000, 1500, undefined, 90, { width: 700, height: 1400 }],
    ['cropped landscape', 3000, 2000, 16 / 9, 0, { width: 1400, height: 788 }],
  ])('preserves the core ratio for %s', (_name, naturalWidth, naturalHeight, targetRatio, rotation, expected) => {
    const geometry = calculateImageEditorGeometry({
      naturalWidth,
      naturalHeight,
      targetRatio,
      rotation,
    })

    expect(geometry.canvas).toEqual(expected)
  })
})
