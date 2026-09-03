import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'

import App from './App'
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
import { GenerationApprovalProvider } from './components/providers/GenerationApprovalContext'
import { ProviderCatalogProvider } from './components/providers/ProviderCatalogContext'
import type { CollaborationOperationMode } from './contracts/collaboration'

import {
  getActiveCollaboration,
  useActiveCollaboration,
} from './collaboration/activeCollaborationStore'
import { FloatingCollaborationBadge } from './components/collaboration/FloatingCollaborationBadge'
import { gatewayClient } from './services/gatewayClient'

interface BrowserLocationSnapshot {
  pathname: string
  search: string
  hash: string
}

export interface ApplicationRootProps {
  repository?: WorkspaceRepository
  thumbnailService?: Pick<CanvasThumbnailService, 'schedule' | 'flush'>
  canManageSettings?: boolean
}

interface AccessContext {
  operationMode: CollaborationOperationMode
  workstation: {
    authenticated: boolean
    userId?: string
    displayName?: string
  }
  canManageSettings: boolean
}

function parseAccessContext(value: unknown): AccessContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const operationMode = record.operationMode
  if (operationMode !== 'solo' && operationMode !== 'host' && operationMode !== 'workstation') {
    return undefined
  }
  const workstation = record.workstation
  if (!workstation || typeof workstation !== 'object' || Array.isArray(workstation)) return undefined
  const status = workstation as Record<string, unknown>
  if (typeof status.authenticated !== 'boolean') return undefined
  const canManageSettings = record.canManageSettings === true
  return {
    operationMode,
    workstation: {
      authenticated: status.authenticated,
      ...(typeof status.userId === 'string' ? { userId: status.userId } : {}),
      ...(typeof status.displayName === 'string' ? { displayName: status.displayName } : {}),
    },
    canManageSettings,
  }
}

function WorkstationNicknameGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [displayName, setDisplayName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalized = displayName.trim()
    if (!normalized || Array.from(normalized).length > 32) {
      setError('昵称长度必须在 1 到 32 个字符之间')
      return
    }
    setSubmitting(true)
    setError(undefined)
    try {
      const response = await fetch('/api/workstation/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ displayName: normalized }),
      })
      if (!response.ok) throw new Error('工作站会话创建失败，请重试')
      onAuthenticated()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '工作站会话创建失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="workstation-entry" data-testid="workstation-entry">
      <form className="workstation-entry__card" onSubmit={submit}>
        <p className="canvas-type-eyebrow">WORKSTATION MODE</p>
        <h1>输入昵称后进入工作区</h1>
        <p>昵称用于选择你的独立工作区。无需账号或密码，同一昵称会继续使用同一组画布。</p>
        <label htmlFor="workstation-display-name">协作昵称</label>
        <input
          autoComplete="nickname"
          autoFocus
          id="workstation-display-name"
          maxLength={32}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="例如：小明"
          value={displayName}
        />
        {error && <p className="workstation-entry__error" role="alert">{error}</p>}
        <button disabled={submitting} type="submit">
          {submitting ? '正在进入…' : '进入工作区'}
        </button>
      </form>
    </main>
  )
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
  canManageSettings,
}: {
  location: BrowserLocationSnapshot
  navigate: (url: string, replace?: boolean) => void
  repository: WorkspaceRepository
  thumbnailService?: Pick<CanvasThumbnailService, 'schedule' | 'flush'>
  canManageSettings?: boolean
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
      canManageSettings={canManageSettings}
    />
  )
}

function WorkspaceApplication({
  repository = defaultWorkspaceRepository,
  thumbnailService,
  canManageSettings = true,
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
    <ProviderCatalogProvider
      canvasScope={currentProjectId && currentCanvasId
        ? { projectId: currentProjectId, canvasId: currentCanvasId }
        : undefined}
    >
      <GenerationApprovalProvider>
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
          <CanvasRoute
            location={location}
            navigate={navigate}
            repository={repository}
            thumbnailService={thumbnailService}
            canManageSettings={canManageSettings}
          />
        )}
        {route.kind !== 'workspace' && route.kind !== 'canvas' && (
          <main aria-busy="true" className="workspace-home-loading">正在返回工作区</main>
        )}
        <FloatingCollaborationBadge
          activeCollab={activeCollab}
          currentCanvasId={currentCanvasId}
          currentProjectId={currentProjectId}
          onNavigate={navigate}
        />
      </GenerationApprovalProvider>
    </ProviderCatalogProvider>
  )
}

export default function ApplicationRoot(props: ApplicationRootProps) {
  const [access, setAccess] = useState<AccessContext | null>(null)
  const [accessReady, setAccessReady] = useState(false)

  useEffect(() => {
    let disposed = false
    const load = async () => {
      try {
        const response = await fetch('/api/access/context', { credentials: 'same-origin' })
        if (!response.ok) throw new Error('access context unavailable')
        const parsed = parseAccessContext(await response.json())
        if (!parsed) throw new Error('access context invalid')
        if (!disposed) {
          setAccess(parsed)
          setAccessReady(true)
        }
      } catch {
        // Unit tests and offline IndexedDB mode do not have the gateway. Keep
        // the legacy local shell available when the access endpoint is absent.
        if (!disposed) {
          setAccess(null)
          setAccessReady(true)
        }
      }
    }
    void load()
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    gatewayClient.setWorkstationSession(
      access?.operationMode === 'workstation' && access.workstation.authenticated,
    )
  }, [access])

  if (!accessReady) {
    return <main aria-busy="true" className="workspace-home-loading">正在准备工作区</main>
  }
  if (access && !access.canManageSettings && access.operationMode !== 'solo' && !access.workstation.authenticated) {
    return (
      <WorkstationNicknameGate
        onAuthenticated={() => setAccess((current) => current
          ? { ...current, workstation: { ...current.workstation, authenticated: true } }
          : current)}
      />
    )
  }
  return (
    <WorkspaceApplication
      {...props}
      canManageSettings={access?.canManageSettings ?? props.canManageSettings ?? true}
    />
  )
}
