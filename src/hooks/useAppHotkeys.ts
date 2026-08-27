import { useEffect } from 'react'

import { collaborationCapabilities } from '../collaboration/capabilities'
import type { CanvasCollaborationController } from '../collaboration/controller'
import type { ToolDockTool } from '../components/shell/ToolDock'
import { canvasStore } from '../store/canvas-store'
import { createCanvasId } from '../utils/id'

function createLocalNodeId(kind: string): string {
  const prefix = (kind === 'group' ? 'g' : kind.startsWith('v') ? 'v' : kind.startsWith('i') ? 'i' : kind.startsWith('t') ? 't' : 'g') as 'i' | 'v' | 't' | 'g' | 'e'
  return createCanvasId(prefix)
}

export interface UseAppHotkeysOptions {
  hydrated: boolean
  collaborationControllerRef: React.RefObject<CanvasCollaborationController | null>
  setActiveTool: (tool: ToolDockTool) => void
  performUndo: () => void
  performRedo: () => void
  copySelectedNodes: (nodeIds: string[]) => Promise<void>
  withBulkLease: (nodeIds: string[], action: () => void) => void
  notify: (message: string, tone?: 'info' | 'success' | 'error') => void
}

/**
 * Encapsulates global keyboard shortcuts for the canvas application:
 * - V / B: Tool switching (Select / Brush)
 * - Delete / Backspace: Remove selected nodes
 * - Ctrl+Z / Ctrl+Shift+Z: Undo / Redo
 * - Ctrl+A: Select all canvas nodes
 * - Ctrl+C: Copy selected nodes to clipboard
 * - Ctrl+D: Duplicate selected nodes
 * - Ctrl+G / Ctrl+Shift+G: Group / Ungroup selected nodes
 */
export function useAppHotkeys({
  hydrated,
  collaborationControllerRef,
  setActiveTool,
  performUndo,
  performRedo,
  copySelectedNodes,
  withBulkLease,
  notify,
}: UseAppHotkeysOptions): void {
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
      const code = event.code
      const modified = event.ctrlKey || event.metaKey
      const controller = collaborationControllerRef.current
      const collaborationReadOnly = controller
        ? !collaborationCapabilities(controller.getState()).canEdit
        : false

      const isZ = key === 'z' || code === 'KeyZ'
      const isA = key === 'a' || code === 'KeyA'
      const isC = key === 'c' || code === 'KeyC'
      const isD = key === 'd' || code === 'KeyD'
      const isG = key === 'g' || code === 'KeyG'
      const isV = key === 'v' || code === 'KeyV'
      const isB = key === 'b' || code === 'KeyB'

      if (!modified) {
        if (key === 'escape') {
          if (state.selectedNodeIds.length > 0 || state.selectedEdgeIds?.length > 0) {
            state.selectNode(null)
            state.selectEdge(null)
          }
          return
        }
        if (isV) {
          setActiveTool('select')
          return
        }
        if (isB) {
          setActiveTool('brush')
          state.selectNode(null)
          state.selectEdge(null)
          return
        }
        if (key === 'delete' || key === 'backspace') {
          event.preventDefault()
          if (collaborationReadOnly) return
          if (state.selectedEdgeIds && state.selectedEdgeIds.length > 0) {
            state.deleteEdges(state.selectedEdgeIds)
            state.selectEdge(null)
            return
          }
          if (state.selectedNodeIds.length > 0) {
            withBulkLease(state.selectedNodeIds, () =>
              state.deleteNodes(state.selectedNodeIds),
            )
          }
          return
        }
        return
      }

      if (collaborationReadOnly && modified && (isV || isD || isG)) {
        event.preventDefault()
        return
      }

      if (modified && isZ) {
        event.preventDefault()
        const collaboration = controller
        if (collaboration?.isLocalAutosaveSuppressed()) {
          if (!collaborationCapabilities(collaboration.getState()).canEdit) return
          if (event.shiftKey) performRedo()
          else performUndo()
        } else if (event.shiftKey) performRedo()
        else performUndo()
      } else if (modified && isA) {
        event.preventDefault()
        canvasStore.setState({
          selectedNodeIds: state.snapshot.nodes.map((node) => node.id),
        })
      } else if (modified && isC) {
        event.preventDefault()
        void copySelectedNodes(state.selectedNodeIds)
          .catch(() => notify('浏览器未允许写入剪贴板', 'error'))
      } else if (modified && isD) {
        event.preventDefault()
        withBulkLease(state.selectedNodeIds, () => state.duplicateNodes(state.selectedNodeIds))
      } else if (modified && isG) {
        event.preventDefault()
        if (event.shiftKey) {
          withBulkLease(state.selectedNodeIds, () => state.ungroupNodes(state.selectedNodeIds))
        } else if (state.selectedNodeIds.length > 1) {
          withBulkLease(state.selectedNodeIds, () =>
            state.groupNodes(
              state.selectedNodeIds,
              createLocalNodeId('group'),
              '节点分组',
            ),
          )
        }
      }
    }

    document.addEventListener('keydown', handleShortcut, true)
    return () => document.removeEventListener('keydown', handleShortcut, true)
  }, [
    copySelectedNodes,
    hydrated,
    notify,
    performRedo,
    performUndo,
    setActiveTool,
    withBulkLease,
    collaborationControllerRef,
  ])
}
