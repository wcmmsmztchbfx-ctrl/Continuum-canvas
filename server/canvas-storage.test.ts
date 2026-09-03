import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasPersistenceService } from './canvas-storage.ts'
import type { CanvasSnapshotV2 } from '../src/model/project.ts'

const testCanvas: CanvasSnapshotV2 = {
  version: 3,
  canvasId: 'canvas-123',
  projectId: 'project-abc',
  name: '测试画布',
  viewport: { x: 50, y: 50, zoom: 1.2 },
  nodes: [
    {
      id: 'node-text-1',
      type: 'text',
      name: '文本节点',
      position: { x: 100, y: 200 },
      size: { width: 240, height: 160 },
      data: { text: '你好，世界' },
    },
  ],
  edges: [],
}

describe('CanvasPersistenceService', () => {
  it('saves and reads canvas snapshots to disk', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'canvas-storage-test-'))
    try {
      const service = new CanvasPersistenceService({ dataDir: tempDir })
      expect(await service.getCanvas('canvas-123')).toBeUndefined()

      await service.saveCanvas(testCanvas)

      // Read back
      const read = await service.getCanvas('canvas-123')
      expect(read).toEqual(testCanvas)

      // Simulate server restart by creating new service on same directory
      const service2 = new CanvasPersistenceService({ dataDir: tempDir })
      const restored = await service2.getCanvas('canvas-123')
      expect(restored?.canvasId).toBe('canvas-123')
      expect(restored?.name).toBe('测试画布')
      expect(restored?.nodes[0]?.data.text).toBe('你好，世界')
      expect(restored?.nodes[0]?.position).toEqual({ x: 100, y: 200 })

      // Delete canvas
      await service2.deleteCanvas('canvas-123')
      expect(await service2.getCanvas('canvas-123')).toBeUndefined()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
