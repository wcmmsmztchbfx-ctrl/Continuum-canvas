import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { expect, test } from '../../fixtures/e2e-env'

test('cold local images use zoom previews; camera changes remain local after reload', async ({ page, request }) => {
  test.setTimeout(90_000)
  const assets: Array<{ id: string; url: string }> = []
  for (let i = 0; i < 4; i++) {
    const image = await sharp({ create: { width: 4096, height: 2048, channels: 3, background: ['#2468ff', '#fd8923', '#22bb88', '#ac33dd'][i] } }).webp().toBuffer()
    const uploaded = await request.post('/api/assets', { headers: { 'content-type': 'image/webp', 'x-filename': 'lod-' + i + '.webp' }, data: image })
    expect(uploaded.status()).toBe(201)
    assets.push((await uploaded.json()).asset)
  }
  const id = 'lod-canvas'
  const state = await (await request.get('/api/workspace/manifest')).json()
  const canvas = { version: 3, canvasId: id, projectId: id, name: 'LOD test', viewport: { x: 0, y: 0, zoom: .2 },
    nodes: Array.from({ length: 16 }, (_, i) => ({ id: 'image-' + i, type: 'image', name: 'image-' + i,
      position: { x: 2000 + i % 4 * 800, y: 1400 + Math.floor(i / 4) * 400 }, size: { width: 400, height: 200 },
      data: { url: assets[i % 4].url, assetId: assets[i % 4].id, displayMode: 'layer' } })), edges: [] }
  const now = new Date().toISOString()
  state.manifest.canvases.push({ canvasId: id, projectId: id, name: canvas.name, nodeCount: 16,
    position: { x: 0, y: 0 }, favorite: false, createdAt: now, updatedAt: now })
  const seeded = await request.post('/api/workspace/commit', { data: {
    protocolVersion: 1, operationId: randomUUID(), kind: 'edit-workspace', expectedWorkspaceRevision: state.workspaceRevision,
    expectedCanvasRevisions: { [id]: 0 }, commit: { manifest: state.manifest, putDocuments: [{ canvasId: id, serialized: JSON.stringify(canvas) }] },
  } })
  expect(seeded.status()).toBe(200)
  const requested: string[] = []
  let writes = 0
  page.on('request', req => {
    const url = new URL(req.url())
    if (assets.some(asset => url.pathname === asset.url)) requested.push(url.pathname + url.search)
    if (url.pathname === '/api/workspace/commit' && req.method() === 'POST') writes++
  })
  await page.addInitScript(() => localStorage.setItem('libtv.ui-preferences.v1',
    JSON.stringify({ layersOpen: false, hideConnections: false, snapToGrid: false, smartSnap: true, showMiniMap: false, lastOpenPanel: null, layersWidth: 240 })))
  await page.goto('/canvas?spaceId=local&projectId=' + id + '&canvasId=' + id)
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  const images = page.locator('img.canvas-image-highres')
  await expect(images).toHaveCount(16)
  await expect.poll(() => images.evaluateAll(elements => elements.every(el => (el as HTMLImageElement).naturalWidth === 128))).toBe(true)
  expect(requested.length).toBe(4)
  expect(requested.every(url => url.endsWith('?preview=128&v=1'))).toBe(true)
  await page.getByRole('button', { name: '缩放选项' }).click()
  await page.getByRole('menuitem', { name: '缩放至100%', exact: true }).click()
  await expect.poll(() => images.evaluateAll(elements => elements.some(el => (el as HTMLImageElement).naturalWidth === 960))).toBe(true)
  await expect(page.getByRole('button', { name: '缩放选项' })).toContainText('100%')
  // Reload exercises the persisted local camera and ensures it doesn't revert to the server's 20%.
  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  await expect(page.getByRole('button', { name: '缩放选项' })).toContainText('100%')
  expect(writes).toBe(0)
  const saved = await (await request.get('/api/canvases/' + id)).json()
  expect(saved.canvas.nodes).toEqual(canvas.nodes)
  expect(saved.revision).toBe(1)
})
