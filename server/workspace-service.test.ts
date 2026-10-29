import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceService } from './workspace-service.ts'

describe('WorkspaceService', () => {
  it('creates and reads default manifest on cold start', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'workspace-svc-test-'))
    try {
      const service = new WorkspaceService({ dataDir: tempDir })
      const manifest = await service.getManifest()
      expect(manifest.version).toBe(1)
      expect(manifest.projects).toHaveLength(0)
      expect(manifest.canvases).toHaveLength(0)

      // Second read should return the same cached/persisted manifest
      const manifest2 = await service.getManifest()
      expect(manifest2).toEqual(manifest)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('migrates a legacy manifest on startup and persists across instances', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'workspace-svc-test-'))
    try {
      const service1 = new WorkspaceService({ dataDir: tempDir })
      const initial = await service1.getManifest()

      initial.projects.push({
        projectId: 'project-1',
        name: '项目 1',
        position: { x: 0, y: 0 },
        size: { width: 620, height: 380 },
        favorite: false,
        createdAt: '2026-08-17T00:00:00.000Z',
        updatedAt: '2026-08-17T00:00:00.000Z',
      })
      initial.canvases.push({
        canvasId: 'canvas-new',
        projectId: 'project-1',
        name: '全新画布',
        position: { x: 100, y: 100 },
        nodeCount: 5,
        favorite: true,
        createdAt: '2026-08-17T00:00:00.000Z',
        updatedAt: '2026-08-17T00:00:00.000Z',
      })

      await mkdir(join(tempDir, 'workspace'), { recursive: true })
      await writeFile(join(tempDir, 'workspace', 'manifest.json'), JSON.stringify(initial), 'utf8')

      // Create new instance on same dataDir to simulate restart
      const service2 = new WorkspaceService({ dataDir: tempDir })
      const restored = await service2.getManifest()
      expect(restored.canvases).toHaveLength(1)
      expect(restored.canvases.find((c) => c.canvasId === 'canvas-new')?.name).toBe('全新画布')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('does not let old collaboration snapshots rewrite manifest or document during reads', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'workspace-svc-collab-'))
    try {
      const seedService = new WorkspaceService({ dataDir: tempDir })
      const initial = await seedService.getManifest()
      initial.canvases.push({
        canvasId: 'test-canvas-1',
        projectId: 'test-canvas-1',
        name: '测试画布',
        position: { x: 0, y: 0 },
        nodeCount: 0,
        favorite: false,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      })
      await mkdir(join(tempDir, 'workspace'), { recursive: true })
      await writeFile(join(tempDir, 'workspace', 'manifest.json'), JSON.stringify(initial), 'utf8')
      const service = new WorkspaceService({ dataDir: tempDir })

      // Create an old disabled room with 20 nodes
      const oldRoomDir = join(tempDir, 'collaboration', 'old-room')
      const { utimes } = await import('node:fs/promises')
      await mkdir(oldRoomDir, { recursive: true })
      await writeFile(
        join(oldRoomDir, 'metadata.json'),
        JSON.stringify({ canvasId: 'test-canvas-1', projectId: 'test-canvas-1', enabled: false }),
      )
      await writeFile(
        join(oldRoomDir, 'canvas.snapshot.json'),
        JSON.stringify({
          version: 3,
          canvasId: 'test-canvas-1',
          projectId: 'test-canvas-1',
          name: '旧版本画布',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: Array.from({ length: 20 }, (_, i) => ({ id: `old-node-${i}`, type: 'text', position: { x: 0, y: 0 } })),
          edges: [],
        }),
      )
      // Set mtime to past
      await utimes(join(oldRoomDir, 'canvas.snapshot.json'), new Date('2026-09-01'), new Date('2026-09-01'))

      // Create a newer enabled room with 15 nodes
      const newRoomDir = join(tempDir, 'collaboration', 'new-room')
      await mkdir(newRoomDir, { recursive: true })
      await writeFile(
        join(newRoomDir, 'metadata.json'),
        JSON.stringify({ canvasId: 'test-canvas-1', projectId: 'test-canvas-1', enabled: true }),
      )
      await writeFile(
        join(newRoomDir, 'canvas.snapshot.json'),
        JSON.stringify({
          version: 3,
          canvasId: 'test-canvas-1',
          projectId: 'test-canvas-1',
          name: '最新协作画布',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: Array.from({ length: 15 }, (_, i) => ({ id: `new-node-${i}`, type: 'text', position: { x: 0, y: 0 } })),
          edges: [],
        }),
      )
      await utimes(join(newRoomDir, 'canvas.snapshot.json'), new Date('2026-10-09'), new Date('2026-10-09'))

      // Historical room files are recovery material, never an automatic read source.
      const reconciledManifest = await service.getManifest()
      const targetCanvas = reconciledManifest.canvases.find((c) => c.canvasId === 'test-canvas-1')
      expect(targetCanvas?.nodeCount).toBe(0)
      expect(targetCanvas?.name).toBe('测试画布')

      // Reads do not copy room snapshots into workspace documents.
      const doc = await service.getCanvasDocument('test-canvas-1')
      expect(doc).toBeUndefined()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
