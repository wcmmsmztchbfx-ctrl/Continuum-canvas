import { expect, test } from '@playwright/test'

test('renders the reference canvas shell and complete fixture', async ({ page }) => {
  await page.goto('/canvas?spaceId=local&projectId=reference')

  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('workspace-control')).toContainText('画布 1')
  await expect(page.getByRole('button', { name: '选择 V' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: '故事板' })).toHaveCount(0)
  await expect(page.getByTestId('canvas-workspace')).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(37)
  await expect(page.getByTestId('tool-dock')).toBeVisible()
})

test('keeps the React Flow workspace mounted without runtime errors', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/canvas?spaceId=local&projectId=reference')
  await expect(page.getByTestId('canvas-workspace')).toBeVisible()
  await page.waitForTimeout(750)

  await expect(page.getByTestId('app-shell')).toBeVisible()
  expect(pageErrors).toEqual([])
})
