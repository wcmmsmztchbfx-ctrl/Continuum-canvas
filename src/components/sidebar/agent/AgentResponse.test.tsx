// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentResponse } from './AgentResponse'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
describe('progressive Agent answer presentation', () => {
  it('appends continued answers without replaying visible text, and does not replay after motion preference changes', () => {
    vi.useFakeTimers()
    let reduced = false; const listeners = new Set<() => void>()
    vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced }, addEventListener(_name: string, listener: () => void) { listeners.add(listener) }, removeEventListener(_name: string, listener: () => void) { listeners.delete(listener) } }))
    const view = render(<AgentResponse text="你好" animate />)
    act(() => { vi.advanceTimersByTime(40) })
    view.rerender(<AgentResponse text="你好世界" animate />)
    expect(view.container.querySelector('[data-agent-visible-text]')!.textContent).toBe('你好')
    act(() => { vi.advanceTimersByTime(20) })
    expect(view.container.querySelector('[data-agent-visible-text]')!.textContent).toBe('你好世')
    act(() => { reduced = true; listeners.forEach(listener => listener()) })
    expect(screen.getByText('你好世界')).toBeInTheDocument()
    act(() => { reduced = false; listeners.forEach(listener => listener()) })
    expect(view.container.querySelector('[data-agent-visible-text]')!.textContent).toBe('你好世界')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('reveals new answers progressively without splitting Unicode characters and can show all immediately', () => {
    vi.useFakeTimers()
    const progress = vi.fn(); const { container } = render(<AgentResponse text="你好👨‍👩‍👧‍👦，画布操作已完成。" animate onProgress={progress} />)
    const visible = container.querySelector('[data-agent-visible-text]')!
    expect(visible.textContent).toBe('')
    act(() => { vi.advanceTimersByTime(40) })
    expect(visible.textContent).toBe('你好')
    act(() => { vi.advanceTimersByTime(20) })
    expect(visible.textContent).toBe('你好👨‍👩‍👧‍👦')
    fireEvent.click(screen.getByRole('button', { name: '显示全文' }))
    expect(visible.textContent).toBe('你好👨‍👩‍👧‍👦，画布操作已完成。')
    expect(screen.queryByRole('button', { name: '显示全文' })).not.toBeInTheDocument()
    expect(progress).toHaveBeenCalled()
  })
  it('shows history and reduced-motion answers immediately and clears animation on unmount', () => {
    vi.useFakeTimers()
    const old = render(<AgentResponse text="历史完整回答" />)
    expect(screen.getByText('历史完整回答')).toBeInTheDocument(); old.unmount()
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    const next = render(<AgentResponse text="减少动画" animate />)
    expect(screen.getByText('减少动画')).toBeInTheDocument()
    next.unmount(); expect(vi.getTimerCount()).toBe(0)
  })
  it('does not repeat an animation on rerenders and bounds long-answer playback time', () => {
    vi.useFakeTimers()
    const text = '长'.repeat(12000)
    const view = render(<AgentResponse text={text} animate />)
    act(() => { vi.advanceTimersByTime(200) })
    const first = view.container.querySelector('[data-agent-visible-text]')!.textContent!.length
    view.rerender(<AgentResponse text={text} animate />)
    expect(view.container.querySelector('[data-agent-visible-text]')!.textContent!.length).toBe(first)
    act(() => { vi.advanceTimersByTime(8000) })
    expect(view.container.querySelector('[data-agent-visible-text]')!.textContent).toBe(text)
    expect(vi.getTimerCount()).toBe(0)
  })
})
