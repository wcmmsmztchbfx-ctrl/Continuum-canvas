import { describe, expect, it } from 'vitest'
import { getCanvasMediaDemand, chooseMediaVariant, createCanvasMediaDemand } from './canvasMediaDemand'
import { createCanvasContentIndex } from '../../model/canvasContentIndex'
import type { CanvasNode } from '../../model/project'
const viewport = { x: -200, y: -100, zoom: 1 }
const stage = { width: 800, height: 600 }
describe('canvas media demand', () => {
  it('uses stage coordinates and retains only the release ring', () => {
    const bounds = { x: 300, y: 200, width: 100, height: 100 }
    expect(getCanvasMediaDemand(bounds, viewport, stage, false, 'none')).toBe('visible')
    expect(getCanvasMediaDemand({ ...bounds, x: 1400 }, viewport, stage, false, 'none')).toBe('none')
    expect(getCanvasMediaDemand({ ...bounds, x: 1400 }, viewport, stage, false, 'visible')).toBe('background')
    expect(getCanvasMediaDemand({ ...bounds, x: 5000 }, viewport, stage, true, 'none')).toBe('active')
  })
  it('selects pixel density with hysteresis and caps DPR', () => {
    expect(chooseMediaVariant(100, 1, 3)).toBe(360)
    expect(chooseMediaVariant(380, 1, 1, 360)).toBe(360)
    expect(chooseMediaVariant(500, 1, 1, 360)).toBe(960)
    expect(chooseMediaVariant(1800, 1, 2)).toBe('original')
  })
  it('leaves 108 distant media nodes without demand and notifies only changes', () => {
    const nodes = Array.from({ length: 120 }, (_, i) => ({
      id: String(i), type: 'image', name: String(i), position: { x: i < 12 ? i * 40 : 10000 + i * 40, y: 0 },
      size: { width: 30, height: 30 }, data: { url: '/' + i },
    })) as CanvasNode[]
    const manager = createCanvasMediaDemand(createCanvasContentIndex(nodes, []))
    manager.update({ x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 }, true)
    expect(nodes.filter(n => manager.get(n.id).demand !== 'none')).toHaveLength(12)
    let notifications = 0
    const off = manager.subscribe('0', () => notifications++)
    manager.update({ x: 1, y: 0, zoom: 1 }, { width: 800, height: 600 }, false)
    expect(notifications).toBe(0)
    off()
  })
})
