import { expect, test } from '../../fixtures/e2e-env'
import { installPerformanceCanvas } from '../../performance/fixtures'
test('120 media nodes start only the 12 visible sources and reveal more on demand', async ({ page }) => {
  const fixture = await installPerformanceCanvas(page, 120, false)
  fixture.document.nodes.forEach((node, i) => {
    node.position = i < 12 ? { x: 80 + (i % 4) * 280, y: 80 + Math.floor(i / 4) * 230 } : { x: 12000 + (i % 4) * 280, y: 80 + Math.floor((i - 12) / 4) * 230 }
  })
  await page.goto(fixture.url)
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  await expect(page.locator('.react-flow__node img')).toHaveCount(12)
  await expect.poll(() => new Set(fixture.requests).size).toBe(12)
  await page.waitForTimeout(350)
  expect(fixture.requests.some(url => Number(url.match(/image-(\d+)/)?.[1]) >= 12)).toBe(false)
  await page.evaluate(() => (window as any).__canvasStore.getState().setViewport({ x: -12000, y: 0, zoom: 1 }))
  await expect.poll(() => fixture.requests.some(url => url.includes('image-12.png'))).toBe(true)
})

test('native CORS fallback displays an image without bypassing admission', async ({ page }) => {
  const fixture = await installPerformanceCanvas(page, 1, false)
  fixture.document.nodes[0].data = { url: 'https://native-image.example.test/a.png', displayMode: 'layer' }
  const body = await (await import('node:fs/promises')).readFile(new URL('../../fixtures/test-assets/sample-image.png', import.meta.url))
  await page.route('https://native-image.example.test/a.png', route => route.fulfill({ body, contentType: 'image/png' }))
  await page.goto(fixture.url)
  const image = page.locator('.react-flow__node img')
  await expect(image).toHaveCount(1)
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
})
