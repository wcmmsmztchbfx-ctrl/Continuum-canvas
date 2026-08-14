import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/canvas?spaceId=local&projectId=reference')
  await expect(page.getByTestId('app-shell')).toHaveAttribute(
    'data-hydrated',
    'true',
  )
  await expect(page.locator('.react-flow__node')).toHaveCount(37)
})

test('persists node deletion and contextual duplication across reloads', async ({
  page,
}) => {
  const nodeId = 'i-TFj65r3PHQ'
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`)

  await node.click()
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__node')).toHaveCount(36)
  await page.waitForTimeout(150)
  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute(
    'data-hydrated',
    'true',
  )
  await expect(page.locator('.react-flow__node')).toHaveCount(36)

  const remainingNode = page.locator(
    '.react-flow__node[data-id="i-2YYUMOBPSy"]',
  )
  await remainingNode.click({ button: 'right' })
  await page.getByRole('menuitem', { name: '生成副本' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(37)
  await page.waitForTimeout(150)
  await page.reload()
  await expect(page.locator('.react-flow__node')).toHaveCount(37)
})

test('fits and restores the live viewport and zoom display', async ({ page }) => {
  const zoom = page.getByRole('button', { name: '缩放选项' })
  const viewport = page.locator('.react-flow__viewport')
  await expect(zoom).toContainText('20%')
  const initialTransform = await viewport.evaluate(
    (element) => getComputedStyle(element).transform,
  )

  await zoom.click()
  await page
    .getByRole('menu', { name: '缩放选项' })
    .getByRole('menuitem', { name: '适合屏幕' })
    .click()
  await expect
    .poll(() =>
      viewport.evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe(initialTransform)
  await page.waitForTimeout(250)
  const fittedZoom = (await zoom.textContent())?.trim()
  const fittedTransform = await viewport.evaluate(
    (element) => getComputedStyle(element).transform,
  )

  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute(
    'data-hydrated',
    'true',
  )
  await expect(page.getByRole('button', { name: '缩放选项' })).toContainText(
    fittedZoom ?? '',
  )
  await expect
    .poll(() =>
      viewport.evaluate((element) => getComputedStyle(element).transform),
    )
    .toBe(fittedTransform)
})
