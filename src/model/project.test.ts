import { describe, expect, expectTypeOf, it } from 'vitest'
import { referenceProjectSnapshot } from '../fixtures/reference'

import {
  CANVAS_SNAPSHOT_VERSION,
  deterministicLegacyCanvasId,
  getOrderedReferences,
  parseCanvasSnapshot,
  parseProjectSnapshot,
  PROJECT_SNAPSHOT_VERSION,
  validatePromptReferences,
} from './project'
import type {
  CanvasEdge,
  CanvasNode,
  GroupNode,
  ImageNode,
  ProjectSnapshot,
  TextNode,
  VideoNode,
  Viewport,
} from './project'

describe('project model', () => {
  it('exposes the current snapshot version', () => {
    expect(PROJECT_SNAPSHOT_VERSION).toBe(1)
  })

  it('defines a discriminated union for every supported node type', () => {
    expectTypeOf<CanvasNode['type']>().toEqualTypeOf<
      'image' | 'video' | 'text' | 'group'
    >()
    expectTypeOf<ImageNode>().toMatchTypeOf<CanvasNode>()
    expectTypeOf<VideoNode>().toMatchTypeOf<CanvasNode>()
    expectTypeOf<TextNode>().toMatchTypeOf<CanvasNode>()
    expectTypeOf<GroupNode>().toMatchTypeOf<CanvasNode>()
  })

  it('defines the serializable snapshot boundary', () => {
    expectTypeOf<ProjectSnapshot>().toMatchTypeOf<{
      version: 1
      projectId: string
      name: string
      viewport: Viewport
      nodes: CanvasNode[]
      edges: CanvasEdge[]
    }>()
  })

  it('migrates canvas snapshot v2 without changing the v1 parser contract', () => {
    const snapshot = {
      version: 2,
      canvasId: 'canvas-1',
      projectId: 'project-1',
      name: '画布 1',
      viewport: { x: 12, y: -8, zoom: 0.8 },
      nodes: [],
      edges: [],
    } as const

    expect(CANVAS_SNAPSHOT_VERSION).toBe(3)
    expect(parseCanvasSnapshot(JSON.stringify(snapshot))).toEqual({ ...snapshot, version: 3 })
    expect(() => parseProjectSnapshot(JSON.stringify(snapshot))).toThrow(
      'Unsupported project snapshot version: 2',
    )
  })

  it('compatibly upgrades a v1 snapshot with a deterministic canvas id', () => {
    const legacy = {
      version: 1 as const,
      projectId: 'legacy-project',
      name: '旧项目',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    }

    expect(parseCanvasSnapshot(JSON.stringify(legacy))).toEqual({
      ...legacy,
      version: 3,
      canvasId: deterministicLegacyCanvasId('legacy-project'),
      name: '画布 1',
    })
    expect(deterministicLegacyCanvasId('legacy-project')).toBe(
      deterministicLegacyCanvasId('legacy-project'),
    )
  })

  it('rejects a v2 canvas whose pending request belongs to another project', () => {
    const legacy = structuredClone(referenceProjectSnapshot)
    const image = legacy.nodes.find((node) => node.type === 'image')
    if (!image || image.type !== 'image') throw new Error('Expected image')
    image.data.generation = {
      prompt: 'pending',
      status: 'generating',
      sourceNodeId: image.id,
      clientRequestId: 'client-1',
      pendingRequest: {
        projectId: 'other-project',
        sourceNodeId: image.id,
        outputs: [{ nodeId: image.id, outputIndex: 0 }],
        request: {
          clientRequestId: 'client-1',
          projectId: 'other-project',
          providerId: 'provider',
          catalogVersion: 'catalog',
          mediaType: 'image',
          channel: 'channel',
          model: 'model',
          prompt: 'pending',
          references: [],
        },
      },
    }

    expect(() =>
      parseCanvasSnapshot(
        JSON.stringify({
          ...legacy,
          version: 2,
          canvasId: 'canvas-1',
          projectId: 'project-1',
        }),
      ),
    ).toThrow('Invalid canvas snapshot')
  })

  it('parses valid v1 snapshots and rejects unsupported versions', () => {
    const serialized = JSON.stringify({
      version: 1,
      projectId: 'project-1',
      name: 'Project',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    })

    expect(parseProjectSnapshot(serialized)).toMatchObject({
      version: 1,
      projectId: 'project-1',
    })
    expect(() =>
      parseProjectSnapshot(serialized.replace('"version":1', '"version":2')),
    ).toThrow('Unsupported project snapshot version: 2')
  })

  it('rejects malformed v1 node data', () => {
    expect(() =>
      parseProjectSnapshot(
        JSON.stringify({
          version: 1,
          projectId: 'project-1',
          name: 'Project',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            {
              id: 'audio-1',
              type: 'audio',
              name: 'Unsupported',
              position: { x: 0, y: 0 },
              size: { width: 100, height: 100 },
              data: { url: 'https://example.com/audio.mp3' },
            },
          ],
          edges: [],
        }),
      ),
    ).toThrow('Invalid project snapshot')
  })

  it('parses optional media generation settings and rejects invalid bounds', () => {
    const snapshot = {
      version: 1,
      projectId: 'project-settings',
      name: 'Settings',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'video-1',
          type: 'video',
          name: 'Video',
          position: { x: 0, y: 0 },
          size: { width: 320, height: 180 },
          data: {
            url: '',
            generationSettings: {
              kind: 'video',
              resolution: '1080P',
              aspectRatio: '21:9',
              durationSec: 12,
              generateAudio: false,
              count: 4,
            },
          },
        },
      ],
      edges: [],
    }

    expect(parseProjectSnapshot(JSON.stringify(snapshot))).toMatchObject(
      snapshot,
    )
    snapshot.nodes[0]!.data.generationSettings.durationSec = 601
    expect(() => parseProjectSnapshot(JSON.stringify(snapshot))).toThrow(
      'Invalid project snapshot',
    )
  })

  it('accepts backward-compatible node presentation hints', () => {
    const snapshot = {
      version: 1,
      projectId: 'project-node-kinds',
      name: 'Node kinds',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'audio-1',
          type: 'text',
          name: '环境声',
          position: { x: 0, y: 0 },
          size: { width: 320, height: 180 },
          data: { text: '', nodeKind: 'audio' },
        },
        {
          id: 'director-1',
          type: 'group',
          name: '分镜控制台',
          position: { x: 400, y: 0 },
          size: { width: 560, height: 360 },
          data: { childIds: [], nodeKind: 'director' },
        },
      ],
      edges: [],
    }

    expect(parseProjectSnapshot(JSON.stringify(snapshot))).toMatchObject(snapshot)

    snapshot.nodes[0]!.data.nodeKind = 'director'
    expect(() => parseProjectSnapshot(JSON.stringify(snapshot))).toThrow(
      'Invalid project snapshot',
    )
  })

  it('normalizes legacy reference ids into stable reference edges without duplicating explicit edges', () => {
    const snapshot = {
      version: 1,
      projectId: 'legacy-references',
      name: 'Legacy references',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'image-a',
          type: 'image',
          name: 'A',
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          data: { url: '/api/assets/a' },
        },
        {
          id: 'image-b',
          type: 'image',
          name: 'B',
          position: { x: 120, y: 0 },
          size: { width: 100, height: 100 },
          data: { url: '/api/assets/b' },
        },
        {
          id: 'video-target',
          type: 'video',
          name: 'Target',
          position: { x: 240, y: 0 },
          size: { width: 160, height: 90 },
          data: {
            url: '',
            referenceNodeIds: ['image-b', 'image-a'],
          },
        },
      ],
      edges: [
        {
          id: 'existing-reference',
          source: 'image-a',
          target: 'video-target',
          relation: 'reference',
          referenceAlias: 4,
        },
        {
          id: 'legacy-wire',
          source: 'image-b',
          target: 'video-target',
        },
      ],
    }

    const parsed = parseProjectSnapshot(JSON.stringify(snapshot))
    const references = getOrderedReferences(parsed, 'video-target')

    expect(references.map(({ edge, node }) => [edge.referenceAlias, node.id])).toEqual([
      [1, 'image-b'],
      [4, 'image-a'],
    ])
    expect(parsed.edges.filter((edge) => edge.relation === 'reference')).toHaveLength(2)
    expect(
      parsed.nodes.find((node) => node.id === 'video-target')?.data,
    ).not.toHaveProperty('referenceNodeIds')
  })

  it('keeps a generated node legacy reference as a reference instead of output', () => {
    const snapshot = {
      version: 1,
      projectId: 'legacy-output',
      name: 'Legacy output',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'source',
          type: 'image',
          name: 'Source',
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          data: { url: '/api/assets/source' },
        },
        {
          id: 'generated',
          type: 'image',
          name: 'Generated',
          position: { x: 120, y: 0 },
          size: { width: 100, height: 100 },
          data: {
            url: '/api/assets/result',
            referenceNodeIds: ['source'],
            generation: { prompt: 'result', status: 'complete' },
          },
        },
        {
          id: 'plain',
          type: 'image',
          name: 'Plain',
          position: { x: 240, y: 0 },
          size: { width: 100, height: 100 },
          data: { url: '/api/assets/plain' },
        },
      ],
      edges: [
        { id: 'result-edge', source: 'source', target: 'generated' },
        { id: 'plain-edge', source: 'source', target: 'plain' },
      ],
    }

    const parsed = parseProjectSnapshot(JSON.stringify(snapshot))

    expect(parsed.edges.find((edge) => edge.id === 'result-edge')).toMatchObject({
      relation: 'reference',
      referenceAlias: 1,
    })
    expect(parsed.edges.find((edge) => edge.id === 'plain-edge')?.relation).toBe(
      'flow',
    )
    expect(getOrderedReferences(parsed, 'generated')).toHaveLength(1)
  })

  it('classifies a legacy generated-result edge only with positive source evidence', () => {
    const snapshot = {
      version: 1,
      projectId: 'legacy-output-evidence',
      name: 'Legacy output evidence',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'source',
          type: 'image',
          name: 'Source',
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          data: { url: '/api/assets/source' },
        },
        {
          id: 'generated',
          type: 'image',
          name: 'Generated',
          position: { x: 120, y: 0 },
          size: { width: 100, height: 100 },
          data: {
            url: '/api/assets/result',
            generation: {
              prompt: 'result',
              status: 'complete',
              sourceNodeId: 'source',
              jobId: 'job-1',
            },
          },
        },
      ],
      edges: [{ id: 'result-edge', source: 'source', target: 'generated' }],
    }

    expect(
      parseProjectSnapshot(JSON.stringify(snapshot)).edges[0]?.relation,
    ).toBe('output')
  })

  it('backfills source metadata from one explicit legacy output edge', () => {
    const snapshot = {
      version: 1,
      projectId: 'explicit-output-source',
      name: 'Explicit output source',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'source',
          type: 'image',
          name: 'Source',
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          data: { url: '/api/assets/source' },
        },
        {
          id: 'result',
          type: 'image',
          name: 'Result',
          position: { x: 120, y: 0 },
          size: { width: 100, height: 100 },
          data: {
            url: '/api/assets/result',
            generation: { prompt: 'legacy result', status: 'complete' },
          },
        },
      ],
      edges: [
        {
          id: 'explicit-output',
          source: 'source',
          target: 'result',
          relation: 'output',
        },
      ],
    }

    const parsed = parseProjectSnapshot(JSON.stringify(snapshot))
    const result = parsed.nodes.find((node) => node.id === 'result')
    expect(result).toMatchObject({
      data: { generation: { sourceNodeId: 'source' } },
    })
  })

  it('preserves unresolved legacy reference ids for generation validation', () => {
    const snapshot = {
      version: 1,
      projectId: 'unresolved-legacy-reference',
      name: 'Unresolved legacy reference',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'target',
          type: 'image',
          name: 'Target',
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          data: {
            url: '',
            referenceNodeIds: ['missing-reference'],
          },
        },
      ],
      edges: [],
    }

    expect(parseProjectSnapshot(JSON.stringify(snapshot)).nodes[0]).toMatchObject({
      data: { unresolvedReferenceNodeIds: ['missing-reference'] },
    })
  })

  it.each([
    {
      label: 'duplicate node ids',
      mutate: (snapshot: Record<string, any>) => {
        snapshot.nodes.push({ ...snapshot.nodes[0] })
      },
    },
    {
      label: 'duplicate edge ids',
      mutate: (snapshot: Record<string, any>) => {
        snapshot.edges.push({ ...snapshot.edges[0] })
      },
    },
    {
      label: 'missing edge endpoints',
      mutate: (snapshot: Record<string, any>) => {
        snapshot.edges[0].target = 'missing'
      },
    },
    {
      label: 'non-positive dimensions',
      mutate: (snapshot: Record<string, any>) => {
        snapshot.nodes[0].size.width = 0
      },
    },
    {
      label: 'an unsafe viewport zoom',
      mutate: (snapshot: Record<string, any>) => {
        snapshot.viewport.zoom = 0
      },
    },
  ])('rejects $label', ({ mutate }) => {
    const snapshot: Record<string, any> = {
      version: 1,
      projectId: 'invalid-graph',
      name: 'Invalid graph',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'node-a',
          type: 'image',
          name: 'A',
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          data: { url: '' },
        },
        {
          id: 'node-b',
          type: 'image',
          name: 'B',
          position: { x: 120, y: 0 },
          size: { width: 100, height: 100 },
          data: { url: '' },
        },
      ],
      edges: [{ id: 'edge-a', source: 'node-a', target: 'node-b' }],
    }
    mutate(snapshot)

    expect(() => parseProjectSnapshot(JSON.stringify(snapshot))).toThrow(
      'Invalid project snapshot',
    )
  })

  it('releases nodes with missing legacy parents to the root layer', () => {
    const snapshot: ProjectSnapshot = { version: 1, projectId: 'repair-parent', name: 'Repair parent', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }
    snapshot.nodes = [{
      id: 'node-a', type: 'image', name: 'A', parentId: 'missing-group',
      position: { x: 12, y: 18 }, size: { width: 100, height: 80 }, data: { url: '' },
    }]
    const parsed = parseProjectSnapshot(JSON.stringify(snapshot))
    expect(parsed.nodes[0]?.parentId).toBeUndefined()
    expect(parsed.nodes[0]?.position).toEqual({ x: 12, y: 18 })
  })

  it('normalizes legacy special names and accepts dynamic generation metadata in v1', () => {
    const snapshot = {
      version: 1,
      projectId: 'dynamic-generation',
      name: 'Dynamic generation',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'audio',
          type: 'text',
          name: '音频节点',
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          data: { text: '' },
        },
        {
          id: 'image',
          type: 'image',
          name: 'Image',
          position: { x: 120, y: 0 },
          size: { width: 100, height: 100 },
          data: {
            url: '',
            generationSettings: {
              kind: 'image',
              providerId: 'provider-local',
              channel: 46,
              model: 'future-image-model',
              mode: 'image-to-image',
              quality: 'ultra',
              resolution: '1536P',
              aspectRatio: '7:5',
              count: 3,
            },
            generation: {
              prompt: 'test',
              status: 'generating',
              phase: 'running',
              progress: 37,
              jobId: 'job-1',
              providerId: 'provider-local',
              createdAt: '2026-07-16T00:00:00.000Z',
            },
          },
        },
      ],
      edges: [],
    }

    const parsed = parseProjectSnapshot(JSON.stringify(snapshot))

    expect(parsed.nodes[0]).toMatchObject({ data: { nodeKind: 'audio' } })
    expect(parsed.nodes[1]).toMatchObject({
      data: {
        generationSettings: { model: 'future-image-model', count: 3 },
        generation: { phase: 'running', progress: 37, jobId: 'job-1' },
      },
    })
  })

  it('keeps stable local asset metadata on uploaded audio nodes', () => {
    const audioAssetId = '33333333-3333-4333-8333-333333333333'
    const snapshot = {
      version: 1,
      projectId: 'uploaded-audio',
      name: 'Uploaded audio',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'audio-1',
          type: 'text',
          name: 'track.wav',
          position: { x: 0, y: 0 },
          size: { width: 480, height: 240 },
          data: {
            text: '',
            nodeKind: 'audio',
            assetId: audioAssetId,
            url: `/api/assets/${audioAssetId}`,
          },
        },
      ],
      edges: [],
    }

    expect(parseProjectSnapshot(JSON.stringify(snapshot)).nodes[0]).toMatchObject({
      data: {
        assetId: audioAssetId,
        url: `/api/assets/${audioAssetId}`,
      },
    })
  })

  it('round-trips a durable pending generation request inside snapshot v1', () => {
    const snapshot = {
      version: 1,
      projectId: 'pending-generation',
      name: 'Pending generation',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'result-1',
          type: 'image',
          name: 'Result',
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          data: {
            url: '',
            generation: {
              prompt: 'pending',
              status: 'generating',
              phase: 'submitted',
              sourceNodeId: 'result-1',
              clientRequestId: 'client-1',
              outputIndex: 0,
              pendingRequest: {
                projectId: 'pending-generation',
                sourceNodeId: 'result-1',
                outputs: [{ nodeId: 'result-1', outputIndex: 0 }],
                request: {
                  clientRequestId: 'client-1',
                  canvasId: 'canvas-pending',
                  targetNodeId: 'result-1',
                  providerId: 'aistartlab',
                  catalogVersion: 'catalog-v1',
                  mediaType: 'image',
                  channel: 46,
                  model: 'gpt-image-2',
                  prompt: 'pending',
                  quality: '1K',
                  aspectRatio: '1:1',
                  n: 1,
                  mode: 'text2image',
                  references: [
                    {
                      alias: 1,
                      assetId: '11111111-1111-4111-8111-111111111111',
                      mediaType: 'image',
                    },
                  ],
                },
              },
            },
          },
        },
      ],
      edges: [],
    }

    expect(parseProjectSnapshot(JSON.stringify(snapshot))).toMatchObject(snapshot)
    const crossProject = structuredClone(snapshot)
    crossProject.nodes[0]!.data.generation.pendingRequest.projectId = 'other-project'
    crossProject.nodes[0]!.data.generation.pendingRequest.request.projectId = 'other-project'
    expect(() => parseProjectSnapshot(JSON.stringify(crossProject))).toThrow(
      'Invalid project snapshot',
    )
    const invalidTarget = structuredClone(snapshot)
    invalidTarget.nodes[0]!.data.generation.pendingRequest.request.targetNodeId = 42 as never
    expect(() => parseProjectSnapshot(JSON.stringify(invalidTarget))).toThrow(
      'Invalid project snapshot',
    )
    snapshot.nodes[0]!.data.generation.pendingRequest.outputs[0]!.outputIndex = -1
    expect(() => parseProjectSnapshot(JSON.stringify(snapshot))).toThrow(
      'Invalid project snapshot',
    )
  })

  it('round-trips a generated output aspect ratio', () => {
    const snapshot = structuredClone(referenceProjectSnapshot)
    const image = snapshot.nodes.find((node) => node.type === 'image')
    if (!image || image.type !== 'image') throw new Error('Expected image')
    image.data.generation = {
      prompt: 'portrait',
      status: 'complete',
      outputAspectRatio: '9:16',
    }

    expect(parseProjectSnapshot(JSON.stringify(snapshot))).toMatchObject(snapshot)
  })

  it('reports resolved and unresolved prompt reference aliases', () => {
    expect(validatePromptReferences('让 @1 走向 @3，再看 @1', [1, 2])).toEqual({
      mentionedAliases: [1, 3],
      resolvedAliases: [1],
      unresolvedAliases: [3],
      valid: false,
    })
    expect(validatePromptReferences('foo@9 保留 @1，拒绝 @0', [1, 9])).toEqual({
      mentionedAliases: [1, 0],
      resolvedAliases: [1],
      unresolvedAliases: [0],
      valid: false,
    })
  })
})
