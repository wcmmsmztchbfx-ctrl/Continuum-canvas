import type {
  WorkspaceCommit,
  WorkspaceInitialization,
  WorkspaceStorageBackend,
} from '../workspace/repository.ts'
import { createIndexedDbWorkspaceBackend } from './projectRepository.ts'

export interface ServerWorkspaceBackendOptions {
  baseUrl?: string
  fallbackBackend?: WorkspaceStorageBackend
}

export function createServerWorkspaceBackend(
  options: ServerWorkspaceBackendOptions = {},
): WorkspaceStorageBackend {
  const fallback = options.fallbackBackend ?? createIndexedDbWorkspaceBackend()
  const baseUrl = options.baseUrl ?? ''

  return {
    async initializeFromLegacy(create: (legacyProjects: readonly string[]) => WorkspaceInitialization): Promise<void> {
      try {
        const response = await fetch(`${baseUrl}/api/workspace/manifest`)
        if (response.ok) {
          const data = await response.json() as { manifest?: unknown }
          if (data.manifest) return
        }
      } catch {
        // Fallback to local
      }
      await fallback.initializeFromLegacy(create)
    },

    async getManifest(): Promise<string | undefined> {
      try {
        const response = await fetch(`${baseUrl}/api/workspace/manifest`)
        if (response.ok) {
          const data = await response.json() as { manifest?: unknown }
          if (data.manifest) {
            const serialized = typeof data.manifest === 'string'
              ? data.manifest
              : JSON.stringify(data.manifest)
            // cache locally
            void fallback.commit({ manifest: serialized }).catch(() => {})
            return serialized
          }
        }
      } catch {
        // network error, use fallback
      }
      return fallback.getManifest()
    },

    async getCanvasDocument(canvasId: string): Promise<string | undefined> {
      try {
        const response = await fetch(`${baseUrl}/api/canvases/${encodeURIComponent(canvasId)}`)
        if (response.ok) {
          const data = await response.json() as { canvas?: unknown }
          if (data.canvas) {
            const serialized = typeof data.canvas === 'string'
              ? data.canvas
              : JSON.stringify(data.canvas)
            // cache locally
            void fallback.commit({
              manifest: (await fallback.getManifest()) ?? '',
              putDocuments: [{ canvasId, serialized }],
            }).catch(() => {})
            return serialized
          }
        }
      } catch {
        // network error, use fallback
      }
      return fallback.getCanvasDocument(canvasId)
    },

    async commit(commit: WorkspaceCommit): Promise<void> {
      // Always commit to local fallback for immediate UI reactivity / offline cache
      await fallback.commit(commit).catch(() => {})

      try {
        const response = await fetch(`${baseUrl}/api/workspace/commit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(commit),
        })
        if (!response.ok) {
          throw new Error(`Server commit failed with status ${response.status}`)
        }
      } catch {
        // If server is temporarily unreachable, local fallback already recorded it
      }
    },
  }
}
