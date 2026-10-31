export interface CanvasPerformanceFlags {
  indexedProjection: boolean
  runtimeViewport: boolean
  scopedZoomUi: boolean
  mediaDemand: boolean
  virtualLayers: boolean
  backgroundScheduling: boolean
}
export function resolveCanvasPerformanceFlags(overrides: Partial<CanvasPerformanceFlags> = {}): CanvasPerformanceFlags {
  const flags = { indexedProjection: true, runtimeViewport: true, scopedZoomUi: true,
    mediaDemand: true, virtualLayers: true, backgroundScheduling: true, ...overrides }
  if (Object.values(flags).some(value => typeof value !== 'boolean')) throw new Error('Performance switches must be booleans')
  if ((flags.scopedZoomUi || flags.mediaDemand) && !flags.runtimeViewport) {
    throw new Error('Viewport optimizations require the viewport runtime')
  }
  if (flags.virtualLayers && !flags.mediaDemand) throw new Error('Virtual layers require media demand')
  if (flags.backgroundScheduling && !flags.mediaDemand) throw new Error('Background scheduling requires media demand')
  return Object.freeze(flags)
}
function readOverrides(): Partial<CanvasPerformanceFlags> {
  try { return JSON.parse(globalThis.localStorage?.getItem('continuum.performance-overrides') ?? '{}') } catch { return {} }
}
export const canvasPerformanceFlags = (() => {
  try { return resolveCanvasPerformanceFlags(readOverrides()) } catch { return resolveCanvasPerformanceFlags() }
})()
