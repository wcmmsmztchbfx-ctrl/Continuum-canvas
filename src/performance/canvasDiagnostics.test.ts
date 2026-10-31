import { describe, expect, it } from 'vitest'
import { createCanvasDiagnostics } from './canvasDiagnostics'
import { resolveCanvasPerformanceFlags } from './canvasPerformanceFlags'

describe('canvas diagnostics', () => {
  it('does not retain disabled counters or share enabled session state', () => {
    const off = createCanvasDiagnostics(false)
    const first = createCanvasDiagnostics(true)
    const second = createCanvasDiagnostics(true)
    off.increment('private-resource')
    first.increment('projection.nodes', 12)
    expect(off.snapshot()).toEqual({})
    expect(second.snapshot()).toEqual({})
    expect(first.snapshot()).toEqual({ 'projection.nodes': 12 })
    first.reset()
    expect(first.snapshot()).toEqual({})
  })
  it('rejects optimizations whose runtime dependencies are disabled', () => {
    expect(() => resolveCanvasPerformanceFlags({ mediaDemand: true, runtimeViewport: false })).toThrow()
    expect(() => resolveCanvasPerformanceFlags({ scopedZoomUi: true, runtimeViewport: false })).toThrow()
    expect(resolveCanvasPerformanceFlags({ indexedProjection: true }).indexedProjection).toBe(true)
  })
})
