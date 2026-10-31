import { describe, expect, it } from 'vitest'

import { referenceProjectSnapshot } from '../../fixtures/reference'
import { mapProjectSnapshotToReactFlow } from './mapping'

describe('mapProjectSnapshotToReactFlow', () => {
  it('reuses content projection when only the camera changes', () => {
    const before = mapProjectSnapshotToReactFlow(referenceProjectSnapshot)
    const after = mapProjectSnapshotToReactFlow({ ...referenceProjectSnapshot, viewport: { x: 80, y: 40, zoom: 0.5 } })
    expect(after.nodes).toBe(before.nodes)
    expect(after.edges).toBe(before.edges)
    expect(after.viewport).toEqual({ x: 80, y: 40, zoom: 0.5 })
  })

  it('reads identifiers linearly when projecting one thousand unconnected nodes', () => {
    let reads = 0
    const nodes = Array.from({ length: 1000 }, (_, i) => ({
      get id() { reads++; return 'linear-' + i },
      type: 'image' as const, name: 'Image', position: { x: i * 300, y: 0 },
      size: { width: 200, height: 100 }, data: { url: '' },
    }))
    const mapped = mapProjectSnapshotToReactFlow({ ...referenceProjectSnapshot, nodes, edges: [] })
    expect(mapped.nodes).toHaveLength(1000)
    expect(reads).toBeLessThan(20_000)
  })

  it('maps the complete reference fixture and its exact viewport', () => {
    const flow = mapProjectSnapshotToReactFlow(referenceProjectSnapshot)

    expect(flow.viewport).toEqual({
      x: 1.442118522171313,
      y: 932.6344931704214,
      zoom: 0.20000000000000026,
    })
    expect(flow.nodes).toHaveLength(37)
    expect(flow.edges).toHaveLength(27)
  })

  it('preserves node identity, geometry, and media data', () => {
    const flow = mapProjectSnapshotToReactFlow(referenceProjectSnapshot)
    const image = flow.nodes.find((node) => node.id === 'i-1wBxIhceMW')
    const video = flow.nodes.find((node) => node.id === 'v-5DTbDflkYR')
    const emptyImage = flow.nodes.find((node) => node.id === 'i-H048wc9RUf')

    expect(image).toMatchObject({
      type: 'image',
      position: { x: 4079, y: 696 },
      width: 627,
      height: 350,
      data: {
        name: '图片节点 7',
        mediaType: 'image',
        url:
          'https://media.continuum.example/fixture-1.png',
      },
    })
    expect(video).toMatchObject({
      type: 'video',
      position: { x: 7528.080201021963, y: -2082.387248420765 },
      width: 350,
      height: 622,
      data: { name: '视频节点 4', mediaType: 'video' },
    })
    expect(emptyImage?.data.url).toBe('')
  })

  it('maps fixture edges to the custom canvas edge type', () => {
    const flow = mapProjectSnapshotToReactFlow(referenceProjectSnapshot)

    expect(flow.edges[0]).toMatchObject({
      id: 'e-1zvDwunYi0',
      source: 'i-Ia5V4APL5X',
      target: 'v-5DTbDflkYR',
      sourceHandle: 'source',
      targetHandle: 'target',
      type: 'canvas',
    })
    expect(flow.edges.every((edge) => edge.type === 'canvas')).toBe(true)
    expect(flow.edges.every((edge) => edge.data?.relation === 'flow')).toBe(true)
  })

  it('maps ordered reference aliases and keeps output edges out of inputs', () => {
    const project = {
      ...referenceProjectSnapshot,
      nodes: referenceProjectSnapshot.nodes.slice(0, 3),
      edges: [
        {
          id: 'reference-2',
          source: referenceProjectSnapshot.nodes[0]!.id,
          target: referenceProjectSnapshot.nodes[2]!.id,
          relation: 'reference' as const,
          referenceAlias: 2,
        },
        {
          id: 'output-1',
          source: referenceProjectSnapshot.nodes[1]!.id,
          target: referenceProjectSnapshot.nodes[2]!.id,
          relation: 'output' as const,
        },
      ],
    }

    const flow = mapProjectSnapshotToReactFlow(project)
    const target = flow.nodes.find(
      (node) => node.id === referenceProjectSnapshot.nodes[2]!.id,
    )

    expect(target?.data.references).toEqual([
      expect.objectContaining({
        id: referenceProjectSnapshot.nodes[0]!.id,
        referenceAlias: 2,
      }),
    ])
    expect(flow.edges).toEqual([
      expect.objectContaining({ data: { relation: 'reference', referenceAlias: 2 } }),
      expect.objectContaining({ data: { relation: 'output' } }),
    ])
  })

  it('maps persisted parent groups before their constrained children', () => {
    const child = {
      ...referenceProjectSnapshot.nodes[0]!,
      parentId: 'group-1',
      position: { x: 40, y: 60 },
    }
    const project = {
      ...referenceProjectSnapshot,
      nodes: [
        {
          id: 'group-1',
          type: 'group' as const,
          name: '测试分组',
          position: { x: 100, y: 100 },
          size: { width: 800, height: 600 },
          data: { childIds: [child.id] },
        },
        child,
      ],
      edges: [],
    }

    const flow = mapProjectSnapshotToReactFlow(project)

    expect(flow.nodes[0]).toMatchObject({ id: 'group-1', type: 'group' })
    expect(flow.nodes[1]).toMatchObject({
      id: child.id,
      parentId: 'group-1',
      position: { x: 40, y: 60 },
    })
  })

  it('keeps text nodes editable instead of reducing them to placeholders', () => {
    const project = {
      ...referenceProjectSnapshot,
      nodes: [
        {
          id: 'text-1',
          type: 'text' as const,
          name: '文本节点',
          position: { x: 100, y: 100 },
          size: { width: 350, height: 350 },
          data: { text: '镜头说明' },
        },
      ],
      edges: [],
    }

    const flow = mapProjectSnapshotToReactFlow(project)

    expect(flow.nodes[0]).toMatchObject({
      type: 'text',
      data: { mediaType: 'text', text: '镜头说明' },
    })
  })

  it('maps protocol-compatible names to dedicated canvas node presentations', () => {
    const project = {
      ...referenceProjectSnapshot,
      nodes: [
        {
          id: 'audio-1',
          type: 'text' as const,
          name: '音频节点',
          position: { x: 0, y: 0 },
          size: { width: 480, height: 240 },
          data: { text: '' },
        },
        {
          id: 'script-1',
          type: 'text' as const,
          name: '脚本节点',
          position: { x: 0, y: 0 },
          size: { width: 420, height: 300 },
          data: { text: '' },
        },
        {
          id: 'director-1',
          type: 'group' as const,
          name: '导演台',
          position: { x: 0, y: 0 },
          size: { width: 560, height: 360 },
          data: { childIds: [] },
        },
        {
          id: 'clip-1',
          type: 'group' as const,
          name: '视频合成',
          position: { x: 0, y: 0 },
          size: { width: 480, height: 270 },
          data: { childIds: [] },
        },
      ],
      edges: [],
    }

    expect(mapProjectSnapshotToReactFlow(project).nodes.map((node) => node.type)).toEqual([
      'audio',
      'script',
      'director',
      'video-clip',
    ])
  })

  it('uses persisted presentation hints after special nodes are renamed', () => {
    const project = {
      ...referenceProjectSnapshot,
      nodes: [
        {
          id: 'audio-renamed',
          type: 'text' as const,
          name: '环境声设计',
          position: { x: 0, y: 0 },
          size: { width: 480, height: 240 },
          data: { text: '', nodeKind: 'audio' as const },
        },
        {
          id: 'director-renamed',
          type: 'group' as const,
          name: '分镜控制台',
          position: { x: 0, y: 0 },
          size: { width: 560, height: 360 },
          data: { childIds: [], nodeKind: 'director' as const },
        },
      ],
      edges: [],
    }

    expect(mapProjectSnapshotToReactFlow(project).nodes.map((node) => node.type)).toEqual([
      'audio',
      'director',
    ])
  })
})
