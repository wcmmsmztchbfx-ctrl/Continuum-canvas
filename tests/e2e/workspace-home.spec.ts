import fs from 'node:fs'
import path from 'node:path'

import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'

test('creates a project and an independent canvas without media affordances', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('workspace-home')).toBeVisible()
  await expect(page.locator('.react-flow__handle')).toHaveCount(0)
  await expect(page.locator('img, video')).toHaveCount(0)
  await expect(page.getByText('生成', { exact: true })).toHaveCount(0)

  const topbar = page.locator('.workspace-home__topbar')
  await topbar.getByRole('button', { name: '新建项目' }).click()
  const projectName = page.getByRole('textbox', { name: '名称' })
  await expect(projectName).toBeVisible()
  await projectName.fill('短片项目')
  await projectName.press('Enter')
  await expect(page.getByLabel('项目 短片项目')).toBeVisible()
  await expect(page).toHaveURL(/\/$/)

  await topbar.getByRole('button', { name: '新建画布' }).click()
  const canvasName = page.getByRole('textbox', { name: '名称' })
  await canvasName.fill('镜头设计')
  await canvasName.press('Enter')
  await expect(page).toHaveURL(/\/canvas\?.*canvasId=/)
  await expect(page.getByTestId('canvas-workspace')).toBeVisible()

  await page.getByRole('button', { name: /打开工作区菜单/ }).click()
  await page.getByRole('menuitem', { name: '返回工作区' }).click()
  await expect(page.getByTestId('workspace-home')).toBeVisible()
  await expect(page.getByRole('button', { name: /镜头设计，0 个节点/ })).toBeVisible()
})

test('searches and filters workspace cards without moving their layout', async ({ page }) => {
  await page.goto('/')
  const target = page.getByRole('button', { name: /画布 1，/ }).first()
  const before = await target.evaluate((element) => {
    const node = element.closest('.react-flow__node') as HTMLElement
    return { transform: node.style.transform, width: node.style.width, height: node.style.height }
  })

  await page.getByRole('searchbox', { name: '搜索工作区' }).fill('画布 1')
  await expect(page.getByRole('listbox', { name: '搜索结果' })).toBeVisible()
  const options = page.getByRole('option')
  expect(await options.count()).toBeGreaterThan(0)
  await options.first().click()

  const after = await target.evaluate((element) => {
    const node = element.closest('.react-flow__node') as HTMLElement
    return { transform: node.style.transform, width: node.style.width, height: node.style.height }
  })
  expect(after).toEqual(before)

  await page.getByRole('button', { name: '独立画布' }).click()
  await expect(page.locator('.react-flow__node-workspace-project')).toHaveCount(0)
  await expect(page.locator('.react-flow__handle')).toHaveCount(0)
})

test('moves a canvas into and back out of a project with persisted ownership', async ({ page }) => {
  await page.goto('/')
  const topbar = page.locator('.workspace-home__topbar')
  await topbar.getByRole('button', { name: '新建画布' }).click()
  const name = page.getByRole('textbox', { name: '名称' })
  await name.fill('可移动画布')
  await name.press('Enter')
  await page.getByRole('button', { name: /打开工作区菜单/ }).click()
  await page.getByRole('menuitem', { name: '返回工作区' }).click()

  const canvas = page.getByRole('button', { name: '可移动画布，0 个节点' })
  const project = page.getByLabel(/项目 /).first()
  const canvasBox = await canvas.boundingBox()
  const projectBox = await project.boundingBox()
  expect(canvasBox).not.toBeNull()
  expect(projectBox).not.toBeNull()
  await page.mouse.move(canvasBox!.x + 90, canvasBox!.y + 56)
  await page.mouse.down()
  await page.mouse.move(projectBox!.x + projectBox!.width - 150, projectBox!.y + 170, {
    steps: 12,
  })
  await page.mouse.up()

  await page.getByRole('button', { name: '独立画布' }).click()
  await expect(canvas).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: '全部' }).click()
  await expect(canvas).toBeVisible()

  const attachedBox = await canvas.boundingBox()
  const refreshedProjectBox = await project.boundingBox()
  await page.mouse.move(attachedBox!.x + 90, attachedBox!.y + 56)
  await page.mouse.down()
  await page.mouse.move(
    refreshedProjectBox!.x + refreshedProjectBox!.width + 180,
    refreshedProjectBox!.y + 180,
    { steps: 14 },
  )
  await page.mouse.up()

  await page.getByRole('button', { name: '独立画布' }).click()
  await expect(canvas).toBeVisible()
  await page.reload()
  await expect(canvas).toBeVisible()
})

test('renames, duplicates, favorites, trashes and restores a canvas', async ({ page }) => {
  await page.goto('/')
  const topbar = page.locator('.workspace-home__topbar')
  await topbar.getByRole('button', { name: '新建画布' }).click()
  const name = page.getByRole('textbox', { name: '名称' })
  await name.fill('整理画布')
  await name.press('Enter')
  await page.getByRole('button', { name: /打开工作区菜单/ }).click()
  await page.getByRole('menuitem', { name: '返回工作区' }).click()

  await page.getByRole('button', { name: '重命名 整理画布' }).click()
  const renamed = page.getByRole('textbox', { name: '名称' })
  await renamed.fill('镜头整理')
  await renamed.press('Enter')
  await expect(page.getByRole('button', { name: '镜头整理，0 个节点' })).toBeVisible()

  await page.getByRole('button', { name: '复制 镜头整理' }).click()
  await expect(page.getByRole('button', { name: /镜头整理 副本，0 个节点/ })).toBeVisible()

  await page.getByRole('button', { name: '收藏 镜头整理', exact: true }).click()
  await page.getByRole('button', { name: '收藏', exact: true }).click()
  await expect(page.getByRole('button', { name: '镜头整理，0 个节点' })).toBeVisible()
  await expect(page.getByRole('button', { name: /镜头整理 副本，0 个节点/ })).toHaveCount(0)

  await page.getByRole('button', { name: '移入回收站 镜头整理' }).click()
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await expect(page.getByRole('button', { name: '镜头整理，0 个节点' })).toBeVisible()
  await page.getByRole('button', { name: '恢复 镜头整理' }).click()

  await page.getByRole('button', { name: '全部' }).click()
  await expect(page.getByRole('button', { name: '镜头整理，0 个节点' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: '镜头整理，0 个节点' })).toBeVisible()
})

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(`keeps the workspace home readable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await expect(page.getByTestId('workspace-home')).toBeVisible()

    const rail = await page.getByLabel('工作区导航').boundingBox()
    const topbar = await page.locator('.workspace-home__topbar').boundingBox()
    const map = await page.getByTestId('workspace-map').boundingBox()
    expect(rail).not.toBeNull()
    expect(topbar).not.toBeNull()
    expect(map).not.toBeNull()
    expect(rail!.x).toBe(0)
    expect(rail!.y).toBe(0)
    expect(rail!.height).toBe(viewport.height)
    expect(topbar!.x).toBeGreaterThanOrEqual(200)
    expect(topbar!.y).toBe(0)
    expect(topbar!.x + topbar!.width).toBeLessThanOrEqual(viewport.width)
    expect(map!.x).toBe(topbar!.x)
    expect(map!.y).toBe(topbar!.height)
    expect(map!.x + map!.width).toBeLessThanOrEqual(viewport.width)
    expect(map!.y + map!.height).toBeLessThanOrEqual(viewport.height)

    const bytes = await page.screenshot({ animations: 'disabled' })
    const image = PNG.sync.read(bytes)
    expect({ width: image.width, height: image.height }).toEqual(viewport)
    const output = path.resolve(
      `tests/visual/current/workspace-home-${viewport.width}x${viewport.height}.png`,
    )
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, bytes)
  })
}
