import { describe, expect, it } from 'vitest'
import type { CanvasEdge, CanvasNode } from '../model/project'
import { buildCanvasLineage, getNodeAncestors, getNodeDescendants } from './lineageGraph'

function createTestNode(id: string, name: string, type: CanvasNode['type'] = 'image', extraData: Record<string, unknown> = {}): CanvasNode {
  return {
    id,
    type,
    name,
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    data: {
      url: '',
      ...extraData,
    },
  }
}

describe('lineageGraph', () => {
  it('constructs a multi-level generation lineage tree from edges and metadata', () => {
    const nodes: CanvasNode[] = [
      createTestNode('root-prompt', '赛博咖啡包装', 'text', { text: '一个赛博朋克风格的咖啡包装袋' }),
      createTestNode('image-v1', '概念图 V1', 'image', {
        generation: { sourceNodeId: 'root-prompt', status: 'succeeded', prompt: '赛博咖啡包装 霓虹' },
      }),
      createTestNode('image-v2', '概念图 V2', 'image'),
      createTestNode('video-out', '衍生视频', 'video', {
        generation: { sourceNodeId: 'image-v1', status: 'succeeded', prompt: '动态光影流淌' },
      }),
    ]

    const edges: CanvasEdge[] = [
      { id: 'e1', source: 'root-prompt', target: 'image-v2', relation: 'flow' },
    ]

    const graph = buildCanvasLineage(nodes, edges)

    expect(graph.trees).toHaveLength(1)
    const root = graph.trees[0]!
    expect(root.id).toBe('root-prompt')
    expect(root.children).toHaveLength(2)

    const childIds = root.children.map((c) => c.id).sort()
    expect(childIds).toEqual(['image-v1', 'image-v2'])

    const imageV1Tree = root.children.find((c) => c.id === 'image-v1')!
    expect(imageV1Tree.children).toHaveLength(1)
    expect(imageV1Tree.children[0]!.id).toBe('video-out')
  })

  it('retrieves accurate ancestors and descendants for any node in the lineage graph', () => {
    const nodes: CanvasNode[] = [
      createTestNode('root', 'Root'),
      createTestNode('mid-1', 'Mid 1'),
      createTestNode('leaf-1', 'Leaf 1'),
    ]

    const edges: CanvasEdge[] = [
      { id: 'e1', source: 'root', target: 'mid-1', relation: 'flow' },
      { id: 'e2', source: 'mid-1', target: 'leaf-1', relation: 'flow' },
    ]

    const graph = buildCanvasLineage(nodes, edges)

    const ancestors = getNodeAncestors('leaf-1', graph.parentMap, graph.nodeMap)
    expect(ancestors.map((n) => n.id)).toEqual(['mid-1', 'root'])

    const descendants = getNodeDescendants('root', graph.childrenMap, graph.nodeMap)
    expect(descendants.map((n) => n.id)).toEqual(['mid-1', 'leaf-1'])
  })

  it('safely handles cyclic edge references without infinite loops', () => {
    const nodes: CanvasNode[] = [
      createTestNode('n1', 'Node 1'),
      createTestNode('n2', 'Node 2'),
    ]

    const edges: CanvasEdge[] = [
      { id: 'e1', source: 'n1', target: 'n2', relation: 'flow' },
      { id: 'e2', source: 'n2', target: 'n1', relation: 'flow' },
    ]

    const graph = buildCanvasLineage(nodes, edges)
    expect(graph.trees.length).toBeGreaterThan(0)
  })
})
