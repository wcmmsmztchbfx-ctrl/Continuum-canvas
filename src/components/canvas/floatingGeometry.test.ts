import { describe, expect, it } from 'vitest'

import { correctViewportOverflow, placeFloatingRect } from './floatingGeometry'

describe('placeFloatingRect', () => {
  it('flips above an anchor when the bottom dock would cover the panel', () => {
    expect(placeFloatingRect({
      anchor: { left: 1180, right: 1280, top: 650, bottom: 680 },
      floating: { width: 342, height: 448 },
      viewport: { width: 1366, height: 768 },
      preferred: 'below',
    })).toEqual({ left: 1016, top: 194, placement: 'above' })
  })

  it('clamps both axes inside topbar and dock safe areas', () => {
    expect(placeFloatingRect({
      anchor: { left: -40, right: 20, top: 20, bottom: 50 },
      floating: { width: 360, height: 620 },
      viewport: { width: 1366, height: 768 },
      preferred: 'above',
    })).toEqual({ left: 8, top: 70, placement: 'below' })
  })
})

describe('correctViewportOverflow', () => {
  it('moves a panel away from the right edge and bottom dock', () => {
    expect(correctViewportOverflow(
      { left: 900, right: 1500, top: 420, bottom: 760 },
      { width: 1366, height: 768 },
    )).toEqual({ x: -142, y: -68 })
  })

  it('moves a panel below the topbar and inside the left edge', () => {
    expect(correctViewportOverflow(
      { left: -50, right: 550, top: 20, bottom: 360 },
      { width: 1440, height: 900 },
    )).toEqual({ x: 58, y: 50 })
  })
})
