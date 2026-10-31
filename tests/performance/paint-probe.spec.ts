import { test, expect } from '@playwright/test'
import { installPerformanceCanvas } from './fixtures'
test('paint cost probes', async ({ page }) => {
  test.skip(process.env.PERF_PROBE !== '1')
  const fixture = await installPerformanceCanvas(page, 500, false)
  await page.goto(fixture.url)
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  await page.waitForTimeout(2500)
  const session = await page.context().newCDPSession(page)
  let layers: any[] = []
  session.on('LayerTree.layerTreeDidChange', value => { layers = value.layers ?? [] })
  await session.send('LayerTree.enable')
  for (const [label, css] of [
    ['current', '/* baseline */'],
    ['no page backdrop', '* {backdrop-filter:none!important;-webkit-backdrop-filter:none!important}'],
    ['no promotion', '.canvas-workspace .react-flow__viewport {will-change:auto;backface-visibility:visible}'],
    ['node visibility', '.canvas-media-node {content-visibility:auto}'],
    ['no labels and chrome', '.canvas-node-label,.canvas-media-node__download,.canvas-node-handle {visibility:hidden}'],
    ['no backdrop or promotion', '* {backdrop-filter:none!important;-webkit-backdrop-filter:none!important} .canvas-workspace .react-flow__viewport {will-change:auto;backface-visibility:visible}'],
  ]) {
    const style = await page.addStyleTag({ content: css })
    await page.evaluate(() => (window as any).__canvasStore.getState().setViewport({ x: 0, y: 0, zoom: 1 }))
    await page.waitForTimeout(800)
    await page.evaluate(() => {
      const sample = { active: true, frames: [] as number[], last: 0 }
      ;(window as any).probe = sample
      const tick = (now: number) => { if (!sample.active) return; if (sample.last) sample.frames.push(now-sample.last); sample.last=now; requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
    })
    await page.mouse.move(900,450); await page.keyboard.down('Control')
    for (let i=0; i<12; i++) { await page.mouse.wheel(0,90); await page.waitForTimeout(20) }
    await page.keyboard.up('Control'); await page.waitForTimeout(300)
    const frames = await page.evaluate(() => { (window as any).probe.active=false; return (window as any).probe.frames as number[] })
    frames.sort((a,b)=>a-b)
    console.log(JSON.stringify({label, p95:frames[Math.floor(frames.length*.95)], layers: layers.length,
      counts: await page.evaluate(() => (window as any).__canvasDiagnostics?.snapshot()) }))
    await style.evaluate(el => el.remove())
  }
})
