import type { WorkspaceManifestV1 } from './workspace/model'
import { referenceProjectSnapshot } from './fixtures/reference'

interface LocationLike {
  pathname: string
  search: string
  hash: string
}

interface HistoryLike {
  replaceState: (data: unknown, unused: string, url?: string | URL | null) => void
}

export type ParsedAppRoute =
  | { kind: 'workspace' }
  | { kind: 'canvas'; projectId: string; canvasId?: string }
  | { kind: 'invalid'; reason: 'unknown-route' | 'missing-project-id' }

export type ResolvedCanvasLocation =
  | { kind: 'workspace' }
  | {
      kind: 'canvas'
      projectId: string
      canvasId: string
      canonicalUrl: string
    }
  | {
      kind: 'invalid'
      reason:
        | 'unknown-route'
        | 'missing-project-id'
        | 'canvas-not-found'
        | 'ambiguous-project-route'
    }

export function buildCanvasRoute(projectId: string, canvasId: string): string {
  const search = new URLSearchParams({
    spaceId: 'local',
    projectId,
    canvasId,
  })
  return `/canvas?${search.toString()}`
}

export function parseAppRoute(location: LocationLike): ParsedAppRoute {
  if (location.pathname === '/') return { kind: 'workspace' }
  if (location.pathname !== '/canvas') {
    return { kind: 'invalid', reason: 'unknown-route' }
  }
  const search = new URLSearchParams(location.search)
  const projectId = search.get('projectId')?.trim()
  if (!projectId) return { kind: 'invalid', reason: 'missing-project-id' }
  const canvasId = search.get('canvasId')?.trim()
  return canvasId
    ? { kind: 'canvas', projectId, canvasId }
    : { kind: 'canvas', projectId }
}

export function resolveCanvasLocation(
  location: LocationLike,
  manifest: WorkspaceManifestV1,
): ResolvedCanvasLocation {
  const parsed = parseAppRoute(location)
  if (parsed.kind !== 'canvas') return parsed
  const requestedProjectId =
    parsed.projectId === 'reference'
      ? referenceProjectSnapshot.projectId
      : parsed.projectId

  if (parsed.canvasId) {
    const canvas = manifest.canvases.find(
      (item) =>
        item.canvasId === parsed.canvasId &&
        item.projectId === requestedProjectId &&
        !item.deletedAt,
    )
    if (!canvas) return { kind: 'invalid', reason: 'canvas-not-found' }
    return {
      kind: 'canvas',
      projectId: canvas.projectId,
      canvasId: canvas.canvasId,
      canonicalUrl: buildCanvasRoute(canvas.projectId, canvas.canvasId),
    }
  }

  const candidates = manifest.canvases.filter(
    (canvas) => canvas.projectId === requestedProjectId && !canvas.deletedAt,
  )
  if (candidates.length === 0) {
    return { kind: 'invalid', reason: 'canvas-not-found' }
  }
  if (candidates.length > 1) {
    return { kind: 'invalid', reason: 'ambiguous-project-route' }
  }
  const canvas = candidates[0]!
  return {
    kind: 'canvas',
    projectId: canvas.projectId,
    canvasId: canvas.canvasId,
    canonicalUrl: buildCanvasRoute(canvas.projectId, canvas.canvasId),
  }
}

export function normalizeCanvasLocation(
  _location: LocationLike,
  _history: HistoryLike,
): void {
  // Route canonicalization now requires the persisted workspace manifest.
}
