// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import { AgentRuntimeClient } from './agentRuntimeClient'
import { canvasStore } from '../../store/canvas-store'
import type { AgentRun } from '../../contracts/agent'
import type { CanvasSnapshotV2 } from '../../model/project'
import type { CanvasSynchronizationResult, WorkspaceRepository } from '../../workspace/repository'

beforeAll(() => { globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } })
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })
const initial: CanvasSnapshotV2 = { version: 3, canvasId: 'a', projectId: 'p', name: 'Canvas', viewport: { x: 70, y: 80, zoom: .5 }, nodes: [], edges: [] }
const remote: CanvasSnapshotV2 = { ...initial, nodes: [{ id: 'agent-result', type: 'text', name: 'Agent result', position: { x: 100, y: 100 }, size: { width: 200, height: 100 }, data: { text: 'Finished remotely' } }] }
const thumbnailService = { schedule: vi.fn(), flush: vi.fn(async () => undefined) }

describe('App background Agent synchronization', () => {
  it('updates the canvas while the Agent panel is closed without echoing autosave', async () => {
    vi.spyOn(AgentRuntimeClient.prototype, 'listRuns').mockResolvedValue([{ canvasId: 'a', appliedCanvasRevision: 2 } as AgentRun])
    const saveCanvas = vi.fn(async () => undefined)
    const repository = { loadCanvas: async () => initial, saveCanvas, synchronizeCanvas: async () => ({ canvas: remote, revision: 2, conflicts: [] }), confirmedCanvasRevision: async () => 2 } as unknown as WorkspaceRepository
    const view = render(<App canvasId="a" projectId="p" workspaceRepository={repository} thumbnailService={thumbnailService} />)
    await waitFor(() => expect(screen.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true'))
    await waitFor(() => expect(canvasStore.getState().snapshot.nodes.map(node => node.id)).toContain('agent-result'))
    expect(canvasStore.getState().snapshot.viewport).toEqual({ x: 70, y: 80, zoom: .5 })
    expect(saveCanvas).not.toHaveBeenCalled()
    view.unmount()
    await act(async () => {})
    expect(saveCanvas).not.toHaveBeenCalled()
  })

  it('does not write an old Agent response into the newly opened canvas', async () => {
    let resolve!: (value: CanvasSynchronizationResult) => void
    const response = new Promise<CanvasSynchronizationResult>(done => { resolve = done })
    vi.spyOn(AgentRuntimeClient.prototype, 'listRuns').mockImplementation(async id => id === 'a' ? [{ canvasId: 'a', appliedCanvasRevision: 2 } as AgentRun] : [])
    const synchronizeCanvas = vi.fn(() => response)
    const repository = { loadCanvas: async (id: string) => ({ ...initial, canvasId: id, name: id }), saveCanvas: async () => undefined, synchronizeCanvas } as unknown as WorkspaceRepository
    const view = render(<App canvasId="a" projectId="p" workspaceRepository={repository} thumbnailService={thumbnailService} />)
    await waitFor(() => expect(synchronizeCanvas).toHaveBeenCalled())
    view.rerender(<App canvasId="b" projectId="p" workspaceRepository={repository} thumbnailService={thumbnailService} />)
    await waitFor(() => expect(canvasStore.getState().snapshot.name).toBe('b'))
    await act(async () => { resolve({ canvas: remote, revision: 2, conflicts: [] }); await response })
    expect(canvasStore.getState().snapshot.name).toBe('b')
    expect(canvasStore.getState().snapshot.nodes).toEqual([])
  })
})
