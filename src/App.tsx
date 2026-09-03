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
import { CANVAS_SNAPSHOT_VERSION } from './model/project'
import {
  defaultWorkspaceRepository,
  type WorkspaceRepository,
} from './workspace'
// Media uploads delegate to persistLocalMedia(file) via useCanvasClipboard
import {
  ensureMockWorkspace,
  gatewayClient,
  mockApi,
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
import { useCanvasClipboard } from './hooks/useCanvasClipboard'
import { copyImageToClipboard, copyText } from './utils/clipboard'

type Popup =
  | 'workspace'
  | 'add'
  | 'api-integration'
  | 'collaboration'
  | 'help'
  | null
type Dialog = 'publish' | 'shortcuts' | 'delete' | 'rename' | 'settings' | null
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
  canvasId?: string
  projectId?: string
  projectName?: string
  onNavigateCanvas?: (canvasId: string, projectId: string) => void
  onNavigateWorkspace?: (create?: 'project' | 'canvas') => void
  workspaceRepository?: WorkspaceRepository
  thumbnailService?: Pick<CanvasThumbnailService, 'schedule' | 'flush'>
  /** System settings are served from the loopback-only administration port. */
  canManageSettings?: boolean
  /** Nickname collected by the gateway entry gate. */
  entryDisplayName?: string
  /** Automatically activate the relay room for server-mode canvas entry. */
  autoJoinServer?: boolean
}

export default function App({
  canvasId,
  projectId,
  projectName,
  onNavigateCanvas,
  onNavigateWorkspace,
  workspaceRepository = defaultWorkspaceRepository,
  thumbnailService = canvasThumbnailService,
  canManageSettings = true,
  entryDisplayName,
  autoJoinServer = false,
}: AppProps = {}) {
  const [hydrated, setHydrated] = useState(false)
  const [loadedCanvasId, setLoadedCanvasId] = useState<string | null>()
  const [preferences, setPreferences] = useState<UiPreferences>(() =>
    loadUiPreferences(),
  )
  const appShellRef = useRef<HTMLElement | null>(null)
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
  const [activeTool, setActiveTool] = useState<ToolDockTool>('select')
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
  const [publishDescription, setPublishDescription] = useState('')
  const [renameProjectName, setRenameProjectName] = useState('')
  const [publishVisibility, setPublishVisibility] = useState<
    'public' | 'unlisted' | 'private'
  >('public')
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
    entryDisplayName,
    autoJoinServer,
    projectId,
    loadedCanvasId,
    workspaceRepository,
    providerCatalog,
    notify,
  })
  const [hostPromptDismissed, setHostPromptDismissed] = useState(false)
  const [appMode, setAppMode] = useState<'host' | 'solo' | 'workstation'>('solo')
  const [appModeLoaded, setAppModeLoaded] = useState(false)
  useEffect(() => {
    let disposed = false
    void fetch('/api/access/context')
      .then((response) => (response.ok ? response.json() as Promise<{ operationMode?: unknown }> : undefined))
      .then((data) => {
        if (disposed) return
        const mode = data?.operationMode === 'host'
          ? 'host'
          : data?.operationMode === 'workstation'
            ? 'workstation'
            : 'solo'
        setAppMode(mode)
        setAppModeLoaded(true)
        localStorage.setItem('continuum_app_mode', mode)
      })
      .catch(() => {
        if (!disposed) setAppModeLoaded(true)
      })
    return () => { disposed = true }
  }, [])
  const isHostMode = appModeLoaded && appMode === 'host'
  const hostPromptOpen = Boolean(
    isHostMode &&
    !entryDisplayName &&
    !hostPromptDismissed &&
    hydrated &&
    loadedCanvasId === canvasId &&
    collaborationState.status === 'inactive' &&
    !collaborationState.session &&
    !collaborationState.pendingInvite &&
    !collaborationState.pendingHostJoin
  )
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
  }, [canvasId])

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
    let unsubscribe = () => {}
    let isHydrated = false
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
        let project = canvasDocument
          ? {
              version: 1 as const,
              projectId: canvasDocument.projectId,
              name: canvasDocument.name,
              viewport: canvasDocument.viewport,
              nodes: canvasDocument.nodes,
              edges: canvasDocument.edges,
              comments: canvasDocument.comments ?? [],
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
      isHydrated = true
      setHydrated(true)
      unsubscribe = canvasStore.subscribe((state, previous) => {
        if (state.snapshot === previous.snapshot) return
        if (collaborationControllerRef.current?.isLocalAutosaveSuppressed()) return
        const project = state.snapshot
        if (canvasId) {
          const document = {
              ...project,
              projectId: projectId ?? project.projectId,
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
                projectId: document.projectId,
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
      if (canvasId && isHydrated) {
        const currentSnapshot = canvasStore.getState().snapshot
        const document = {
          ...currentSnapshot,
          projectId: projectId ?? currentSnapshot.projectId,
          version: CANVAS_SNAPSHOT_VERSION,
          canvasId,
          comments: currentSnapshot.comments ?? [],
        } as const
        void workspaceRepository.saveCanvas(document).catch(() => undefined)
        void thumbnailService.flush(canvasId)
      }
    }
  }, [canvasId, notify, projectId, thumbnailService, workspaceRepository])


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
    if (!capabilities.canPublish) {
      setDialog((current) => current === 'publish' ? null : current)
    }
  }, [capabilities.canManageApi, capabilities.canPublish])


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
      if (!canManageSettings) return
      setDialog('settings')
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
        .catch((error: unknown) => notify(
          error instanceof Error ? error.message : '浏览器未允许读取剪贴板',
          'error',
        ))
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
        const saved = assetRegistry.registerNodeAsAsset(node, canvasStore.getState().snapshot.projectId)
        if (saved) {
          notify(`已将「${saved.name}」存入资产库`, 'success')
        } else {
          notify('当前节点不支持存入资产库', 'warning')
        }
      }
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
    if (action === 'copy-image') {
      const snapshot = canvasStore.getState().snapshot
      const node = snapshot.nodes.find(
        (n) => selectedIds.includes(n.id) && n.type === 'image',
      )
      if (!node || node.type !== 'image' || !node.data?.url) {
        notify('当前节点未包含有效图片数据', 'warning')
        return
      }
      void copyImageToClipboard(node.data.url)
        .then(() => notify('已复制图片到剪贴板', 'info'))
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
            <LibTvLogo size={20} />
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
            <Layers3 size={18} />
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
            <GitBranch size={18} />
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
            <Package size={18} />
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
            <Bot size={18} />
            <span className="app-layer-sidebar__rail-label">Agent</span>
          </button>
          {canManageSettings && (
            <button
              aria-label="设置"
              className="app-layer-sidebar__rail-btn"
              onClick={() => setDialog('settings')}
              style={{ marginTop: 'auto' }}
              title="系统设置"
              type="button"
            >
              <Settings size={18} />
              <span className="app-layer-sidebar__rail-label">设置</span>
            </button>
          )}
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
              onSelect={(id) => { if (imageSelectionGuardRef.current(id)) canvasStore.getState().selectNode(id) }}
              onToggleHidden={(id) => canvasStore.getState().setNodeVisibility(id, Boolean(snapshot.nodes.find((node) => node.id === id)?.hidden))}
              onToggleLocked={(id) => canvasStore.getState().setNodeLocked(id, !snapshot.nodes.find((node) => node.id === id)?.locked)}
              open
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
                const viewport = state.snapshot.viewport
                const zoom = Math.max(viewport.zoom, 0.01)
                const centerPos = {
                  x: (window.innerWidth / 2 - viewport.x) / zoom,
                  y: (window.innerHeight / 2 - viewport.y) / zoom,
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
        className="canvas-stage"
        onPointerMove={(event) => {
          lastCanvasPointerRef.current = { x: event.clientX, y: event.clientY }
        }}
      >
        {!preferences.layersOpen && (
          <>
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

            <div className="canvas-top-right-pill" data-testid="canvas-top-right-pill">
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
                        style={{ background: member.color || 'var(--canvas-accent-primary)', zIndex: 10 - idx }}
                        title={`${member.displayName}${isOnline ? ' (在线)' : ' (离线)'}`}
                      >
                        {(member.displayName || '名').trim().slice(0, 1).toUpperCase()}
                      </div>
                    )
                  })
                ) : (
                  <div
                    className="inspector-top-bar__avatar-bubble inspector-top-bar__avatar-bubble--none"
                    style={{ background: 'var(--canvas-avatar-fallback)' }}
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
        <CanvasWorkspace
          activeTool={activeTool}
          onToolComplete={() => setActiveTool('select')}
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
      ) : (
        <div className="canvas-stage__loading" aria-busy="true" />
      )}

      <BottomStatusBar
        hideConnections={preferences.hideConnections}
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
        onOpenSettings={() => setDialog('shortcuts')}
        onStartResize={startInspectorResize}
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
        publishDescription={publishDescription}
        setPublishDescription={setPublishDescription}
        publishVisibility={publishVisibility}
        setPublishVisibility={setPublishVisibility}
        workspaceRepository={workspaceRepository}
        onNavigateCanvas={onNavigateCanvas}
        onNavigateWorkspace={onNavigateWorkspace}
        hostPromptOpen={hostPromptOpen}
        onDismissHostPrompt={() => setHostPromptDismissed(true)}
        appMode={appMode}
        canManageSettings={canManageSettings}
        entryDisplayName={entryDisplayName}
        onAppModeChange={setAppMode}
        notify={notify}
        runMockAction={runMockAction}
        restoreProjectFrom={restoreProjectFrom}
      />
      <ToastRegion
        onDismiss={dismissToast}
        toasts={toasts}
      />
    </main>
  )
}
