import { useEffect } from 'react'

import { collaborationCapabilities } from '../collaboration/capabilities'
import type { CanvasCollaborationController } from '../collaboration/controller'
import { canvasStore, createLocalNodeId } from '../store/canvas-store'
import type { ToolType } from '../types'

export interface UseAppHotkeysOptions {
  hydrated: boolean
  collaborationControllerRef: React.RefObject<CanvasCollaborationController | null>
  setActiveTool: (tool: ToolType) => void
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
      const modified = event.ctrlKey || event.metaKey
      const controller = collaborationControllerRef.current
      const collaborationReadOnly = controller
        ? !collaborationCapabilities(controller.getState()).canEdit
        : false

      if (!modified) {
        if (key === 'v') {
          setActiveTool('select')
          return
        }
        if (key === 'b') {
          setActiveTool('brush')
          state.selectNode(null)
          return
        }
        if (key === 'delete' || key === 'backspace') {
          event.preventDefault()
          if (collaborationReadOnly) return
          state.deleteNodes(state.selectedNodeIds)
          return
        }
        return
      }

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
      } else if (!modified && (key === 'delete' || key === 'backspace')) {
        event.preventDefault()
        if (collaborationReadOnly) return
        state.deleteNodes(state.selectedNodeIds)
      }
    }

    document.addEventListener('keydown', handleShortcut)
    return () => document.removeEventListener('keydown', handleShortcut)
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
