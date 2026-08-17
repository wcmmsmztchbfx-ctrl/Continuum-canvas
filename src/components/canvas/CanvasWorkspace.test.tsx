// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useEffect, type ReactNode } from 'react'
import type { ReactFlowProps } from '@xyflow/react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { referenceProjectSnapshot } from '../../fixtures/reference'
import type { NodeLeaseKind } from '../../contracts/collaboration'
import { createCanvasStore } from '../../store/canvas-store'
import { CanvasWorkspace } from './CanvasWorkspace'
import type { CanvasFlowEdge, CanvasFlowNode } from './mapping'

const reactFlowMock = vi.hoisted(() => {
  interface MockFlowNode {
    id: string
    position: { x: number; y: number }
    parentId?: string
    width?: number
    height?: number
    initialWidth?: number
    initialHeight?: number
  }

  const state = {
    props: undefined as unknown,
    renderCount: 0,
    initialized: false,
    nodes: [] as unknown[],
    edges: [] as unknown[],
    nodeSetCount: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    screenToFlowPosition: (point: { x: number; y: number }) => point,
  }

  const getStoreState = () => {
    const nodes = state.nodes as MockFlowNode[]
    const nodesById = new Map(nodes.map((node) => [node.id, node]))
    const absolutePositions = new Map<string, { x: number; y: number }>()
    const resolveAbsolutePosition = (node: MockFlowNode) => {
      const existing = absolutePositions.get(node.id)
      if (existing) return existing
      const parent = node.parentId ? nodesById.get(node.parentId) : undefined
      const parentPosition = parent
        ? resolveAbsolutePosition(parent)
        : { x: 0, y: 0 }
      const position = {
        x: parentPosition.x + node.position.x,
        y: parentPosition.y + node.position.y,
      }
      absolutePositions.set(node.id, position)
      return position
    }

    return {
      nodeLookup: new Map(
        nodes.map((node) => [
          node.id,
          {
            ...node,
            measured: {
              width: node.width ?? node.initialWidth,
              height: node.height ?? node.initialHeight,
            },
            internals: {
              positionAbsolute: resolveAbsolutePosition(node),
              z: 0,
            },
          },
        ]),
      ),
      transform: [
        state.viewport.x,
        state.viewport.y,
        state.viewport.zoom,
      ] as [number, number, number],
    }
  }

  const resolveUpdate = (update: unknown, current: unknown[]) =>
    typeof update === 'function'
      ? (update as (items: unknown[]) => unknown[])(current)
      : (update as unknown[])

  return {
    ...state,
    instance: {
      setNodes: (update: unknown) => {
        state.nodeSetCount += 1
        state.nodes = resolveUpdate(update, state.nodes)
      },
      setEdges: (update: unknown) => {
        state.edges = resolveUpdate(update, state.edges)
      },
      fitView: () => Promise.resolve(true),
      getViewport: () => state.viewport,
      getNodes: () => state.nodes,
      getInternalNode: (id: string) => reactFlowMock.getStoreState().nodeLookup.get(id),
      setViewport: vi.fn(async (viewport: { x: number; y: number; zoom: number }) => {
        state.viewport = viewport
        return undefined
      }),
      screenToFlowPosition: (point: { x: number; y: number }) =>
        state.screenToFlowPosition(point),
    },
    getStoreState,
    state,
  }
})

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()

  return {
    ...actual,
    ReactFlow: (props: ReactFlowProps) => {
      if (!reactFlowMock.state.initialized) {
        reactFlowMock.state.nodes = [...(props.defaultNodes ?? props.nodes ?? [])]
        reactFlowMock.state.edges = [...(props.defaultEdges ?? props.edges ?? [])]
        if (props.defaultViewport) {
          reactFlowMock.state.viewport = props.defaultViewport
        }
        reactFlowMock.state.initialized = true
      }
      if (props.nodes) reactFlowMock.state.nodes = props.nodes
      if (props.edges) reactFlowMock.state.edges = props.edges
      reactFlowMock.props = props
      reactFlowMock.renderCount += 1
      const onInit = props.onInit
      useEffect(() => {
        onInit?.(reactFlowMock.instance as never)
      }, [onInit])
      return (
        <div className="react-flow__pane" data-testid="react-flow-mock">
          {(props.nodes ?? []).map((node) => (
            <div data-flow-node-id={node.id} key={node.id} />
          ))}
          {(props.edges ?? []).map((edge) => (
            <div data-flow-edge-id={edge.id} key={edge.id} />
          ))}
          {props.children}
        </div>
      )
    },
    MiniMap: () => <div data-testid="canvas-minimap" />,
    ViewportPortal: ({ children }: { children?: ReactNode }) => (
      <div data-testid="viewport-portal">{children}</div>
    ),
    useStore: <StateSlice,>(
      selector: (
        state: ReturnType<typeof reactFlowMock.getStoreState>,
      ) => StateSlice,
    ) => selector(reactFlowMock.getStoreState()),
    NodeToolbar: ({
      children,
      isVisible,
      nodeId,
      position,
    }: {
      children?: ReactNode
      isVisible?: boolean
      nodeId?: string | string[]
      position?: string
    }) =>
      isVisible ? (
        <div
          data-node-ids={Array.isArray(nodeId) ? nodeId.join(',') : nodeId}
          data-position={position}
          data-testid="node-toolbar"
        >
          {children}
        </div>
      ) : null,
  }
})

function flowProps() {
  return reactFlowMock.props as ReactFlowProps<CanvasFlowNode, CanvasFlowEdge>
}

function flowNodes() {
  return reactFlowMock.state.nodes as CanvasFlowNode[]
}

function flowEdges() {
  return reactFlowMock.state.edges as CanvasFlowEdge[]
}

beforeEach(() => {
  reactFlowMock.props = undefined
  reactFlowMock.renderCount = 0
  reactFlowMock.state.initialized = false
  reactFlowMock.state.nodes = []
  reactFlowMock.state.edges = []
  reactFlowMock.state.nodeSetCount = 0
  reactFlowMock.state.viewport = { x: 0, y: 0, zoom: 1 }
  reactFlowMock.state.screenToFlowPosition = (point) => point
  vi.mocked(reactFlowMock.instance.setViewport).mockClear()
})

afterEach(cleanup)

describe('CanvasWorkspace', () => {
  it('owns persistent React Flow nodes and edges through controlled props', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)

    expect(flowProps().nodes).toBeDefined()
    expect(flowProps().edges).toBeDefined()
    expect(flowProps().defaultNodes).toBeUndefined()
    expect(flowProps().defaultEdges).toBeUndefined()
  })

  it('preserves projected node and edge identity across equivalent presence updates', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const callbacks = {
      setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn(),
    }
    const presence = [{
      clientId: 8,
      member: { memberId: 'remote-b', displayName: '远端', color: '#d08c55', role: 'editor' as const },
      cursor: { x: 200, y: 160 }, selection: { nodeIds: [] },
    }]
    const view = render(<CanvasWorkspace collaboration={{
      ...callbacks, localMemberId: 'local-a', status: 'synced', presence,
    }} store={store} />)
    const beforeNodes = [...(flowProps().nodes ?? [])]
    const beforeEdges = [...(flowProps().edges ?? [])]
    const beforeData = beforeNodes.map((node) => node.data)
    const beforeNodeElements = beforeNodes.map((node) =>
      view.container.querySelector(`[data-flow-node-id="${node.id}"]`),
    )
    const beforeEdgeElements = beforeEdges.map((edge) =>
      view.container.querySelector(`[data-flow-edge-id="${edge.id}"]`),
    )

    view.rerender(<CanvasWorkspace collaboration={{
      ...callbacks, localMemberId: 'local-a', status: 'synced',
      presence: presence.map((entry) => ({
        ...entry,
        member: { ...entry.member },
        cursor: entry.cursor ? { ...entry.cursor } : null,
        selection: { nodeIds: [...entry.selection.nodeIds] },
      })),
    }} store={store} />)

    expect(flowProps().nodes).toEqual(beforeNodes)
    expect(flowProps().edges).toEqual(beforeEdges)
    ;(flowProps().nodes ?? []).forEach((node, index) => {
      expect(node).toBe(beforeNodes[index])
      expect(node.data).toBe(beforeData[index])
    })
    ;(flowProps().edges ?? []).forEach((edge, index) => {
      expect(edge).toBe(beforeEdges[index])
    })
    beforeNodes.forEach((node, index) => {
      expect(view.container.querySelector(`[data-flow-node-id="${node.id}"]`))
        .toBe(beforeNodeElements[index])
    })
    beforeEdges.forEach((edge, index) => {
      expect(view.container.querySelector(`[data-flow-edge-id="${edge.id}"]`))
        .toBe(beforeEdgeElements[index])
    })
  })

  it('reprojects only the changed node and edges linked to a changed selection', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)
    const beforeNodes = [...(flowProps().nodes ?? [])]
    const beforeEdges = [...(flowProps().edges ?? [])]
    const changed = referenceProjectSnapshot.nodes[0]!

    act(() => store.getState().moveNodes([{
      id: changed.id,
      position: { x: changed.position.x + 40, y: changed.position.y + 20 },
    }]))

    const afterRenameNodes = [...(flowProps().nodes ?? [])]
    const afterRenameEdges = [...(flowProps().edges ?? [])]
    expect(afterRenameNodes.filter((node, index) => node !== beforeNodes[index]).map((node) => node.id))
      .toEqual([changed.id])
    afterRenameEdges.forEach((edge, index) => expect(edge).toBe(beforeEdges[index]))

    act(() => store.setState({ selectedNodeIds: [changed.id] }))

    const afterSelectionNodes = [...(flowProps().nodes ?? [])]
    const afterSelectionEdges = [...(flowProps().edges ?? [])]
    expect(afterSelectionNodes.filter((node, index) => node !== afterRenameNodes[index]).map((node) => node.id))
      .toEqual([changed.id])
    afterSelectionEdges.forEach((edge, index) => {
      const linked = edge.source === changed.id || edge.target === changed.id
      expect(edge === afterRenameEdges[index]).toBe(!linked)
    })
  })

  it('broadcasts canvas presence while keeping local selection independent', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const setCursor = vi.fn()
    const setSelection = vi.fn()
    const setViewport = vi.fn()
    reactFlowMock.state.screenToFlowPosition = (point) => ({
      x: point.x - 20,
      y: point.y + 10,
    })
    const view = render(
      <CanvasWorkspace
        collaboration={{
          presence: [], setCursor, setSelection, setViewport,
        }}
        store={store}
      />,
    )

    fireEvent.pointerMove(view.getByTestId('canvas-workspace'), {
      clientX: 120, clientY: 70,
    })
    expect(setCursor).toHaveBeenLastCalledWith({ x: 100, y: 80 })
    fireEvent.pointerLeave(view.getByTestId('canvas-workspace'))
    expect(setCursor).toHaveBeenLastCalledWith(null)

    const nodeId = store.getState().snapshot.nodes[0]!.id
    act(() => store.setState({ selectedNodeIds: [nodeId] }))
    expect(setSelection).toHaveBeenLastCalledWith([nodeId])
    expect(flowNodes().filter((node) => node.selected).map((node) => node.id)).toEqual([nodeId])

    const nextViewport = { x: 44, y: -12, zoom: 0.7 }
    act(() => flowProps().onMoveEnd?.(null, nextViewport))
    expect(setViewport).toHaveBeenLastCalledWith(nextViewport)
  })

  it('renders remote cursors and selection outlines without marking nodes selected', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const remoteNodeId = store.getState().snapshot.nodes[0]!.id
    render(
      <CanvasWorkspace
        collaboration={{
          presence: [{
            clientId: 9,
            member: { memberId: 'remote-a', displayName: '远端成员', color: '#e59a52', role: 'editor' },
            cursor: { x: 250, y: 160 },
            selection: { nodeIds: [remoteNodeId] },
          }],
          setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn(),
        }}
        store={store}
      />,
    )

    expect(document.querySelector('[data-remote-cursor="remote-a"]')).not.toBeNull()
    expect(document.querySelector(`[data-remote-selection="${remoteNodeId}"]`)).not.toBeNull()
    expect(flowNodes().find((node) => node.id === remoteNodeId)?.selected).toBe(false)
  })

  it('renders remote drag preview without touching the store or reconciling media nodes', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const node = referenceProjectSnapshot.nodes.find((candidate) => candidate.type === 'image')!
    const before = store.getState().serialize()
    const callbacks = { setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn() }
    const view = render(<CanvasWorkspace collaboration={{
      ...callbacks, localMemberId: 'local-a', status: 'synced', presence: [],
    }} store={store} />)
    const baselineNodeSets = reactFlowMock.state.nodeSetCount
    const originalUrl = flowNodes().find((candidate) => candidate.id === node.id)?.data.url

    view.rerender(<CanvasWorkspace collaboration={{
      ...callbacks, localMemberId: 'local-a', status: 'synced', presence: [{
        clientId: 7,
        member: { memberId: 'remote-a', displayName: '远端', color: '#d08c55', role: 'editor' },
        cursor: null,
        selection: { nodeIds: [node.id] },
        interactionPreview: { kind: 'drag', coordinateSpace: 'canvas-absolute', nodes: [{ nodeId: node.id, position: { x: 800, y: 600 } }] },
      }],
    }} store={store} />)

    expect(document.querySelector(`[data-remote-preview="${node.id}"]`)).not.toBeNull()
    expect(store.getState().serialize()).toBe(before)
    expect(flowNodes().find((candidate) => candidate.id === node.id)?.selected).toBe(false)
    expect(flowNodes().find((candidate) => candidate.id === node.id)?.data.url).toBe(originalUrl)
    expect(reactFlowMock.state.nodeSetCount).toBe(baselineNodeSets)
  })

  it('resolves remote preview and lease geometry without requiring a remote selection', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const node = referenceProjectSnapshot.nodes[0]!
    render(<CanvasWorkspace collaboration={{
      localMemberId: 'local-a', status: 'synced',
      setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn(),
      presence: [{
        clientId: 17,
        member: { memberId: 'remote-a', displayName: '远端', color: '#d08c55', role: 'editor' },
        cursor: null, selection: { nodeIds: [] },
        lease: {
          leaseId: 'remote-lease', nodeIds: [node.id], memberId: 'remote-a', kind: 'drag',
          startedAt: 1, heartbeatAt: 1, expiresAt: 7000, confirmed: true,
        },
        interactionPreview: {
          kind: 'drag', coordinateSpace: 'canvas-absolute',
          nodes: [{ nodeId: node.id, position: { x: 840, y: 610 } }],
        },
      }],
    }} store={store} />)

    expect((document.querySelector(`[data-remote-preview="${node.id}"]`) as HTMLElement | null)?.style.transform)
      .toBe('translate(840px, 610px)')
    expect(document.querySelector(`[data-remote-lock="${node.id}"]`)).not.toBeNull()
    expect(flowNodes().find((candidate) => candidate.id === node.id)?.selected).toBe(false)
  })

  it('leases resize previews and commits the final size once', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const media = referenceProjectSnapshot.nodes.find((node) => node.type === 'video')!
    const lease = {
      leaseId: 'lease-resize', nodeIds: [media.id], memberId: 'local-a', kind: 'resize' as const,
      startedAt: 1, heartbeatAt: 1, expiresAt: 7000, confirmed: true,
    }
    const preview = vi.fn()
    const resizeNode = vi.spyOn(store.getState(), 'resizeNode')
    render(<CanvasWorkspace collaboration={{
      localMemberId: 'local-a', status: 'synced', presence: [],
      setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn(),
      acquireLease: vi.fn(() => lease), getLease: vi.fn(() => lease), releaseLease: vi.fn(),
      subscribeLeaseLost: vi.fn(() => () => undefined), setInteractionPreview: preview,
      clearPreview: vi.fn(), setInteraction: vi.fn(), clearInteraction: vi.fn(),
    }} store={store} />)
    const flow = flowNodes().find((node) => node.id === media.id)!

    expect(flow.data.onResizeStart?.(media.id)).toBe(true)
    for (let step = 1; step <= 40; step += 1) {
      flow.data.onResizePreview?.(media.id, { width: 480 + step, height: 270 + step })
    }
    flow.data.onResize?.(media.id, { width: 520, height: 310 })

    expect(preview).toHaveBeenCalledTimes(40)
    expect(resizeNode).toHaveBeenCalledTimes(1)
    expect(store.getState().snapshot.nodes.find((node) => node.id === media.id)?.size)
      .toEqual({ width: 520, height: 310 })
  })

  it('follows an online member and exits on local navigation or disconnect', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const onStopFollowing = vi.fn()
    const remote = {
      clientId: 11,
      member: { memberId: 'remote-b', displayName: '导演', color: '#66b7a4', role: 'owner' as const },
      cursor: null,
      selection: { nodeIds: [] },
      viewport: { x: 320, y: 180, zoom: 1.4 },
    }
    const view = render(
      <CanvasWorkspace
        collaboration={{
          followingMemberId: 'remote-b', onStopFollowing,
          presence: [remote], setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn(),
        }}
        store={store}
      />,
    )

    expect(reactFlowMock.instance.setViewport).toHaveBeenCalledWith(
      remote.viewport,
      { duration: 60 },
    )
    fireEvent.wheel(view.getByTestId('canvas-workspace'))
    fireEvent.pointerDown(view.getByTestId('canvas-workspace'), { button: 1 })
    act(() => flowProps().onMoveStart?.({} as MouseEvent, remote.viewport))
    expect(onStopFollowing).toHaveBeenCalledTimes(3)

    view.rerender(
      <CanvasWorkspace
        collaboration={{
          followingMemberId: 'remote-b', onStopFollowing,
          presence: [], setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn(),
        }}
        store={store}
      />,
    )
    expect(onStopFollowing).toHaveBeenCalledTimes(4)
  })

  it('applies followed viewports without broadcasting them back', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const setPresenceViewport = vi.fn()
    const remote = {
      clientId: 11,
      member: { memberId: 'remote-b', displayName: '导演', color: '#66b7a4', role: 'owner' as const },
      cursor: null, selection: { nodeIds: [] },
      viewport: { x: 320, y: 180, zoom: 1.4 },
    }
    render(<CanvasWorkspace collaboration={{
      followingMemberId: 'remote-b', onStopFollowing: vi.fn(), presence: [remote],
      setCursor: vi.fn(), setSelection: vi.fn(), setViewport: setPresenceViewport,
    }} store={store} />)

    act(() => flowProps().onMoveEnd?.(null, remote.viewport))
    expect(setPresenceViewport).not.toHaveBeenCalled()
  })

  it('keeps viewer navigation selectable while disabling every canvas write surface', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const before = store.getState().serialize()
    const generationController = {
      start: vi.fn(), startSubmitted: vi.fn(), resumePersisted: vi.fn(), dispose: vi.fn(), retry: vi.fn(),
    }
    render(<CanvasWorkspace generationController={generationController} readOnly store={store} />)
    const props = flowProps()
    expect(props.nodesDraggable).toBe(false)
    expect(props.nodesConnectable).toBe(false)
    expect(props.deleteKeyCode).toBeNull()
    expect(props.elementsSelectable).toBe(true)
    expect(generationController.resumePersisted).not.toHaveBeenCalled()
    expect(flowNodes().every((node) =>
      node.data.onGenerate === undefined &&
      node.data.onTextChange === undefined &&
      node.data.onRename === undefined &&
      node.data.onResize === undefined &&
      node.data.onAttachReference === undefined)).toBe(true)
    act(() => {
      props.onNodesDelete?.([flowNodes()[0]!] as never)
      props.onEdgesDelete?.([flowEdges()[0]!] as never)
      props.onConnect?.({ source: flowNodes()[0]!.id, target: flowNodes()[1]!.id } as never)
    })
    expect(store.getState().serialize()).toBe(before)
    expect(generationController.start).not.toHaveBeenCalled()
  })
  it('configures React Flow with the full fixture and interaction limits', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const view = render(<CanvasWorkspace store={store} />)
    const props = flowProps()

    expect(view.getByTestId('canvas-workspace')).toBeTruthy()
    expect(props.nodes).toHaveLength(37)
    expect(props.edges).toHaveLength(27)
    expect(props.defaultViewport).toEqual(referenceProjectSnapshot.viewport)
    expect(props.minZoom).toBe(0.1)
    expect(props.maxZoom).toBe(8)
    expect(props.connectionRadius).toBeCloseTo(320)
    expect(props.onlyRenderVisibleElements).toBe(false)
    expect(props.selectionOnDrag).toBe(true)
    expect(props.multiSelectionKeyCode).toEqual(['Shift', 'Meta', 'Control'])
    expect(props.deleteKeyCode).toEqual(['Backspace', 'Delete'])
  })

  it('switches between selection, pan, and connection interactions', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)

    expect(flowProps().nodesDraggable).toBe(true)
    expect(flowProps().panOnDrag).toEqual([1])
    expect(flowProps().nodesConnectable).toBe(true)
    expect(flowProps().connectionLineComponent).toBeTypeOf('function')

    act(() => store.getState().setMode('pan'))
    expect(flowProps().nodesDraggable).toBe(false)
    expect(flowProps().panOnDrag).toEqual([0, 1])
    expect(flowProps().nodesConnectable).toBe(false)

    act(() => store.getState().setMode('connect'))
    expect(flowProps().nodesConnectable).toBe(true)
    expect(flowProps().elementsSelectable).toBe(false)
  })

  it('anchors bulk actions to a multi-selection and exposes grouped state', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const onSelectionAction = vi.fn()
    const view = render(
      <CanvasWorkspace
        onSelectionAction={onSelectionAction}
        store={store}
      />,
    )
    const selectedIds = referenceProjectSnapshot.nodes
      .slice(0, 2)
      .map((node) => node.id)

    act(() => store.setState({ selectedNodeIds: selectedIds }))

    expect(
      flowNodes()
        .filter((node) => selectedIds.includes(node.id))
        .every((node) => node.data.isSoleSelection === false),
    ).toBe(true)
    expect(view.queryByTestId('selection-union-boundary')).toBeNull()
    expect(
      view.getByTestId('node-toolbar').getAttribute('data-node-ids'),
    ).toBe(selectedIds.join(','))
    const toolbarAnchor = view.getByTestId('selection-toolbar-anchor')
    expect(toolbarAnchor.getAttribute('data-node-ids')).toBe(
      selectedIds.join(','),
    )
    expect(toolbarAnchor.getAttribute('data-placement')).toBe('above')
    fireEvent.click(view.getByRole('button', { name: '打组' }))
    expect(onSelectionAction).toHaveBeenCalledWith('group')

    act(() => {
      store.getState().groupNodes(selectedIds, 'group-toolbar-test', '节点分组')
    })
    expect(reactFlowMock.getStoreState().nodeLookup.has('group-toolbar-test')).toBe(true)
    view.rerender(
      <CanvasWorkspace onSelectionAction={onSelectionAction} store={store} />,
    )
    expect(view.getByRole('button', { name: '解组' })).toBeTruthy()
  })

  it('applies persisted connection and grid preferences', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const view = render(
      <CanvasWorkspace hideConnections snapToGrid store={store} />,
    )

    expect(flowEdges()).toEqual([])
    expect(flowProps().snapToGrid).toBe(false)
    expect(flowProps().snapGrid).toEqual([12, 12])

    view.rerender(
      <CanvasWorkspace
        hideConnections={false}
        snapToGrid={false}
        store={store}
      />,
    )
    expect(flowEdges()).toHaveLength(27)
    expect(flowProps().snapToGrid).toBe(false)
  })

  it('renders the minimap only when the persisted toggle is enabled', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const view = render(<CanvasWorkspace showMiniMap store={store} />)

    expect(view.getByTestId('canvas-minimap')).toBeTruthy()

    view.rerender(<CanvasWorkspace showMiniMap={false} store={store} />)
    expect(view.queryByTestId('canvas-minimap')).toBeNull()
  })

  it('activates only edges incident to a selected node', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)
    const anchorId = referenceProjectSnapshot.edges[0]!.source

    act(() => store.getState().selectNode(anchorId))

    const incident = flowEdges().filter(
      (edge) => edge.source === anchorId || edge.target === anchorId,
    )
    const unrelated = flowEdges().filter(
      (edge) => edge.source !== anchorId && edge.target !== anchorId,
    )

    expect(incident.length).toBeGreaterThan(0)
    expect(unrelated.length).toBeGreaterThan(0)
    expect(incident.every((edge) => edge.data?.linkedToSelected)).toBe(true)
    expect(unrelated.every((edge) => !edge.data?.linkedToSelected)).toBe(true)
  })

  it('preserves unchanged edge references across project snapshot synchronization', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)
    const initial = flowEdges()

    act(() => store.setState((state) => ({
      snapshot: {
        ...state.snapshot,
        edges: state.snapshot.edges.map((edge) => ({ ...edge })),
      },
    })))

    expect(flowEdges()).toBe(initial)
    expect(flowEdges().every((edge, index) => edge === initial[index])).toBe(true)

    const changedId = referenceProjectSnapshot.edges[0]!.id
    act(() => store.setState((state) => ({
      snapshot: {
        ...state.snapshot,
        edges: state.snapshot.edges.map((edge) => edge.id === changedId
          ? { ...edge, relation: edge.relation === 'output' ? 'flow' : 'output' }
          : { ...edge }),
      },
    })))

    expect(flowEdges()).not.toBe(initial)
    expect(flowEdges().find((edge) => edge.id === changedId)).not.toBe(
      initial.find((edge) => edge.id === changedId),
    )
    expect(
      flowEdges()
        .filter((edge) => edge.id !== changedId)
        .every((edge) => edge === initial.find((candidate) => candidate.id === edge.id)),
    ).toBe(true)
  })

  it('replaces only incident edges when selection decoration changes', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)
    const initial = flowEdges()
    const anchorId = referenceProjectSnapshot.edges[0]!.source

    act(() => store.getState().selectNode(anchorId))

    const incidentIds = new Set(initial
      .filter((edge) => edge.source === anchorId || edge.target === anchorId)
      .map((edge) => edge.id))
    expect(flowEdges().every((edge) => incidentIds.has(edge.id)
      ? edge !== initial.find((candidate) => candidate.id === edge.id)
      : edge === initial.find((candidate) => candidate.id === edge.id))).toBe(true)
  })

  it('does not activate related edge animation for a multi-selection', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)
    const selectedIds = referenceProjectSnapshot.nodes.slice(0, 2).map((node) => node.id)

    act(() => store.setState({ selectedNodeIds: selectedIds }))

    expect(flowEdges().every((edge) => !edge.data?.linkedToSelected)).toBe(true)
  })

  it('picks image references from the canvas with stable aliases and exits on pane actions', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const view = render(<CanvasWorkspace store={store} />)
    const target = flowNodes().find((node) => node.data.mediaType === 'video')!
    const candidate = flowNodes().find(
      (node) => node.data.mediaType === 'image' && node.id !== target.id,
    )!

    act(() => target.data.onReferencePickerChange?.(target.id, true))
    expect(
      view
        .getByTestId('canvas-workspace')
        .getAttribute('data-reference-pick-target'),
    ).toBe(target.id)
    expect(
      flowNodes().find((node) => node.id === candidate.id)?.data
        .referencePickCandidate,
    ).toBe(true)
    expect(flowProps().elementsSelectable).toBe(false)

    act(() => {
      flowProps().onNodeClick?.(
        new MouseEvent('click') as never,
        candidate,
      )
    })
    const reference = store
      .getState()
      .getOrderedReferences(target.id)
      .find(({ node }) => node.id === candidate.id)
    expect(reference?.edge).toMatchObject({
      relation: 'reference',
      referenceAlias: expect.any(Number),
    })
    expect(store.getState().selectedNodeIds).toEqual([target.id])
    expect(flowProps().elementsSelectable).toBe(true)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(
      view
        .getByTestId('canvas-workspace')
        .hasAttribute('data-reference-pick-target'),
    ).toBe(false)

    act(() => target.data.onReferencePickerChange?.(target.id, true))
    act(() => flowProps().onPaneClick?.({} as never))
    expect(
      view
        .getByTestId('canvas-workspace')
        .hasAttribute('data-reference-pick-target'),
    ).toBe(false)
  })

  it('synchronizes multi-selection and completed drags to the canvas store', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)
    const first = flowNodes()[0]
    const second = flowNodes()[1]

    expect(first).toBeDefined()
    expect(second).toBeDefined()

    act(() => {
      flowProps().onNodesChange?.([
        { id: first!.id, type: 'select', selected: true },
        { id: second!.id, type: 'select', selected: true },
      ])
    })
    expect(store.getState().selectedNodeIds).toEqual([first!.id, second!.id])

    const firstPosition = { x: 123, y: 456 }
    const secondPosition = { x: 654, y: 321 }
    act(() => {
      flowProps().onNodeDragStop?.(
        {} as React.MouseEvent,
        { ...first!, position: firstPosition },
        [
          { ...first!, position: firstPosition },
          { ...second!, position: secondPosition },
        ],
      )
    })
    expect(
      store.getState().snapshot.nodes.find((node) => node.id === first!.id)
        ?.position,
    ).toEqual(firstPosition)
    expect(
      store.getState().snapshot.nodes.find((node) => node.id === second!.id)
        ?.position,
    ).toEqual(secondPosition)

    act(() => store.getState().undo())
    expect(
      store.getState().snapshot.nodes.find((node) => node.id === first!.id)
        ?.position,
    ).toEqual(first!.position)
    expect(
      store.getState().snapshot.nodes.find((node) => node.id === second!.id)
        ?.position,
    ).toEqual(second!.position)
  })

  it('replaces the prior selection for an ordinary partial box selection', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)
    const first = flowNodes()[0]!
    const second = flowNodes()[1]!
    act(() => store.setState({ selectedNodeIds: [first.id] }))

    act(() => {
      flowProps().onSelectionStart?.({ shiftKey: false } as never)
      flowProps().onNodesChange?.([
        { id: second.id, type: 'select', selected: true },
      ])
    })

    expect(store.getState().selectedNodeIds).toEqual([second.id])
  })

  it('adds a partial box selection when the gesture starts with Shift', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)
    const first = flowNodes()[0]!
    const second = flowNodes()[1]!
    act(() => store.setState({ selectedNodeIds: [first.id] }))

    act(() => {
      flowProps().onSelectionStart?.({ shiftKey: true } as never)
      flowProps().onNodesChange?.([
        { id: second.id, type: 'select', selected: true },
      ])
    })

    expect(store.getState().selectedNodeIds).toEqual([first.id, second.id])
  })

  it('commits a leased multi-node drag once after forty preview steps', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const first = referenceProjectSnapshot.nodes[0]!
    const second = referenceProjectSnapshot.nodes[1]!
    const lease = {
      leaseId: 'lease-drag', nodeIds: [first.id, second.id], memberId: 'local-a',
      kind: 'drag' as const, startedAt: 1, heartbeatAt: 1, expiresAt: 7000, confirmed: true,
    }
    const setInteractionPreview = vi.fn()
    const releaseLease = vi.fn()
    const moveNodes = vi.spyOn(store.getState(), 'moveNodesInHierarchy')
    render(<CanvasWorkspace collaboration={{
      localMemberId: 'local-a', status: 'synced', presence: [],
      setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn(),
      acquireLease: vi.fn(() => lease), getLease: vi.fn(() => lease),
      releaseLease, subscribeLeaseLost: vi.fn(() => () => undefined),
      setInteractionPreview, clearPreview: vi.fn(), setInteraction: vi.fn(), clearInteraction: vi.fn(),
    }} store={store} />)
    const nodes = flowNodes().slice(0, 2)
    act(() => flowProps().onNodeDragStart?.({} as never, nodes[0]!, nodes))
    for (let step = 1; step <= 40; step += 1) {
      const moved = nodes.map((node) => ({ ...node, position: { x: node.position.x + step, y: node.position.y } }))
      act(() => flowProps().onNodeDrag?.({} as never, moved[0]!, moved))
    }
    const finalNodes = nodes.map((node) => ({ ...node, position: { x: node.position.x + 40, y: node.position.y } }))
    act(() => flowProps().onNodeDragStop?.({} as never, finalNodes[0]!, finalNodes))

    expect(setInteractionPreview).toHaveBeenCalledTimes(40)
    expect(moveNodes).toHaveBeenCalledTimes(1)
    expect(releaseLease).toHaveBeenCalledTimes(1)
  })

  it('does not commit movement when the whole selection lease is refused', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const before = store.getState().serialize()
    render(<CanvasWorkspace collaboration={{
      localMemberId: 'local-a', status: 'synced', presence: [],
      setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn(),
      acquireLease: vi.fn(() => undefined), getLease: vi.fn(() => undefined),
      releaseLease: vi.fn(), subscribeLeaseLost: vi.fn(() => () => undefined),
      setInteractionPreview: vi.fn(), clearPreview: vi.fn(), setInteraction: vi.fn(), clearInteraction: vi.fn(),
    }} store={store} />)
    const node = flowNodes()[0]!
    act(() => flowProps().onNodeDragStart?.({} as never, node, [node]))
    act(() => flowProps().onNodeDragStop?.({} as never, { ...node, position: { x: 999, y: 999 } }, [node]))

    expect(store.getState().serialize()).toBe(before)
    expect(document.querySelector('.collaboration-lock-notice')).not.toBeNull()
  })

  it('restores the live React Flow geometry and suppresses previews after a drag lease is refused', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const preview = vi.fn()
    render(<CanvasWorkspace collaboration={{
      localMemberId: 'local-a', status: 'synced', presence: [],
      setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn(),
      acquireLease: vi.fn(() => undefined), getLease: vi.fn(() => undefined),
      releaseLease: vi.fn(), subscribeLeaseLost: vi.fn(() => () => undefined),
      setInteractionPreview: preview, clearPreview: vi.fn(), setInteraction: vi.fn(), clearInteraction: vi.fn(),
    }} store={store} />)
    const original = flowNodes()[0]!
    const live = {
      ...original,
      position: { x: 321, y: 456 },
      internals: { positionAbsolute: { x: 521, y: 656 } },
    } as unknown as CanvasFlowNode
    reactFlowMock.state.nodes = [live, ...flowNodes().slice(1)]

    act(() => flowProps().onNodeDragStart?.({} as never, live, [live]))
    const moved = { ...live, position: { x: 900, y: 900 } }
    reactFlowMock.state.nodes = [moved, ...flowNodes().slice(1)]
    act(() => flowProps().onNodeDrag?.({} as never, moved, [moved]))
    act(() => flowProps().onNodeDragStop?.({} as never, moved, [moved]))

    expect(flowNodes().find((node) => node.id === original.id)?.position)
      .toEqual({ x: 321, y: 456 })
    expect(preview).not.toHaveBeenCalled()
  })

  it('patches remote locks without replacing unaffected node data or active drag geometry', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const callbacks = { setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn() }
    const lease = {
      leaseId: 'lease-local', nodeIds: [referenceProjectSnapshot.nodes[0]!.id],
      memberId: 'local-a', kind: 'drag' as const, startedAt: 1, heartbeatAt: 1,
      expiresAt: 7000, confirmed: true,
    }
    const view = render(<CanvasWorkspace collaboration={{
      ...callbacks, localMemberId: 'local-a', status: 'synced', presence: [],
      acquireLease: vi.fn(() => lease), getLease: vi.fn(() => lease),
      releaseLease: vi.fn(), subscribeLeaseLost: vi.fn(() => () => undefined),
    }} store={store} />)
    const dragged = flowNodes()[0]!
    const locked = flowNodes()[1]!
    const unaffected = flowNodes()[2]!
    const unaffectedData = unaffected.data
    act(() => flowProps().onNodeDragStart?.({} as never, dragged, [dragged]))
    const draggedPreview = { ...dragged, position: { x: 777, y: 555 } }
    act(() => flowProps().onNodeDrag?.({ ctrlKey: true } as never, draggedPreview, [draggedPreview]))

    view.rerender(<CanvasWorkspace collaboration={{
      ...callbacks, localMemberId: 'local-a', status: 'synced', presence: [{
        clientId: 8,
        member: { memberId: 'remote-b', displayName: '远端', color: '#d08c55', role: 'editor' },
        cursor: null, selection: { nodeIds: [] },
        lease: { ...lease, leaseId: 'lease-remote', memberId: 'remote-b', nodeIds: [locked.id] },
      }],
      acquireLease: vi.fn(() => lease), getLease: vi.fn(() => lease),
      releaseLease: vi.fn(), subscribeLeaseLost: vi.fn(() => () => undefined),
    }} store={store} />)

    expect(flowNodes().find((node) => node.id === dragged.id)?.position)
      .toEqual({ x: 777, y: 555 })
    expect(flowNodes().find((node) => node.id === unaffected.id)?.data).toBe(unaffectedData)
    expect(flowNodes().find((node) => node.id === locked.id)).toMatchObject({
      draggable: false,
      data: { remoteLock: { memberId: 'remote-b', kind: 'drag' } },
    })
  })

  it('does not resynchronize the same selection when React Flow changes its order', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)
    const first = flowNodes()[0]!
    const second = flowNodes()[1]!

    act(() => store.setState({ selectedNodeIds: [first.id, second.id] }))
    const setState = vi.spyOn(store, 'setState')

    act(() => {
      flowProps().onNodesChange?.([
        { id: second.id, type: 'select', selected: true },
        { id: first.id, type: 'select', selected: true },
      ])
    })

    expect(flowProps().onSelectionChange).toBeUndefined()
    expect(setState).not.toHaveBeenCalled()
    expect(store.getState().selectedNodeIds).toEqual([first.id, second.id])
  })

  it('does not reconcile the full node list after persisting a completed drag', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)
    const node = flowNodes()[0]!
    const baselineSets = reactFlowMock.state.nodeSetCount

    act(() => {
      flowProps().onNodeDragStop?.(
        {} as React.MouseEvent,
        { ...node, position: { x: 321, y: 654 } },
        [node],
      )
    })

    expect(reactFlowMock.state.nodeSetCount).toBe(baselineSets)
  })

  it('projects position changes locally without persisting each drag frame', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)
    const baselineSnapshot = store.getState().snapshot
    const node = flowNodes()[0]!
    const nextPosition = { x: node.position.x + 36, y: node.position.y + 24 }

    act(() => {
      flowProps().onNodesChange?.([{
        id: node.id,
        type: 'position',
        position: nextPosition,
        dragging: true,
      }])
    })

    expect(flowNodes().find((candidate) => candidate.id === node.id)?.position)
      .toEqual(nextPosition)
    expect(store.getState().snapshot).toBe(baselineSnapshot)
    expect(store.getState().canUndo).toBe(false)
  })

  it('projects measured dimensions locally without persisting resize observations', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    render(<CanvasWorkspace store={store} />)
    const baselineSnapshot = store.getState().snapshot
    const node = flowNodes()[0]!

    act(() => {
      flowProps().onNodesChange?.([{
        id: node.id,
        type: 'dimensions',
        dimensions: { width: 512, height: 288 },
        resizing: true,
        setAttributes: true,
      }])
    })

    const projected = flowNodes().find((candidate) => candidate.id === node.id)
    expect(projected?.width).toBe(512)
    expect(projected?.height).toBe(288)
    expect(store.getState().snapshot).toBe(baselineSnapshot)
    expect(store.getState().canUndo).toBe(false)
  })

  it('adds valid connections to the store and reports them to consumers', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const onConnect = vi.fn()
    render(<CanvasWorkspace store={store} onConnect={onConnect} />)

    act(() => {
      flowProps().onConnect?.({
        source: 'i-H048wc9RUf',
        target: 'v-9HZFkt8xXj',
        sourceHandle: 'source',
        targetHandle: 'target',
      })
    })

    expect(store.getState().snapshot.edges).toHaveLength(28)
    expect(store.getState().snapshot.edges.at(-1)).toMatchObject({
      source: 'i-H048wc9RUf',
      target: 'v-9HZFkt8xXj',
      sourceHandle: 'source',
      targetHandle: 'target',
      relation: 'reference',
      referenceAlias: 1,
    })
    expect(onConnect).toHaveBeenCalledOnce()
  })

  it('connects nodes seamlessly while collaboration is active without lease blocking', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const onConnect = vi.fn()
    render(
      <CanvasWorkspace
        collaboration={{
          localMemberId: 'editor-b',
          status: 'synced',
          presence: [],
          setCursor: vi.fn(),
          setSelection: vi.fn(),
          setViewport: vi.fn(),
        }}
        store={store}
        onConnect={onConnect}
      />,
    )

    act(() => {
      flowProps().onConnect?.({
        source: 'i-1wBxIhceMW',
        target: 'i-2YYUMOBPSy',
        sourceHandle: 'source',
        targetHandle: 'target',
      })
    })

    expect(store.getState().snapshot.edges.at(-1)).toMatchObject({
      source: 'i-1wBxIhceMW',
      target: 'i-2YYUMOBPSy',
    })
    expect(onConnect).toHaveBeenCalledOnce()
  })

  it('falls back to flow relation when media reference cannot be attached', () => {
    const store = createCanvasStore({
      ...referenceProjectSnapshot,
      nodes: [
        ...referenceProjectSnapshot.nodes,
        {
          id: 'text-source-node',
          type: 'text',
          name: 'Text 1',
          position: { x: 0, y: 0 },
          size: { width: 480, height: 320 },
          data: { text: 'Hello' },
        },
        {
          id: 'image-target-node',
          type: 'image',
          name: 'Image 2',
          position: { x: 500, y: 0 },
          size: { width: 480, height: 320 },
          data: { url: '' },
        },
      ],
    })
    const onConnect = vi.fn()
    render(<CanvasWorkspace store={store} onConnect={onConnect} />)

    act(() => {
      flowProps().onConnect?.({
        source: 'text-source-node',
        target: 'image-target-node',
        sourceHandle: 'source',
        targetHandle: 'target',
      })
    })

    expect(store.getState().snapshot.edges.at(-1)).toMatchObject({
      source: 'text-source-node',
      target: 'image-target-node',
      relation: 'flow',
    })
    expect(onConnect).toHaveBeenCalledOnce()
  })

  it('does not render a ghost connection when the store rejects the edge', () => {
    const store = createCanvasStore({
      ...referenceProjectSnapshot,
      nodes: [
        ...referenceProjectSnapshot.nodes,
        {
          id: 'ghost-source', type: 'text', name: 'Source',
          position: { x: 0, y: 0 }, size: { width: 200, height: 120 },
          data: { text: '', nodeKind: 'text' },
        },
        {
          id: 'ghost-target', type: 'group', name: 'Target',
          position: { x: 300, y: 0 }, size: { width: 400, height: 300 },
          data: { childIds: [], nodeKind: 'group' },
        },
      ],
    })
    const addEdge = vi.fn()
    store.setState({ addEdge })
    render(<CanvasWorkspace store={store} />)
    const source = flowNodes().find((node) => node.id === 'ghost-source')!
    const target = flowNodes().find((node) => node.id === 'ghost-target')!
    const initialEdgeCount = flowEdges().length

    act(() => {
      flowProps().onConnect?.({
        source: source.id,
        target: target.id,
        sourceHandle: 'source',
        targetHandle: 'target',
      })
    })

    expect(addEdge).toHaveBeenCalledOnce()
    expect(flowEdges()).toHaveLength(initialEdgeCount)
  })

  it('keeps reference and generation side effects at zero when a bulk lease loses', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const before = store.getState().serialize()
    const generationController = {
      start: vi.fn(), startSubmitted: vi.fn(), resumePersisted: vi.fn(), dispose: vi.fn(), retry: vi.fn(),
    }
    const withNodeLease = vi.fn(async () => undefined)
    const onGenerationError = vi.fn()
    render(<CanvasWorkspace collaboration={{
      localMemberId: 'local-a', status: 'synced', presence: [],
      setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn(), withNodeLease,
    }} generationController={generationController} onGenerationError={onGenerationError} store={store} />)
    const source = flowNodes().find((node) => node.type === 'image' && Boolean(node.data.url))!
    const target = flowNodes().find((node) => node.type === 'image' && node.id !== source.id)!

    await act(async () => {
      await target.data.onAttachReference?.(target.id, source.id)
      source.data.onGenerate?.(source.id, {
        clientRequestId: 'blocked-generation', projectId: referenceProjectSnapshot.projectId,
        providerId: 'aistartlab', mediaType: 'image', channel: 46, model: 'model',
        prompt: 'blocked', quality: '1K', aspectRatio: '1:1', n: 1, references: [],
      })
    })

    expect(withNodeLease).toHaveBeenCalled()
    expect(store.getState().serialize()).toBe(before)
    expect(generationController.start).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(onGenerationError).toHaveBeenCalledWith(
      '生成所需节点正在被其他协作者操作，请稍后再试',
    ))
  })

  it('lets an editor collaborator delete nodes without acquiring a bulk lease', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const withNodeLease = vi.fn(async () => undefined)
    render(<CanvasWorkspace collaboration={{
      localMemberId: 'editor-a', status: 'synced', presence: [],
      setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn(), withNodeLease,
    }} store={store} />)
    const node = flowNodes()[0]!

    await act(async () => {
      flowProps().onNodesDelete?.([node])
      await Promise.resolve()
    })

    expect(withNodeLease).not.toHaveBeenCalled()
    expect(store.getState().snapshot.nodes.some((candidate) => candidate.id === node.id)).toBe(false)
  })

  it('does not create a connected node when the anchor bulk lease loses', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const before = store.getState().serialize()
    render(<CanvasWorkspace collaboration={{
      status: 'synced', presence: [], setCursor: vi.fn(), setSelection: vi.fn(),
      setViewport: vi.fn(), withNodeLease: vi.fn(async () => undefined),
    }} store={store} />)
    const source = flowNodes()[0]!

    await act(async () => {
      source.data.onCreateConnected?.(source.id, 'image')
      await Promise.resolve()
    })

    expect(store.getState().serialize()).toBe(before)
  })

  it('renames through one settled text lease and leaves the title unchanged on loss', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const node = referenceProjectSnapshot.nodes[0]!
    let allow = false
    const withNodeLease = vi.fn(async (
      _ids: readonly string[],
      _kind: NodeLeaseKind,
      operation: () => unknown | Promise<unknown>,
    ) => allow ? await operation() : undefined)
    render(<CanvasWorkspace collaboration={{
      status: 'synced', presence: [], setCursor: vi.fn(), setSelection: vi.fn(),
      setViewport: vi.fn(), withNodeLease,
    }} store={store} />)
    const flowNode = flowNodes().find((candidate) => candidate.id === node.id)!

    await act(async () => flowNode.data.onRename?.(node.id, 'blocked'))
    expect(store.getState().snapshot.nodes[0]?.name).toBe(node.name)
    allow = true
    await act(async () => flowNode.data.onRename?.(node.id, 'committed'))

    expect(store.getState().snapshot.nodes[0]?.name).toBe('committed')
    expect(withNodeLease).toHaveBeenNthCalledWith(2, [node.id], 'text', expect.any(Function))
  })

  it('keeps offline text edits writable while disabling generation submission', () => {
    const textNode = {
      id: 'text-offline', type: 'text' as const, name: 'Offline text',
      position: { x: 0, y: 0 }, size: { width: 320, height: 180 },
      data: { text: 'Before offline edit' },
    }
    const mediaNode = referenceProjectSnapshot.nodes.find((node) => node.type === 'image')!
    const store = createCanvasStore({
      ...referenceProjectSnapshot,
      nodes: [textNode, mediaNode],
      edges: [],
    })
    const lease = {
      leaseId: 'lease-offline-text', nodeIds: [textNode.id], memberId: 'local-a',
      kind: 'text' as const, startedAt: 1, heartbeatAt: 1, expiresAt: 7_000,
      confirmed: false,
    }
    render(<CanvasWorkspace canGenerate={false} collaboration={{
      status: 'offline', localMemberId: 'local-a', presence: [],
      setCursor: vi.fn(), setSelection: vi.fn(), setViewport: vi.fn(),
      acquireLease: vi.fn(() => lease), getLease: vi.fn(() => lease),
      releaseLease: vi.fn(), subscribeLeaseLost: vi.fn(() => () => undefined),
    }} store={store} />)
    const textFlowNode = flowNodes().find((node) => node.id === textNode.id)!
    const mediaFlowNode = flowNodes().find((node) => node.id === mediaNode.id)!

    expect(textFlowNode.data.onInteractionStart?.(textNode.id, 'text')).toBe(true)
    act(() => textFlowNode.data.onTextChange?.(textNode.id, 'Edited while offline'))

    expect(store.getState().snapshot.nodes.find((node) => node.id === textNode.id)?.data.text)
      .toBe('Edited while offline')
    expect(mediaFlowNode.data.onGenerate).toBeUndefined()
    expect(mediaFlowNode.data.onPromptChange).toBeTypeOf('function')
  })

  it('releases the generation bulk lease after submission without awaiting polling', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const released = vi.fn()
    const start = vi.fn(() => new Promise(() => undefined))
    const startSubmitted = vi.fn().mockResolvedValue({ id: 'job-submitted' })
    const withNodeLease = vi.fn(async (
      _nodeIds: readonly string[],
      _kind: NodeLeaseKind,
      operation: () => unknown | Promise<unknown>,
    ) => {
      const result = await operation()
      released()
      return result
    })
    render(<CanvasWorkspace collaboration={{
      status: 'synced', presence: [], setCursor: vi.fn(), setSelection: vi.fn(),
      setViewport: vi.fn(), withNodeLease,
    }} generationController={{
      start, startSubmitted, resumePersisted: vi.fn(), dispose: vi.fn(),
    }} store={store} />)
    const source = flowNodes().find((node) => node.type === 'image')!

    await act(async () => {
      source.data.onGenerate?.(source.id, {
        clientRequestId: 'submitted-only', projectId: referenceProjectSnapshot.projectId,
        providerId: 'aistartlab', mediaType: 'image', channel: 46, model: 'model',
        prompt: 'submitted', quality: '1K', aspectRatio: '1:1', n: 1, references: [],
      })
      await Promise.resolve()
    })

    expect(startSubmitted).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
    expect(released).toHaveBeenCalledOnce()
  })

  it('keeps blank connection drops as an invisible pointer anchor until a kind is chosen', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const view = render(<CanvasWorkspace store={store} />)
    const sourceNode = flowNodes()[0]!

    act(() => {
      reactFlowMock.state.screenToFlowPosition = () => ({ x: 600, y: 400 })
    })
    act(() => {
      flowProps().onConnectEnd?.(
        new MouseEvent('mouseup', { clientX: 620, clientY: 420 }),
        {
          fromNode: sourceNode,
          fromHandle: { id: 'source', type: 'source' },
          isValid: false,
          toHandle: null,
        } as never,
      )
    })

    const pendingNode = flowNodes().at(-1)
    expect(pendingNode).toMatchObject({
      type: 'placeholder',
      position: { x: 600, y: 400 },
      width: 1,
      height: 1,
      style: { width: 1, height: 1, pointerEvents: 'none' },
    })
    expect(view.getByRole('menu', { name: '引用该节点生成' })).toBeTruthy()
    expect(view.queryByText('选择生成类型')).toBeNull()

    fireEvent.click(view.getByRole('menuitem', { name: '图片' }))

    expect(store.getState().snapshot.nodes.at(-1)).toMatchObject({
      type: 'image',
      position: { x: 600, y: 240 },
    })
    expect(store.getState().snapshot.edges.at(-1)).toMatchObject({
      source: sourceNode.id,
      target: store.getState().snapshot.nodes.at(-1)!.id,
    })
  })

  it('exposes node, edge, and resize mutation interfaces', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const onNodesDelete = vi.fn()
    const onEdgesDelete = vi.fn()
    const onNodeResize = vi.fn()
    render(
      <CanvasWorkspace
        store={store}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeResize={onNodeResize}
      />,
    )
    const node = flowNodes()[0]
    const edge = flowEdges()[0]

    act(() => node.data.onResize?.(node.id, { width: 800, height: 450 }))
    expect(
      store.getState().snapshot.nodes.find((candidate) => candidate.id === node.id)
        ?.size,
    ).toEqual({ width: 800, height: 450 })

    act(() => flowProps().onEdgesDelete?.([edge]))
    expect(store.getState().snapshot.edges).toHaveLength(26)

    act(() => flowProps().onNodesDelete?.([node]))
    expect(store.getState().snapshot.nodes).toHaveLength(36)

    expect(onNodesDelete).toHaveBeenCalledWith([node.id])
    expect(onEdgesDelete).toHaveBeenCalledWith([edge.id])
    expect(onNodeResize).toHaveBeenCalledWith(node.id, {
      width: 800,
      height: 450,
    })
  })

  it('persists text edits emitted by text nodes', () => {
    const textProject = {
      ...referenceProjectSnapshot,
      nodes: [
        {
          id: 'text-1',
          type: 'text' as const,
          name: '文本节点',
          position: { x: 0, y: 0 },
          size: { width: 350, height: 350 },
          data: { text: '原始内容' },
        },
      ],
      edges: [],
    }
    const store = createCanvasStore(textProject)
    render(<CanvasWorkspace store={store} />)
    const textNode = flowNodes()[0]

    act(() => textNode.data.onTextChange?.(textNode.id, '新的镜头说明'))

    expect(store.getState().snapshot.nodes[0]).toMatchObject({
      data: { text: '新的镜头说明' },
    })
  })

  it('delegates uncommitted output drafts so the controller can lock and transact once', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const generationController = {
      start: vi.fn(async () => ({ id: 'local-job' } as never)),
      startSubmitted: vi.fn(async () => ({ id: 'local-job' } as never)),
      resumePersisted: vi.fn(async () => {}),
      dispose: vi.fn(),
    }
    render(
      <CanvasWorkspace
        generationController={generationController}
        store={store}
      />,
    )
    const source = flowNodes().find(
      (node) => node.type === 'image' && Boolean(node.data.url),
    )!
    const nodesBefore = store.getState().snapshot.nodes.length
    const edgesBefore = store.getState().snapshot.edges.length

    act(() => {
      source.data.onSettingsChange?.(source.id, {
        kind: 'image',
        quality: 'standard',
        resolution: '2K',
        aspectRatio: '16:9',
        count: 4,
      })
    })
    const refreshedSource = flowNodes().find((node) => node.id === source.id)!
    act(() => refreshedSource.data.onGenerate?.(source.id, {
      clientRequestId: 'quote-client-1',
      projectId: referenceProjectSnapshot.projectId,
      providerId: 'aistartlab',
      catalogVersion: 'catalog-v1',
      mediaType: 'image',
      channel: 46,
      model: 'image-model',
      prompt: '四张本地结果',
      quality: '2K',
      aspectRatio: '9:16',
      n: 4,
      references: [],
    }))

    expect(store.getState().snapshot.nodes).toHaveLength(nodesBefore)
    expect(store.getState().snapshot.edges).toHaveLength(edgesBefore)
    expect(generationController.startSubmitted).toHaveBeenCalledTimes(1)
    expect(generationController.startSubmitted).toHaveBeenCalledWith(expect.objectContaining({
      sourceNodeId: source.id,
      prompt: '四张本地结果',
      targetNodeIds: expect.any(Array),
      targetNodes: expect.arrayContaining([
        expect.objectContaining({
          type: 'image',
          data: expect.objectContaining({ url: '' }),
        }),
      ]),
      outputEdges: expect.arrayContaining([
        expect.objectContaining({ source: source.id, relation: 'output' }),
      ]),
    }))
    const request = generationController.startSubmitted.mock.calls[0]![0]
    expect(request.targetNodeIds[0]).toBe(source.id)
    expect(request.targetNodeIds).toHaveLength(4)
    expect(request.targetNodes).toHaveLength(3)
    expect(request.outputEdges).toHaveLength(3)
    expect(request.outputEdges).not.toContainEqual(
      expect.objectContaining({ source: source.id, target: source.id }),
    )
    expect(request.settings).toMatchObject({
      kind: 'image',
      aspectRatio: '9:16',
      quality: '2K',
      resolution: '2K',
      count: 4,
    })
  })

  it('freezes references from the current store instead of a stale panel request', () => {
    const referenceSource = referenceProjectSnapshot.nodes.find(
      (node) => node.type === 'image' && Boolean(node.data.url),
    )!
    const target = referenceProjectSnapshot.nodes.find(
      (node) => node.type === 'video',
    )!
    const store = createCanvasStore({
      ...referenceProjectSnapshot,
      nodes: [referenceSource, target],
      edges: [{
        id: 'current-reference',
        source: referenceSource.id,
        target: target.id,
        relation: 'reference',
        referenceAlias: 3,
      }],
    })
    const generationController = {
      start: vi.fn(async () => ({ id: 'unused' } as never)),
      startSubmitted: vi.fn(async () => ({ id: 'local-job' } as never)),
      resumePersisted: vi.fn(async () => {}),
      dispose: vi.fn(),
    }
    render(<CanvasWorkspace generationController={generationController} store={store} />)
    const targetFlowNode = flowNodes().find((node) => node.id === target.id)!

    act(() => targetFlowNode.data.onGenerate?.(target.id, {
      clientRequestId: 'stale-panel-reference',
      projectId: referenceProjectSnapshot.projectId,
      providerId: 'aistartlab',
      catalogVersion: 'catalog-v1',
      mediaType: 'video',
      channel: 37,
      model: 'seedance-2.0',
      mode: 'image2video',
      prompt: 'use @3',
      quality: '720P',
      aspectRatio: '16:9',
      duration: 15,
      n: 1,
      references: [{ alias: 3, mediaType: 'image', nodeId: 'stale-node' }],
    }))

    expect(generationController.startSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        references: [{
          alias: 3,
          mediaType: 'image',
          nodeId: referenceSource.id,
        }],
      }),
    )
  })

  it('rejects an approved request after the active project changes', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const generationController = {
      start: vi.fn(async () => ({ id: 'local-job' } as never)),
      startSubmitted: vi.fn(async () => ({ id: 'local-job' } as never)),
      resumePersisted: vi.fn(async () => {}),
      dispose: vi.fn(),
    }
    const onGenerationError = vi.fn()
    render(
      <CanvasWorkspace
        generationController={generationController}
        onGenerationError={onGenerationError}
        store={store}
      />,
    )
    const source = flowNodes().find(
      (node) => node.type === 'image' && Boolean(node.data.url),
    )!

    act(() => source.data.onGenerate?.(source.id, {
      clientRequestId: 'quote-from-another-project',
      projectId: 'another-project',
      providerId: 'aistartlab',
      mediaType: 'image',
      channel: 46,
      model: 'image-model',
      prompt: 'must not submit',
      quality: '1K',
      aspectRatio: '1:1',
      n: 1,
      references: [],
    }))

    expect(generationController.startSubmitted).not.toHaveBeenCalled()
    expect(onGenerationError).toHaveBeenCalledWith('项目已切换，请重新确认本次生成')
  })

  it('projects an active batch onto its source and retries the persisted request', () => {
    const source = {
      ...referenceProjectSnapshot.nodes.find((node) => node.type === 'image')!,
      id: 'source-image',
    }
    const target = {
      ...source,
      id: 'target-image',
      data: {
        ...source.data,
        url: '',
        generation: {
          prompt: '恢复这个请求',
          status: 'generating' as const,
          sourceNodeId: source.id,
          clientRequestId: 'client-existing',
          outputIndex: 0,
          error: {
            code: 'manual_recovery_required',
            message: '上次提交结果未知',
          },
        },
      },
    }
    const store = createCanvasStore({
      ...referenceProjectSnapshot,
      nodes: [source, target],
      edges: [
        {
          id: 'output-edge',
          source: source.id,
          target: target.id,
          relation: 'output' as const,
        },
      ],
    })
    const generationController = {
      start: vi.fn(async () => ({ id: 'unused' } as never)),
      startSubmitted: vi.fn(async () => ({ id: 'unused' } as never)),
      retry: vi.fn(async () => ({ id: 'recovered-job' } as never)),
      resumePersisted: vi.fn(async () => {}),
      dispose: vi.fn(),
    }

    render(
      <CanvasWorkspace
        generationController={generationController}
        store={store}
      />,
    )
    const sourceFlow = flowNodes().find((node) => node.id === source.id)!

    expect(sourceFlow.data.generationPending).toBe(true)
    expect(sourceFlow.data.generationError).toEqual({
      code: 'manual_recovery_required',
      message: '上次提交结果未知',
    })
    act(() => sourceFlow.data.onRetry?.(source.id, '恢复这个请求'))
    expect(generationController.retry).toHaveBeenCalledWith({
      sourceNodeId: source.id,
      targetNodeIds: [target.id],
      prompt: '恢复这个请求',
    })
  })

  it('contains no legacy generation timer or fake result resolver', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/canvas/CanvasWorkspace.tsx'),
      'utf8',
    )

    expect(source).not.toContain('generationTimers')
    expect(source).not.toContain('resolveGenerationResult')
    expect(source).not.toContain('1800')
    expect(source).not.toContain('.catch(() => {})')
  })

  it('limits compositing-heavy effect suppression to an actively moving viewport', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/canvas/canvas.css'),
      'utf8',
    )

    expect(source).toContain(
      '.canvas-workspace[data-viewport-moving="true"] .react-flow__viewport',
    )
    expect(source).toContain('backdrop-filter: none')
    expect(source).toContain('-webkit-backdrop-filter: none')
  })

  it('keeps high-frequency viewport changes outside React state and persists only the completed move', async () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const view = render(<CanvasWorkspace store={store} />)
    const workspace = view.getByTestId('canvas-workspace')
    const renderCountBeforeMove = reactFlowMock.renderCount
    const initialViewport = store.getState().snapshot.viewport
    const viewports = Array.from({ length: 80 }, (_, index) => ({
      x: 60 + index,
      y: -20 - index,
      zoom: 0.6 + index / 400,
    }))
    const nextViewport = viewports.at(-1)!

    act(() => {
      flowProps().onMoveStart?.({} as never, initialViewport)
      viewports.forEach((viewport) => flowProps().onViewportChange?.(viewport))
    })

    expect(flowProps().viewport).toBeUndefined()
    expect(reactFlowMock.renderCount).toBe(renderCountBeforeMove)
    expect(store.getState().snapshot.viewport).toEqual(initialViewport)
    expect(workspace.getAttribute('data-viewport-moving')).toBe('true')

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(workspace.style.getPropertyValue('--canvas-ui-scale')).toBe(
      String(1 / nextViewport.zoom),
    )

    act(() => flowProps().onMoveEnd?.({} as never, nextViewport))
    expect(store.getState().snapshot.viewport).toEqual(nextViewport)
    expect(flowProps().connectionRadius).toBeCloseTo(
      64 / nextViewport.zoom,
    )
    expect(workspace.hasAttribute('data-viewport-moving')).toBe(false)
  })

  it('reports pane and node context menus without relying on the app shell', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const onPaneContextMenu = vi.fn()
    const onNodeContextMenu = vi.fn()
    render(
      <CanvasWorkspace
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        store={store}
      />,
    )
    const node = flowNodes()[0]
    const event = {
      clientX: 300,
      clientY: 220,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent

    act(() => flowProps().onPaneContextMenu?.(event))
    act(() => flowProps().onNodeContextMenu?.(event, node))

    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    expect(onPaneContextMenu).toHaveBeenCalledWith({ x: 300, y: 220 })
    expect(onNodeContextMenu).toHaveBeenCalledWith(node.id, {
      x: 300,
      y: 220,
    })
  })

  it('reports blank-pane double clicks without zooming the viewport', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const onPaneDoubleClick = vi.fn()
    const view = render(
      <CanvasWorkspace
        onPaneDoubleClick={onPaneDoubleClick}
        store={store}
      />,
    )

    expect(flowProps().zoomOnDoubleClick).toBe(false)
    const pane = view.container.querySelector('.react-flow__pane')
    expect(pane).not.toBeNull()
    fireEvent.doubleClick(pane!, {
      clientX: 460,
      clientY: 280,
    })

    expect(onPaneDoubleClick).toHaveBeenCalledWith({ x: 460, y: 280 })
  })

  it('allows continuous brush strokes without selecting the created path node', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const view = render(
      <CanvasWorkspace
        activeTool="brush"
        store={store}
      />,
    )

    const workspace = view.container.querySelector('.canvas-workspace') as HTMLElement
    expect(workspace).not.toBeNull()
    expect(workspace.getAttribute('data-active-tool')).toBe('brush')

    // Stroke 1: pointerdown -> pointermove -> pointerup
    fireEvent.pointerDown(workspace, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(workspace, { clientX: 110, clientY: 110, pointerId: 1 })
    fireEvent.pointerMove(workspace, { clientX: 120, clientY: 120, pointerId: 1 })
    fireEvent.pointerUp(workspace, { pointerId: 1 })

    const nodesAfterStroke1 = store.getState().snapshot.nodes
    const stroke1 = nodesAfterStroke1.find((n) => n.type === 'path' && n.data.kind === 'brush')
    expect(stroke1).toBeDefined()
    // Stroke 1 must NOT be selected
    expect(store.getState().selectedNodeIds).not.toContain(stroke1?.id)

    // Stroke 2: immediately draw over/near stroke 1 without triggering selection/edit
    fireEvent.pointerDown(workspace, { button: 0, clientX: 110, clientY: 110, pointerId: 2 })
    fireEvent.pointerMove(workspace, { clientX: 130, clientY: 140, pointerId: 2 })
    fireEvent.pointerMove(workspace, { clientX: 150, clientY: 160, pointerId: 2 })
    fireEvent.pointerUp(workspace, { pointerId: 2 })

    const nodesAfterStroke2 = store.getState().snapshot.nodes
    const brushNodes = nodesAfterStroke2.filter((n) => n.type === 'path' && n.data.kind === 'brush')
    expect(brushNodes).toHaveLength(2)
    expect(store.getState().selectedNodeIds).toHaveLength(0)
  })

  it('cleans up brush state and releases pointer capture when activeTool switches or pointer cancels', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const { container, rerender } = render(
      <CanvasWorkspace
        activeTool="brush"
        store={store}
      />,
    )

    const workspace = container.querySelector('.canvas-workspace') as HTMLElement
    expect(workspace).not.toBeNull()

    // Start drawing a stroke with brush
    fireEvent.pointerDown(workspace, { button: 0, clientX: 100, clientY: 100, pointerId: 3 })
    fireEvent.pointerMove(workspace, { clientX: 120, clientY: 120, pointerId: 3 })

    // Simulate switching activeTool to 'select' (e.g. user pressed V)
    rerender(
      <CanvasWorkspace
        activeTool="select"
        store={store}
      />,
    )

    // Pointer up should not commit broken stroke or leave pointer capture locked
    fireEvent.pointerUp(workspace, { pointerId: 3 })

    // Re-activate 'brush' mode
    rerender(
      <CanvasWorkspace
        activeTool="brush"
        store={store}
      />,
    )

    // Drawing a new stroke now works cleanly
    fireEvent.pointerDown(workspace, { button: 0, clientX: 200, clientY: 200, pointerId: 4 })
    fireEvent.pointerMove(workspace, { clientX: 250, clientY: 250, pointerId: 4 })
    fireEvent.pointerUp(workspace, { pointerId: 4 })

    const brushNodes = store.getState().snapshot.nodes.filter((n) => n.type === 'path' && n.data.kind === 'brush')
    expect(brushNodes).toHaveLength(1)
  })
})
