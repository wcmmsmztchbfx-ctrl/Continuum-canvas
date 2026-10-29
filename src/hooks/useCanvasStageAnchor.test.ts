// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { canvasStore } from '../store/canvas-store'
import { useCanvasStageAnchor } from './useCanvasStageAnchor'

let resizeCallback: ResizeObserverCallback
let rect: DOMRect
let stage: HTMLElement
let shell: HTMLElement
const disconnect = vi.fn()

function moveStage(x: number, y = 0, width = 900) {
  rect = new DOMRect(x, y, width, 900)
  act(() => resizeCallback([], {} as ResizeObserver))
}

beforeEach(() => {
  canvasStore.getState().restore(JSON.stringify({
    version: 1, projectId: 'anchor-test', name: 'Anchor',
    viewport: { x: 100, y: 80, zoom: 0.5 }, nodes: [], edges: [],
  }))
  rect = new DOMRect(0, 0, 1440, 900)
  shell = document.createElement('main')
  stage = document.createElement('section')
  shell.append(stage)
  document.body.append(shell)
  vi.spyOn(stage, 'getBoundingClientRect').mockImplementation(() => rect)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback }
    observe() {}
    disconnect = disconnect
  })
  disconnect.mockClear()
})

afterEach(() => {
  cleanup()
  shell.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useCanvasStageAnchor', () => {
  it('compensates the actual stage origin in CSS pixels without changing zoom or undo history', () => {
    renderHook(() => useCanvasStageAnchor({ current: stage }, true))
    moveStage(288, 12, 872)

    expect(canvasStore.getState().snapshot.viewport).toEqual({ x: -188, y: 68, zoom: 0.5 })
    expect(canvasStore.getState().canUndo).toBe(false)
    moveStage(0, 0, 1440)
    expect(canvasStore.getState().snapshot.viewport).toEqual({ x: 100, y: 80, zoom: 0.5 })
  })

  it('tracks consecutive drag frames and keeps a user pan made between measurements', () => {
    renderHook(() => useCanvasStageAnchor({ current: stage }, true))
    moveStage(288)
    moveStage(322.5)
    act(() => canvasStore.getState().setViewport({ x: -202.5, y: 95, zoom: 0.5 }))
    moveStage(405.25)
    moveStage(351.75)

    expect(canvasStore.getState().snapshot.viewport).toEqual({ x: -231.75, y: 95, zoom: 0.5 })
    moveStage(351.75, 0, 350)
    expect(canvasStore.getState().snapshot.viewport).toEqual({ x: -231.75, y: 95, zoom: 0.5 })
  })

  it('does not translate the canvas when overlay sidebars or right-side resizing leave the origin unchanged', () => {
    renderHook(() => useCanvasStageAnchor({ current: stage }, true))
    moveStage(0, 0, 640)
    moveStage(0, 0, 400)
    expect(canvasStore.getState().snapshot.viewport).toEqual({ x: 100, y: 80, zoom: 0.5 })
  })

  it('uses a fresh baseline after loading and ignores hidden zero-sized stages', () => {
    const ref = { current: stage }
    const hook = renderHook(({ enabled }) => useCanvasStageAnchor(ref, enabled), {
      initialProps: { enabled: false },
    })
    rect = new DOMRect(288, 0, 872, 900)
    hook.rerender({ enabled: true })
    expect(canvasStore.getState().snapshot.viewport.x).toBe(100)
    moveStage(0, 0, 0)
    moveStage(350, 0, 700)
    expect(canvasStore.getState().snapshot.viewport.x).toBe(100)
    moveStage(370, 0, 680)
    expect(canvasStore.getState().snapshot.viewport.x).toBe(80)
  })

  it('measures position-only parent style changes even if the stage size stays the same', async () => {
    renderHook(() => useCanvasStageAnchor({ current: stage }, true))
    await act(async () => {
      rect = new DOMRect(40, 20, 1440, 900)
      shell.style.paddingLeft = '40px'
    })
    expect(canvasStore.getState().snapshot.viewport).toEqual({ x: 60, y: 60, zoom: 0.5 })
  })

  it('disconnects observers and ignores callbacks after unmount', () => {
    const hook = renderHook(() => useCanvasStageAnchor({ current: stage }, true))
    hook.unmount()
    moveStage(288)
    expect(canvasStore.getState().snapshot.viewport.x).toBe(100)
    expect(disconnect).toHaveBeenCalled()
  })
})
