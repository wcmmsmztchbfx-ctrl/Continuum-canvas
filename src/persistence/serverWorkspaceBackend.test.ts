import { describe, expect, it, vi } from 'vitest'
import { createServerWorkspaceBackend } from './serverWorkspaceBackend.ts'
import type { WorkspaceStorageBackend } from '../workspace/repository.ts'

describe('createServerWorkspaceBackend', () => {
  it('reads manifest from server when available and falls back to local backend on failure', async () => {
    const localManifest = JSON.stringify({ version: 1, canvases: [{ canvasId: 'local-c1' }] })
    const fallback: WorkspaceStorageBackend = {
      initializeFromLegacy: vi.fn(async () => {}),
      getManifest: vi.fn(async () => localManifest),
      getCanvasDocument: vi.fn(async (_id) => undefined),
      commit: vi.fn(async () => {}),
    }

    // Mock fetch for server manifest
    const serverManifest = { version: 1, canvases: [{ canvasId: 'server-c1' }] }
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ manifest: serverManifest }),
    } as unknown as Response)

    const backend = createServerWorkspaceBackend({ fallbackBackend: fallback })
    const manifestStr = await backend.getManifest()
    expect(manifestStr).toBe(JSON.stringify(serverManifest))
    expect(fallback.commit).toHaveBeenCalledWith({ manifest: JSON.stringify(serverManifest) })
  })

  it('falls back to local backend when server fetch fails', async () => {
    const localManifest = JSON.stringify({ version: 1, canvases: [{ canvasId: 'local-c1' }] })
    const fallback: WorkspaceStorageBackend = {
      initializeFromLegacy: vi.fn(async () => {}),
      getManifest: vi.fn(async () => localManifest),
      getCanvasDocument: vi.fn(async (_id) => undefined),
      commit: vi.fn(async () => {}),
    }

    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'))

    const backend = createServerWorkspaceBackend({ fallbackBackend: fallback })
    const manifestStr = await backend.getManifest()
    expect(manifestStr).toBe(localManifest)
    expect(fallback.getManifest).toHaveBeenCalledTimes(1)
  })
})
