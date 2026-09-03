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

function collaborationRoomFromLocation(): string | undefined {
  try {
    const roomId = new URL(globalThis.location.href).searchParams.get('collabRoom') ?? undefined
    return roomId && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(roomId) ? roomId : undefined
  } catch {
    return undefined
  }
}

export function createServerWorkspaceBackend(
  options: ServerWorkspaceBackendOptions = {},
): WorkspaceStorageBackend {
  const fallback = options.fallbackBackend ?? createIndexedDbWorkspaceBackend()
  const baseUrl = options.baseUrl ?? ''
  let localAdminReady = false
  let localAdminFlight: Promise<void> | undefined

  const ensureLocalAdminSession = async (): Promise<void> => {
    if (localAdminReady) return
    localAdminFlight ??= fetch(`${baseUrl}/api/local-admin/session`, { method: 'POST' })
      .then((response) => {
        if (!response.ok) throw new Error(`Local administrator session failed with status ${response.status}`)
        localAdminReady = true
      })
      .finally(() => { localAdminFlight = undefined })
    return localAdminFlight
  }

  return {
    async initializeFromLegacy(create: (legacyProjects: readonly string[]) => WorkspaceInitialization): Promise<void> {
      try {
        const headers = new Headers()
        const roomId = collaborationRoomFromLocation()
        if (roomId) headers.set('x-collaboration-room', roomId)
        const response = await fetch(`${baseUrl}/api/workspace/manifest`, { headers })
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
        const headers = new Headers()
        const roomId = collaborationRoomFromLocation()
        if (roomId) headers.set('x-collaboration-room', roomId)
        const response = await fetch(`${baseUrl}/api/workspace/manifest`, { headers })
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
        const headers = new Headers()
        const roomId = collaborationRoomFromLocation()
        if (roomId) headers.set('x-collaboration-room', roomId)
        const response = await fetch(`${baseUrl}/api/canvases/${encodeURIComponent(canvasId)}`, { headers })
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
        const headers = new Headers({ 'content-type': 'application/json' })
        const roomId = collaborationRoomFromLocation()
        if (!roomId) await ensureLocalAdminSession()
        if (roomId) headers.set('x-collaboration-room', roomId)
        const response = await fetch(`${baseUrl}/api/workspace/commit`, {
          method: 'POST',
          headers,
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
