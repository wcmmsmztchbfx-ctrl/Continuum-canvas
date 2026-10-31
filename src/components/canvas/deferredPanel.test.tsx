// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { createDeferredPanel } from './deferredPanel'
afterEach(cleanup)
it('preserves the first loaded editor instance and draft across parent updates', async () => {
  const mounted = vi.fn()
  function Editor({ label }: { label: string }) {
    const [draft, setDraft] = useState('initial')
    useEffect(mounted, [])
    return <input aria-label={label} value={draft} onChange={event => setDraft(event.target.value)} />
  }
  const Panel = createDeferredPanel('editor', async () => ({ default: Editor })).Component
  const view = render(<Panel label="first" />)
  fireEvent.change(await screen.findByLabelText('first'), { target: { value: 'draft' } })
  view.rerender(<Panel label="second" />)
  expect(screen.getByLabelText('second')).toHaveProperty('value', 'draft')
  expect(mounted).toHaveBeenCalledTimes(1)
})
it('loads only when mounted and retries a failed module locally', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const loader = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({ default: () => <input defaultValue="保留的提示词" /> })
  const panel = createDeferredPanel('工具', loader)
  expect(loader).not.toHaveBeenCalled()
  const Panel = panel.Component
  render(<Panel />)
  fireEvent.click(await screen.findByRole('button', { name: '重试加载' }))
  expect(await screen.findByDisplayValue('保留的提示词')).toBeTruthy()
  expect(loader).toHaveBeenCalledTimes(2)
  vi.restoreAllMocks()
})
