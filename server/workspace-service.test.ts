import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
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

  it('commits manifest updates and persists across instances', async () => {
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

      await service1.commit({ manifest: JSON.stringify(initial) })

      // Create new instance on same dataDir to simulate restart
      const service2 = new WorkspaceService({ dataDir: tempDir })
      const restored = await service2.getManifest()
      expect(restored.canvases).toHaveLength(1)
      expect(restored.canvases.find((c) => c.canvasId === 'canvas-new')?.name).toBe('全新画布')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
