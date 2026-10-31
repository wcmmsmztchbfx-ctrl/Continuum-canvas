import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { useStore } from 'zustand'
import { Package, Layers3, Settings, PanelLeftClose, PanelLeftOpen, Cpu, UsersRound, Bot, GitBranch } from 'lucide-react'

import { CanvasWorkspace, LayersPanel } from './components/canvas'
import { AssetsSidebarPanel, AgentSidebarPanel, LineageSidebarPanel } from './components/sidebar'
import { assetRegistry } from './services/assetRegistry'
import {
  AppOverlays,
  LayoutDecisionBar,
  ToastRegion,
  useToastQueue,
  type AddNodeKind,
  type BlankContextAction,
  type HelpAction,
  type NodeContextAction,
  type OverlayPosition,
  type SelectionAction,
  type SidePanelKind,
  type WorkspaceAction,
} from './components/overlays'
import {
  BottomStatusBar,
  LibTvLogo,
  ToolDock,
  WorkspaceMenu,
  type ToolDockTool,
} from './components/shell'
import { InspectorPanel } from './components/inspector/InspectorPanel'
import { getCollaboratorColor } from './collaboration/colors'
import {
  defaultProjectPersistenceQueue,
  defaultProjectRepository,
  loadUiPreferences,
  MAX_LAYERS_WIDTH,
  MIN_LAYERS_WIDTH,
  saveUiPreferences,
  type UiPreferences,
} from './persistence'
import { createCanvasSaveSession, type CapturedCanvasSave } from './persistence/canvasSaveSession'
import { createAgentCanvasSync, type AgentCanvasSync } from './services/agent/agentCanvasSync'
import { AgentRuntimeClient } from './services/agent/agentRuntimeClient'
import {
  defaultWorkspaceRepository,
  type WorkspaceRepository,
} from './workspace'
// Media uploads delegate to persistLocalMedia(file) via useCanvasClipboard
import {
  gatewayClient,
  uploadAndPrepareMediaAsset,
} from './services'
import { canvasStore } from './store/canvas-store'
import {
  type CanvasNode,
  type ProjectSnapshot,
} from './model/project'
import {
  canvasThumbnailService,
  type CanvasThumbnailService,
} from './thumbnails/canvasThumbnail'
import type { CollaborationInteraction, InteractionPreview, NodeLease, NodeLeaseKind } from './contracts/collaboration'
import { useOptionalProviderCatalog } from './components/providers/ProviderCatalogContext'
import { createBrowserUuid } from './utils/id'
import {
  createCanvasClipboardEnvelope,
  readClipboardContents,
  writeCanvasClipboardEnvelope,
  type CanvasClipboardEnvelope,
} from './clipboard-import'
import { useAppCollaboration } from './hooks/useAppCollaboration'
import { useAppHotkeys } from './hooks/useAppHotkeys'
import { useSidebarResize } from './hooks/useSidebarResize'
import { useCanvasStageAnchor } from './hooks/useCanvasStageAnchor'
import { canvasPerformanceFlags } from './performance/canvasPerformanceFlags'
import { createCanvasViewportRuntime } from './components/canvas/canvasViewportRuntime'
import { useCanvasClipboard } from './hooks/useCanvasClipboard'
import { copyImageToClipboard } from './utils/clipboard'

type Popup =
  | 'workspace'
  | 'add'
  | 'api-integration'
  | 'collaboration'
  | 'help'
  | null
type Dialog = 'shortcuts' | 'delete' | 'rename' | 'settings' | null
type ContextMenu = 'blank' | 'node' | null

const sidePanelKinds: ReadonlyArray<SidePanelKind> = [
  'project-files',
  'canvases',
  'assets',
  'history',
  'agent',
]

const ACTIVE_PROJECT_STORAGE_KEY = 'libtv.active-project.v1'
const DEFAULT_INITIAL_PROJECT: ProjectSnapshot = {
  version: 1,
  projectId: 'default-project',
  name: '画布 1',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
}

async function ensureReferenceProject(): Promise<ProjectSnapshot> {
  return DEFAULT_INITIAL_PROJECT
}

function readActiveProjectId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)
  } catch {
    return null
  }
}

function saveActiveProjectId(projectId: string): void {
  try {
    localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId)
  } catch {
    // IndexedDB still retains the project when preference storage is blocked.
  }
}

function createLocalNodeId(kind: string): string {
  const existingIds = new Set(
    canvasStore.getState().snapshot.nodes.map((node) => node.id),
  )
  let id: string
  do {
    const randomPart = createBrowserUuid()
    id = `local-${kind}-${randomPart}`
  } while (existingIds.has(id))
  return id
}

function isSidePanelKind(value: string | null): value is SidePanelKind {
  return sidePanelKinds.some((kind) => kind === value)
}


const addNodeLabels: Record<AddNodeKind, string> = {
  image: '图片',
  video: '视频',
  'video-compose': '视频合成',
  director: '导演台',
  audio: '音频',
  text: '文本',
  'asset-library': '资产库',
  upload: '上传',
  'generation-history': '生成历史',
  group: '分组',
  script: '脚本',
  storyboard: '故事板',
  'video-story': '视频故事',
  'blank-scene': '空白场景',
  'style-shot': '风格与镜头',
  'reference-image': '参考图',
}

export interface AppProps {
  onSyncStatusHost?: (host: HTMLDivElement | null) => void
  canvasId?: string
  projectId?: string
  projectName?: string
  onNavigateCanvas?: (canvasId: string, projectId: string) => void
  onNavigateWorkspace?: (create?: 'project' | 'canvas') => void
  workspaceRepository?: WorkspaceRepository
  thumbnailService?: Pick<CanvasThumbnailService, 'schedule' | 'flush'>
}

export default function App({
  onSyncStatusHost,
  canvasId,
  projectId,
  projectName,
  onNavigateCanvas,
  onNavigateWorkspace,
  workspaceRepository = defaultWorkspaceRepository,
  thumbnailService = canvasThumbnailService,
}: AppProps = {}) {
  const [hydrated, setHydrated] = useState(false)
  const [loadedCanvasId, setLoadedCanvasId] = useState<string | null>()
  const [loadError, setLoadError] = useState<string>()
  const [loadAttempt, setLoadAttempt] = useState(0)
  const beforeAgentRunRef = useRef<(() => Promise<{ expectedRevision: number }>) | undefined>(undefined)
  const agentSyncCanvasRef = useRef<string | undefined>(undefined)
  const prepareAgentRun = useCallback(async () => {
    if (!beforeAgentRunRef.current || agentSyncCanvasRef.current !== canvasId) throw new Error('画布已切换或尚未同步，请在当前画布重新发送')
    return beforeAgentRunRef.current()
  }, [canvasId])
  const [preferences, setPreferences] = useState<UiPreferences>(() =>
    loadUiPreferences(),
  )
  const appShellRef = useRef<HTMLElement | null>(null)
  const canvasStageRef = useRef<HTMLElement | null>(null)
  const {
    layersWidth,
    layersResizing,
    inspectorWidth,
    inspectorResizing,
    startLayersResize,
    startInspectorResize,
    resizeLayersByKeyboard,
  } = useSidebarResize({
    appShellRef,
    initialLayersWidth: preferences.layersWidth,
    initialInspectorWidth: preferences.inspectorWidth || 280,
    onPersistPreferences: (changes) => {
      setPreferences((current) => {
        const next = { ...current, ...changes }
        try {
          saveUiPreferences(next)
        } catch (error) {
          notify(
            error instanceof Error ? error.message : '保存界面偏好失败',
            'error',
          )
        }
        return next
      })
    },
  })

  const camera = useMemo(() => createCanvasViewportRuntime(canvasStore.getState().snapshot.viewport), [canvasId])
  useCanvasStageAnchor(canvasStageRef, hydrated, canvasPerformanceFlags.runtimeViewport ? camera : undefined)

  const getStageCenterPoint = useCallback(() => {
    const rect = canvasStageRef.current?.getBoundingClientRect()
    if (rect && rect.width > 0 && rect.height > 0) {
      return { x: rect.width / 2, y: rect.height / 2 }
    }
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  }, [])
  const [activeTool, setActiveTool] = useState<ToolDockTool>('select')
  const [editingPathNodeId, setEditingPathNodeId] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      ;(window as any).__canvasStore = canvasStore
    }
  }, [])

  useEffect(() => {
    if (!editingPathNodeId) return
    const unsubscribe = canvasStore.subscribe((state) => {
      if (!state.selectedNodeIds.includes(editingPathNodeId)) {
        setEditingPathNodeId(null)
      }
    })
    return unsubscribe
  }, [editingPathNodeId])
  const [popup, setPopup] = useState<Popup>(null)
  const [providerDrawerOpen, setProviderDrawerOpen] = useState(false)
  const [providerDrawerTab, setProviderDrawerTab] = useState<'media' | 'agent'>('media')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [assetManagerOpen, setAssetManagerOpen] = useState(false)
  const [activeLeftTab, setActiveLeftTab] = useState<'layers' | 'lineage' | 'assets' | 'agent'>('layers')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [panel, setPanel] = useState<SidePanelKind | null>(() =>
    isSidePanelKind(preferences.lastOpenPanel) &&
    preferences.lastOpenPanel !== 'history'
      ? preferences.lastOpenPanel
      : null,
  )
  const [contextMenu, setContextMenu] = useState<ContextMenu>(null)
  const [contextPosition, setContextPosition] = useState<OverlayPosition>({
    x: 0,
    y: 0,
  })
  const [addNodePosition, setAddNodePosition] =
    useState<OverlayPosition | undefined>()
  const [renameProjectName, setRenameProjectName] = useState('')
  const { dismiss: dismissToast, notify, toasts } = useToastQueue()
  const providerCatalog = useOptionalProviderCatalog()

  const {
    collaborationState,
    collaborationPresence,
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
  } = useAppCollaboration({
    hydrated,
    canvasId,
    projectId,
    loadedCanvasId,
    workspaceRepository,
    providerCatalog,
    notify,
  })
  const [fitViewRequest, setFitViewRequest] = useState(0)
  const [focusNodeRequest, setFocusNodeRequest] = useState<{ id: string; nonce: number }>()
  const [layoutPreviewOpen, setLayoutPreviewOpen] = useState(false)
  const copiedNodeIdsRef = useRef<string[]>([])
  const internalClipboardRef = useRef<CanvasClipboardEnvelope | undefined>(undefined)
  const lastCanvasPointerRef = useRef<OverlayPosition | undefined>(undefined)
  const contextMenuDismissedAtRef = useRef(0)
  const snapshot = useStore(canvasStore, (state) => state.snapshot)
  const selectedNodeIds = useStore(canvasStore, (state) => state.selectedNodeIds)
  const imageSelectionGuardRef = useRef<(nodeId: string | null) => boolean>(() => true)

  const copySelectedNodes = useCallback(async (selectedIds: string[]) => {
    const envelope = createCanvasClipboardEnvelope(
      canvasStore.getState().snapshot,
      selectedIds,
      canvasId,
    )
    if (envelope.nodes.length === 0) return
    copiedNodeIdsRef.current = [...selectedIds]
    internalClipboardRef.current = envelope
    await writeCanvasClipboardEnvelope(envelope, navigator.clipboard ?? {})
    notify(`已复制 ${envelope.nodes.length} 个节点到剪贴板`, 'info')
  }, [canvasId, notify])

  const closeFloatingUi = useCallback(() => {
    setPopup(null)
    setContextMenu(null)
    setAddNodePosition(undefined)
  }, [])

  const dismissContextMenu = useCallback(() => {
    contextMenuDismissedAtRef.current = Date.now()
    setContextMenu(null)
  }, [])

  const closeProductPopup = useCallback(
    (kind: 'api-integration' | 'collaboration') => {
      setPopup(null)
      window.requestAnimationFrame(() => {
        document.getElementById(`${kind}-trigger`)?.focus()
      })
    },
    [],
  )

  const persistPreferences = useCallback(
    (changes: Partial<UiPreferences>) => {
      setPreferences((current) => {
        const next = { ...current, ...changes }
        try {
          saveUiPreferences(next)
        } catch (error) {
          notify(
            error instanceof Error ? error.message : '保存界面偏好失败',
            'error',
          )
        }
        return next
      })
    },
    [notify],
  )





  useAppHotkeys({
    hydrated,
    collaborationControllerRef,
    setActiveTool,
    performUndo,
    performRedo,
    copySelectedNodes,
    withBulkLease,
    notify,
  })

  useEffect(() => {
    let disposed = false
    let sharedSnapshotPending = false
    let unsubscribe = () => {}
    let unsubscribeCamera = () => {}
    let lastCapturedViewport = camera.getLocal()
    let isHydrated = false
    let applyingAgentRemote = false
    let agentSync: AgentCanvasSync | undefined
    const pendingSaves = new Set<Promise<void>>()
    const saveSession = canvasId
      ? createCanvasSaveSession({ canvasId, projectId, owner: workspaceRepository })
      : undefined
    setHydrated(false)
    setLoadedCanvasId(undefined)
    setLoadError(undefined)

    const submit = (save: CapturedCanvasSave) => {
      saveSession!.markQueued(save)
      let persisted = false
      const pending = workspaceRepository.saveCanvas(save.document)
        .then(() => {
          persisted = true
          if (agentSync?.isSynchronizing()) return
          if (!saveSession!.succeed(save)) return
          const document = save.document
          return saveSession!.publish(save, async () => {
            thumbnailService.schedule(document)
            if (disposed) void thumbnailService.flush(document.canvasId)
            return gatewayClient.syncCanvasAssetReferences({
              canvasId: document.canvasId,
              projectId: document.projectId,
              assetIds: [
                ...new Set(
                  document.nodes.flatMap((node) => {
                    const direct = 'assetId' in node.data && typeof node.data.assetId === 'string' ? [node.data.assetId] : []
                    const versions = node.type === 'image'
                      ? (node.data.versions ?? []).flatMap((version) => version.assetId ? [version.assetId] : [])
                      : []
                    return [...direct, ...versions]
                  }),
                ),
              ],
            })
          })
        })
        .catch((error: unknown) => {
          const current = persisted ? saveSession!.isLatest(save) : saveSession!.fail(save)
          if (!disposed && current && !agentSync?.isSynchronizing()) {
            notify(error instanceof Error ? error.message : '自动保存画布失败', 'error')
          }
        })
      pendingSaves.add(pending)
      void pending.finally(() => pendingSaves.delete(pending))
    }

    const flushLocalCamera = () => {
      if (!isHydrated || !saveSession || agentSync?.isSynchronizing()) return
      sharedSnapshotPending = collaborationControllerRef.current?.isLocalAutosaveSuppressed() ?? sharedSnapshotPending
      if (sharedSnapshotPending) return
      const viewport = camera.getLocal()
      if (viewport.x === lastCapturedViewport.x && viewport.y === lastCapturedViewport.y && viewport.zoom === lastCapturedViewport.zoom) return
      const save = saveSession.capture(canvasStore.getState().snapshot, viewport)
      if (save) { lastCapturedViewport = viewport; submit(save) }
    }
    const onVisibilityChange = () => { if (document.visibilityState === 'hidden') flushLocalCamera() }
    window.addEventListener('pagehide', flushLocalCamera)
    document.addEventListener('visibilitychange', onVisibilityChange)

    const hydrate = async () => {
      try {
        const canvasDocument = canvasId
          ? await workspaceRepository.loadCanvas(canvasId)
          : undefined
        if (canvasId && !canvasDocument) {
          throw new Error('当前画布不存在或已经移入回收站')
        }
        if (
          canvasDocument &&
          projectId &&
          canvasDocument.projectId !== projectId
        ) {
          throw new Error('画布归属与当前地址不一致')
        }
        const activeProjectId = canvasDocument ? null : readActiveProjectId()
        const activeProject = activeProjectId
          ? await defaultProjectRepository.loadProject(activeProjectId)
          : undefined
        let project = canvasDocument
          ? {
              version: 1 as const,
              projectId: canvasDocument.projectId,
              name: canvasDocument.name,
              viewport: canvasDocument.viewport,
              nodes: canvasDocument.nodes,
              edges: canvasDocument.edges,
            }
          : activeProject ?? (await ensureReferenceProject())

        if (disposed) return
        if (canvasDocument) saveSession!.acceptLoaded(canvasDocument)
        lastCapturedViewport = project.viewport
        camera.set(project.viewport, 'restore')
        canvasStore.getState().restore(JSON.stringify(project))
        if (!canvasDocument) saveActiveProjectId(project.projectId)
        setLoadedCanvasId(canvasId ?? null)
      } catch (error: unknown) {
        if (disposed) return
        saveSession?.failLoading()
        setLoadError(error instanceof Error ? error.message : '恢复本地项目失败')
        return
      }

      if (disposed) return
      isHydrated = true
      setHydrated(true)
      unsubscribeCamera = camera.subscribe(() => {
        sharedSnapshotPending = collaborationControllerRef.current?.isLocalAutosaveSuppressed() ?? sharedSnapshotPending
      })
      unsubscribe = canvasStore.subscribe((state, previous) => {
        if (state.snapshot === previous.snapshot || applyingAgentRemote) return
        const project = state.snapshot
        if (saveSession) {
          sharedSnapshotPending = collaborationControllerRef.current?.isLocalAutosaveSuppressed() ?? false
          if (sharedSnapshotPending) return
          if (project.viewport !== previous.snapshot.viewport) camera.set(project.viewport, 'restore')
          const save = saveSession.capture(project, camera.getLocal())
          if (save) { lastCapturedViewport = save.document.viewport; if (!agentSync?.isSynchronizing()) submit(save) }
          return
        }
        if (collaborationControllerRef.current?.isLocalAutosaveSuppressed()) return
        void defaultProjectPersistenceQueue
          .enqueue(project)
          .catch((error: unknown) =>
            notify(
              error instanceof Error ? error.message : '自动保存项目失败',
              'error',
            ),
          )
      })
      if (canvasId && saveSession && workspaceRepository.synchronizeCanvas) {
        agentSync = createAgentCanvasSync({
          canvasId,
          repository: workspaceRepository,
          readLocal: () => ({ ...canvasStore.getState().snapshot, version: 3, canvasId, viewport: camera.getLocal() }),
          isCollaborating: () => collaborationControllerRef.current?.isLocalAutosaveSuppressed() ?? false,
          flushLocal: async () => {
            flushLocalCamera()
            while (pendingSaves.size) await Promise.all([...pendingSaves])
          },
          prepareCollaboration: async () => {
            const controller = collaborationControllerRef.current
            if (!controller) throw new Error('协作连接尚未就绪')
            await controller.flushForAgent()
            return (await new AgentRuntimeClient().canvasRevision(canvasId)).expectedRevision
          },
          applyRemote: document => {
            if (disposed) return
            saveSession.acceptRemote(document)
            applyingAgentRemote = true
            try {
              canvasStore.getState().reconcileRemoteSnapshot({ ...document, version: 1 }, {
                rebaseHistory: true,
                onHistoryInvalidated: count => notify(`后台更新已同步，${count} 项会覆盖新内容的旧撤销记录已失效`, 'info'),
              })
            } finally { applyingAgentRemote = false }
          },
          onError: message => notify(message, 'error'),
        })
        beforeAgentRunRef.current = agentSync.beforeRun
        agentSyncCanvasRef.current = canvasId
        agentSync.start()
      }
    }

    void hydrate()

    return () => {
      const syncingAtClose = agentSync?.isSynchronizing()
      agentSync?.stop()
      if (beforeAgentRunRef.current === agentSync?.beforeRun) { beforeAgentRunRef.current = undefined; agentSyncCanvasRef.current = undefined }
      disposed = true
      flushLocalCamera()
      window.removeEventListener('pagehide', flushLocalCamera)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      unsubscribeCamera()
      unsubscribe()
      const pending = saveSession?.close()
      // The collaboration hook clears its controller before this cleanup runs.
      // Retain the captured snapshot's owner so shared changes stay on the Yjs path.
      if (pending && !sharedSnapshotPending && !syncingAtClose) submit(pending)
      if (canvasId && isHydrated) {
        void thumbnailService.flush(canvasId)
      }
    }
  }, [canvasId, loadAttempt, notify, projectId, thumbnailService, workspaceRepository])


  useEffect(() => {
    if (!followingMemberId) return
    if (collaborationState.status !== 'synced' || !collaborationPresence.some(
      (presence) => presence.member.memberId === followingMemberId,
    )) {
      setFollowingMemberId(undefined)
    }
  }, [collaborationPresence, collaborationState.status, followingMemberId])

  const setPresenceCursor = useCallback((cursor: { x: number; y: number } | null) => {
    collaborationControllerRef.current?.setCursor(cursor)
  }, [])
  const setPresenceSelection = useCallback((nodeIds: readonly string[]) => {
    collaborationControllerRef.current?.setSelection(nodeIds)
  }, [])
  const setPresenceViewport = useCallback((viewport: { x: number; y: number; zoom: number }) => {
    collaborationControllerRef.current?.setViewport(viewport)
  }, [])
  const stopFollowing = useCallback(() => setFollowingMemberId(undefined), [])

  const canvasCollaboration = useMemo(() => {
    if (!collaborationState.session) return undefined
    return {
      localMemberId: collaborationState.session.memberId,
      status: collaborationState.status,
      followingMemberId,
      onStopFollowing: stopFollowing,
      presence: collaborationPresence,
      setCursor: setPresenceCursor,
      setSelection: setPresenceSelection,
      setViewport: setPresenceViewport,
      acquireLease: (nodeIds: readonly string[], kind: NodeLeaseKind) =>
        collaborationControllerRef.current?.acquireLease(nodeIds, kind),
      releaseLease: () => collaborationControllerRef.current?.releaseLease(),
      getLease: (nodeId: string) => collaborationControllerRef.current?.getLease(nodeId),
      subscribeLeaseLost: (listener: (lease: NodeLease) => void) =>
        collaborationControllerRef.current?.subscribeLeaseLost(listener) ?? (() => undefined),
      setInteractionPreview: (preview: InteractionPreview) =>
        collaborationControllerRef.current?.setInteractionPreview(preview),
      clearPreview: () => collaborationControllerRef.current?.clearPreview(),
      setInteraction: (interaction: CollaborationInteraction) =>
        collaborationControllerRef.current?.setInteraction(interaction),
      clearInteraction: () => collaborationControllerRef.current?.clearInteraction(),
      withNodeLease: <T,>(
        nodeIds: readonly string[],
        kind: NodeLeaseKind,
        operation: () => T | Promise<T>,
      ): Promise<Awaited<T> | undefined> =>
        collaborationControllerRef.current?.withNodeLease(nodeIds, kind, operation) ??
        Promise.resolve(operation()),
    }
  }, [
    collaborationPresence,
    collaborationState.session,
    collaborationState.status,
    followingMemberId,
    setPresenceCursor,
    setPresenceSelection,
    setPresenceViewport,
    stopFollowing,
  ])

  const topbarCollaborationMembers = useMemo(() => {
    const roomMembers = (collaborationState.room?.members ?? []).filter((member) => !member.removed)
    const onlinePresenceMap = new Map(
      collaborationPresence.map((presence) => [presence.member.memberId, presence]),
    )

    const memberMap = new Map<string, { id: string; displayName: string; color: string; online: boolean }>()

    // 1. Add all registered room members
    for (const member of roomMembers) {
      const isOnline = onlinePresenceMap.has(member.id) || member.id === collaborationState.session?.memberId
      memberMap.set(member.id, {
        id: member.id,
        displayName: member.displayName,
        color: getCollaboratorColor(member.id),
        online: isOnline,
      })
    }

    // 2. Add current session if not in room.members yet
    const current = collaborationState.session
    if (current && !memberMap.has(current.memberId)) {
      memberMap.set(current.memberId, {
        id: current.memberId,
        displayName: current.displayName,
        color: getCollaboratorColor(current.memberId),
        online: true,
      })
    }

    // 3. Add any online presences
    for (const presence of collaborationPresence) {
      if (!memberMap.has(presence.member.memberId)) {
        memberMap.set(presence.member.memberId, {
          id: presence.member.memberId,
          displayName: presence.member.displayName,
          color: presence.member.color || getCollaboratorColor(presence.member.memberId),
          online: true,
        })
      }
    }

    const list = [...memberMap.values()]
    if (current) {
      const selfIndex = list.findIndex((m) => m.id === current.memberId)
      if (selfIndex > 0) {
        const [self] = list.splice(selfIndex, 1)
        if (self) list.unshift(self)
      }
    }
    return list
  }, [collaborationPresence, collaborationState.room?.members, collaborationState.session])

  useEffect(() => {
    if (popup !== 'collaboration') return
    const controller = collaborationControllerRef.current
    if (!controller) return
    void controller.refreshRoom().catch(() => undefined)
  }, [popup])

  useEffect(() => {
    const roomId = collaborationState.room?.roomId
    gatewayClient.setCollaborationRoomId(roomId)
    return () => gatewayClient.setCollaborationRoomId(undefined)
  }, [collaborationState.room?.roomId])

  useEffect(() => {
    if (!capabilities.canManageApi) {
      setProviderDrawerOpen(false)
      setPopup((current) => current === 'api-integration' ? null : current)
    }
  }, [capabilities.canManageApi])


  const openPanel = useCallback((nextPanel: SidePanelKind) => {
    closeFloatingUi()
    setHistoryOpen(false)
    setDialog(null)
    setPanel(nextPanel)
    persistPreferences({ lastOpenPanel: nextPanel })
  }, [closeFloatingUi, persistPreferences])

  const closePanel = () => {
    setPanel(null)
    persistPreferences({ lastOpenPanel: null })
  }

  const openGenerationHistory = useCallback(() => {
    closeFloatingUi()
    setProviderDrawerOpen(false)
    setDialog(null)
    setPanel(null)
    setHistoryOpen(true)
    persistPreferences({ lastOpenPanel: null })
  }, [closeFloatingUi, persistPreferences])

  const handleToolSelect = (tool: ToolDockTool) => {
    if (readOnly && !['select', 'more'].includes(tool)) return
    setContextMenu(null)
    canvasStore.getState().setMode('select')
    if (tool === 'undo') { performUndo(); return }
    if (tool === 'redo') { performRedo(); return }
    if (tool === 'upload') {
      setAddNodePosition(undefined)
      setPopup((current) => (current === 'add' ? null : 'add'))
      return
    }
    if (tool === 'more') { setPopup((current) => current === 'help' ? null : 'help'); return }
    setActiveTool(tool)
  }

  const setCanvasZoom = (nextZoom: number) => {
    const state = canvasStore.getState()
    const current = camera.getDisplay()
    const zoom = Math.min(8, Math.max(0.1, nextZoom))
    const center = getStageCenterPoint()
    const flowCenter = {
      x: (center.x - current.x) / current.zoom,
      y: (center.y - current.y) / current.zoom,
    }
    state.setViewport({
      x: center.x - flowCenter.x * zoom,
      y: center.y - flowCenter.y * zoom,
      zoom,
    })
  }

  const handleWorkspaceAction = (action: WorkspaceAction) => {
    if (collaborationRestricted && action !== 'rename') return
    if (readOnly && ['new', 'rename', 'duplicate', 'delete'].includes(action)) return
    if (action === 'home') {
      onNavigateWorkspace?.()
      return
    }
    if (action === 'new') {
      if (onNavigateWorkspace) {
        onNavigateWorkspace('project')
        return
      }
      void workspaceRepository
        .createCanvas('未命名画布')
        .then((canvas) => {
          onNavigateCanvas?.(canvas.canvasId, canvas.projectId)
        })
        .catch((error: unknown) =>
          notify(
            error instanceof Error ? error.message : '创建画布失败',
            'error',
          ),
        )
      return
    }
    if (action === 'settings') {
      setDialog('settings')
      return
    }
    if (action === 'rename') {
      setRenameProjectName(canvasStore.getState().snapshot.name)
      setDialog('rename')
      return
    }

    const activeSnapshot = canvasStore.getState().snapshot
    if (action === 'duplicate') {
      const targetId = canvasId || activeSnapshot.projectId
      void workspaceRepository
        .duplicateCanvas(targetId)
        .then((canvas) => {
          onNavigateCanvas?.(canvas.canvasId, canvas.projectId)
        })
        .catch((error: unknown) =>
          notify(
            error instanceof Error ? error.message : '复制画布失败',
            'error',
          ),
        )
      return
    }
    if (action === 'delete') {
      setDialog('delete')
    }
  }

  const handleAddNode = useMemo(() => {
    const addNode = (
      kind: AddNodeKind,
      content?: string,
      fileName?: string,
      assetId?: string,
      posterUrl?: string,
    ) => {
    if (readOnly && kind !== 'asset-library' && kind !== 'generation-history') return
    if (kind === 'asset-library') {
      setActiveLeftTab('assets')
      persistPreferences({ layersOpen: true })
      return
    }
    if (kind === 'generation-history') {
      openGenerationHistory()
      return
    }
    if (kind === 'upload') {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*,video/*,audio/*'
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) return
        try {
          const prepared = await uploadAndPrepareMediaAsset(file)
          addNode(prepared.kind, prepared.url, file.name, prepared.assetId, prepared.posterUrl)
        } catch (error: unknown) {
          notify(
            error instanceof Error ? error.message : '上传本地文件失败',
            'error',
          )
        }
      }
      input.click()
      return
    }

    const commitNode = (mediaUrl = content ?? '') => {
      const id = createLocalNodeId(kind)
      const displayViewport = camera.getDisplay()
      const zoom = Math.max(displayViewport.zoom, 0.01)
      const name = fileName || addNodeLabels[kind]
      let node: CanvasNode
      const size =
        kind === 'image' || kind === 'reference-image' || kind === 'style-shot'
          ? { width: 480, height: 320 }
          : kind === 'video' || kind === 'video-story'
            ? { width: 480, height: 270 }
            : kind === 'video-compose'
              ? { width: 480, height: 270 }
              : kind === 'director'
                ? { width: 560, height: 360 }
                : kind === 'audio'
                  ? { width: 480, height: 240 }
                  : kind === 'script'
                    ? { width: 420, height: 300 }
            : kind === 'group' ||
                kind === 'storyboard' ||
                kind === 'blank-scene'
              ? { width: 520, height: 360 }
              : { width: 420, height: 220 }
      const stageCenter = getStageCenterPoint()
      const position = addNodePosition
        ? {
            x:
              (addNodePosition.x - displayViewport.x) / zoom -
              size.width / 2,
            y:
              (addNodePosition.y - displayViewport.y) / zoom -
              size.height / 2,
          }
        : {
            x: (stageCenter.x - displayViewport.x) / zoom - size.width / 2,
            y: (stageCenter.y - displayViewport.y) / zoom - size.height / 2,
          }

      if (
        kind === 'image' ||
        kind === 'reference-image' ||
        kind === 'style-shot'
      ) {
        node = {
          id,
          type: 'image',
          name,
          position,
          size,
          data: { url: mediaUrl, assetId, alt: name },
        }
      } else if (kind === 'video' || kind === 'video-story') {
        node = {
          id,
          type: 'video',
          name,
          position,
          size,
          data: { url: mediaUrl, poster: posterUrl, assetId },
        }
      } else if (
        kind === 'video-compose' ||
        kind === 'director' ||
        kind === 'group' ||
        kind === 'storyboard' ||
        kind === 'blank-scene'
      ) {
        node = {
          id,
          type: 'group',
          name:
            kind === 'video-compose'
              ? '视频合成'
              : kind === 'director'
                ? '导演台'
                : name,
          position,
          size,
          data: {
            childIds: [],
            nodeKind:
              kind === 'video-compose'
                ? 'video-clip'
                : kind === 'director'
                  ? 'director'
                  : 'group',
          },
        }
      } else {
        node = {
          id,
          type: 'text',
          name:
            kind === 'audio'
              ? '音频节点'
              : kind === 'script'
                ? '脚本节点'
                : name,
          position,
          size,
          data: {
            text: kind === 'audio' ? '' : content ?? '',
            ...(kind === 'audio' ? { url: mediaUrl, assetId } : {}),
            nodeKind:
              kind === 'audio'
                ? 'audio'
                : kind === 'script'
                  ? 'script'
                  : 'text',
          },
        }
      }

      canvasStore.getState().addNode(node)
      canvasStore.getState().selectNode(node.id)
    }

    commitNode()
    }
    return addNode
  }, [addNodePosition, notify, openGenerationHistory, openPanel, readOnly])

  const { importClipboardContents } = useCanvasClipboard({
    store: canvasStore,
    hydrated,
    readOnly,
    notify,
    lastCanvasPointerRef,
    copiedNodeIdsRef,
    internalClipboardRef,
  })

  const handleHelpAction = (action: HelpAction) => {
    if (action === 'guide') setPopup(null)
  }

  const handleBlankContextAction = (action: BlankContextAction) => {
    if (action === 'undo') performUndo()
    else if (action === 'redo') performRedo()
    else if (readOnly) return
    else if (action === 'upload') handleAddNode('upload')
    else if (action === 'add-node') {
      setAddNodePosition(contextPosition)
      setPopup('add')
    } else if (action === 'paste') {
      void readClipboardContents(navigator.clipboard ?? {})
        .then(importClipboardContents)
        .catch((error: unknown) => {
          if (internalClipboardRef.current) {
            void importClipboardContents({ files: [], html: '', text: '', internal: '' })
              .catch((err) => notify(err instanceof Error ? err.message : '无法粘贴内容', 'error'))
            return
          }
          notify(
            error instanceof Error ? error.message : '浏览器未允许读取剪贴板',
            'error',
          )
        })
    }
  }

  const handleNodeContextAction = (action: NodeContextAction) => {
    if (
      readOnly &&
      action !== 'copy-node' &&
      action !== 'copy-to-clipboard' &&
      action !== 'copy-image'
    ) {
      return
    }
    const selectedIds = canvasStore.getState().selectedNodeIds
    if (action === 'toggle-lock') {
      const snapshot = canvasStore.getState().snapshot
      const isAnyLocked = selectedIds.some((id) => snapshot.nodes.find((n) => n.id === id)?.locked)
      const nextLocked = !isAnyLocked
      for (const id of selectedIds) {
        canvasStore.getState().setNodeLocked(id, nextLocked)
      }
      notify(nextLocked ? '已固定节点' : '已解除固定', 'info')
      return
    }
    if (action === 'delete') {
      canvasStore.getState().deleteNodes(selectedIds)
      return
    }
    if (action === 'save-asset') {
      const selectedId = selectedIds[0]
      const node = canvasStore.getState().snapshot.nodes.find((n) => n.id === selectedId)
      if (node) {
        void assetRegistry.registerNodeAsAsset(node, canvasStore.getState().snapshot.projectId)
          .then((saved) => {
            if (saved) {
              notify(`已将「${saved.name}」存入资产库`, 'success')
            } else {
              notify('当前节点不支持存入资产库', 'warning')
            }
          })
          .catch((err) => {
            notify(err instanceof Error ? err.message : '保存到资产失败', 'error')
          })
      }
      return
    }
    if (action === 'duplicate') {
      withBulkLease(selectedIds, () => canvasStore.getState().duplicateNodes(selectedIds))
      return
    }
    if (action === 'copy-node' || action === 'copy-to-clipboard') {
      void copySelectedNodes(selectedIds)
        .catch(() => notify('浏览器未允许写入剪贴板', 'error'))
      return
    }
    if (action === 'copy-image') {
      const snapshot = canvasStore.getState().snapshot
      const node = snapshot.nodes.find(
        (n) => selectedIds.includes(n.id) && n.type === 'image',
      )
      if (!node || node.type !== 'image' || !node.data?.url) {
        notify('当前节点未包含有效图片数据', 'warning')
        return
      }
      const envelope = createCanvasClipboardEnvelope(snapshot, [node.id], canvasId)
      internalClipboardRef.current = envelope
      copiedNodeIdsRef.current = [node.id]
      void copyImageToClipboard(node.data.url)
        .then((result) => {
          if (result?.fallback) {
            notify('已复制图片内容与链接（当前网络环境不支持直接写入图片文件）', 'info')
          } else {
            notify('已复制图片到剪贴板', 'info')
          }
        })
        .catch((error: unknown) =>
          notify(
            error instanceof Error ? error.message : '无法复制图片到剪贴板',
            'error',
          ),
        )
      return
    }
    if (action === 'paste') {
      void readClipboardContents(navigator.clipboard ?? {})
        .then(importClipboardContents)
        .catch((error: unknown) => {
          if (internalClipboardRef.current) {
            void importClipboardContents({ files: [], html: '', text: '', internal: '' })
              .catch((err) => notify(err instanceof Error ? err.message : '无法粘贴内容', 'error'))
            return
          }
          notify(
            error instanceof Error ? error.message : '浏览器未允许读取剪贴板',
            'error',
          )
        })
      return
    }
  }

  const handleSelectionAction = (action: SelectionAction) => {
    if (readOnly && action !== 'copy' && action !== 'save-assets') return
    const state = canvasStore.getState()
    if (action === 'save-assets') {
      const selectedNodes = state.snapshot.nodes.filter((node) => state.selectedNodeIds.includes(node.id))
      const mediaNodes = selectedNodes.filter((node) => node.type === 'image' || node.type === 'video')
      if (mediaNodes.length === 0) {
        notify('请选择包含图片、视频或音频的节点', 'info')
        return
      }
      void Promise.all(mediaNodes.map((node) => assetRegistry.registerNodeAsAsset(node, state.snapshot.projectId)))
        .then((entries) => {
          const valid = entries.filter(Boolean)
          if (valid.length > 0) {
            notify(`已成功保存 ${valid.length} 个素材到资产库`, 'success')
          } else {
            notify('未找到可保存的有效媒体内容', 'warning')
          }
        })
        .catch((err) => {
          notify(err instanceof Error ? err.message : '保存到资产失败', 'error')
        })
      return
    }
    if (action === 'copy') {
      void copySelectedNodes(state.selectedNodeIds)
        .catch(() => notify('浏览器未允许写入剪贴板', 'error'))
      return
    }
    if (action === 'duplicate') {
      withBulkLease(state.selectedNodeIds, () => state.duplicateNodes(state.selectedNodeIds))
      return
    }
    if (action === 'group') {
      const groupId = createLocalNodeId('group')
      withBulkLease(state.selectedNodeIds, () => state.groupNodes(
        state.selectedNodeIds,
        groupId,
        '节点分组',
      ))
      return
    }
    if (action === 'ungroup') {
      withBulkLease(state.selectedNodeIds, () => state.ungroupNodes(state.selectedNodeIds))
      return
    }
    if (action === 'layout') {
      withBulkLease(state.selectedNodeIds, () => state.layoutNodes(state.selectedNodeIds))
      return
    }
  }

  if (loadError) {
    return (
      <main className="workspace-home-loading" data-testid="app-shell" data-hydrated="false" data-load-state="error">
        <section role="alert">
          <h1>无法打开画布</h1>
          <p>{loadError}</p>
          <button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>重新加载画布</button>
          {onNavigateWorkspace
            ? <button onClick={() => onNavigateWorkspace()}>返回工作区</button>
            : <a href="/">返回工作区</a>}
        </section>
      </main>
    )
  }

  return (
    <main
      ref={appShellRef}
      aria-busy={!hydrated}
      className="app-shell"
      data-hydrated={hydrated}
      data-testid="app-shell"
      data-layers-open={preferences.layersOpen || undefined}
      data-layers-resizing={layersResizing || undefined}
      data-inspector-resizing={inspectorResizing || undefined}
      inert={!hydrated}
      style={{
        '--layers-sidebar-width': `${Math.min(layersWidth, Math.floor(window.innerWidth * 0.7))}px`,
        '--inspector-sidebar-width': `${Math.min(inspectorWidth, Math.floor(window.innerWidth * 0.5))}px`,
      } as CSSProperties}
    >
      <aside
        className="app-layer-sidebar"
      >
        <div className="app-layer-sidebar__rail">
          <button
            aria-label="打开工作区菜单"
            className="app-layer-sidebar__logo-btn"
            onClick={() => setPopup((current) => current === 'workspace' ? null : 'workspace')}
            title="工作区与画布"
            type="button"
          >
            <LibTvLogo size={16} variant="outline" />
          </button>
          <div className="app-layer-sidebar__rail-divider" />
          <button
            aria-label={preferences.layersOpen ? '图层' : '展开图层'}
            className={`app-layer-sidebar__rail-btn ${preferences.layersOpen && activeLeftTab === 'layers' ? 'app-layer-sidebar__rail-btn--active' : ''}`}
            onClick={() => {
              if (!preferences.layersOpen) {
                setActiveLeftTab('layers')
                persistPreferences({ layersOpen: true })
              } else if (activeLeftTab === 'layers') {
                persistPreferences({ layersOpen: false })
              } else {
                setActiveLeftTab('layers')
              }
              setPopup(null)
            }}
            title={preferences.layersOpen ? '图层树 (Ctrl+\\)' : '展开图层 (Ctrl+\\)'}
            type="button"
          >
            <Layers3 size={15} strokeWidth={1.6} />
            <span className="app-layer-sidebar__rail-label">图层</span>
          </button>
          <button
            aria-label={preferences.layersOpen ? '演化' : '展开演化'}
            className={`app-layer-sidebar__rail-btn ${preferences.layersOpen && activeLeftTab === 'lineage' ? 'app-layer-sidebar__rail-btn--active' : ''}`}
            onClick={() => {
              if (!preferences.layersOpen) {
                setActiveLeftTab('lineage')
                persistPreferences({ layersOpen: true })
              } else if (activeLeftTab === 'lineage') {
                persistPreferences({ layersOpen: false })
              } else {
                setActiveLeftTab('lineage')
              }
              setPopup(null)
            }}
            title="AI 演化谱系"
            type="button"
          >
            <GitBranch size={15} strokeWidth={1.6} />
            <span className="app-layer-sidebar__rail-label">演化</span>
          </button>
          <button
            aria-label="资产管理"
            className={`app-layer-sidebar__rail-btn ${preferences.layersOpen && activeLeftTab === 'assets' ? 'app-layer-sidebar__rail-btn--active' : ''}`}
            onClick={() => {
              if (!preferences.layersOpen) {
                setActiveLeftTab('assets')
                persistPreferences({ layersOpen: true })
              } else if (activeLeftTab === 'assets') {
                persistPreferences({ layersOpen: false })
              } else {
                setActiveLeftTab('assets')
              }
              setPopup(null)
            }}
            title="资产库"
            type="button"
          >
            <Package size={15} strokeWidth={1.6} />
            <span className="app-layer-sidebar__rail-label">资产</span>
          </button>
          <button
            aria-label="Agent 助手"
            className={`app-layer-sidebar__rail-btn ${preferences.layersOpen && activeLeftTab === 'agent' ? 'app-layer-sidebar__rail-btn--active' : ''}`}
            onClick={() => {
              if (!preferences.layersOpen) {
                setActiveLeftTab('agent')
                persistPreferences({ layersOpen: true })
              } else if (activeLeftTab === 'agent') {
                persistPreferences({ layersOpen: false })
              } else {
                setActiveLeftTab('agent')
              }
              setPopup(null)
            }}
            title="Agent 智能助手"
            type="button"
          >
            <Bot size={15} strokeWidth={1.6} />
            <span className="app-layer-sidebar__rail-label">Agent</span>
          </button>
          <button
            aria-label="设置"
            className="app-layer-sidebar__rail-btn"
            onClick={() => setDialog('settings')}
            style={{ marginTop: 'auto' }}
            title="系统设置"
            type="button"
          >
            <Settings size={15} strokeWidth={1.6} />
            <span className="app-layer-sidebar__rail-label">设置</span>
          </button>
        </div>
        <div
          aria-hidden={!preferences.layersOpen}
          className="app-layer-sidebar__content"
          data-testid="layers-sidebar"
          inert={!preferences.layersOpen}
        >
          <div className="app-layer-sidebar__header">
            <WorkspaceMenu
              canvasName={snapshot.name}
              collaborationRestricted={collaborationRestricted}
              onClick={() => setPopup((current) => current === 'workspace' ? null : 'workspace')}
              testId="workspace-control-sidebar"
              workspaceName={projectName ?? '未命名工作区'}
            />
            {preferences.layersOpen && onSyncStatusHost && <div className="canvas-save-status" ref={onSyncStatusHost} />}
            <button
              aria-label="收起图层"
              className="app-layer-sidebar__toggle-btn"
              onClick={() => persistPreferences({ layersOpen: false })}
              title="收起图层 (Ctrl+\)"
              type="button"
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
          {activeLeftTab === 'layers' && (
            <LayersPanel
              nodes={snapshot.nodes}
              onFocusNode={(id) => {
                if (imageSelectionGuardRef.current(id)) {
                  canvasStore.getState().selectNode(id)
                }
                setFocusNodeRequest({ id, nonce: Date.now() })
              }}
              onOpenChange={(layersOpen) => persistPreferences({ layersOpen })}
              onRename={(id, name) => canvasStore.getState().renameNode(id, name)}
              onReorder={(ids, targetId, placement) => canvasStore.getState().reorderNodes(ids, targetId, placement)}
              onSelect={(id, options) => {
                if (!imageSelectionGuardRef.current(id)) return
                if (options?.range && options.rangeIds && options.rangeIds.length > 0) {
                  canvasStore.getState().selectNodes(options.rangeIds, false)
                  return
                }
                canvasStore.getState().selectNode(id, options?.additive)
              }}
              onToggleHidden={(id) => canvasStore.getState().setNodeVisibility(id, Boolean(snapshot.nodes.find((node) => node.id === id)?.hidden))}
              onToggleLocked={(id) => canvasStore.getState().setNodeLocked(id, !snapshot.nodes.find((node) => node.id === id)?.locked)}
              open={preferences.layersOpen}
              selectedIds={selectedNodeIds}
            />
          )}
          {activeLeftTab === 'lineage' && (
            <LineageSidebarPanel
              edges={snapshot.edges}
              nodes={snapshot.nodes}
              onFocusNode={(id) => {
                if (imageSelectionGuardRef.current(id)) {
                  canvasStore.getState().selectNode(id)
                }
                setFocusNodeRequest({ id, nonce: Date.now() })
              }}
              onNotify={notify}
              onSelect={(id) => {
                if (imageSelectionGuardRef.current(id)) canvasStore.getState().selectNode(id)
              }}
              selectedIds={selectedNodeIds}
            />
          )}
          {activeLeftTab === 'assets' && (
            <AssetsSidebarPanel
              onInsertAsset={(asset) => {
                if (readOnly) return
                const state = canvasStore.getState()
                const viewport = camera.getDisplay()
                const zoom = Math.max(viewport.zoom, 0.01)
                const stageCenter = getStageCenterPoint()
                const centerPos = {
                  x: (stageCenter.x - viewport.x) / zoom,
                  y: (stageCenter.y - viewport.y) / zoom,
                }
                const nodeId = `asset-${asset.type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
                if (asset.type === 'video') {
                  state.addNode({
                    id: nodeId,
                    type: 'video',
                    name: asset.name,
                    position: centerPos,
                    size: { width: asset.width || 480, height: asset.height || 270 },
                    data: {
                      url: asset.url,
                      poster: asset.posterUrl || asset.thumbnailUrl,
                    },
                  })
                } else {
                  state.addNode({
                    id: nodeId,
                    type: 'image',
                    name: asset.name,
                    position: centerPos,
                    size: { width: asset.width || 400, height: asset.height || 400 },
                    data: {
                      url: asset.url,
                    },
                  })
                }
              }}
              onNotify={notify}
              projectId={snapshot.projectId}
            />
          )}
          {activeLeftTab === 'agent' && (
            <AgentSidebarPanel
              canvasId={canvasId}
              onBeforeRun={prepareAgentRun}
              onNotify={notify}
              onOpenProviderDrawer={() => {
                setProviderDrawerTab('agent')
                setProviderDrawerOpen(true)
              }}
              readOnly={
                readOnly ||
                (Boolean(collaborationState.session) &&
                  collaborationState.session?.role !== 'owner')
              }
            />
          )}
          {preferences.layersOpen && (
            <div
              aria-label="调整图层侧栏宽度"
              aria-orientation="vertical"
              aria-valuemax={Math.min(MAX_LAYERS_WIDTH, Math.floor(window.innerWidth * 0.7))}
              aria-valuemin={MIN_LAYERS_WIDTH}
              aria-valuenow={layersWidth}
              className="app-layer-sidebar__resize-handle"
              onMouseDown={startLayersResize}
              onKeyDown={resizeLayersByKeyboard}
              role="separator"
            />
          )}
        </div>
      </aside>
      <section
        ref={canvasStageRef}
        className="canvas-stage"
        onPointerMove={(event) => {
          lastCanvasPointerRef.current = { x: event.clientX, y: event.clientY }
        }}
      >
        {!preferences.layersOpen && (
          <>
            <div className="canvas-top-left-controls">
              <div className="canvas-top-left-pill" data-testid="canvas-top-left-pill">
                <WorkspaceMenu
                  canvasName={snapshot.name}
                  collaborationRestricted={collaborationRestricted}
                  onClick={() => setPopup((current) => current === 'workspace' ? null : 'workspace')}
                  testId="workspace-control-floating"
                  workspaceName={projectName ?? '未命名工作区'}
                />
                <div className="canvas-top-left-pill__divider" />
                <button
                  aria-label="展开侧边栏"
                  className="canvas-floating-expand-btn"
                  onClick={() => persistPreferences({ layersOpen: true })}
                  title="展开侧边栏 (Ctrl+\)"
                  type="button"
                >
                  <PanelLeftOpen size={14} />
                </button>
              </div>
              {onSyncStatusHost && <div className="canvas-save-status" ref={onSyncStatusHost} />}
            </div>

            <div
              className="canvas-top-right-pill"
              data-collaboration-status={collaborationState.status}
              data-testid="top-bar"
            >
              <div
                className="inspector-top-bar__avatars"
                onClick={() => {
                  setProviderDrawerOpen(false)
                  setContextMenu(null)
                  setAddNodePosition(undefined)
                  setPopup((current) => current === 'collaboration' ? null : 'collaboration')
                }}
                title={topbarCollaborationMembers && topbarCollaborationMembers.length > 0 ? `协作成员 (${topbarCollaborationMembers.length}人)` : (collaborationState.session?.displayName ? `当前用户：${collaborationState.session.displayName}` : '暂无协作者')}
              >
                {topbarCollaborationMembers && topbarCollaborationMembers.length > 0 ? (
                  topbarCollaborationMembers.map((member, idx) => {
                    const isOnline = member.online !== false
                    return (
                      <div
                        key={member.id || idx}
                        className={`inspector-top-bar__avatar-bubble ${!isOnline ? 'inspector-top-bar__avatar-bubble--offline' : ''}`}
                        style={{ background: member.color || '#0d99ff', zIndex: 10 - idx }}
                        title={`${member.displayName}${isOnline ? ' (在线)' : ' (离线)'}`}
                      >
                        {(member.displayName || '名').trim().slice(0, 1).toUpperCase()}
                      </div>
                    )
                  })
                ) : (
                  <div
                    className="inspector-top-bar__avatar-bubble inspector-top-bar__avatar-bubble--none"
                    style={{ background: '#475569' }}
                  >
                    {collaborationState.session?.displayName ? collaborationState.session.displayName.trim().slice(0, 1).toUpperCase() : '无'}
                  </div>
                )}
              </div>

              <button
                aria-label="API 接入与模型"
                className="inspector-top-bar__icon-btn"
                onClick={() => {
                  setProviderDrawerOpen(true)
                  setPopup(null)
                }}
                title="API 接入与模型设置"
                type="button"
              >
                <Cpu size={14} />
              </button>

              <button
                aria-label="多人协作"
                className={`inspector-top-bar__share-btn ${collaborationState.status === 'synced' ? 'inspector-top-bar__share-btn--synced' : ''}`}
                onClick={() => {
                  setProviderDrawerOpen(false)
                  setContextMenu(null)
                  setAddNodePosition(undefined)
                  setPopup((current) => current === 'collaboration' ? null : 'collaboration')
                }}
                title="多人协作"
                type="button"
              >
                <UsersRound size={12} />
                <span>协作</span>
                {topbarCollaborationMembers && topbarCollaborationMembers.length > 1 && (
                  <span className="inspector-top-bar__share-badge">
                    {topbarCollaborationMembers.length}
                  </span>
                )}
              </button>
            </div>
          </>
        )}
      {hydrated ? (
        <>
        <CanvasWorkspace
          camera={camera}
          activeTool={activeTool}
          onToolComplete={() => setActiveTool('select')}
          editingPathNodeId={editingPathNodeId}
          onEditingPathNodeChange={setEditingPathNodeId}
          canvasId={canvasId}
          canGenerate={capabilities.canPublish}
          collaboration={canvasCollaboration}
          fitViewRequest={fitViewRequest}
          focusNodeRequest={focusNodeRequest}
          hideConnections={preferences.hideConnections}
          readOnly={readOnly}
          onSelectionAction={handleSelectionAction}
          onGenerationError={(message) => notify(message, 'error')}
          onImageEditingStateChange={(state) => { imageSelectionGuardRef.current = state.requestSelect ?? (() => true) }}
          showMiniMap={preferences.showMiniMap}
          onNodeContextMenu={(nodeId, position) => {
            if (!imageSelectionGuardRef.current(nodeId)) return
            closeFloatingUi()
            canvasStore.getState().selectNode(nodeId)
            setContextPosition(position)
            setContextMenu('node')
          }}
          onPaneContextMenu={(position) => {
            if (contextMenu) {
              setContextMenu(null)
              return
            }
            closeFloatingUi()
            contextMenuDismissedAtRef.current = 0
            lastCanvasPointerRef.current = position
            setContextPosition(position)
            setContextMenu('blank')
          }}
          onPaneClick={() => {
            if (contextMenu) dismissContextMenu()
          }}
          onPaneDoubleClick={(position) => {
            const followsMenuDismissal =
              Date.now() - contextMenuDismissedAtRef.current <= 500
            if (contextMenu || followsMenuDismissal) {
              contextMenuDismissedAtRef.current = 0
              setContextMenu(null)
              return
            }
            closeFloatingUi()
            canvasStore.getState().setMode('select')
            setActiveTool('select')
            setAddNodePosition(position)
            setPopup('add')
          }}
          snapToGrid={preferences.snapToGrid}
          smartSnap={preferences.smartSnap}
        />
        </>
      ) : (
        <div className="canvas-stage__loading" aria-busy="true" />
      )}

      </section>
      <div className="canvas-controls">
      <BottomStatusBar
        hideConnections={preferences.hideConnections}
        historyOpen={historyOpen}
        onHistory={() => setHistoryOpen(true)}
        onFitCanvas={() => {
          setFitViewRequest((current) => current + 1)
        }}
        onLayout={() => {
          if (readOnly) return
          const ids = canvasStore.getState().snapshot.nodes.map((node) => node.id)
          withBulkLease(ids, () => {
            if (layoutPreviewOpen) performUndo()
            canvasStore.getState().layoutNodes()
            setLayoutPreviewOpen(true)
          })
        }}
        onToggleConnections={() => {
          const hideConnections = !preferences.hideConnections
          persistPreferences({ hideConnections })
        }}
        onToggleMiniMap={() =>
          persistPreferences({ showMiniMap: !preferences.showMiniMap })
        }
        onToggleSnap={() => persistPreferences({ smartSnap: !preferences.smartSnap })}
        onToggleGridSnap={() => persistPreferences({ snapToGrid: !preferences.snapToGrid })}
        onZoomIn={() => setCanvasZoom(camera.getDisplay().zoom * 1.2)}
        onZoomOut={() => setCanvasZoom(camera.getDisplay().zoom / 1.2)}
        onZoomTo={setCanvasZoom}
        showMiniMap={preferences.showMiniMap}
        snapToGrid={preferences.snapToGrid}
        smartSnap={preferences.smartSnap}
        zoom={snapshot.viewport.zoom * 100}
      />
      <ToolDock activeTool={activeTool} onToolSelect={handleToolSelect} />
      <LayoutDecisionBar
        onKeep={() => setLayoutPreviewOpen(false)}
        onRestore={() => {
          performUndo()
          setLayoutPreviewOpen(false)
        }}
        open={layoutPreviewOpen}
      />
      </div>

      <InspectorPanel
        collapsed={!preferences.layersOpen}
        collaborationMembers={topbarCollaborationMembers}
        collaborationStatus={collaborationState.status}
        currentNickname={collaborationState.session?.displayName}
        onOpenApiManagement={() => {
          setProviderDrawerTab('media')
          setProviderDrawerOpen(true)
          setPopup(null)
        }}
        onOpenCollaboration={() => {
          setProviderDrawerOpen(false)
          setContextMenu(null)
          setAddNodePosition(undefined)
          setPopup((current) =>
            current === 'collaboration' ? null : 'collaboration',
          )
        }}
        onOpenSettings={() => setDialog('settings')}
        onStartResize={startInspectorResize}
        onStartVectorEdit={(nodeId) =>
          setEditingPathNodeId((prev) => (prev === nodeId ? null : nodeId))
        }
        isEditingVector={Boolean(editingPathNodeId)}
        readOnly={readOnly}
        store={canvasStore}
      />

      <AppOverlays
        popup={popup}
        setPopup={setPopup}
        dialog={dialog}
        setDialog={setDialog}
        contextMenu={contextMenu}
        contextPosition={contextPosition}
        addNodePosition={addNodePosition}
        providerDrawerOpen={providerDrawerOpen}
        setProviderDrawerOpen={setProviderDrawerOpen}
        providerDrawerTab={providerDrawerTab}
        historyOpen={historyOpen}
        setHistoryOpen={setHistoryOpen}
        assetManagerOpen={assetManagerOpen}
        setAssetManagerOpen={setAssetManagerOpen}
        panel={panel}
        closePanel={closePanel}
        handleAddNode={handleAddNode}
        handleWorkspaceAction={handleWorkspaceAction}
        handleHelpAction={handleHelpAction}
        handleBlankContextAction={handleBlankContextAction}
        handleNodeContextAction={handleNodeContextAction}
        closeFloatingUi={closeFloatingUi}
        dismissContextMenu={dismissContextMenu}
        closeProductPopup={closeProductPopup}
        collaborationState={collaborationState}
        collaborationPresence={collaborationPresence}
        followingMemberId={followingMemberId}
        setFollowingMemberId={setFollowingMemberId}
        collaborationControllerRef={collaborationControllerRef}
        collaborationAction={collaborationAction}
        collaborationRestricted={collaborationRestricted}
        capabilities={capabilities}
        readOnly={readOnly}
        canvasId={canvasId}
        snapshot={snapshot}
        selectedNodeIds={selectedNodeIds}
        renameProjectName={renameProjectName}
        setRenameProjectName={setRenameProjectName}
        workspaceRepository={workspaceRepository}
        onNavigateCanvas={onNavigateCanvas}
        onNavigateWorkspace={onNavigateWorkspace}
        notify={notify}
      />
      <ToastRegion
        onDismiss={dismissToast}
        toasts={toasts}
      />
    </main>
  )
}
