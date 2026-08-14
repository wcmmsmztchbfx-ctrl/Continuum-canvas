// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceRepository } from '../../workspace'
import type { WorkspaceManifestV1 } from '../../workspace/model'

const thumbnailMocks = vi.hoisted(() => ({
  load: vi.fn(),
  delete: vi.fn(),
}))
vi.mock('../../persistence/projectRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../persistence/projectRepository')>()
  return {
    ...actual,
    loadCanvasThumbnail: thumbnailMocks.load,
    deleteCanvasThumbnail: thumbnailMocks.delete,
  }
})

import { WorkspaceHome } from './WorkspaceHomeContainer'

const manifest: WorkspaceManifestV1 = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  projects: [],
  canvases: [{
    canvasId: 'canvas-a', projectId: 'canvas-a', name: '旧画布',
    position: { x: 0, y: 0 }, nodeCount: 2, favorite: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  }],
  pendingOperations: [],
}

function repository(current: WorkspaceManifestV1 = manifest): WorkspaceRepository {
  return {
    getManifest: vi.fn(async () => structuredClone(current)),
    permanentlyDeleteCanvas: vi.fn(async () => undefined),
  } as unknown as WorkspaceRepository
}

describe('workspace thumbnail integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:thumbnail-a'),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('loads stored thumbnail blobs and revokes their object URLs on unmount', async () => {
    thumbnailMocks.load.mockResolvedValue({ canvasId: 'canvas-a', blob: new Blob(['x']) })
    const view = render(<WorkspaceHome repository={repository()} />)

    expect(await screen.findByRole('img', { name: '旧画布预览' })).toHaveAttribute(
      'src', 'blob:thumbnail-a',
    )
    view.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumbnail-a')
  })

  it('deletes the stored thumbnail only when a trashed canvas is permanently deleted', async () => {
    thumbnailMocks.load.mockResolvedValue(undefined)
    const trashed = {
      ...manifest,
      canvases: [{ ...manifest.canvases[0]!, deletedAt: '2026-08-03T00:00:00.000Z' }],
    }
    render(<WorkspaceHome repository={repository(trashed)} />)
    await screen.findByTestId('workspace-home')
    fireEvent.click(screen.getByRole('button', { name: '回收站' }))
    fireEvent.click(screen.getByRole('button', { name: '永久删除 旧画布' }))

    await waitFor(() => expect(thumbnailMocks.delete).toHaveBeenCalledWith('canvas-a'))
  })
})
