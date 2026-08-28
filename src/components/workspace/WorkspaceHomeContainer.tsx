import { Suspense, lazy, useCallback, useEffect, useState } from 'react'

import { gatewayClient, type GatewayClient } from '../../services/gatewayClient'
import {
  defaultWorkspaceRepository,
  type WorkspaceRepository,
} from '../../workspace'
import type {
  WorkspaceCanvas,
  WorkspaceManifestV1,
} from '../../workspace/model'
import { WorkspaceHomeView, type WorkspaceCanvasMove } from './WorkspaceHome'
import { createBrowserUuid } from '../../utils/id'
import {
  deleteCanvasThumbnail,
  loadCanvasThumbnail,
} from '../../persistence/projectRepository'
import { SettingsModal } from '../overlays/SettingsModal'

const ProviderDrawer = lazy(() =>
  import('../providers/ProviderDrawer').then((module) => ({
    default: module.ProviderDrawer,
  })),
)

export interface WorkspaceHomeProps {
  initialCreate?: 'project' | 'canvas'
  onNavigateCanvas?: (canvas: WorkspaceCanvas) => void
  repository?: WorkspaceRepository
  gateway?: Pick<GatewayClient, 'reassignGenerationHistory'> &
    Partial<Pick<GatewayClient, 'releaseCanvasAssetReferences'>>
}

type EditingItem = {
  kind: 'project' | 'canvas'
  id: string
  openAfterCommit?: boolean
} | null

function createOperationId(): string {
  return `move-${createBrowserUuid()}`
}

export function WorkspaceHome({
  gateway = gatewayClient,
  initialCreate,
  onNavigateCanvas,
  repository = defaultWorkspaceRepository,
}: WorkspaceHomeProps) {
  const [manifest, setManifest] = useState<WorkspaceManifestV1 | null>(null)
  const [editing, setEditing] = useState<EditingItem>(null)
  const [providerDrawerOpen, setProviderDrawerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [createHandled, setCreateHandled] = useState(false)
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!manifest) return
    let disposed = false
    const createdUrls: string[] = []
    void Promise.all(
      manifest.canvases.map(async (canvas) => {
        const thumbnail = await loadCanvasThumbnail(canvas.canvasId)
        if (!thumbnail || disposed) return undefined
        const url = URL.createObjectURL(thumbnail.blob)
        createdUrls.push(url)
        return [canvas.canvasId, url] as const
      }),
    ).then((entries) => {
      if (!disposed) {
        setThumbnailUrls(Object.fromEntries(
          entries.filter(Boolean) as Array<readonly [string, string]>,
        ))
      }
    }).catch(() => {
      if (!disposed) setThumbnailUrls({})
    })
    return () => {
      disposed = true
      for (const url of createdUrls) URL.revokeObjectURL(url)
    }
  }, [manifest])

  const refresh = useCallback(async () => {
    setManifest(await repository.getManifest())
  }, [repository])

  const reportError = useCallback((error: unknown) => {
    setMessage(error instanceof Error ? error.message : '工作区操作失败')
  }, [])

  const resumePendingMoves = useCallback(
    async (current: WorkspaceManifestV1) => {
      for (const operation of current.pendingOperations) {
        try {
          await gateway.reassignGenerationHistory({
            operationId: operation.operationId,
            canvasId: operation.canvasId,
            fromProjectId: operation.fromProjectId,
            toProjectId: operation.toProjectId,
          })
          const canvas = current.canvases.find(
            (candidate) => candidate.canvasId === operation.canvasId,
          )
          if (!canvas) {
            await repository.cancelCanvasMove(operation.operationId)
            continue
          }
          await repository.completeCanvasMove(operation.operationId, {
            position: operation.position ?? canvas.position,
            projectId: operation.toProjectId,
          })
        } catch (error) {
          reportError(error)
          break
        }
      }
    },
    [gateway, repository, reportError],
  )

  useEffect(() => {
    let disposed = false
    void repository
      .getManifest()
      .then(async (current) => {
        if (disposed) return
        await resumePendingMoves(current)
        if (!disposed) setManifest(await repository.getManifest())
      })
      .catch(reportError)
    return () => {
      disposed = true
    }
  }, [repository, reportError, resumePendingMoves])

  const createProject = useCallback(
    async (position: { x: number; y: number }) => {
      try {
        const project = await repository.createProject('未命名项目', position)
        await refresh()
        setEditing({ kind: 'project', id: project.projectId })
      } catch (error) {
        reportError(error)
      }
    },
    [refresh, repository, reportError],
  )

  const createCanvas = useCallback(
    async (position: { x: number; y: number }) => {
      try {
        const canvas = await repository.createCanvas('未命名画布', { position })
        await refresh()
        setEditing({
          kind: 'canvas',
          id: canvas.canvasId,
          openAfterCommit: true,
        })
      } catch (error) {
        reportError(error)
      }
    },
    [refresh, repository, reportError],
  )

  useEffect(() => {
    if (!manifest || createHandled || !initialCreate) return
    setCreateHandled(true)
    const position = {
      x: (window.innerWidth / 2 - manifest.viewport.x) / manifest.viewport.zoom,
      y: (window.innerHeight / 2 - manifest.viewport.y) / manifest.viewport.zoom,
    }
    if (initialCreate === 'project') void createProject(position)
    else void createCanvas(position)
  }, [createCanvas, createHandled, createProject, initialCreate, manifest])

  const commitRename = useCallback(
    async (name: string) => {
      if (!editing) return
      try {
        if (editing.kind === 'project') {
          await repository.renameProject(editing.id, name)
          setEditing(null)
          await refresh()
          return
        }
        const canvas = await repository.renameCanvas(editing.id, name)
        setEditing(null)
        await refresh()
        if (editing.openAfterCommit) onNavigateCanvas?.(canvas)
      } catch (error) {
        reportError(error)
      }
    },
    [editing, onNavigateCanvas, refresh, repository, reportError],
  )

  const moveCanvas = useCallback(
    async (canvas: WorkspaceCanvas, move: WorkspaceCanvasMove) => {
      try {
        if (canvas.projectId === move.projectId) {
          await repository.moveCanvas(canvas.canvasId, move)
          await refresh()
          return
        }
        const operationId = createOperationId()
        const operation = await repository.beginCanvasMove(
          canvas.canvasId,
          move.projectId,
          operationId,
          move.position,
        )
        await gateway.reassignGenerationHistory({
          operationId,
          canvasId: canvas.canvasId,
          fromProjectId: operation.fromProjectId,
          toProjectId: operation.toProjectId,
        })
        await repository.completeCanvasMove(operationId, move)
        await refresh()
      } catch (error) {
        reportError(error)
        await refresh().catch(() => undefined)
      }
    },
    [gateway, refresh, repository, reportError],
  )

  if (!manifest) {
    return (
      <main aria-busy="true" className="workspace-home-loading">
        <span>正在恢复本地工作区</span>
        {message ? <p role="alert">{message}</p> : null}
      </main>
    )
  }

  return (
    <>
      <WorkspaceHomeView
        editingItem={editing ?? undefined}
        manifest={manifest}
        thumbnailUrls={thumbnailUrls}
        onApiIntegration={() => {
          setProviderDrawerOpen((current) => !current)
        }}
        onCancelRename={() => setEditing(null)}
        onCommitRename={commitRename}
        onCreateCanvas={createCanvas}
        onCreateProject={createProject}
        onMoveCanvas={moveCanvas}
        onMoveProject={async (project, position) => {
          try {
            await repository.moveProject(project.projectId, position)
            await refresh()
          } catch (error) {
            reportError(error)
          }
        }}
        onOpenCanvas={onNavigateCanvas}
        onDeleteCanvas={async (canvas) => {
          if (!window.confirm(`永久删除画布“${canvas.name}”？此操作不可撤销。`)) return
          try {
            await repository.permanentlyDeleteCanvas(canvas.canvasId)
            await deleteCanvasThumbnail(canvas.canvasId).catch(() => undefined)
            await gateway.releaseCanvasAssetReferences?.(
              canvas.projectId,
              canvas.canvasId,
            )
            await refresh()
          } catch (error) {
            reportError(error)
          }
        }}
        onDeleteProject={async (project) => {
          if (!window.confirm(`永久删除项目“${project.name}”及其中画布？此操作不可撤销。`)) return
          try {
            await repository.permanentlyDeleteProject(project.projectId)
            const children = manifest.canvases.filter(
              (canvas) => canvas.projectId === project.projectId,
            )
            for (const canvas of children) {
              await deleteCanvasThumbnail(canvas.canvasId).catch(() => undefined)
              await gateway.releaseCanvasAssetReferences?.(
                project.projectId,
                canvas.canvasId,
              )
            }
            await refresh()
          } catch (error) {
            reportError(error)
          }
        }}
        onDuplicateCanvas={async (canvas) => {
          try {
            await repository.duplicateCanvas(canvas.canvasId)
            await refresh()
          } catch (error) {
            reportError(error)
          }
        }}
        onDuplicateProject={async (project) => {
          try {
            await repository.duplicateProject(project.projectId)
            await refresh()
          } catch (error) {
            reportError(error)
          }
        }}
        onRenameCanvas={(canvas) =>
          setEditing({ kind: 'canvas', id: canvas.canvasId })
        }
        onRenameProject={(project) =>
          setEditing({ kind: 'project', id: project.projectId })
        }
        onResizeProject={async (project, size) => {
          try {
            await repository.resizeProject(project.projectId, size)
            await refresh()
          } catch (error) {
            reportError(error)
          }
        }}
        onRestoreCanvas={async (canvas) => {
          try {
            await repository.restoreCanvas(canvas.canvasId)
            await refresh()
          } catch (error) {
            reportError(error)
          }
        }}
        onRestoreProject={async (project) => {
          try {
            await repository.restoreProject(project.projectId)
            await refresh()
          } catch (error) {
            reportError(error)
          }
        }}
        onTrashCanvas={async (canvas) => {
          try {
            await repository.trashCanvas(canvas.canvasId)
            await refresh()
          } catch (error) {
            reportError(error)
          }
        }}
        onTrashProject={async (project) => {
          try {
            await repository.trashProject(project.projectId)
            await refresh()
          } catch (error) {
            reportError(error)
          }
        }}
        onToggleCanvasFavorite={async (canvas) => {
          try {
            await repository.setCanvasFavorite(canvas.canvasId, !canvas.favorite)
            await refresh()
          } catch (error) {
            reportError(error)
          }
        }}
        onToggleProjectFavorite={async (project) => {
          try {
            await repository.setProjectFavorite(
              project.projectId,
              !project.favorite,
            )
            await refresh()
          } catch (error) {
            reportError(error)
          }
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onViewportChange={(viewport) => {
          void repository.updateViewport(viewport).catch(reportError)
        }}
      />

      {providerDrawerOpen ? (
        <Suspense fallback={null}>
          <ProviderDrawer onClose={() => setProviderDrawerOpen(false)} open />
        </Suspense>
      ) : null}
      <SettingsModal
        onClose={() => setSettingsOpen(false)}
        onNotify={(msg) => setMessage(msg)}
        open={settingsOpen}
      />
      {message ? (
        <div className="workspace-home-message" role="alert">
          <span>{message}</span>
          <button aria-label="关闭提示" onClick={() => setMessage(null)} type="button">
            ×
          </button>
        </div>
      ) : null}
    </>
  )
}
