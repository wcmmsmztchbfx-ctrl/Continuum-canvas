import { describe, expect, it, vi } from 'vitest'
import { createCanvasStore } from './canvas-store'
import { parseProjectSnapshot, type CanvasNode, type ProjectSnapshot } from '../model/project'

const node = (id: string): CanvasNode => ({ id, type: 'text', name: id, position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, data: { text: id } })
const initial: ProjectSnapshot = { version: 1, projectId: 'p', name: 'Canvas', viewport: { x: 70, y: 80, zoom: .5 }, nodes: [node('mine')], edges: [] }

describe('remote Agent reconciliation', () => {
  it('keeps a local addition undoable after the save round trip fills default node metadata', () => {
    const store = createCanvasStore({ ...structuredClone(initial), nodes: [] })
    store.getState().addNode(node('manual'))
    const incoming = parseProjectSnapshot(JSON.stringify(store.getState().snapshot))
    incoming.nodes.push(node('agent'))
    const onHistoryInvalidated = vi.fn()

    store.getState().reconcileRemoteSnapshot(incoming, { rebaseHistory: true, onHistoryInvalidated })
    expect(onHistoryInvalidated).not.toHaveBeenCalled()
    expect(store.getState().canUndo).toBe(true)
    store.getState().undo()
    expect(store.getState().snapshot.nodes.map(n => n.id)).toEqual(['agent'])
    store.getState().redo()
    expect(store.getState().snapshot.nodes.map(n => n.id)).toEqual(['manual', 'agent'])
  })

  it('invalidates undoing an addition when the remote actually edited that node', () => {
    const store = createCanvasStore({ ...structuredClone(initial), nodes: [] })
    store.getState().addNode(node('manual'))
    const incoming = parseProjectSnapshot(JSON.stringify(store.getState().snapshot))
    incoming.nodes[0]!.name = 'Remote edit'
    incoming.nodes.push(node('agent'))
    const onHistoryInvalidated = vi.fn()

    store.getState().reconcileRemoteSnapshot(incoming, { rebaseHistory: true, onHistoryInvalidated })
    expect(onHistoryInvalidated).toHaveBeenCalledWith(1)
    expect(store.getState().canUndo).toBe(false)
    store.getState().undo()
    expect(store.getState().snapshot.nodes.map(n => n.name)).toEqual(['Remote edit', 'agent'])
  })

  it('keeps remote additions through normal undo and redo without clearing local history or camera', () => {
    const store = createCanvasStore(structuredClone(initial))
    store.getState().renameNode('mine', 'Edited')
    store.getState().selectNode('mine')
    const incoming = { ...store.getState().snapshot, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [...store.getState().snapshot.nodes, node('agent')] }
    store.getState().reconcileRemoteSnapshot(incoming, { rebaseHistory: true })
    expect(store.getState().snapshot.viewport).toEqual({ x: 70, y: 80, zoom: .5 })
    expect(store.getState().selectedNodeIds).toEqual(['mine'])
    expect(store.getState().canUndo).toBe(true)
    store.getState().undo()
    expect(store.getState().snapshot.nodes.map(n => [n.id, n.name])).toEqual([['mine', 'mine'], ['agent', 'agent']])
    store.getState().redo()
    expect(store.getState().snapshot.nodes.map(n => [n.id, n.name])).toEqual([['mine', 'Edited'], ['agent', 'agent']])
  })

  it('does not let historical same-field edits overwrite a newer remote value', () => {
    const store = createCanvasStore(structuredClone(initial))
    store.getState().renameNode('mine', 'Old local edit')
    const incoming = structuredClone(store.getState().snapshot)
    incoming.nodes[0]!.name = 'New remote name'
    store.getState().reconcileRemoteSnapshot(incoming, { rebaseHistory: true })
    store.getState().undo()
    expect(store.getState().snapshot.nodes[0]!.name).toBe('New remote name')
  })
})
