import { describe, expect, it } from 'vitest'
import { createCanvasViewportRuntime } from './canvasViewportRuntime'
describe('runtime camera ownership', () => {
  it('does not persist followed camera and compensates both coordinate spaces independently', () => {
    const camera = createCanvasViewportRuntime({ x: 100, y: 80, zoom: 0.5 })
    camera.set({ x: 900, y: 700, zoom: 2 }, 'follow')
    camera.compensateLayout(288, 12)
    expect(camera.getDisplay()).toEqual({ x: 612, y: 688, zoom: 2 })
    expect(camera.getLocal()).toEqual({ x: -188, y: 68, zoom: 0.5 })
    camera.set({ x: 600, y: 650, zoom: 2 }, 'local')
    expect(camera.getLocal()).toEqual(camera.getDisplay())
  })
  it('does not notify unchanged or disposed cameras', () => {
    const camera = createCanvasViewportRuntime({ x: 0, y: 0, zoom: 1 })
    let notifications = 0
    const unsubscribe = camera.subscribe(() => notifications++)
    camera.set({ x: 0, y: 0, zoom: 1 }, 'local')
    expect(notifications).toBe(0)
    camera.set({ x: 20, y: 0, zoom: 1 }, 'local')
    expect(notifications).toBe(1)
    unsubscribe()
    camera.dispose()
    camera.set({ x: 30, y: 0, zoom: 1 }, 'local')
    expect(notifications).toBe(1)
  })
})
