import { expect, test } from '../../fixtures/e2e-env'
import { installPerformanceCanvas } from '../../performance/fixtures'
test('a thousand layers keep a bounded DOM and range selection uses the whole logical list', async ({ page }) => {
  const fixture = await installPerformanceCanvas(page, 1000, false)
  await page.goto(fixture.url)
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  expect(await page.locator('.layers-panel__row').count()).toBe(0)
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click()
  const list = page.locator('.layers-panel__list')
  await expect(list).toBeVisible()
  const maximum = Math.ceil((await list.boundingBox())!.height / 40) + 16
  expect(await list.locator('.layers-panel__row').count()).toBeLessThanOrEqual(maximum)
  await list.getByRole('button', { name: 'Image 999', exact: true }).click()
  await list.evaluate(element => { element.scrollTop = 20000 })
  await expect(list.getByRole('button', { name: 'Image 499', exact: true })).toBeVisible()
  await page.keyboard.down('Shift')
  await list.getByRole('button', { name: 'Image 499', exact: true }).click()
  await page.keyboard.up('Shift')
  expect(await page.evaluate(() => (window as any).__canvasStore.getState().selectedNodeIds.length)).toBe(501)
  expect(await list.locator('.layers-panel__row').count()).toBeLessThanOrEqual(maximum + 1)
})
