import { describe, expect, it, vi } from 'vitest'
import { createAgentCanvasSync } from './agentCanvasSync'
import type { CanvasSnapshotV2 } from '../../model/project'
import type { CanvasSynchronizationResult, WorkspaceRepository } from '../../workspace/repository'
import { createCanvasStore } from '../../store/canvas-store'
import type { AgentRun } from '../../contracts/agent'

const initial: CanvasSnapshotV2 = { version: 3, canvasId: 'a', projectId: 'p', name: 'Canvas', viewport: { x: 50, y: 60, zoom: .5 }, nodes: [], edges: [] }
const remote: CanvasSnapshotV2 = { ...initial, nodes: [{ id: 'agent', type: 'text', name: 'Agent', position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, data: { text: 'new' } }] }
const run = { canvasId: 'a', appliedCanvasRevision: 3 } as AgentRun
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('background Agent canvas observer', () => {
  it('receives a background result without a panel and does not echo it through saveCanvas', async () => {
    const store = createCanvasStore({ ...initial, version: 1 })
    const saveCanvas = vi.fn(async () => undefined)
    const repository = { synchronizeCanvas: async () => ({ canvas: remote, conflicts: [], revision: 3 }), confirmedCanvasRevision: async () => 3, saveCanvas } as unknown as WorkspaceRepository
    const sync = createAgentCanvasSync({ canvasId: 'a', repository, readLocal: () => ({ ...store.getState().snapshot, version: 3, canvasId: 'a' }),
      readRuns: async () => [run], isCollaborating: () => false, applyRemote: canvas => store.getState().reconcileRemoteSnapshot({ ...canvas, version: 1 }, { rebaseHistory: true }), flushLocal: async () => {}, onError: () => {} })
    await sync.poll()
    expect(store.getState().snapshot.nodes.map(n => n.id)).toEqual(['agent'])
    expect(store.getState().snapshot.viewport).toEqual({ x: 50, y: 60, zoom: .5 })
    expect(saveCanvas).not.toHaveBeenCalled()
    sync.stop()
  })

  it('does not apply a delayed response to the canvas opened after switching', async () => {
    const response = deferred<CanvasSynchronizationResult>()
    let displayed = initial
    const sync = createAgentCanvasSync({ canvasId: 'a', repository: { synchronizeCanvas: () => response.promise } as unknown as WorkspaceRepository,
      readLocal: () => displayed, readRuns: async () => [run], isCollaborating: () => false, applyRemote: canvas => { displayed = canvas }, flushLocal: async () => {}, onError: () => {} })
    const pending = sync.poll()
    await vi.waitFor(() => expect(sync.isSynchronizing()).toBe(true))
    sync.stop()
    displayed = { ...initial, canvasId: 'b', name: 'Other canvas' }
    response.resolve({ canvas: remote, conflicts: [], revision: 3 })
    await pending
    expect(displayed.canvasId).toBe('b')
    expect(displayed.nodes).toEqual([])
  })

  it('preserves edits made while the remote read is in flight', async () => {
    const response = deferred<CanvasSynchronizationResult>()
    let displayed = initial, calls = 0
    const repository = { synchronizeCanvas: async (canvas: CanvasSnapshotV2) => ++calls === 1 ? response.promise : ({ canvas, conflicts: [], revision: 3 }) } as unknown as WorkspaceRepository
    const sync = createAgentCanvasSync({ canvasId: 'a', repository, readLocal: () => displayed, readRuns: async () => [run], isCollaborating: () => false,
      applyRemote: canvas => { displayed = canvas }, flushLocal: async () => {}, onError: () => {} })
    const pending = sync.poll()
    await vi.waitFor(() => expect(sync.isSynchronizing()).toBe(true))
    displayed = { ...initial, name: 'Typed while waiting' }
    response.resolve({ canvas: remote, conflicts: [], revision: 3 })
    await pending
    expect(displayed.name).toBe('Typed while waiting')
    expect(displayed.nodes.map(n => n.id)).toEqual(['agent'])
    sync.stop()
  })

  it('retains the closing canvas camera when switching during a remote read', async () => {
    const response = deferred<CanvasSynchronizationResult>()
    let displayed = initial, calls = 0, retained: CanvasSnapshotV2 | undefined
    const repository = { synchronizeCanvas: async (canvas: CanvasSnapshotV2) => {
      if (++calls === 1) return response.promise
      retained = canvas
      return { canvas, conflicts: [], revision: 3 }
    } } as unknown as WorkspaceRepository
    const sync = createAgentCanvasSync({ canvasId: 'a', repository, readLocal: () => displayed, readRuns: async () => [run], isCollaborating: () => false,
      applyRemote: canvas => { displayed = canvas }, flushLocal: async () => {}, onError: () => {} })
    const pending = sync.poll()
    await vi.waitFor(() => expect(sync.isSynchronizing()).toBe(true))
    displayed = { ...initial, viewport: { x: 900, y: 800, zoom: .25 } }
    sync.stop()
    displayed = { ...initial, canvasId: 'b' }
    response.resolve({ canvas: remote, conflicts: [], revision: 3 })
    await pending
    expect(retained?.viewport).toEqual({ x: 900, y: 800, zoom: .25 })
    expect(retained?.nodes.map(n => n.id)).toEqual(['agent'])
    expect(displayed.canvasId).toBe('b')
  })

  it('waits for confirmed local saves before returning the task revision', async () => {
    const saved = deferred<void>()
    let confirmed = false
    const sync = createAgentCanvasSync({ canvasId: 'a', repository: { synchronizeCanvas: async () => ({ canvas: initial, conflicts: [], revision: 4 }), confirmedCanvasRevision: async () => { expect(confirmed).toBe(true); return 4 } } as unknown as WorkspaceRepository,
      readLocal: () => initial, readRuns: async () => [], isCollaborating: () => false, applyRemote: () => {}, flushLocal: async () => { await saved.promise; confirmed = true }, onError: () => {} })
    let returned = false
    const pending = sync.beforeRun().then(result => { returned = true; return result })
    await Promise.resolve()
    expect(returned).toBe(false)
    saved.resolve()
    expect(await pending).toEqual({ expectedRevision: 4 })
    sync.stop()
  })

  it('rechecks an edit made while waiting for the final revision confirmation', async () => {
    let displayed = initial, confirmations = 0
    const firstConfirmation = deferred<number>()
    const repository = { synchronizeCanvas: async (canvas: CanvasSnapshotV2) => ({ canvas, conflicts: [], revision: 4 }),
      confirmedCanvasRevision: async () => ++confirmations === 1 ? firstConfirmation.promise : 5 } as unknown as WorkspaceRepository
    const sync = createAgentCanvasSync({ canvasId: 'a', repository, readLocal: () => displayed, readRuns: async () => [], isCollaborating: () => false,
      applyRemote: canvas => { displayed = canvas }, flushLocal: async () => {}, onError: () => {} })
    const pending = sync.beforeRun()
    await vi.waitFor(() => expect(confirmations).toBe(1))
    displayed = { ...initial, name: 'An edit during confirmation' }
    firstConfirmation.resolve(4)
    expect(await pending).toEqual({ expectedRevision: 5 })
    sync.stop()
  })
})
