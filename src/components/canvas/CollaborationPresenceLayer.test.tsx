// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'

import { CollaborationPresenceLayer } from './CollaborationPresenceLayer'
import type { PresenceState } from '../../contracts/collaboration'

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...actual,
    ViewportPortal: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="viewport-portal">{children}</div>
    ),
    useStore: () => new Map(),
  }
})

describe('CollaborationPresenceLayer', () => {
  it('renders remote collaborator cursor and name tag with presence color', () => {
    const presence: PresenceState[] = [
      {
        clientId: 42,
        member: {
          memberId: 'user-alice',
          displayName: 'Alice',
          color: '#e11d48',
          role: 'editor',
        },
        cursor: { x: 300, y: 150 },
        selection: { nodeIds: [] },
      },
    ]

    const { container } = render(
      <ReactFlowProvider>
        <CollaborationPresenceLayer presence={presence} />
      </ReactFlowProvider>,
    )

    const cursor = container.querySelector('[data-remote-cursor="user-alice"]')
    expect(cursor).toBeTruthy()
    expect(cursor?.textContent).toContain('Alice')
    expect(cursor?.getAttribute('style')).toContain('translate(300px, 150px)')
    expect(cursor?.getAttribute('style')).toContain('--presence-color: #e11d48')
  })
})
