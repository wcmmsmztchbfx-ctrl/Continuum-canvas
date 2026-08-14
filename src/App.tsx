import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { useStore } from 'zustand'

import { CanvasWorkspace, LayersPanel } from './components/canvas'
import {
  AddNodeMenu,
  ApiIntegrationPopover,
  BlankContextMenu,
  CollaborationNicknameDialog,
  CollaborationPopover,
  ConfirmDialog,
  GenerationHistoryModal,
  HelpPopover,
  KeyboardShortcutsDialog,
  LayoutDecisionBar,
  NodeContextMenu,
  PublishDialog,
  RenameProjectDialog,
  SidePanel,
  ToastRegion,
  useToastQueue,
  WorkspaceDropdown,
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
  ToolDock,
  TopBar,
  WorkspaceMenu,
  type ShellMode,
  type ToolDockTool,
} from './components/shell'
import {
  bootstrapReferenceProject,
  defaultProjectPersistenceQueue,
  defaultProjectRepository,
  loadUiPreferences,
  MAX_LAYERS_WIDTH,
  MIN_LAYERS_WIDTH,
  normalizeLayersWidth,
  saveUiPreferences,
  type UiPreferences,
} from './persistence'
import { CANVAS_SNAPSHOT_VERSION } from './model/project'
import {
  defaultWorkspaceRepository,
  type WorkspaceRepository,
} from './workspace'
import { gatewayClient, MockApi, persistLocalMedia } from './services'
import { canvasStore } from './store/canvas-store'
import type { CanvasNode, ProjectSnapshot } from './model/project'
import {
  canvasThumbnailService,
  type CanvasThumbnailService,
} from './thumbnails/canvasThumbnail'
import {
  CanvasCollaborationController,
  type CollaborationControllerState,
} from './collaboration/controller'
import { collaborationCapabilities } from './collaboration/capabilities'
import type { CollaborationInteraction, InteractionPreview, NodeLease, NodeLeaseKind, PresenceState } from './contracts/collaboration'
import { useOptionalProviderCatalog } from './components/providers/ProviderCatalogContext'
import { createBrowserUuid } from './utils/id'
import {
  contentsFromDataTransfer,
  createCanvasClipboardEnvelope,
  detectMediaKind,
  persistRemoteClipboardMedia,
  readClipboardContents,
  resolveClipboardContents,
  writeCanvasClipboardEnvelope,
  type CanvasClipboardEnvelope,
  type ClipboardContents,
} from './clipboard-import'

const ProviderDrawer = lazy(() =>
  import('./components/providers/ProviderDrawer').then((module) => ({
    default: module.ProviderDrawer,
  })),
)

type Popup =
  | 'workspace'
  | 'add'
  | 'api-integration'
  | 'collaboration'
  | 'help'
  | null
type Dialog = 'publish' | 'shortcuts' | 'delete' | 'rename' | null
type ContextMenu = 'blank' | 'node' | null

const sidePanelKinds: ReadonlyArray<SidePanelKind> = [
  'project-files',
  'canvases',
  'assets',
  'templates',
  'styles',
  'characters',
  'history',
  'agent',
]

const mockApi = new MockApi()
const ACTIVE_PROJECT_STORAGE_KEY = 'libtv.active-project.v1'
let bootstrapPromise: ReturnType<typeof bootstrapReferenceProject> | undefined
let workspacePromise: ReturnType<MockApi['createWorkspace']> | undefined

function ensureReferenceProject() {
  bootstrapPromise ??= bootstrapReferenceProject()
  return bootstrapPromise
}

function ensureMockWorkspace() {
  workspacePromise ??= mockApi.createWorkspace('未命名工作区')
  return workspacePromise
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

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand?.('copy') ?? false
  textarea.remove()
  if (!copied) throw new Error('浏览器未允许写入剪贴板')
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
  canvasId?: string
  projectId?: string
  projectName?: string
  onNavigateCanvas?: (canvasId: string, projectId: string) => void
  onNavigateWorkspace?: (create?: 'project' | 'canvas') => void
  workspaceRepository?: WorkspaceRepository
  thumbnailService?: Pick<CanvasThumbnailService, 'schedule' | 'flush'>
}

export default function App({
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
  const [preferences, setPreferences] = useState<UiPreferences>(() =>
    loadUiPreferences(),
  )
  const [layersWidth, setLayersWidth] = useState(preferences.layersWidth)
  const [layersResizing, setLayersResizing] = useState(false)
  const layersResizeRef = useRef<{
    startX: number
    startWidth: number
    width: number
    cleanup: () => void
  } | undefined>(undefined)
  const [mode, setMode] = useState<ShellMode>('workflow')
  const [activeTool, setActiveTool] = useState<ToolDockTool>('select')
  const [popup, setPopup] = useState<Popup>(null)
  const [providerDrawerOpen, setProviderDrawerOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
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
  const [publishDescription, setPublishDescription] = useState('')
  const [renameProjectName, setRenameProjectName] = useState('')
  const [publishVisibility, setPublishVisibility] = useState<
    'public' | 'unlisted' | 'private'
  >('public')
  const { dismiss: dismissToast, notify, toasts } = useToastQueue()
  const [collaborationState, setCollaborationState] =
    useState<CollaborationControllerState>({ status: 'inactive', inviteLinks: {} })
  const [collaborationPresence, setCollaborationPresence] = useState<PresenceState[]>([])
  const [followingMemberId, setFollowingMemberId] = useState<string>()
  const collaborationControllerRef = useRef<CanvasCollaborationController | null>(null)
  const [fitViewRequest, setFitViewRequest] = useState(0)
  const [layoutPreviewOpen, setLayoutPreviewOpen] = useState(false)
  const copiedNodeIdsRef = useRef<string[]>([])
  const internalClipboardRef = useRef<CanvasClipboardEnvelope | undefined>(undefined)
  const lastCanvasPointerRef = useRef<OverlayPosition | undefined>(undefined)
  const pasteCascadeRef = useRef<{ key: string; count: number } | undefined>(undefined)
  const contextMenuDismissedAtRef = useRef(0)
  const snapshot = useStore(canvasStore, (state) => state.snapshot)
  const selectedNodeIds = useStore(canvasStore, (state) => state.selectedNodeIds)
  const previousLayersOpenRef = useRef(preferences.layersOpen)
  const imageSelectionGuardRef = useRef<(nodeId: string | null) => boolean>(() => true)
  const providerCatalog = useOptionalProviderCatalog()

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
  }, [canvasId])

  useLayoutEffect(() => {
    const previous = previousLayersOpenRef.current
    if (previous === preferences.layersOpen) return
    previousLayersOpenRef.current = preferences.layersOpen
    if (window.innerWidth <= 720) return
    const viewport = canvasStore.getState().snapshot.viewport
    canvasStore.getState().setViewport({
      ...viewport,
      x: viewport.x + (preferences.layersOpen ? 120 : -120),
    })
  }, [preferences.layersOpen])

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
    } else canvasStore.getState().undo()
  }, [])
  const performRedo = useCallback(() => {
    const controller = collaborationControllerRef.current
    if (controller?.isLocalAutosaveSuppressed()) {
      if (collaborationCapabilities(controller.getState()).canEdit) controller.redo()
    } else canvasStore.getState().redo()
  }, [])
  const withBulkLease = useCallback(async <T,>(
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
  }, [readOnly])

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

  const finishLayersResize = useCallback(() => {
    const resize = layersResizeRef.current
    if (!resize) return
    layersResizeRef.current = undefined
    resize.cleanup()
    setLayersResizing(false)
    persistPreferences({ layersWidth: resize.width })
  }, [persistPreferences])

  const startLayersResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 720 || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const move = (moveEvent: MouseEvent) => {
      const resize = layersResizeRef.current
      if (!resize) return
      const maximum = Math.min(MAX_LAYERS_WIDTH, Math.floor(window.innerWidth * 0.7))
      const width = Math.min(maximum, Math.max(MIN_LAYERS_WIDTH,
        resize.startWidth + moveEvent.clientX - resize.startX))
      resize.width = normalizeLayersWidth(width)
      setLayersWidth(resize.width)
    }
    const end = () => finishLayersResize()
    const cleanup = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', end)
      window.removeEventListener('blur', end)
    }
    layersResizeRef.current = {
      startX: event.clientX,
      startWidth: layersWidth,
      width: layersWidth,
      cleanup,
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', end)
    window.addEventListener('blur', end)
    setLayersResizing(true)
  }, [finishLayersResize, layersWidth])

  const resizeLayersByKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    const step = event.shiftKey ? 40 : 10
    const maximum = Math.min(MAX_LAYERS_WIDTH, Math.floor(window.innerWidth * 0.7))
    const width = Math.min(maximum, Math.max(MIN_LAYERS_WIDTH,
      layersWidth + (event.key === 'ArrowRight' ? step : -step)))
    setLayersWidth(width)
    persistPreferences({ layersWidth: width })
  }, [layersWidth, persistPreferences])

  const runMockAction = useCallback(
    (task: Promise<unknown>, successMessage: string) => {
      void task
        .then(() => notify(successMessage))
        .catch((error: unknown) =>
          notify(
            error instanceof Error ? error.message : '本地模拟操作失败',
            'error',
          ),
        )
    },
    [notify],
  )

  const restoreProjectFrom = useCallback(
    (task: Promise<ProjectSnapshot>, successMessage?: string) => {
      void task
        .then((project) => {
          canvasStore.getState().restore(JSON.stringify(project))
          saveActiveProjectId(project.projectId)
          if (successMessage) notify(successMessage)
        })
        .catch((error: unknown) =>
          notify(
            error instanceof Error ? error.message : '本地模拟操作失败',
            'error',
          ),
        )
    },
    [notify],
  )

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!hydrated) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return
      }

      const state = canvasStore.getState()
      const key = event.key.toLowerCase()
      const modified = event.ctrlKey || event.metaKey
      if (!modified && key !== 'delete' && key !== 'backspace') return
      const controller = collaborationControllerRef.current
      const collaborationReadOnly = controller
        ? !collaborationCapabilities(controller.getState()).canEdit
        : false
      if (collaborationReadOnly && modified && (key === 'v' || key === 'd' || key === 'g')) {
        event.preventDefault()
        return
      }

      if (modified && key === 'z') {
        event.preventDefault()
        const collaboration = controller
        if (collaboration?.isLocalAutosaveSuppressed()) {
          if (!collaborationCapabilities(collaboration.getState()).canEdit) return
          if (event.shiftKey) performRedo()
          else performUndo()
        } else if (event.shiftKey) performRedo()
        else performUndo()
      } else if (modified && key === 'a') {
        event.preventDefault()
        canvasStore.setState({
          selectedNodeIds: state.snapshot.nodes.map((node) => node.id),
        })
      } else if (modified && key === 'c') {
        event.preventDefault()
        void copySelectedNodes(state.selectedNodeIds)
          .catch(() => notify('浏览器未允许写入剪贴板', 'error'))
      } else if (modified && key === 'd') {
        event.preventDefault()
        withBulkLease(state.selectedNodeIds, () => state.duplicateNodes(state.selectedNodeIds))
      } else if (modified && key === 'g') {
        event.preventDefault()
        if (event.shiftKey) withBulkLease(state.selectedNodeIds, () => state.ungroupNodes(state.selectedNodeIds))
        else if (state.selectedNodeIds.length > 1) {
          withBulkLease(state.selectedNodeIds, () => state.groupNodes(
            state.selectedNodeIds,
            createLocalNodeId('group'),
            '节点分组',
          ))
        }
      } else if (!modified && (key === 'delete' || key === 'backspace')) {
        event.preventDefault()
        if (collaborationReadOnly) return
        state.deleteNodes(state.selectedNodeIds)
      }
    }

    document.addEventListener('keydown', handleShortcut)
    return () => document.removeEventListener('keydown', handleShortcut)
  }, [copySelectedNodes, hydrated, notify, performRedo, performUndo, withBulkLease])

  useEffect(() => {
    let disposed = false
    let unsubscribe: () => void = () => {}
    setHydrated(false)
    setLoadedCanvasId(undefined)

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
        const project = canvasDocument
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
        canvasStore.getState().restore(JSON.stringify(project))
        if (!canvasDocument) saveActiveProjectId(project.projectId)
        setLoadedCanvasId(canvasId ?? null)
      } catch (error: unknown) {
        notify(
          error instanceof Error ? error.message : '恢复本地项目失败',
          'error',
        )
      }

      if (disposed) return
      setHydrated(true)
      unsubscribe = canvasStore.subscribe((state, previous) => {
        if (state.snapshot === previous.snapshot) return
        if (collaborationControllerRef.current?.isLocalAutosaveSuppressed()) return
        const project = state.snapshot
        if (canvasId) {
          const document = {
              ...project,
              version: CANVAS_SNAPSHOT_VERSION,
              canvasId,
              comments: project.comments ?? [],
            } as const
          void workspaceRepository
            .saveCanvas(document)
            .then(() => {
              thumbnailService.schedule(document)
              if (disposed) void thumbnailService.flush(canvasId)
              return gatewayClient.syncCanvasAssetReferences({
                canvasId,
                projectId: project.projectId,
                assetIds: [
                  ...new Set(
                    project.nodes.flatMap((node) => {
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
            .catch((error: unknown) =>
              notify(
                error instanceof Error ? error.message : '自动保存画布失败',
                'error',
              ),
            )
          return
        }
        void defaultProjectPersistenceQueue
          .enqueue(project)
          .catch((error: unknown) =>
            notify(
              error instanceof Error ? error.message : '自动保存项目失败',
              'error',
            ),
          )
      })
    }

    void hydrate()

    return () => {
      disposed = true
      unsubscribe()
      if (canvasId) void thumbnailService.flush(canvasId)
    }
  }, [canvasId, notify, projectId, thumbnailService, workspaceRepository])

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
    const members = [...new Map(collaborationPresence.map((presence) => [
      presence.member.memberId,
      {
        id: presence.member.memberId,
        displayName: presence.member.displayName,
        color: presence.member.color,
      },
    ] as const)).values()]
    const current = collaborationState.session
    if (current && !members.some((member) => member.id === current.memberId)) {
      members.unshift({
        id: current.memberId,
        displayName: current.displayName,
        color: '#668da0',
      })
    }
    return members
  }, [collaborationPresence, collaborationState.session])

  useEffect(() => {
    if (popup !== 'collaboration') return
    const controller = collaborationControllerRef.current
    if (!controller) return
    void controller.refreshRoom().catch(() => undefined)
    const timer = window.setInterval(() => {
      void controller.refreshRoom().catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(timer)
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
    if (!capabilities.canPublish) {
      setDialog((current) => current === 'publish' ? null : current)
    }
  }, [capabilities.canManageApi, capabilities.canPublish])

  const collaborationAction = useCallback(
    async (action: (controller: CanvasCollaborationController) => Promise<unknown>) => {
      const controller = collaborationControllerRef.current
      if (!controller) {
        notify('只有工作区画布可以开启多人协作', 'warning')
        return
      }
      try { await action(controller) }
      catch (error) { notify(error instanceof Error ? error.message : '协作操作失败', 'error') }
    },
    [notify],
  )

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
    if (tool === 'redo') { canvasStore.getState().redo(); return }
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
    const current = state.snapshot.viewport
    const zoom = Math.min(8, Math.max(0.1, nextZoom))
    const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
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
    }
    if (action === 'settings') {
      if (!capabilities.canPublish) return
      setDialog('publish')
      return
    }
    if (action === 'rename') {
      setRenameProjectName(canvasStore.getState().snapshot.name)
      setDialog('rename')
      return
    }

    const activeSnapshot = canvasStore.getState().snapshot
    if (action === 'new') {
      restoreProjectFrom(
        ensureMockWorkspace().then((workspace) =>
          mockApi.createProject(workspace.id, '未命名项目'),
        ),
      )
    }
    if (action === 'duplicate') {
      if (canvasId) {
        void workspaceRepository
          .duplicateCanvas(canvasId)
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
      restoreProjectFrom(
        mockApi.cloneProject(activeSnapshot.projectId),
      )
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
    ) => {
    if (readOnly && kind !== 'asset-library' && kind !== 'generation-history') return
    if (kind === 'asset-library') {
      openPanel('assets')
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
      input.onchange = () => {
        const file = input.files?.[0]
        if (!file) return
        const targetKind: AddNodeKind = file.type.startsWith('video/')
          ? 'video'
          : file.type.startsWith('audio/')
            ? 'audio'
            : 'image'
        void persistLocalMedia(file)
          .then((asset) =>
              addNode(targetKind, asset.url, file.name, asset.assetId),
          )
          .catch((error: unknown) =>
            notify(
              error instanceof Error ? error.message : '上传本地文件失败',
              'error',
            ),
          )
      }
      input.click()
      return
    }

    const commitNode = (mediaUrl = content ?? '') => {
      const current = canvasStore.getState().snapshot
      const id = createLocalNodeId(kind)
      const zoom = Math.max(current.viewport.zoom, 0.01)
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
      const position = addNodePosition
        ? {
            x:
              (addNodePosition.x - current.viewport.x) / zoom -
              size.width / 2,
            y:
              (addNodePosition.y - current.viewport.y) / zoom -
              size.height / 2,
          }
        : {
            x: (window.innerWidth / 2 - current.viewport.x) / zoom - 160,
            y: (window.innerHeight / 2 - current.viewport.y) / zoom - 100,
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
          data: { url: mediaUrl, assetId },
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

  const importClipboardContents = useCallback(async (contents: ClipboardContents) => {
    const resolved = await resolveClipboardContents(contents)
    const pasteAnchor = (signature: string) => {
      const current = canvasStore.getState().snapshot
      const zoom = Math.max(current.viewport.zoom, 0.01)
      const pointer = lastCanvasPointerRef.current ?? {
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      }
      const key = `${signature}:${pointer.x}:${pointer.y}`
      const count = pasteCascadeRef.current?.key === key
        ? pasteCascadeRef.current.count + 1
        : 0
      pasteCascadeRef.current = { key, count }
      return {
        x: (pointer.x - current.viewport.x) / zoom + count * 32,
        y: (pointer.y - current.viewport.y) / zoom + count * 32,
      }
    }
    const pasteGraph = (
      nodes: CanvasNode[],
      edges: CanvasClipboardEnvelope['edges'],
      signature: string,
    ) => canvasStore.getState().pasteImportedGraph({
      nodes,
      edges,
      anchor: pasteAnchor(signature),
    })
    const importEnvelope = (envelope: CanvasClipboardEnvelope) => {
      internalClipboardRef.current = envelope
      pasteGraph(
        envelope.nodes,
        envelope.edges,
        `internal:${envelope.sourceCanvasId}:${envelope.nodes.map((node) => node.id).join(',')}`,
      )
    }

    if (resolved.kind === 'empty') {
      if (!internalClipboardRef.current) throw new Error('剪贴板中没有可粘贴的内容')
      importEnvelope(internalClipboardRef.current)
    } else if (resolved.kind === 'error') {
      throw new Error(resolved.message)
    } else if (resolved.kind === 'internal') {
      importEnvelope(resolved.envelope)
    } else if (resolved.kind === 'files') {
      copiedNodeIdsRef.current = []
      internalClipboardRef.current = undefined
      const nodes: CanvasNode[] = []
      for (const [index, file] of resolved.files.entries()) {
        const media = await detectMediaKind(file)
        if (!media) continue
        const asset = await persistLocalMedia(file)
        nodes.push({
          id: `clipboard-source-${index}`,
          type: media,
          name: file.name,
          position: { x: index * 32, y: index * 32 },
          size: media === 'image'
            ? { width: 480, height: 320 }
            : { width: 480, height: 270 },
          data: { url: asset.url, assetId: asset.assetId },
        } as CanvasNode)
      }
      pasteGraph(nodes, [], `files:${resolved.files.map((file) => `${file.name}:${file.size}`).join('|')}`)
    } else if (resolved.kind === 'url') {
      let asset: { assetId: string; url: string }
      if (/^data:/i.test(resolved.url)) {
        const response = await fetch(resolved.url)
        const blob = await response.blob()
        asset = await persistLocalMedia(new File(
          [blob],
          `clipboard.${resolved.media === 'image' ? 'png' : 'mp4'}`,
          { type: blob.type },
        ))
      } else {
        asset = await persistRemoteClipboardMedia(resolved.url, resolved.media, gatewayClient)
      }
      pasteGraph([{
        id: 'clipboard-remote-source',
        type: resolved.media,
        name: resolved.media === 'image' ? '剪贴板图片' : '剪贴板视频',
        position: { x: 0, y: 0 },
        size: resolved.media === 'image'
          ? { width: 480, height: 320 }
          : { width: 480, height: 270 },
        data: { url: asset.url, assetId: asset.assetId },
      } as CanvasNode], [], `url:${resolved.url}`)
    } else {
      pasteGraph([{
        id: 'clipboard-text-source',
        type: 'text',
        name: '文本',
        position: { x: 0, y: 0 },
        size: { width: 420, height: 220 },
        data: { text: resolved.text, nodeKind: 'text' },
      }], [], `text:${resolved.text}`)
    }
  }, [])

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (!hydrated || readOnly) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return
      }

      event.preventDefault()
      void importClipboardContents(contentsFromDataTransfer(event.clipboardData))
        .catch((error: unknown) => notify(
          error instanceof Error ? error.message : '无法读取剪贴板内容',
          'error',
        ))
    }

    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [hydrated, importClipboardContents, notify, readOnly])

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
        .catch((error: unknown) => notify(
          error instanceof Error ? error.message : '浏览器未允许读取剪贴板',
          'error',
        ))
    }
  }

  const handleNodeContextAction = (action: NodeContextAction) => {
    if (readOnly && action !== 'copy-node' && action !== 'copy-to-clipboard') return
    const selectedIds = canvasStore.getState().selectedNodeIds
    if (action === 'delete') {
      canvasStore.getState().deleteNodes(selectedIds)
      return
    }
    if (action === 'duplicate') {
      withBulkLease(selectedIds, () => canvasStore.getState().duplicateNodes(selectedIds))
      return
    }
    if (action === 'copy-node') {
      void copySelectedNodes(selectedIds)
        .catch(() => notify('浏览器未允许写入剪贴板', 'error'))
      return
    }
    if (action === 'paste') {
      void readClipboardContents(navigator.clipboard ?? {})
        .then(importClipboardContents)
        .catch((error: unknown) => notify(
          error instanceof Error ? error.message : '浏览器未允许读取剪贴板',
          'error',
        ))
      return
    }
    if (action === 'copy-to-clipboard') {
      const nodes = canvasStore
        .getState()
        .snapshot.nodes.filter((node) => selectedIds.includes(node.id))
      void copyText(JSON.stringify(nodes, null, 2))
        .catch(() => notify('浏览器未允许写入剪贴板', 'error'))
      return
    }
  }

  const handleSelectionAction = (action: SelectionAction) => {
    if (readOnly && action !== 'copy' && action !== 'save-assets') return
    const state = canvasStore.getState()
    if (action === 'save-assets') {
      notify('保存到资产暂未接入', 'warning')
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

  return (
    <main
      aria-busy={!hydrated}
      className="app-shell"
      data-hydrated={hydrated}
      data-testid="app-shell"
      data-layers-open={preferences.layersOpen || undefined}
      data-layers-resizing={layersResizing || undefined}
      inert={!hydrated}
      style={{ '--layers-sidebar-width': `${Math.min(layersWidth, Math.floor(window.innerWidth * 0.7))}px` } as CSSProperties}
    >
        <aside
          aria-hidden={!preferences.layersOpen}
          className="app-layer-sidebar"
          data-testid="layers-sidebar"
          inert={!preferences.layersOpen}
        >
          <WorkspaceMenu
            canvasName={snapshot.name}
            onClick={() => setPopup((current) => current === 'workspace' ? null : 'workspace')}
            testId="workspace-control-sidebar"
            workspaceName={projectName ?? '未命名工作区'}
          />
          <LayersPanel
            nodes={snapshot.nodes}
            onOpenChange={(layersOpen) => persistPreferences({ layersOpen })}
            onRename={(id, name) => canvasStore.getState().renameNode(id, name)}
            onReorder={(ids, targetId, placement) => canvasStore.getState().reorderNodes(ids, targetId, placement)}
            onSelect={(id) => { if (imageSelectionGuardRef.current(id)) canvasStore.getState().selectNode(id) }}
            onToggleHidden={(id) => canvasStore.getState().setNodeVisibility(id, Boolean(snapshot.nodes.find((node) => node.id === id)?.hidden))}
            onToggleLocked={(id) => canvasStore.getState().setNodeLocked(id, !snapshot.nodes.find((node) => node.id === id)?.locked)}
            open
            selectedIds={selectedNodeIds}
          />
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
        </aside>
      <section
        className="canvas-stage"
        onPointerMove={(event) => {
          lastCanvasPointerRef.current = { x: event.clientX, y: event.clientY }
        }}
      >
        {!preferences.layersOpen ? <div className="collapsed-sidebar-controls"><WorkspaceMenu canvasName={snapshot.name} onClick={() => setPopup((current) => current === 'workspace' ? null : 'workspace')} workspaceName={projectName ?? '未命名工作区'} /><LayersPanel nodes={snapshot.nodes} onOpenChange={(layersOpen) => persistPreferences({ layersOpen })} onRename={() => undefined} onReorder={() => undefined} onSelect={() => undefined} onToggleHidden={() => undefined} onToggleLocked={() => undefined} open={false} selectedIds={selectedNodeIds} /></div> : null}
      <CanvasWorkspace
        activeTool={activeTool}
        onToolComplete={() => setActiveTool('select')}
        canvasId={canvasId}
        canGenerate={capabilities.canPublish}
        collaboration={canvasCollaboration}
        fitViewRequest={fitViewRequest}
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

      <TopBar
        apiIntegrationDisabled={!capabilities.canManageApi}
        collaborationStatus={collaborationState.status}
        collaborationMembers={topbarCollaborationMembers}
        mode={mode}
        onAgent={() => openPanel('agent')}
        onApiIntegration={() => {
          if (!capabilities.canManageApi) return
          setProviderDrawerOpen(false)
          setContextMenu(null)
          setAddNodePosition(undefined)
          setPopup((current) =>
            current === 'api-integration' ? null : 'api-integration',
          )
        }}
        onAssets={() => openPanel('assets')}
        onCollaboration={() => {
          setProviderDrawerOpen(false)
          setContextMenu(null)
          setAddNodePosition(undefined)
          setPopup((current) =>
            current === 'collaboration' ? null : 'collaboration',
          )
        }}
        onModeChange={setMode}
      />

      <BottomStatusBar
        hideConnections={preferences.hideConnections}
        onAssetManager={() => openPanel('project-files')}
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
        onZoomIn={() => setCanvasZoom(snapshot.viewport.zoom * 1.2)}
        onZoomOut={() => setCanvasZoom(snapshot.viewport.zoom / 1.2)}
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
      </section>

      <WorkspaceDropdown
        collaborationRestricted={collaborationRestricted}
        onAction={handleWorkspaceAction}
        onClose={() => setPopup(null)}
        open={popup === 'workspace'}
        subject={canvasId ? 'canvas' : 'project'}
      />
      <AddNodeMenu
        onClose={closeFloatingUi}
        onSelect={handleAddNode}
        open={popup === 'add'}
        position={addNodePosition}
      />
      <ApiIntegrationPopover
        onClose={() => closeProductPopup('api-integration')}
        onManage={() => {
          if (!capabilities.canManageApi) return
          // TODO(security): enforce owner role server-side once provider routes accept room context.
          setPopup(null)
          setProviderDrawerOpen(true)
        }}
        onUnavailable={() => notify('本地 API 网关暂不可用', 'error')}
        open={popup === 'api-integration'}
      />
      {providerDrawerOpen ? (
        <Suspense fallback={null}>
          <ProviderDrawer
            onClose={() => {
              setProviderDrawerOpen(false)
              window.requestAnimationFrame(() => {
                document.getElementById('api-integration-trigger')?.focus()
              })
            }}
            onNotify={(message, tone = 'info') => notify(message, tone)}
            open
            readOnly={!capabilities.canManageApi}
          />
        </Suspense>
      ) : null}
      <CollaborationPopover
        followingMemberId={followingMemberId}
        onClose={() => closeProductPopup('collaboration')}
        onCloseRoom={() => collaborationAction((controller) => controller.closeRoom())}
        onCreateInvite={(role) => collaborationAction(async (controller) => {
          const link = await controller.createInvite(role)
          await copyText(link)
        })}
        onDismissRecoverySecret={() => collaborationControllerRef.current?.dismissRecoverySecret()}
        onEnable={(displayName) => collaborationAction((controller) => controller.enable(displayName))}
        onLeave={() => collaborationAction((controller) => controller.leave())}
        onFollowMember={setFollowingMemberId}
        onRemoveMember={(memberId) => collaborationAction((controller) => controller.removeMember(memberId))}
        onRetryResume={() => collaborationAction((controller) => controller.retryAuthenticatedResume())}
        onRevokeInvite={(inviteId) => collaborationAction((controller) => controller.revokeInvite(inviteId))}
        onSetMemberRole={(memberId, role) => collaborationAction((controller) => controller.setMemberRole(memberId, role))}
        onRecoverConflictRoom={(secret, displayName) => collaborationAction((controller) => controller.recoverConflictRoom(secret, displayName))}
        onForceResetAndEnable={(displayName) => collaborationAction((controller) => controller.forceResetAndEnable(displayName))}
        onDismissConflict={() => collaborationControllerRef.current?.dismissConflict()}
        open={popup === 'collaboration'}
        presence={collaborationPresence}
        state={collaborationState}
      />
      <CollaborationNicknameDialog
        defaultName={collaborationState.pendingInvite?.suggestedName}
        onCancel={() => {
          collaborationControllerRef.current?.dismissPendingInvite()
          notify('邀请链接会保留，刷新页面后仍可加入', 'warning')
        }}
        onSubmit={(displayName) => collaborationAction((controller) => controller.joinPendingInvite(displayName))}
        open={Boolean(collaborationState.pendingInvite)}
      />
      <HelpPopover
        onAction={handleHelpAction}
        onClose={() => setPopup(null)}
        open={popup === 'help'}
      />

      <SidePanel
        agentWidth={400}
        canvasNodes={snapshot.nodes.map((node) => ({
          id: node.id,
          name: node.name,
          type: node.type,
        }))}
        kind={panel ?? 'assets'}
        onAction={(action) => {
          if (action === 'upload') handleAddNode('upload')
          else if (action === 'new-canvas') {
            if (onNavigateWorkspace) onNavigateWorkspace('canvas')
            else handleWorkspaceAction('new')
          }
          else if (action === 'use-template')
            handleAddNode('text', '根据参考图生成连续镜头')
          else if (action === 'apply-style') handleAddNode('style-shot')
          else if (action === 'apply-character')
            handleAddNode('reference-image')
          else closePanel()
        }}
        onClose={closePanel}
        onLocateNode={(nodeId) => {
          const state = canvasStore.getState()
          const node = state.snapshot.nodes.find(
            (candidate) => candidate.id === nodeId,
          )
          if (!node) return
          const zoom = state.snapshot.viewport.zoom
          state.selectNode(nodeId)
          state.setViewport({
            x:
              window.innerWidth / 2 -
              (node.position.x + node.size.width / 2) * zoom,
            y:
              window.innerHeight / 2 -
              (node.position.y + node.size.height / 2) * zoom,
            zoom,
          })
        }}
        open={panel !== null}
      />
      <GenerationHistoryModal
        onClose={() => setHistoryOpen(false)}
        onNotify={(message, tone = 'info') => notify(message, tone)}
        onUse={(entry) => {
          if (readOnly) return
          const state = canvasStore.getState()
          const viewport = state.snapshot.viewport
          const zoom = Math.max(viewport.zoom, 0.01)
          state.createNodeFromHistory(entry, {
            x: (window.innerWidth / 2 - viewport.x) / zoom,
            y: (window.innerHeight / 2 - viewport.y) / zoom,
          })
        }}
        open={historyOpen}
        projectId={snapshot.projectId}
      />
      <PublishDialog
        description={publishDescription}
        onClose={() => setDialog(null)}
        onDescriptionChange={setPublishDescription}
        onPublish={() => {
          if (!capabilities.canPublish) return
          setDialog(null)
          runMockAction(
            mockApi.publishProject(canvasStore.getState().snapshot.projectId),
            '项目已发布到本地预览',
          )
        }}
        onVisibilityChange={setPublishVisibility}
        open={dialog === 'publish'}
        projectTitle={snapshot.name}
        visibility={publishVisibility}
      />
      <KeyboardShortcutsDialog
        onClose={() => setDialog(null)}
        open={dialog === 'shortcuts'}
      />
      <RenameProjectDialog
        name={renameProjectName}
        onClose={() => setDialog(null)}
        onNameChange={setRenameProjectName}
        onRename={() => {
          if (readOnly) return
          const activeProjectId = canvasStore.getState().snapshot.projectId
          setDialog(null)
          if (canvasId) {
            void workspaceRepository
              .renameCanvas(canvasId, renameProjectName)
              .then(() => {
                const current = canvasStore.getState().snapshot
                canvasStore.getState().restore(
                  JSON.stringify({ ...current, name: renameProjectName.trim() }),
                )
                notify('画布已重命名')
              })
              .catch((error: unknown) =>
                notify(
                  error instanceof Error ? error.message : '重命名画布失败',
                  'error',
                ),
              )
            return
          }
          restoreProjectFrom(
            mockApi.renameProject(activeProjectId, renameProjectName),
            '项目已重命名',
          )
        }}
        open={dialog === 'rename'}
      />
      <ConfirmDialog
        confirmLabel={canvasId ? '移入回收站' : '删除项目'}
        message={
          canvasId
            ? '画布会移入工作区回收站，可以随时恢复。'
            : '删除后将保留其他本地项目，并立即打开一个新的空白项目。'
        }
        onClose={() => setDialog(null)}
        onConfirm={() => {
          if (readOnly) return
          const activeProjectId = canvasStore.getState().snapshot.projectId
          setDialog(null)
          if (canvasId) {
            void workspaceRepository
              .trashCanvas(canvasId)
              .then(() => onNavigateWorkspace?.())
              .catch((error: unknown) =>
                notify(
                  error instanceof Error ? error.message : '移动画布失败',
                  'error',
                ),
              )
            return
          }
          restoreProjectFrom(
            ensureMockWorkspace().then(async (workspace) => {
              await mockApi.deleteProject(activeProjectId)
              return mockApi.createProject(workspace.id, '未命名项目')
            }),
            '当前项目已删除，已打开新的空白项目',
          )
        }}
        open={dialog === 'delete'}
        title={canvasId ? '将画布移入回收站？' : '删除当前项目？'}
      />

      <BlankContextMenu
        onAction={handleBlankContextAction}
        onClose={dismissContextMenu}
        open={contextMenu === 'blank'}
        position={contextPosition}
      />
      <NodeContextMenu
        onAction={handleNodeContextAction}
        onClose={dismissContextMenu}
        open={contextMenu === 'node'}
        position={contextPosition}
      />
      <ToastRegion
        onDismiss={dismissToast}
        toasts={toasts}
      />
    </main>
  )
}
