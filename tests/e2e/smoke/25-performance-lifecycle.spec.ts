import { expect, test } from '../../fixtures/e2e-env'
import { installPerformanceCanvas } from '../../performance/fixtures'
import { clickEdge, hoverEdge } from '../../fixtures/edge-interaction'

test('only a selected edge or edges incident to a single selected node animate', async ({ page }) => {
  const fixture = await installPerformanceCanvas(page, 4, false)
  fixture.document.edges = [
    { id: 'flow-test', source: 'perf-0', target: 'perf-1', relation: 'flow' },
    { id: 'outgoing', source: 'perf-1', target: 'perf-2', relation: 'flow' },
    { id: 'unrelated', source: 'perf-2', target: 'perf-3', relation: 'flow' },
  ]
  await page.goto(fixture.url)
  const edge = page.locator('.react-flow__edge[data-id="flow-test"]')
  await expect(edge).toBeAttached()
  const animationStates = () => page.evaluate(() => document.getAnimations().filter(animation =>
    animation instanceof CSSAnimation && animation.animationName === 'canvas-edge-flow').map(animation => animation.playState))
  await expect.poll(animationStates).toEqual([])
  await hoverEdge(page, 'flow-test')
  await expect(edge.locator('.canvas-edge__path')).toHaveCSS('stroke', 'rgb(154, 206, 245)')
  await expect.poll(animationStates).toEqual([])
  await page.locator('.react-flow__node[data-id="perf-1"]').click()
  await expect.poll(animationStates).toEqual(['running', 'running'])
  for (const id of ['flow-test', 'outgoing']) {
    const path = page.locator(`.react-flow__edge[data-id="${id}"] .canvas-edge__path`)
    await expect(path).toHaveCSS('stroke', 'rgb(13, 153, 255)')
    await expect(path).toHaveCSS('stroke-dasharray', '6px, 6px')
  }
  await expect(page.locator('.react-flow__edge[data-id="unrelated"] .canvas-edge__path')).toHaveCSS('animation-name', 'none')
  await page.mouse.click(1300, 650)
  await expect.poll(animationStates).toEqual([])
  await clickEdge(page, 'flow-test')
  await expect.poll(animationStates).toEqual(['running'])
  await expect(edge.locator('.canvas-edge__path')).toHaveCSS('stroke-dasharray', '6px, 6px')
  await expect(edge.locator('.canvas-edge__path')).toHaveCSS('stroke', 'rgb(13, 153, 255)')
  await page.keyboard.press('Escape')
  await expect.poll(animationStates).toEqual([])
  await expect(edge.locator('.canvas-edge__path')).toHaveCSS('stroke-dasharray', 'none')
  await clickEdge(page, 'flow-test')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(animationStates).toEqual([])
  await expect(edge.locator('.canvas-edge__path')).toHaveCSS('stroke-dasharray', '6px, 6px')
})

test('paused video releases offscreen and restores playback state; playing video stays mounted', async ({ page }) => {
  const fixture = await installPerformanceCanvas(page, 1, false)
  fixture.document.nodes[0] = { ...fixture.document.nodes[0], type: 'video', data: { url: '/__fixture_video.mp4', displayMode: 'layer' } }
  const body = await (await import('node:fs/promises')).readFile(new URL('../../fixtures/test-assets/sample-video.mp4', import.meta.url))
  await page.route('**/__fixture_video.mp4', route => {
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/)
    if (!range) return route.fulfill({ body, contentType: 'video/mp4', headers: { 'accept-ranges': 'bytes' } })
    const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
    return route.fulfill({ status: 206, body: body.subarray(start, end + 1), contentType: 'video/mp4',
      headers: { 'accept-ranges': 'bytes', 'content-range': 'bytes ' + start + '-' + end + '/' + body.length } })
  })
  await page.goto(fixture.url)
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  await page.locator('.canvas-media-node__frame').hover()
  await page.getByRole('button', { name: '播放视频', exact: true }).click()
  const video = page.locator('.canvas-video-element')
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(2)
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.seekable.length ? el.seekable.end(0) : 0)).toBeGreaterThan(.2)
  await video.evaluate((el: HTMLVideoElement) => { el.pause(); el.currentTime = .2; el.volume = .4; el.muted = true; el.playbackRate = .5 })
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => ({time:Math.round(el.currentTime*10),seeking:el.seeking}))).toEqual({time:2,seeking:false})
  await page.mouse.click(800, 600)
  await page.evaluate(() => (window as any).__canvasStore.getState().setViewport({x:-20000,y:0,zoom:1}))
  await expect(video).toHaveCount(0)
  await page.evaluate(() => (window as any).__canvasStore.getState().setViewport({x:0,y:0,zoom:1}))
  await expect(video).toHaveCount(1)
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => ({ time: Math.round(el.currentTime*10), volume: el.volume, muted: el.muted, rate: el.playbackRate })))
    .toEqual({time:2,volume:.4,muted:true,rate:.5})
  await video.evaluate((el: HTMLVideoElement) => { el.loop = true })
  await page.locator('.canvas-media-node__frame').hover()
  await page.getByRole('button', { name: '播放视频', exact: true }).click()
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false)
  await page.evaluate(() => (window as any).__canvasStore.getState().setViewport({x:-20000,y:0,zoom:1}))
  await expect(video).toHaveCount(1)
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false)
})

test('the all-disabled fallback still loads and moves canvas nodes', async ({ page }) => {
  const fixture = await installPerformanceCanvas(page, 3, false)
  await page.addInitScript(() => localStorage.setItem('continuum.performance-overrides', JSON.stringify({indexedProjection:false,runtimeViewport:false,scopedZoomUi:false,mediaDemand:false,virtualLayers:false,backgroundScheduling:false})))
  await page.goto(fixture.url)
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  await expect(page.locator('.react-flow__node img')).toHaveCount(3)
  const box = (await page.locator('.react-flow__node[data-id="perf-0"]').boundingBox())!
  await page.mouse.move(box.x + box.width/2, box.y + box.height/2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width/2 + 80, box.y + box.height/2 + 40, {steps:8})
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => (window as any).__canvasStore.getState().snapshot.nodes[0].position)).not.toEqual(fixture.document.nodes[0].position)
})

test('a failed native image recovers when the source is restored and retry is clicked', async ({ page }) => {
  const fixture = await installPerformanceCanvas(page, 1, false)
  fixture.document.nodes[0].data = { url: 'https://native-retry.example.test/a.png', displayMode: 'layer' }
  const body = await (await import('node:fs/promises')).readFile(new URL('../../fixtures/test-assets/sample-image.png', import.meta.url))
  let available = false, nativeRequests = 0
  await page.route('https://native-retry.example.test/a.png', route => {
    if (route.request().resourceType() === 'fetch') return route.abort()
    nativeRequests++
    return available ? route.fulfill({ body, contentType: 'image/png' }) : route.abort()
  })
  await page.goto(fixture.url)
  await expect(page.getByRole('button', { name: '加载失败，重试' })).toBeVisible()
  const failedRequests = nativeRequests
  available = true
  await page.getByRole('button', { name: '加载失败，重试' }).click()
  const image = page.locator('.react-flow__node img')
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
  expect(nativeRequests).toBeGreaterThan(failedRequests)
})

test('a slow offscreen cover never delays document writes or the next edit', async ({ page }) => {
  const fixture = await installPerformanceCanvas(page, 1, false)
  fixture.document.nodes.push({ ...fixture.document.nodes[0], id: 'slow-cover', position: { x: 20000, y: 0 }, data: { url: '/__slow_cover.png', displayMode: 'layer' } })
  let requested = false
  await page.route('**/__slow_cover.png', async route => { requested = true; await new Promise<void>(resolve => setTimeout(resolve, 8000)); await route.abort().catch(() => {}) })
  await page.goto(fixture.url)
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  await page.evaluate(() => (window as any).__canvasStore.getState().renameNode('perf-0', 'first edit'))
  await expect.poll(() => fixture.saves.length).toBeGreaterThan(0)
  await expect.poll(() => requested, { timeout: 6000 }).toBe(true)
  const writes = fixture.saves.length
  await page.evaluate(() => (window as any).__canvasStore.getState().renameNode('perf-0', 'second edit'))
  await expect.poll(() => fixture.saves.length, { timeout: 2000 }).toBeGreaterThan(writes)
  await expect(page.getByTestId('tool-dock')).toBeVisible()
})

test('renaming remains mounted while the virtual layer window scrolls away', async ({ page }) => {
  const fixture = await installPerformanceCanvas(page, 1000, false)
  await page.goto(fixture.url)
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click()
  const list = page.locator('.layers-panel__list')
  await list.getByRole('button', { name: 'Image 999', exact: true }).dblclick()
  const input = list.getByRole('textbox', { name: '重命名 Image 999' })
  await input.fill('保留的草稿')
  await list.evaluate(el => { el.scrollTop = 20000 })
  await expect(input).toHaveCount(1)
  await expect(input).toHaveValue('保留的草稿')
  await input.press('Enter')
  expect(await page.evaluate(() => (window as any).__canvasStore.getState().snapshot.nodes.find((node: any) => node.id === 'perf-999').name)).toBe('保留的草稿')
})
