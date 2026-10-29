// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import {
  createCanvasClipboardEnvelope,
  materializeCanvasClipboardEnvelope,
  parseEnvelope,
  readClipboardContents,
  resolveClipboardContents,
  safeMediaUrl,
  writeCanvasClipboardEnvelope,
} from './clipboard-import'

describe('clipboard import resolver', () => {
  it('prefers clipboard files over copied HTML and text', async () => {
    const file = new File(['image'], 'shot.png', { type: 'image/png' })
    const result = await resolveClipboardContents({
      files: [file],
      html: '<img src="https://images.example/fallback.png">',
      text: 'fallback',
    })

    expect(result).toEqual({ kind: 'files', files: [file] })
  })

  it('rejects unsafe image protocols from copied HTML', async () => {
    const result = await resolveClipboardContents({
      files: [],
      html: '<img src="javascript:alert(1)">',
      text: '',
    })

    expect(result).toEqual({
      kind: 'error',
      message: '剪贴板图片地址不安全',
    })
  })

  it('reads rich clipboard items before falling back to readText', async () => {
    const result = await readClipboardContents({
      read: async () => [{
        types: ['image/png'],
        getType: async () => new Blob(['image'], { type: 'image/png' }),
      }],
      readText: async () => 'fallback',
    })

    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.type).toBe('image/png')
    expect(result.text).toBe('')
  })

  it('materializes every copied node and its internal edges with fresh ids', () => {
    let id = 0
    const result = materializeCanvasClipboardEnvelope({
      kind: 'libtv-canvas-nodes',
      version: 1,
      sourceCanvasId: 'source',
      nodes: [
        { id: 'a', type: 'text', name: 'A', position: { x: 0, y: 0 }, size: { width: 10, height: 10 }, data: { text: 'A', nodeKind: 'text' } },
        { id: 'b', type: 'text', name: 'B', position: { x: 20, y: 0 }, size: { width: 10, height: 10 }, data: { text: 'B', nodeKind: 'text' } },
      ],
      edges: [{ id: 'ab', source: 'a', target: 'b', relation: 'flow' }],
    }, (kind) => `${kind}-${++id}`)

    expect(result.nodes).toHaveLength(2)
    expect(result.edges).toEqual([
      expect.objectContaining({ source: result.nodes[0]?.id, target: result.nodes[1]?.id }),
    ])
  })

  it('recursively gathers child nodes and edges when a group or frame is copied', () => {
    const snapshot = {
      nodes: [
        {
          id: 'group-1',
          type: 'group' as const,
          name: 'Food Group',
          position: { x: 0, y: 0 },
          size: { width: 500, height: 400 },
          data: { childIds: ['img-1', 'img-2'] },
        },
        {
          id: 'img-1',
          type: 'image' as const,
          name: 'Pork Heart',
          parentId: 'group-1',
          position: { x: 20, y: 20 },
          size: { width: 100, height: 100 },
          data: { url: 'https://example.com/pork.png' },
        },
        {
          id: 'img-2',
          type: 'image' as const,
          name: 'Duck Leg',
          parentId: 'group-1',
          position: { x: 140, y: 20 },
          size: { width: 100, height: 100 },
          data: { url: 'https://example.com/duck.png' },
        },
        {
          id: 'other-node',
          type: 'text' as const,
          name: 'Unrelated',
          position: { x: 800, y: 800 },
          size: { width: 50, height: 50 },
          data: { text: 'Other' },
        },
      ],
      edges: [
        { id: 'edge-1', source: 'img-1', target: 'img-2', relation: 'flow' as const },
        { id: 'edge-other', source: 'img-1', target: 'other-node', relation: 'flow' as const },
      ],
    }

    const envelope = createCanvasClipboardEnvelope(snapshot, ['group-1'], 'canvas-1')
    expect(envelope.nodes.map((n) => n.id).sort()).toEqual(['group-1', 'img-1', 'img-2'].sort())
    expect(envelope.edges.map((e) => e.id)).toEqual(['edge-1'])
  })

  it('writes envelope using fallback copyText when writeText is missing', async () => {
    const envelope = {
      kind: 'libtv-canvas-nodes' as const,
      version: 1 as const,
      sourceCanvasId: 'source',
      nodes: [],
      edges: [],
    }

    // Mock document.execCommand for copyText fallback
    const execCommand = vi.fn().mockReturnValue(true)
    document.execCommand = execCommand

    const serialized = await writeCanvasClipboardEnvelope(envelope, {})
    expect(JSON.parse(serialized)).toEqual(envelope)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('parses raw node array JSON from copy-to-clipboard as a valid envelope', () => {
    const rawNodes = [
      { id: 'img-1', type: 'image', name: '麻辣猪心', position: { x: 10, y: 10 }, size: { width: 100, height: 100 }, data: { url: '/api/assets/123' } },
      { id: 'img-2', type: 'image', name: '大鸭腿', position: { x: 120, y: 10 }, size: { width: 100, height: 100 }, data: { url: '/api/assets/456' } },
    ]
    const parsed = parseEnvelope(JSON.stringify(rawNodes, null, 2))
    expect(parsed).toBeDefined()
    expect(parsed?.kind).toBe('libtv-canvas-nodes')
    expect(parsed?.nodes).toHaveLength(2)
    expect(parsed?.nodes[0]?.name).toBe('麻辣猪心')
  })

  it('parses single node JSON object as a valid envelope', () => {
    const singleNode = { id: 'group-1', type: 'group', name: 'Food Group', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, data: { childIds: [] } }
    const parsed = parseEnvelope(JSON.stringify(singleNode))
    expect(parsed).toBeDefined()
    expect(parsed?.nodes).toHaveLength(1)
    expect(parsed?.nodes[0]?.id).toBe('group-1')
  })

  it('resolves raw JSON array in clipboard text as internal envelope instead of text node', async () => {
    const rawNodes = [
      { id: 'img-1', type: 'image', name: '麻辣猪心', position: { x: 10, y: 10 }, size: { width: 100, height: 100 }, data: { url: '/api/assets/123' } },
    ]
    const result = await resolveClipboardContents({
      files: [],
      html: '',
      text: JSON.stringify(rawNodes),
    })
    expect(result.kind).toBe('internal')
    if (result.kind === 'internal') {
      expect(result.envelope.nodes).toHaveLength(1)
      expect(result.envelope.nodes[0]?.name).toBe('麻辣猪心')
    }
  })

  it('recognizes local asset URLs with no file extension as images', () => {
    const relativeAsset = safeMediaUrl('/api/assets/d69c0b83-9db6-4447-bfa9-43c22b9bbf5b')
    expect(relativeAsset).toEqual({
      media: 'image',
      url: `${window.location.origin}/api/assets/d69c0b83-9db6-4447-bfa9-43c22b9bbf5b`,
    })

    const absoluteAsset = safeMediaUrl('http://192.168.1.100:4173/api/assets/d69c0b83-9db6-4447-bfa9-43c22b9bbf5b')
    expect(absoluteAsset).toEqual({
      media: 'image',
      url: 'http://192.168.1.100:4173/api/assets/d69c0b83-9db6-4447-bfa9-43c22b9bbf5b',
    })

    const blobAsset = safeMediaUrl('blob:http://localhost:4173/1234-5678')
    expect(blobAsset).toEqual({
      media: 'image',
      url: 'blob:http://localhost:4173/1234-5678',
    })
  })
})


