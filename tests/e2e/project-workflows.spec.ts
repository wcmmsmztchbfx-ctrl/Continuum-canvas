import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/canvas?spaceId=local&projectId=reference')
  await expect(page.getByTestId('app-shell')).toHaveAttribute(
    'data-hydrated',
    'true',
  )
})

test('creates and renames a workspace project, then restores it after reload', async ({
  page,
}) => {
  await page.getByTestId('workspace-control').click()
  await page.getByRole('menuitem', { name: '新建项目' }).click()
  await expect(page.getByTestId('workspace-home')).toBeVisible()
  const nameField = page.getByRole('textbox', { name: '名称' })
  await expect(nameField).toBeFocused()
  await nameField.fill('广告分镜项目')
  await nameField.press('Enter')
  await expect(page.getByLabel('项目 广告分镜项目')).toBeVisible()

  await page.getByRole('button', { name: '重命名 广告分镜项目' }).click()
  const renamedField = page.getByRole('textbox', { name: '名称' })
  await renamedField.fill('广告分镜项目 2')
  await renamedField.press('Enter')
  await expect(page.getByLabel('项目 广告分镜项目 2')).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('workspace-home')).toBeVisible()
  await expect(page.getByLabel('项目 广告分镜项目 2')).toBeVisible()
})

test('does not route API form undo shortcuts to the canvas history', async ({ page }) => {
  await page.getByRole('button', { name: '上传媒体 U' }).click()
  await page.getByRole('menuitem', { name: '文本' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(38)
  await expect(page.getByText('已准备添加文本节点')).toHaveCount(0)

  await page.getByRole('button', { name: '打开 API 接入' }).click()
  await page.getByRole('dialog', { name: 'API 接入' })
    .getByRole('button', { name: '管理接入' })
    .click()
  const drawer = page.getByRole('dialog', { name: '管理 API 接入' })
  await drawer.getByRole('button', { name: '新增供应商' }).click()
  const field = drawer.getByLabel('接口地址')
  await field.fill('https://draft.example.test/openapi')
  await field.press('Control+z')

  await expect(page.locator('.react-flow__node')).toHaveCount(38)
})

test('generates collision-free local node ids after reload', async ({ page }) => {
  await page.getByRole('button', { name: '上传媒体 U' }).click()
  await page.getByRole('menuitem', { name: '文本' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(38)
  await page.waitForTimeout(150)
  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute(
    'data-hydrated',
    'true',
  )

  await page.getByRole('button', { name: '上传媒体 U' }).click()
  await page.getByRole('menuitem', { name: '文本' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(39)
})
