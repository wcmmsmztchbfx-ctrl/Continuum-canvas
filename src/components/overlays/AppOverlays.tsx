import { lazy, Suspense } from 'react'

import type { CollaborationCapabilities } from '../../collaboration/capabilities'
import type { CanvasCollaborationController, CollaborationControllerState } from '../../collaboration/controller'
import type { PresenceState } from '../../contracts/collaboration'
import type { ProjectSnapshot } from '../../model/project'
import { canvasStore } from '../../store/canvas-store'
import type { WorkspaceRepository } from '../../workspace'
import { ensureMockWorkspace, mockApi } from '../../services/mockApi'
import { copyText } from '../../utils/clipboard'

import {
  AddNodeMenu,
  BlankContextMenu,
  CollaborationNicknameDialog,
  CollaborationPopover,
  ConfirmDialog,
  HelpPopover,
  KeyboardShortcutsDialog,
  NodeContextMenu,
  PublishDialog,
  RenameProjectDialog,
  SidePanel,
  WorkspaceDropdown,
  type AddNodeKind,
  type BlankContextAction,
  type HelpAction,
  type NodeContextAction,
  type OverlayPosition,
  type PublishVisibility,
  type SidePanelKind,
  type WorkspaceAction,
} from './index'
import { GenerationHistoryModal } from './GenerationHistoryModal'
import { AssetManagerModal } from './AssetManagerModal'
import { SettingsModal } from './SettingsModal'

const ProviderDrawer = lazy(() =>
  import('../providers/ProviderDrawer').then((m) => ({
    default: m.ProviderDrawer,
  })),
)

export type AppPopup = 'workspace' | 'add' | 'api-integration' | 'collaboration' | 'help' | null
export type AppDialog = 'publish' | 'shortcuts' | 'delete' | 'rename' | 'settings' | null
export type AppContextMenu = 'blank' | 'node' | null

export interface AppOverlaysProps {
  popup: AppPopup
  setPopup: (popup: AppPopup) => void
  dialog: AppDialog
  setDialog: (dialog: AppDialog) => void
  contextMenu: AppContextMenu
  contextPosition: OverlayPosition
  addNodePosition?: OverlayPosition
  providerDrawerOpen: boolean
  setProviderDrawerOpen: (open: boolean) => void
  providerDrawerTab?: 'media' | 'agent'
  historyOpen: boolean
  setHistoryOpen: (open: boolean) => void
  assetManagerOpen: boolean
  setAssetManagerOpen: (open: boolean) => void
  panel: SidePanelKind | null
  closePanel: () => void
  handleAddNode: (
    kind: AddNodeKind,
    content?: string,
    fileName?: string,
    assetId?: string,
    posterUrl?: string,
  ) => void
  handleWorkspaceAction: (action: WorkspaceAction) => void
  handleHelpAction: (action: HelpAction) => void
  handleBlankContextAction: (action: BlankContextAction) => void
  handleNodeContextAction: (action: NodeContextAction) => void
  closeFloatingUi: () => void
  dismissContextMenu: () => void
  closeProductPopup: (kind: 'api-integration' | 'collaboration') => void
  collaborationState: CollaborationControllerState
  collaborationPresence: readonly PresenceState[]
  followingMemberId?: string
  setFollowingMemberId: (id?: string) => void
  collaborationControllerRef: React.RefObject<CanvasCollaborationController | null>
  collaborationAction: (action: (controller: CanvasCollaborationController) => Promise<unknown>) => void
  collaborationRestricted: boolean
  capabilities: CollaborationCapabilities
  readOnly: boolean
  canvasId?: string
  snapshot: ProjectSnapshot
  selectedNodeIds: readonly string[]
  renameProjectName: string
  setRenameProjectName: (name: string) => void
  publishDescription: string
  setPublishDescription: (desc: string) => void
  publishVisibility: PublishVisibility
  setPublishVisibility: (vis: PublishVisibility) => void
  workspaceRepository: WorkspaceRepository
  onNavigateCanvas?: (canvasId: string, projectId: string) => void
  onNavigateWorkspace?: (create?: 'canvas' | 'project') => void
  notify: (message: string, tone?: 'info' | 'success' | 'error' | 'warning') => void
  runMockAction: (task: Promise<unknown>, successMessage: string) => void
  restoreProjectFrom: (task: Promise<ProjectSnapshot>, successMessage?: string) => void
  hostPromptOpen?: boolean
  onDismissHostPrompt?: () => void
}

export function AppOverlays({
  popup,
  setPopup,
  dialog,
  setDialog,
  contextMenu,
  contextPosition,
  addNodePosition,
  providerDrawerOpen,
  setProviderDrawerOpen,
  providerDrawerTab,
  historyOpen,
  setHistoryOpen,
  assetManagerOpen,
  setAssetManagerOpen,
  panel,
  closePanel,
  handleAddNode,
  handleWorkspaceAction,
  handleHelpAction,
  handleBlankContextAction,
  handleNodeContextAction,
  closeFloatingUi,
  dismissContextMenu,
  closeProductPopup,
  collaborationState,
  collaborationPresence,
  followingMemberId,
  setFollowingMemberId,
  collaborationControllerRef,
  collaborationAction,
  collaborationRestricted,
  capabilities,
  readOnly,
  canvasId,
  snapshot,
  selectedNodeIds,
  renameProjectName,
  setRenameProjectName,
  publishDescription,
  setPublishDescription,
  publishVisibility,
  setPublishVisibility,
  workspaceRepository,
  onNavigateCanvas,
  onNavigateWorkspace,
  notify,
  runMockAction,
  restoreProjectFrom,
  hostPromptOpen,
  onDismissHostPrompt,
}: AppOverlaysProps) {
  return (
    <>
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
            initialTab={providerDrawerTab}
            readOnly={!capabilities.canManageApi}
          />
        </Suspense>
      ) : null}
      <CollaborationPopover
        currentCanvasId={canvasId}
        followingMemberId={followingMemberId}
        onClose={() => closeProductPopup('collaboration')}
        onCloseRoom={() => collaborationAction((controller) => controller.closeRoom())}
        onCreateInvite={(role, customOrigin) =>
          collaborationAction(async (controller) => {
            const link = await controller.createInvite(role, customOrigin)
            await copyText(link)
          })
        }
        onDismissRecoverySecret={() => collaborationControllerRef.current?.dismissRecoverySecret()}
        onEnable={(displayName) => collaborationAction((controller) => controller.enable(displayName))}
        onLeave={() => collaborationAction((controller) => controller.leave())}
        onFollowMember={setFollowingMemberId}
        onNavigateToActiveCollaboration={(collab) => {
          setPopup(null)
          onNavigateCanvas?.(collab.canvasId, collab.projectId)
        }}
        onRemoveMember={(memberId) => collaborationAction((controller) => controller.removeMember(memberId))}
        onRetryResume={() => collaborationAction((controller) => controller.retryAuthenticatedResume())}
        onRevokeInvite={(inviteId) => collaborationAction((controller) => controller.revokeInvite(inviteId))}
        onSetMemberRole={(memberId, role) => collaborationAction((controller) => controller.setMemberRole(memberId, role))}
        onRecoverConflictRoom={(secret, displayName) =>
          collaborationAction((controller) => controller.recoverConflictRoom(secret, displayName))
        }
        onForceResetAndEnable={(displayName) =>
          collaborationAction((controller) => controller.forceResetAndEnable(displayName))
        }
        onDismissConflict={() => collaborationControllerRef.current?.dismissConflict()}
        onGetTunnelStatus={async () => collaborationControllerRef.current?.getTunnelStatus()}
        onStartTunnel={async (mode, customUrl) => collaborationControllerRef.current?.startTunnel(mode, customUrl)}
        onStopTunnel={async () => collaborationControllerRef.current?.stopTunnel()}
        onSetCustomTunnelUrl={async (customUrl) => collaborationControllerRef.current?.setCustomTunnelUrl(customUrl)}
        open={popup === 'collaboration'}
        presence={collaborationPresence}
        state={collaborationState}
      />
      <CollaborationNicknameDialog
        defaultName={
          collaborationState.pendingInvite?.suggestedName ||
          (typeof window !== 'undefined'
            ? localStorage.getItem('libtv-collaboration-display-name') || ''
            : '')
        }
        onCancel={() => {
          if (collaborationState.pendingInvite) {
            collaborationControllerRef.current?.dismissPendingInvite()
            notify('邀请链接会保留，刷新页面后仍可加入', 'warning')
          } else {
            onDismissHostPrompt?.()
          }
        }}
        onSubmit={(displayName) => {
          if (collaborationState.pendingInvite) {
            collaborationAction((controller) => controller.joinPendingInvite(displayName))
          } else {
            onDismissHostPrompt?.()
            collaborationAction((controller) => controller.enable(displayName))
          }
        }}
        open={Boolean(collaborationState.pendingInvite) || Boolean(hostPromptOpen)}
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
          } else if (action === 'use-template')
            handleAddNode('text', '根据参考图生成连续镜头')
          else if (action === 'apply-style') handleAddNode('style-shot')
          else if (action === 'apply-character')
            handleAddNode('reference-image')
          else closePanel()
        }}
        onClose={closePanel}
        onLocateNode={(nodeId) => {
          const state = canvasStore.getState()
          const node = state.snapshot.nodes.find((candidate) => candidate.id === nodeId)
          if (!node) return
          const zoom = state.snapshot.viewport.zoom
          state.selectNode(nodeId)
          state.setViewport({
            x: window.innerWidth / 2 - (node.position.x + node.size.width / 2) * zoom,
            y: window.innerHeight / 2 - (node.position.y + node.size.height / 2) * zoom,
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
      <AssetManagerModal
        onClose={() => setAssetManagerOpen(false)}
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
        onNotify={(message, tone = 'info') => notify(message, tone)}
        open={assetManagerOpen}
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
                canvasStore.getState().renameCanvas(renameProjectName)
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
      <SettingsModal
        onClose={() => setDialog(null)}
        onNotify={(message, tone) => notify(message, tone)}
        open={dialog === 'settings'}
      />

      <BlankContextMenu
        onAction={handleBlankContextAction}
        onClose={dismissContextMenu}
        open={contextMenu === 'blank'}
        position={contextPosition}
      />
      <NodeContextMenu
        hasImage={Boolean(
          selectedNodeIds.length > 0 &&
            (() => {
              const targetNode = snapshot.nodes.find((n) => n.id === selectedNodeIds[0])
              return targetNode?.type === 'image' && Boolean(targetNode.data?.url)
            })(),
        )}
        isLocked={Boolean(
          selectedNodeIds.length > 0 &&
            snapshot.nodes.find((n) => n.id === selectedNodeIds[0])?.locked,
        )}
        onAction={handleNodeContextAction}
        onClose={dismissContextMenu}
        open={contextMenu === 'node'}
        position={contextPosition}
      />
    </>
  )
}
