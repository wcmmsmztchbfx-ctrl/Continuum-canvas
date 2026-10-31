import { describe, expect, it } from 'vitest'
import { getLayerWindow } from './layerWindow'
describe('layer window', () => {
  it('mounts visible rows plus overscan and unique pinned rows', () => {
    expect(getLayerWindow(1000, 4000, 400, [0, 100, 999, 999])).toEqual({ start: 92, end: 118, pinned: [0, 999] })
  })
  it('clamps stale scroll after filtering and handles a closed list', () => {
    expect(getLayerWindow(3, 4000, 400, [])).toEqual({ start: 0, end: 3, pinned: [] })
    expect(getLayerWindow(0, 4000, 0, [])).toEqual({ start: 0, end: 0, pinned: [] })
  })
})
