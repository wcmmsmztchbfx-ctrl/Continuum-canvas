import { expect, test } from '../../fixtures/e2e-env'

test.describe('Continuum visual regression', () => {
  test('workspace home', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('workspace-home')).toBeVisible()
    await expect(page).toHaveScreenshot('workspace-home.png', { animations: 'disabled' })
  })

  test('standard canvas', async ({ page }) => {
    await openCanvas(page)
    await expect(page).toHaveScreenshot('canvas-standard.png', { animations: 'disabled' })
  })

  test('layers sidebar', async ({ page }) => {
    await openCanvas(page)
    const sidebar = page.getByTestId('layers-sidebar')
    await page.getByRole('button', { name: '展开图层' }).click()
    await expect(sidebar).toBeVisible()
    await expect(page).toHaveScreenshot('canvas-layers.png', { animations: 'disabled' })
  })

  test('unified image panel', async ({ page }) => {
    await openCanvas(page)
    await page.locator(".react-flow__node[data-id='i-Ia5V4APL5X']").click()
    await expect(page.locator('.canvas-node-generator')).toBeVisible()
    await expect(page).toHaveScreenshot('image-panel.png', { animations: 'disabled' })
  })

  test('compact canvas layout', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await openCanvas(page)
    await expect(page).toHaveScreenshot('canvas-compact.png', { animations: 'disabled' })
  })
})

async function openCanvas(page: import('@playwright/test').Page) {
  await page.goto('/canvas?spaceId=local&projectId=reference')
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  await page.evaluate(async () => { await document.fonts.ready })
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
}
