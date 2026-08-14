import { expect, test } from '@playwright/test'

test.describe('reference geometry', () => {
  test.use({ viewport: { width: 2552, height: 1308 } })

  test.beforeEach(async ({ page }) => {
    await page.goto('/canvas?spaceId=local&projectId=reference')
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test('matches the measured primary shell anchors', async ({ page }) => {
    await expect(page.getByTestId('workspace-control')).toHaveCSS(
      'width',
      '220px',
    )

    const workspace = await page.getByTestId('workspace-control').boundingBox()
    expect(workspace).toEqual({ x: 16, y: 16, width: 220, height: 36 })

    await expect(page.getByRole('group', { name: '视图模式' })).toHaveCount(0)

    const dock = await page.getByTestId('tool-dock').boundingBox()
    expect(dock?.height).toBe(50)
    expect(dock?.y).toBe(1246)
    expect(dock?.x).toBeGreaterThan(900)
  })

  test('renders the exported graph at the screenshot viewport', async ({ page }) => {
    const flow = page.getByTestId('canvas-workspace')
    await expect(flow.locator('.react-flow__node')).toHaveCount(37)
    await expect(flow.locator('.react-flow__edge')).toHaveCount(27)

    await expect(flow.locator('.react-flow__viewport')).toHaveAttribute(
      'style',
      /translate\(1\.442.*px, 932\.634.*px\) scale\(0\.2\)/,
    )
  })
})

test.describe('desktop constraints', () => {
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    test(`keeps fixed controls inside ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport)
      await page.goto('/canvas?spaceId=local&projectId=reference')
      await expect(page.getByTestId('app-shell')).toBeVisible()

      for (const testId of ['top-bar', 'tool-dock', 'bottom-status-bar']) {
        const box = await page.getByTestId(testId).boundingBox()
        expect(box, `${testId} should be measurable`).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.y).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
      }
    })
  }
})
