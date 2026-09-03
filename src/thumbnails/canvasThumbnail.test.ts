import { describe, expect, it, vi } from 'vitest'

import { CANVAS_SNAPSHOT_VERSION, type CanvasSnapshotV2 } from '../model/project'
import {
  CanvasThumbnailService,
  computeCanvasThumbnailHash,
  renderCanvasThumbnail,
} from './canvasThumbnail'

const snapshot: CanvasSnapshotV2 = {
  version: CANVAS_SNAPSHOT_VERSION,
  canvasId: 'canvas-a',
  projectId: 'project-a',
  name: '分镜',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    {
      id: 'text-a',
      type: 'text',
      name: '旁白',
      position: { x: 100, y: 80 },
      size: { width: 240, height: 120 },
      data: { text: '第一场', fontSize: 28, color: '#ffffff' },
    },
  ],
  edges: [],
}

describe('canvas thumbnail rendering', () => {
  it('hashes visual snapshot content deterministically without viewport', () => {
    const changedViewport = {
      ...snapshot,
      viewport: { x: 500, y: -200, zoom: 0.25 },
    }
    expect(computeCanvasThumbnailHash(changedViewport)).toBe(
      computeCanvasThumbnailHash(snapshot),
    )
    expect(computeCanvasThumbnailHash({
      ...snapshot,
      nodes: [{ ...snapshot.nodes[0]!, position: { x: 101, y: 80 } }],
    })).not.toBe(computeCanvasThumbnailHash(snapshot))
  })

  it('ignores non-visual generation metadata while tracking visible text changes', () => {
    const mediaSnapshot: CanvasSnapshotV2 = {
      ...snapshot,
      nodes: [{
        id: 'image-a', type: 'image', name: '图片',
        position: { x: 0, y: 0 }, size: { width: 320, height: 180 },
        data: { url: '/asset/a', promptDraft: 'first prompt' },
      }],
    }
    expect(computeCanvasThumbnailHash({
      ...mediaSnapshot,
      nodes: [{
        ...mediaSnapshot.nodes[0]!,
        data: { ...mediaSnapshot.nodes[0]!.data, promptDraft: 'changed prompt' },
      }],
    })).toBe(computeCanvasThumbnailHash(mediaSnapshot))

    expect(computeCanvasThumbnailHash({
      ...snapshot,
      nodes: [{ ...snapshot.nodes[0]!, data: { text: '第二场' } }],
    })).not.toBe(computeCanvasThumbnailHash(snapshot))
  })

  it('renders a fixed 640 by 360 blob from snapshot nodes', async () => {
    const calls: string[] = []
    const context = {
      fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textBaseline: '',
      fillRect: vi.fn(() => calls.push('fillRect')),
      strokeRect: vi.fn(() => calls.push('strokeRect')),
      fillText: vi.fn(() => calls.push('fillText')),
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      ellipse: vi.fn(), closePath: vi.fn(), save: vi.fn(), restore: vi.fn(),
      translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(),
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: BlobCallback) =>
        callback(new Blob(['thumbnail'], { type: 'image/webp' })),
    } as unknown as HTMLCanvasElement

    const blob = await renderCanvasThumbnail(snapshot, {
      createCanvas: () => canvas,
      loadImage: vi.fn(),
    })

    expect(canvas.width).toBe(640)
    expect(canvas.height).toBe(360)
    expect(blob.type).toBe('image/webp')
    expect(calls).toContain('fillText')
  })
})

describe('CanvasThumbnailService', () => {
  it('debounces saves and skips rendering when persisted content hash matches', async () => {
    vi.useFakeTimers()
    const render = vi.fn(async () => new Blob(['new'], { type: 'image/webp' }))
    const save = vi.fn(async () => undefined)
    const hash = computeCanvasThumbnailHash(snapshot)
    const load = vi.fn(async () => ({
      canvasId: snapshot.canvasId,
      blob: new Blob(['old']),
      width: 640,
      height: 360,
      contentHash: hash,
      updatedAt: '2026-08-13T00:00:00.000Z',
    }))
    const service = new CanvasThumbnailService({ load, save, delete: vi.fn(), render })

    service.schedule(snapshot)
    service.schedule(structuredClone(snapshot))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(load).toHaveBeenCalledOnce()
    expect(render).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('flushes pending work and swallows rendering failures', async () => {
    vi.useFakeTimers()
    const service = new CanvasThumbnailService({
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      render: vi.fn(async () => { throw new Error('image failed') }),
    })
    service.schedule(snapshot)

    await expect(service.flush(snapshot.canvasId)).resolves.toBeUndefined()
    vi.useRealTimers()
  })
})
