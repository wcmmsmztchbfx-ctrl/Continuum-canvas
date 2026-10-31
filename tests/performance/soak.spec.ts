import { expect, test } from '@playwright/test'
import { installPerformanceCanvas } from './fixtures'

test('ten-minute resource and interaction soak', async ({page}, info) => {
  test.skip(process.env.PERF_SOAK !== '1')
  test.setTimeout(660000)
  const fixture = await installPerformanceCanvas(page, 1000, false)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    const urls = new Map<string, number>()
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = blob => { const url = create(blob); urls.set(url, blob instanceof Blob ? blob.size : 0); return url }
    URL.revokeObjectURL = url => { urls.delete(url); revoke(url) }
    ;(window as any).resourceProbe = () => ({ liveUrls: urls.size, blobBytes: [...urls.values()].reduce((a,b)=>a+b,0) })
  })
  await page.goto(fixture.url)
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated','true')
  const samples: unknown[] = []
  const started = Date.now()
  for (let trip = 0; trip < 20; trip++) {
    await page.evaluate(viewport => (window as any).__canvasStore.getState().setViewport(viewport),
      {x: trip % 2 ? 0 : -5200, y: 0, zoom: 1})
    await page.mouse.move(900,450)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0,120)
    await page.keyboard.up('Control')
    await page.waitForTimeout(750)
    await expect(page.getByTestId('tool-dock')).toBeVisible()
    const sample = await page.evaluate(() => ({...(window as any).resourceProbe(), nodes:document.querySelectorAll('.react-flow__node').length}))
    samples.push({trip, ...sample})
    console.log(JSON.stringify({soak:trip, ...sample}))
    const until = started + (trip + 1) * 30000
    await page.waitForTimeout(Math.max(0,until-Date.now()))
  }
  expect(errors).toEqual([])
  const tail = (samples as {trip:number;liveUrls:number;blobBytes:number}[]).filter(value => value.trip >= 10 && value.trip % 2 === 0)
  // Compare the same settled viewport after warm-up, not different active rings.
  expect(tail.at(-1)!.liveUrls).toBeLessThanOrEqual(tail[0].liveUrls + 16)
  expect(tail.at(-1)!.blobBytes).toBeLessThanOrEqual(tail[0].blobBytes + 1024 * 1024)
  await info.attach('soak-metrics',{body:JSON.stringify({durationMs:Date.now()-started,samples,errors}),contentType:'application/json'})
})
