// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import {
  materializeCanvasClipboardEnvelope,
  readClipboardContents,
  resolveClipboardContents,
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
})
