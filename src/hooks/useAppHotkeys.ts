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
  modalOpen?: boolean
  collaborationControllerRef: React.RefObject<CanvasCollaborationController | null>
  setActiveTool: (tool: ToolDockTool) => void
  performUndo: () => void
  performRedo: () => void
  copySelectedNodes: (nodeIds: string[]) => Promise<void>
  withBulkLease: (nodeIds: string[], action: () => void) => void
  notify: (message: string, tone?: 'info' | 'success' | 'error') => void
  toggleLayers?: () => void
  fitView?: () => void
  onAddNode?: (kind: 'upload') => void
}

/**
 * Encapsulates global keyboard shortcuts for the canvas application:
 * - V / B / F / R / T / U: Tool switching (Select / Brush / Frame / Shape / Text / Upload)
 * - Delete / Backspace: Remove selected non-locked nodes
 * - Arrow keys (Up/Down/Left/Right): Nudge selected nodes by 1px (10px with Shift)
 * - Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y: Undo / Redo
 * - Ctrl+\: Toggle layers sidebar
 * - Shift+1: Fit canvas to viewport
 * - Ctrl+A: Select all canvas nodes
 * - Ctrl+C: Copy selected nodes to clipboard
 * - Ctrl+D: Duplicate selected nodes
 * - Ctrl+G / Ctrl+Shift+G: Group / Ungroup selected nodes
 */
export function useAppHotkeys({
  hydrated,
  modalOpen = false,
  collaborationControllerRef,
  setActiveTool,
  performUndo,
  performRedo,
  copySelectedNodes,
  withBulkLease,
  notify,
  toggleLayers,
  fitView,
  onAddNode,
}: UseAppHotkeysOptions): void {
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!hydrated || modalOpen) return
      if (event.isComposing || event.keyCode === 229) return

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
        if (key === 'escape') {
          if (state.selectedNodeIds.length > 0) {
            state.selectNode(null)
          }
          return
        }
        if (event.shiftKey && (key === '1' || key === '!')) {
          event.preventDefault()
          fitView?.()
          return
        }
        if (key === 'v') {
          setActiveTool('select')
          return
        }
        if (key === 'b') {
          setActiveTool('brush')
          state.selectNode(null)
          return
        }
        if (key === 'f') {
          setActiveTool('frame')
          return
        }
        if (key === 'r') {
          setActiveTool('shape')
          return
        }
        if (key === 't') {
          setActiveTool('text')
          return
        }
        if (key === 'u') {
          if (onAddNode) onAddNode('upload')
          else setActiveTool('upload')
          return
        }
        if (key === 'delete' || key === 'backspace') {
          event.preventDefault()
          if (collaborationReadOnly) return
          if (state.selectedNodeIds.length > 0) {
            const unlockedNodeIds = state.selectedNodeIds.filter((id) => {
              const node = state.snapshot.nodes.find((n) => n.id === id)
              return node && !node.locked
            })
            if (unlockedNodeIds.length > 0) {
              withBulkLease(unlockedNodeIds, () =>
                state.deleteNodes(unlockedNodeIds),
              )
            }
          }
          return
        }
        if (
          key === 'arrowup' ||
          key === 'arrowdown' ||
          key === 'arrowleft' ||
          key === 'arrowright'
        ) {
          if (collaborationReadOnly || state.selectedNodeIds.length === 0) return
          event.preventDefault()
          const step = event.shiftKey ? 10 : 1
          let dx = 0
          let dy = 0
          if (key === 'arrowup') dy = -step
          else if (key === 'arrowdown') dy = step
          else if (key === 'arrowleft') dx = -step
          else if (key === 'arrowright') dx = step

          const moves = state.selectedNodeIds
            .map((id) => {
              const node = state.snapshot.nodes.find((n) => n.id === id)
              if (!node || node.locked) return null
              return {
                id,
                position: {
                  x: Math.round(node.position.x + dx),
                  y: Math.round(node.position.y + dy),
                },
              }
            })
            .filter((m): m is { id: string; position: { x: number; y: number } } => m !== null)

          if (moves.length > 0) {
            withBulkLease(moves.map((m) => m.id), () => {
              state.moveNodes(moves)
            })
          }
          return
        }
        return
      }

      if (key === '\\') {
        event.preventDefault()
        toggleLayers?.()
        return
      }

      if (collaborationReadOnly && modified && (key === 'v' || key === 'd' || key === 'g' || key === 'y')) {
        event.preventDefault()
        return
      }

      if (modified && (key === 'z' || key === 'y')) {
        event.preventDefault()
        const collaboration = controller
        const isRedo = key === 'y' || event.shiftKey
        if (collaboration?.isLocalAutosaveSuppressed()) {
          if (!collaborationCapabilities(collaboration.getState()).canEdit) return
          if (isRedo) performRedo()
          else performUndo()
        } else if (isRedo) performRedo()
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
      }
    }

    document.addEventListener('keydown', handleShortcut)
    return () => document.removeEventListener('keydown', handleShortcut)
  }, [
    copySelectedNodes,
    fitView,
    hydrated,
    modalOpen,
    notify,
    onAddNode,
    performRedo,
    performUndo,
    setActiveTool,
    toggleLayers,
    withBulkLease,
    collaborationControllerRef,
  ])
}
