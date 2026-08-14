// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  GenerationApprovalProvider,
  useGenerationApproval,
} from './GenerationApprovalContext'

afterEach(cleanup)

function Probe({
  currentDigest,
  onGenerate,
}: {
  currentDigest: () => string
  onGenerate: (name: string, digest: string) => void
}) {
  const { requestGeneration } = useGenerationApproval()
  return (
    <>
      <button
        onClick={() =>
          requestGeneration(
            {
              providerName: 'AIStartLab', modelName: 'GPT Image 2', credits: 5,
              quote: { requestDigest: 'quote-first', request: { prompt: 'first' } },
            },
            (quote) => onGenerate('first', quote.requestDigest),
            (quote) => currentDigest() === quote.requestDigest,
          )
        }
        type="button"
      >
        第一次
      </button>
      <button
        onClick={() =>
          requestGeneration(
            {
              providerName: 'AIStartLab', modelName: 'Grok 1.0', credits: 120,
              quote: { requestDigest: 'quote-second', request: { prompt: 'second' } },
            },
            (quote) => onGenerate('second', quote.requestDigest),
            (quote) => currentDigest() === quote.requestDigest,
          )
        }
        type="button"
      >
        第二次
      </button>
    </>
  )
}

describe('GenerationApprovalProvider', () => {
  it('submits paid actions immediately without rendering a confirmation dialog', async () => {
    const onGenerate = vi.fn()
    let digest = 'quote-first'
    const user = userEvent.setup()
    render(
      <GenerationApprovalProvider>
        <Probe currentDigest={() => digest} onGenerate={onGenerate} />
      </GenerationApprovalProvider>,
    )

    await user.click(screen.getByRole('button', { name: '第一次' }))
    expect(onGenerate).toHaveBeenCalledWith('first', 'quote-first')
    expect(screen.queryByRole('dialog', { name: '确认生成任务' })).toBeNull()

    digest = 'quote-second'
    await user.click(screen.getByRole('button', { name: '第二次' }))
    expect(onGenerate).toHaveBeenCalledWith('second', 'quote-second')
    expect(screen.queryByRole('dialog', { name: '确认生成任务' })).toBeNull()
  })

  it('freezes the submitted quote before invoking the generation action', async () => {
    const onGenerate = vi.fn()
    let digest = 'quote-first'
    const user = userEvent.setup()
    render(
      <GenerationApprovalProvider>
        <Probe currentDigest={() => digest} onGenerate={onGenerate} />
      </GenerationApprovalProvider>,
    )

    await user.click(screen.getByRole('button', { name: '第一次' }))
    digest = 'changed-after-dialog-opened'
    expect(onGenerate).toHaveBeenCalledWith('first', 'quote-first')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
