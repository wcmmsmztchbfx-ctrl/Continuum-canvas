import { describe, expect, it } from 'vitest'

import { placeSelectionToolbar, selectionUnionBounds } from './selectionGeometry'

describe('selection geometry', () => {
  it('builds one screen-space union from top-level nodes', () => {
    expect(selectionUnionBounds([
      { x: 100, y: 80, width: 200, height: 100 },
      { x: 420, y: 220, width: 160, height: 120 },
    ], { x: 10, y: 20, zoom: 0.5 })).toEqual({
      left: 60,
      top: 60,
      width: 240,
      height: 130,
    })
  })

  it('clamps a right-edge toolbar while keeping a 14px gap', () => {
    expect(placeSelectionToolbar(
      { left: 1200, top: 200, width: 300, height: 260 },
      { width: 480, height: 40 },
      { width: 1366, height: 768 },
    )).toEqual({ left: 878, top: 146, placement: 'above' })
  })

  it('moves the toolbar inside only when the topbar would cover it', () => {
    expect(placeSelectionToolbar(
      { left: 200, top: 60, width: 600, height: 400 },
      { width: 480, height: 40 },
      { width: 1440, height: 900 },
    )).toEqual({ left: 260, top: 74, placement: 'inside' })
  })

  it('keeps the toolbar above the bottom dock when the selection continues offscreen', () => {
    expect(placeSelectionToolbar(
      { left: 900, top: 900, width: 500, height: 300 },
      { width: 480, height: 40 },
      { width: 1366, height: 768 },
    )).toEqual({ left: 878, top: 652, placement: 'above' })
  })
})
