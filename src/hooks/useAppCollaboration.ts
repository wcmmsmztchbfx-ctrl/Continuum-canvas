import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { collaborationCapabilities } from '../collaboration/capabilities'
import {
  CanvasCollaborationController,
  type CollaborationControllerState,
} from '../collaboration/controller'
import type { PresenceState } from '../collaboration/document'
import type { ProviderCatalogState } from '../components/providers/ProviderCatalogContext'
import { canvasStore } from '../store/canvas-store'
import type { WorkspaceRepository } from '../workspace'

export interface UseAppCollaborationOptions {
  hydrated: boolean
  canvasId?: string
  projectId?: string
  loadedCanvasId?: string | null
  workspaceRepository: WorkspaceRepository
  providerCatalog?: ProviderCatalogState
  notify: (message: string, tone?: 'info' | 'success' | 'error' | 'warning') => void
}

export function useAppCollaboration({
  hydrated,
  canvasId,
  projectId,
  loadedCanvasId,
  workspaceRepository,
  providerCatalog,
  notify,
}: UseAppCollaborationOptions) {
  const [collaborationState, setCollaborationState] =
    useState<CollaborationControllerState>({ status: 'inactive', inviteLinks: {} })
  const [collaborationPresence, setCollaborationPresence] = useState<PresenceState[]>([])
  const [followingMemberId, setFollowingMemberId] = useState<string>()
  const collaborationControllerRef = useRef<CanvasCollaborationController | null>(null)

  const capabilities = collaborationCapabilities(collaborationState)
  const collaborationRestricted = Boolean(
    collaborationState.pendingInvite ||
    collaborationState.authenticatedPendingResume ||
    (collaborationState.session && collaborationState.session.role !== 'owner'),
  )
  const readOnly = !capabilities.canEdit

  useLayoutEffect(() => {
    providerCatalog?.setApiManagementAllowed(capabilities.canManageApi)
  }, [capabilities.canManageApi, providerCatalog])

  const performUndo = useCallback(() => {
    const controller = collaborationControllerRef.current
    if (controller?.isLocalAutosaveSuppressed()) {
      if (collaborationCapabilities(controller.getState()).canEdit) controller.undo()
    } else {
      canvasStore.getState().undo()
    }
  }, [])

  const performRedo = useCallback(() => {
    const controller = collaborationControllerRef.current
    if (controller?.isLocalAutosaveSuppressed()) {
      if (collaborationCapabilities(controller.getState()).canEdit) controller.redo()
    } else {
      canvasStore.getState().redo()
    }
  }, [])

  const withBulkLease = useCallback(
    async <T,>(
      nodeIds: readonly string[],
      operation: () => T | Promise<T>,
    ): Promise<Awaited<T> | undefined> => {
      if (readOnly) return undefined
      const ids = [...new Set(nodeIds)]
      if (ids.length === 0) return undefined
      const controller = collaborationControllerRef.current
      return controller?.isLocalAutosaveSuppressed()
        ? await controller.withNodeLease(ids, 'bulk', operation)
        : await operation()
    },
    [readOnly],
  )

  const collaborationAction = useCallback(
    async (action: (controller: CanvasCollaborationController) => Promise<unknown>) => {
      const controller = collaborationControllerRef.current
      if (!controller) {
        notify('只有工作区画布可以开启多人协作', 'warning')
        return
      }
      try {
        await action(controller)
      } catch (error) {
        notify(error instanceof Error ? error.message : '协作操作失败', 'error')
      }
    },
    [notify],
  )

  useEffect(() => {
    if (!hydrated || !canvasId || !projectId || loadedCanvasId !== canvasId) return
    const controller = new CanvasCollaborationController({
      canvasId,
      projectId,
      repository: workspaceRepository,
      store: canvasStore,
      shareOrigin: import.meta.env.VITE_CANVAS_PUBLIC_ORIGIN || undefined,
    })
    collaborationControllerRef.current = controller
    setCollaborationState(controller.getState())
    const unsubscribe = controller.subscribe(setCollaborationState)
    setCollaborationPresence(controller.getPresence())
    const unsubscribePresence = controller.subscribePresence((presence) => {
      setCollaborationPresence([...presence])
    })
    void controller.initializeFromLocation().catch(() => undefined)
    return () => {
      unsubscribe()
      unsubscribePresence()
      setCollaborationPresence([])
      setFollowingMemberId(undefined)
      if (collaborationControllerRef.current === controller) {
        collaborationControllerRef.current = null
      }
      void controller.destroy()
    }
  }, [canvasId, hydrated, loadedCanvasId, projectId, workspaceRepository])

  return {
    collaborationState,
    setCollaborationState,
    collaborationPresence,
    setCollaborationPresence,
    followingMemberId,
    setFollowingMemberId,
    collaborationControllerRef,
    capabilities,
    collaborationRestricted,
    readOnly,
    performUndo,
    performRedo,
    withBulkLease,
    collaborationAction,
  }
}
