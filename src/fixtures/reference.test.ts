import { describe, expect, it } from 'vitest'

import { referenceProjectSnapshot } from './reference'

describe('reference project fixture', () => {
  it('normalizes the structured LibTV canvas into snapshot v1', () => {
    expect(referenceProjectSnapshot).toMatchObject({
      version: 1,
      projectId: '9f4cca3a4e36451b900e0d5741199db8',
      name: '画布 1',
      viewport: {
        x: 1.442118522171313,
        y: 932.6344931704214,
        zoom: 0.20000000000000026,
      },
    })
    expect(referenceProjectSnapshot.nodes).toHaveLength(37)
    expect(referenceProjectSnapshot.edges).toHaveLength(27)
  })

  it('keeps the source node distribution and remote media references', () => {
    const imageNodes = referenceProjectSnapshot.nodes.filter(
      (node) => node.type === 'image',
    )
    const videoNodes = referenceProjectSnapshot.nodes.filter(
      (node) => node.type === 'video',
    )

    expect(imageNodes).toHaveLength(21)
    expect(videoNodes).toHaveLength(16)

    for (const node of [...imageNodes, ...videoNodes]) {
      expect(node.data.url === '' || /^https?:\/\//.test(node.data.url)).toBe(
        true,
      )
      expect(node.data.url).not.toMatch(/^data:/)
      expect(node.data).not.toHaveProperty('localPath')
    }
  })

  it('preserves normalized geometry and valid edge references', () => {
    expect(referenceProjectSnapshot.nodes[0]).toMatchObject({
      id: 'i-1wBxIhceMW',
      type: 'image',
      name: '图片节点 7',
      position: { x: 4079, y: 696 },
      size: { width: 627, height: 350 },
    })

    const nodeIds = new Set(
      referenceProjectSnapshot.nodes.map((node) => node.id),
    )
    for (const edge of referenceProjectSnapshot.edges) {
      expect(nodeIds.has(edge.source)).toBe(true)
      expect(nodeIds.has(edge.target)).toBe(true)
    }
  })
})
