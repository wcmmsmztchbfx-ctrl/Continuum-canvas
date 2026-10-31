import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import type { ProjectSnapshotV1 } from '../../src/model/project'
import { migrateLegacyProjects } from '../../src/workspace/migration'

export async function installPerformanceCanvas(page: Page, count: number, allVisible: boolean) {
  const columns = allVisible && count > 500 ? 40 : 20
  const project: ProjectSnapshotV1 = {
    version: 1, projectId: 'performance-project', name: 'Performance fixture',
    viewport: { x: 0, y: allVisible ? 80 : 0, zoom: allVisible ? 0.1 : 1 },
    nodes: Array.from({ length: count }, (_, i) => ({
      id: 'perf-' + i, type: 'image', name: 'Image ' + i,
      position: { x: 100 + (i % columns) * 340, y: 120 + Math.floor(i / columns) * 270 },
      size: { width: 240, height: 160 }, data: { url: '/__perf_asset/image-' + i + '.png', displayMode: 'layer' },
    })), edges: [],
  }
  const seed = migrateLegacyProjects([project], { now: '2026-10-30T00:00:00.000Z', seedProject: project })
  const canvasId = 'performance-canvas'
  seed.manifest.canvases[0].canvasId = canvasId
  const document = { ...seed.documents[0], canvasId }
  const state = { manifest: seed.manifest, workspaceRevision: 1, canvasRevisions: { [canvasId]: 1 } }
  const image = await readFile(new URL('../fixtures/test-assets/sample-image.png', import.meta.url))
  const requests: string[] = []
  const saves: unknown[] = []
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.pathname === '/api/workspace/manifest') return route.fulfill({ json: state })
    if (url.pathname === '/api/canvases/' + canvasId) return route.fulfill({ json: { canvas: document, revision: state.canvasRevisions[canvasId], workspaceRevision: state.workspaceRevision } })
    if (url.pathname === '/api/workspace/commit') {
      const mutation = req.postDataJSON()
      saves.push(mutation)
      state.workspaceRevision++
      if (mutation.kind === 'save-canvas') state.canvasRevisions[canvasId] = mutation.expectedRevision + 1
      return route.fulfill({ json: { ...state, protocolVersion: 1, operationId: mutation.operationId } })
    }
    if (url.pathname.startsWith('/__perf_asset/')) {
      requests.push(url.pathname)
      return route.fulfill({ body: image, contentType: 'image/png', headers: { 'cache-control': 'public,max-age=86400' } })
    }
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort()
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method())) return route.fulfill({ json: { ok: true } })
    return route.continue()
  })
  await page.addInitScript(() => {
    localStorage.setItem('libtv.ui-preferences.v1', JSON.stringify({ layersOpen: false, hideConnections: false, snapToGrid: false, smartSnap: true, showMiniMap: false, lastOpenPanel: null, layersWidth: 240 }))
  })
  return { url: '/canvas?spaceId=local&projectId=performance-project&canvasId=' + canvasId, requests, saves, document }
}
