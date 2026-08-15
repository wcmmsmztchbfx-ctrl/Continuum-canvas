// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentSidebarPanel } from './AgentSidebarPanel'

describe('AgentSidebarPanel', () => {
  afterEach(cleanup)

  it('renders agent shell with suggested prompts and input box', () => {
    const onNotify = vi.fn()
    render(<AgentSidebarPanel onNotify={onNotify} />)

    expect(screen.getByText('Agent 智能助手')).toBeInTheDocument()
    expect(screen.getByText('自动排版画布')).toBeInTheDocument()

    const taskBtn = screen.getByRole('button', { name: /自动排版画布/ })
    fireEvent.click(taskBtn)

    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining('自动排版画布'),
      'info',
    )
  })
})
