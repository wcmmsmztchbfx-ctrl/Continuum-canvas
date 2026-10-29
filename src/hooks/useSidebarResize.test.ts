// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSidebarResize } from './useSidebarResize'

let shell: HTMLElement
let layers: HTMLElement
let inspector: HTMLElement

beforeEach(() => {
  vi.stubGlobal('innerWidth', 900)
  shell = document.createElement('main')
  layers = document.createElement('div')
  layers.className = 'app-layer-sidebar__content'
  inspector = document.createElement('aside')
  inspector.className = 'inspector-panel'
  shell.append(layers, inspector)
  document.body.append(shell)
  vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 900))
  vi.spyOn(layers, 'getBoundingClientRect').mockReturnValue(new DOMRect(48, 0, 240, 900))
  vi.spyOn(inspector, 'getBoundingClientRect').mockReturnValue(new DOMRect(620, 0, 280, 900))
})

afterEach(() => {
  cleanup()
  shell.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function startEvent(clientX: number) {
  return { clientX, button: 0, preventDefault() {}, stopPropagation() {} } as ReactMouseEvent<HTMLDivElement>
}

describe('useSidebarResize', () => {
  it('starts a drag from the rendered width when saved preferences exceed the available space', () => {
    const persist = vi.fn()
    const { result } = renderHook(() => useSidebarResize({
      appShellRef: { current: shell }, initialLayersWidth: 2000,
      initialInspectorWidth: 560, onPersistPreferences: persist,
    }))
    act(() => result.current.startLayersResize(startEvent(288)))
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 298 })))
    expect(shell.style.getPropertyValue('--layers-sidebar-width')).toBe('250px')
    act(() => window.dispatchEvent(new MouseEvent('mouseup')))
    expect(result.current.layersWidth).toBe(250)
    expect(persist).toHaveBeenLastCalledWith({ layersWidth: 250 })
  })

  it('keeps room for both sidebars and a usable canvas while dragging either separator', () => {
    const { result } = renderHook(() => useSidebarResize({
      appShellRef: { current: shell }, initialLayersWidth: 240,
      initialInspectorWidth: 280, onPersistPreferences: vi.fn(),
    }))
    act(() => result.current.startLayersResize(startEvent(288)))
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1000 })))
    expect(Number.parseFloat(shell.style.getPropertyValue('--layers-sidebar-width'))).toBeLessThanOrEqual(352)
    act(() => window.dispatchEvent(new MouseEvent('mouseup')))
    act(() => result.current.startInspectorResize(startEvent(620)))
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 })))
    expect(Number.parseFloat(shell.style.getPropertyValue('--inspector-sidebar-width'))).toBeLessThanOrEqual(392)
  })

  it('removes drag listeners on unmount without persisting a late mouse event', () => {
    const persist = vi.fn()
    const hook = renderHook(() => useSidebarResize({
      appShellRef: { current: shell }, initialLayersWidth: 240,
      initialInspectorWidth: 280, onPersistPreferences: persist,
    }))
    act(() => hook.result.current.startLayersResize(startEvent(288)))
    hook.unmount()
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 })))
    act(() => window.dispatchEvent(new MouseEvent('mouseup')))
    expect(shell.style.getPropertyValue('--layers-sidebar-width')).toBe('')
    expect(persist).not.toHaveBeenCalled()
  })
})
