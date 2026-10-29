import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultInitialCanvas } from './canvas-storage.ts'
import { createCanvasStateResolver } from './canvas-state-resolver.ts'
import { WorkspaceService } from './workspace-service.ts'

describe('canvas state resolver', () => {
  it('uses the revisioned record over newer legacy and closed-room files without writing during read', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'canvas-state-'))
    try {
      const workspace = new WorkspaceService({ dataDir })
      const current = { ...defaultInitialCanvas('canvas-a', 'project-a'), name: '权威版本' }
      await workspace.applyWorkspaceMutation({ protocolVersion: 1, operationId: 'save-current',
        kind: 'save-canvas', expectedRevision: 0, canvas: current })
      const roomDir = join(dataDir, 'collaboration', 'old-room')
      const legacyDir = join(dataDir, 'canvases', 'canvas-a')
      await mkdir(roomDir, { recursive: true })
      await mkdir(legacyDir, { recursive: true })
      const stale = { ...current, name: '旧房间内容' }
      await writeFile(join(roomDir, 'canvas.snapshot.json'), JSON.stringify(stale), 'utf8')
      await writeFile(join(roomDir, 'metadata.json'), JSON.stringify({ enabled: false,
        canvasId: 'canvas-a', projectId: 'project-a' }), 'utf8')
      await writeFile(join(legacyDir, 'snapshot.json'), JSON.stringify(stale), 'utf8')
      const manifestPath = join(dataDir, 'workspace', 'manifest.json')
      const before = await readFile(manifestPath, 'utf8')

      const resolve = createCanvasStateResolver(workspace)
      expect(await resolve({ canvasId: 'canvas-a', projectId: 'project-a' })).toMatchObject({
        snapshot: { name: '权威版本' }, revision: 1, workspaceRevision: 1,
      })
      expect(await resolve({ canvasId: 'canvas-a', projectId: 'other-project' })).toBeUndefined()
      expect(await readFile(manifestPath, 'utf8')).toBe(before)
    } finally { await rm(dataDir, { recursive: true, force: true }) }
  })
})
