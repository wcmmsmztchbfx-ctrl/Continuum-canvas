import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'

import { WorkspaceHome } from './components/workspace'
import {
  buildCanvasRoute,
  parseAppRoute,
  resolveCanvasLocation,
  type ResolvedCanvasLocation,
} from './routing'
import {
  defaultWorkspaceRepository,
  type WorkspaceRepository,
} from './workspace'
import type { WorkspaceManifestV1 } from './workspace/model'
import type { CanvasThumbnailService } from './thumbnails/canvasThumbnail'

import {
  getActiveCollaboration,
  useActiveCollaboration,
} from './collaboration/activeCollaborationStore'
import { FloatingCollaborationBadge } from './components/collaboration/FloatingCollaborationBadge'
import { WorkspaceSyncStatus } from './components/workspace/WorkspaceSyncStatus'
import { defaultWorkspaceBackend } from './workspace/defaultRepository'

const App = lazy(() => import('./App'))

interface BrowserLocationSnapshot {
  pathname: string
  search: string
  hash: string
}

export interface ApplicationRootProps {
  repository?: WorkspaceRepository
  thumbnailService?: Pick<CanvasThumbnailService, 'schedule' | 'flush'>
}

function currentLocation(): BrowserLocationSnapshot {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  }
}

function canonicalCanvasUrl(
  canonicalUrl: string,
  location: BrowserLocationSnapshot,
): string {
  const searchRoom = new URLSearchParams(location.search).get('collabRoom')
  if (searchRoom) {
    const url = new URL(canonicalUrl, window.location.origin)
    url.searchParams.set('collabRoom', searchRoom)
    return `${url.pathname}${url.search}`
  }
  const active = getActiveCollaboration()
  const requested = parseAppRoute(location)
  if (
    active &&
    active.status === 'active' &&
    requested.kind === 'canvas' &&
    requested.projectId === active.projectId &&
    requested.canvasId === active.canvasId
  ) {
    const url = new URL(canonicalUrl, window.location.origin)
    url.searchParams.set('collabRoom', active.roomId)
    return `${url.pathname}${url.search}`
  }
  return canonicalUrl
}

function CanvasRoute({
  location,
  navigate,
  repository,
  thumbnailService,
}: {
  location: BrowserLocationSnapshot
  navigate: (url: string, replace?: boolean) => void
  repository: WorkspaceRepository
  thumbnailService?: Pick<CanvasThumbnailService, 'schedule' | 'flush'>
}) {
  const [manifest, setManifest] = useState<WorkspaceManifestV1 | null>(null)
  const [resolved, setResolved] = useState<ResolvedCanvasLocation | null>(null)

  useEffect(() => {
    let disposed = false
    const invitation = new URLSearchParams(
      location.hash.startsWith('#') ? location.hash.slice(1) : location.hash,
    ).has('invite') && new URLSearchParams(location.search).has('collabRoom')
    const requested = parseAppRoute(location)
    void (async () => {
      let nextManifest = await repository.getManifest()
      if (
        invitation && requested.kind === 'canvas' && requested.canvasId &&
        !nextManifest.canvases.some((canvas) => canvas.canvasId === requested.canvasId)
      ) {
        await repository.ensureInvitedCanvas?.(requested.projectId, requested.canvasId)
        nextManifest = await repository.getManifest()
      }
      return nextManifest
    })()
      .then((nextManifest) => {
        if (disposed) return
        const nextResolved = resolveCanvasLocation(location, nextManifest)
        setManifest(nextManifest)
        setResolved(nextResolved)
        const canonicalUrl = nextResolved.kind === 'canvas'
          ? canonicalCanvasUrl(nextResolved.canonicalUrl, location)
          : undefined
        if (
          !invitation &&
          nextResolved.kind === 'canvas' &&
          canonicalUrl &&
          `${location.pathname}${location.search}` !== canonicalUrl
        ) {
          navigate(canonicalUrl, true)
        }
      })
      .catch(() => {
        if (!disposed) setResolved({ kind: 'invalid', reason: 'canvas-not-found' })
      })
    return () => {
      disposed = true
    }
  }, [location, navigate, repository])

  useEffect(() => {
    if (resolved?.kind === 'invalid') navigate('/', true)
  }, [navigate, resolved])

  if (!manifest || !resolved || resolved.kind !== 'canvas') {
    return <main aria-busy="true" className="workspace-home-loading">正在打开画布</main>
  }

  const project = manifest.projects.find(
    (candidate) => candidate.projectId === resolved.projectId,
  )
  const canvas = manifest.canvases.find(
    (candidate) => candidate.canvasId === resolved.canvasId,
  )
  return (
    <App
      canvasId={resolved.canvasId}
      key={resolved.canvasId}
      onNavigateCanvas={(canvasId, projectId) =>
        navigate(buildCanvasRoute(projectId, canvasId))
      }
      onNavigateWorkspace={(create) =>
        navigate(create ? `/?create=${create}` : '/')
      }
      projectId={resolved.projectId}
      projectName={project?.name ?? canvas?.name ?? '独立画布'}
      workspaceRepository={repository}
      thumbnailService={thumbnailService}
    />
  )
}

export default function ApplicationRoot({
  repository = defaultWorkspaceRepository,
  thumbnailService,
}: ApplicationRootProps) {
  const [location, setLocation] = useState(currentLocation)
  const navigate = useCallback((url: string, replace = false) => {
    if (replace) window.history.replaceState(null, '', url)
    else window.history.pushState(null, '', url)
    setLocation(currentLocation())
  }, [])

  useEffect(() => {
    const handlePopState = () => setLocation(currentLocation())
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  const route = useMemo(() => parseAppRoute(location), [location])
  useEffect(() => {
    if (route.kind === 'invalid') navigate('/', true)
  }, [navigate, route])
  const activeCollab = useActiveCollaboration()
  const currentCanvasId = route.kind === 'canvas' ? route.canvasId : undefined
  const currentProjectId = route.kind === 'canvas' ? route.projectId : undefined
  const create = new URLSearchParams(location.search).get('create')

  return (
    <>
      {route.kind === 'workspace' && (
        <WorkspaceHome
          initialCreate={
            create === 'project' || create === 'canvas' ? create : undefined
          }
          onNavigateCanvas={(canvas) =>
            navigate(buildCanvasRoute(canvas.projectId, canvas.canvasId))
          }
          repository={repository}
        />
      )}
      {route.kind === 'canvas' && (
        <Suspense fallback={<main aria-busy="true" className="workspace-home-loading">正在打开画布</main>}>
          <CanvasRoute
            location={location}
            navigate={navigate}
            repository={repository}
            thumbnailService={thumbnailService}
          />
        </Suspense>
      )}
      {route.kind !== 'workspace' && route.kind !== 'canvas' && (
        <main aria-busy="true" className="workspace-home-loading">正在返回工作区</main>
      )}
      {repository === defaultWorkspaceRepository && (
        <WorkspaceSyncStatus service={defaultWorkspaceBackend} />
      )}
      <FloatingCollaborationBadge
        activeCollab={activeCollab}
        currentCanvasId={currentCanvasId}
        currentProjectId={currentProjectId}
        onNavigate={navigate}
      />
    </>
  )
}
