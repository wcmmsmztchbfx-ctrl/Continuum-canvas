// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import ApplicationRoot from './Root'
import { GenerationApprovalProvider } from './components/providers/GenerationApprovalContext'
import { ProviderCatalogProvider } from './components/providers/ProviderCatalogContext'
import {
  createWorkspaceRepository,
  type WorkspaceCommit,
  type WorkspaceInitialization,
  type WorkspaceStorageBackend,
} from './workspace/repository'

class MemoryWorkspaceBackend implements WorkspaceStorageBackend {
  manifest?: string
  readonly documents = new Map<string, string>()

  async initializeFromLegacy(
    create: (legacy: readonly string[]) => WorkspaceInitialization,
  ) {
    if (this.manifest) return
    const initialization = create([])
    this.manifest = initialization.manifest
    for (const document of initialization.documents) {
      this.documents.set(document.canvasId, document.serialized)
    }
  }

  async getManifest() {
    return this.manifest
  }

  async getCanvasDocument(canvasId: string) {
    return this.documents.get(canvasId)
  }

  async commit(commit: WorkspaceCommit) {
    this.manifest = commit.manifest
    for (const document of commit.putDocuments ?? []) {
      this.documents.set(document.canvasId, document.serialized)
    }
    for (const canvasId of commit.deleteCanvasIds ?? []) {
      this.documents.delete(canvasId)
    }
  }
}

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: ResizeObserverStub,
  })
})

beforeEach(() => window.history.replaceState(null, '', '/'))
afterEach(cleanup)

function renderRoot() {
  const repository = createWorkspaceRepository(new MemoryWorkspaceBackend())
  render(
    <ProviderCatalogProvider>
      <GenerationApprovalProvider>
        <ApplicationRoot repository={repository} />
      </GenerationApprovalProvider>
    </ProviderCatalogProvider>,
  )
  return repository
}

describe('application workspace routing', () => {
  it('keeps the root URL on the infinite workspace home', async () => {
    renderRoot()

    expect(await screen.findByTestId('workspace-home')).toBeVisible()
    expect(window.location.pathname).toBe('/')
    expect(screen.queryByTestId('canvas-workspace')).toBeNull()
  })

  it('creates, names and opens an independent canvas from the home', async () => {
    renderRoot()
    await screen.findByTestId('workspace-home')

    fireEvent.click(screen.getAllByRole('button', { name: '新建画布' })[0]!)
    const input = await screen.findByRole('textbox', { name: '名称' })
    fireEvent.change(input, { target: { value: '新分镜画布' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(window.location.pathname).toBe('/canvas'))
    await waitFor(() => expect(screen.getByTestId('canvas-workspace')).toBeVisible())
    expect(new URLSearchParams(window.location.search).get('canvasId')).toBeTruthy()
    expect(screen.getByRole('button', { name: /新分镜画布/ })).toBeVisible()
  })

  it('preserves the collaboration room while canonicalizing a refreshed canvas URL', async () => {
    const backend = new MemoryWorkspaceBackend()
    const repository = createWorkspaceRepository(backend)
    const view = render(
      <ProviderCatalogProvider>
        <GenerationApprovalProvider>
          <ApplicationRoot repository={repository} />
        </GenerationApprovalProvider>
      </ProviderCatalogProvider>,
    )
    await screen.findByTestId('workspace-home')
    fireEvent.click(screen.getAllByRole('button', { name: '新建画布' })[0]!)
    const input = await screen.findByRole('textbox', { name: '名称' })
    fireEvent.change(input, { target: { value: '协作刷新画布' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(window.location.pathname).toBe('/canvas'))
    const search = new URLSearchParams(window.location.search)
    search.set('collabRoom', 'room-refresh')
    window.history.replaceState(null, '', `/canvas?${search.toString()}`)

    view.unmount()
    render(
      <ProviderCatalogProvider>
        <GenerationApprovalProvider>
          <ApplicationRoot repository={repository} />
        </GenerationApprovalProvider>
      </ProviderCatalogProvider>,
    )
    await screen.findByTestId('canvas-workspace')

    expect(new URLSearchParams(window.location.search).get('collabRoom'))
      .toBe('room-refresh')
  })
})
