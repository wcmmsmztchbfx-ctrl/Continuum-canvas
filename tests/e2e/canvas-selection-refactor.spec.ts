import { expect, test, type Page } from '@playwright/test'

async function openCanvas(page: Page) {
  await page.goto('/canvas?spaceId=local&projectId=reference')
  await expect(page.getByTestId('app-shell')).toHaveAttribute(
    'data-hydrated',
    'true',
  )
}

async function dragSelectNearbyNodes(page: Page) {
  const pane = page.locator('.react-flow__pane')
  const paneBox = await pane.boundingBox()
  expect(paneBox).not.toBeNull()

  const candidates = await page.locator('.react-flow__node:visible').evaluateAll(
    (elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          top: rect.top,
        }
      }),
  )
  expect(candidates.length).toBeGreaterThan(1)

  let best:
    | { bottom: number; left: number; right: number; top: number; score: number }
    | undefined
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < candidates.length;
      rightIndex += 1
    ) {
      const leftNode = candidates[leftIndex]
      const rightNode = candidates[rightIndex]
      const bounds = {
        bottom: Math.max(leftNode.bottom, rightNode.bottom) + 7,
        left: Math.min(leftNode.left, rightNode.left) - 7,
        right: Math.max(leftNode.right, rightNode.right) + 7,
        top: Math.min(leftNode.top, rightNode.top) - 7,
      }
      const insidePane =
        bounds.left > paneBox!.x + 8 &&
        bounds.top > paneBox!.y + 72 &&
        bounds.right < paneBox!.x + paneBox!.width - 8 &&
        bounds.bottom < paneBox!.y + paneBox!.height - 54
      if (!insidePane) continue

      const score =
        (bounds.right - bounds.left) * (bounds.bottom - bounds.top)
      if (!best || score < best.score) best = { ...bounds, score }
    }
  }
  expect(best).toBeDefined()

  await pane.click({ position: { x: 8, y: 90 } })
  await page.mouse.move(best!.left, best!.top)
  await page.mouse.down()
  await page.mouse.move(best!.right, best!.bottom, { steps: 24 })
  await page.mouse.up()
}

async function unionOfSelectedNodes(page: Page) {
  return page.locator('.react-flow__node.selected').evaluateAll((elements) => {
    const rects = elements.map((element) => element.getBoundingClientRect())
    return {
      bottom: Math.max(...rects.map((rect) => rect.bottom)),
      left: Math.min(...rects.map((rect) => rect.left)),
      right: Math.max(...rects.map((rect) => rect.right)),
      top: Math.min(...rects.map((rect) => rect.top)),
    }
  })
}

test('keeps the native multi-selection boundary aligned through a 40-step drag', async ({
  page,
}) => {
  test.slow()
  await openCanvas(page)
  await dragSelectNearbyNodes(page)

  const selectedNodes = page.locator('.react-flow__node.selected')
  await expect.poll(() => selectedNodes.count()).toBeGreaterThan(1)
  await expect(page.getByTestId('selection-union-boundary')).toHaveCount(0)

  const nativeBoundary = page.locator('.react-flow__nodesselection-rect')
  await expect(nativeBoundary).toBeVisible()
  await expect(nativeBoundary).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')

  const draggedNode = selectedNodes.first()
  const draggedBox = await draggedNode.boundingBox()
  expect(draggedBox).not.toBeNull()
  const start = {
    x: draggedBox!.x + draggedBox!.width / 2,
    y: draggedBox!.y + draggedBox!.height / 2,
  }

  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  for (let step = 1; step <= 40; step += 1) {
    await page.mouse.move(start.x + step * 2, start.y + step, { steps: 1 })
    const [selection, boundary] = await Promise.all([
      unionOfSelectedNodes(page),
      nativeBoundary.boundingBox(),
    ])
    expect(boundary).not.toBeNull()
    expect(Math.abs(boundary!.x - selection.left)).toBeLessThanOrEqual(2)
    expect(Math.abs(boundary!.y - selection.top)).toBeLessThanOrEqual(2)
    expect(
      Math.abs(boundary!.width - (selection.right - selection.left)),
    ).toBeLessThanOrEqual(2)
    expect(
      Math.abs(boundary!.height - (selection.bottom - selection.top)),
    ).toBeLessThanOrEqual(2)
  }
  await page.mouse.up()
})

test('keeps the root route on the workspace home', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('workspace-home')).toBeVisible()
  await expect(page.getByTestId('canvas-workspace')).toHaveCount(0)
})

test('selects all nodes without entering a React Flow update loop', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await openCanvas(page)

  await page.keyboard.press('Control+A')
  await expect(page.getByTestId('canvas-workspace')).toHaveAttribute(
    'data-multiselect',
    'true',
  )
  await expect(page.getByRole('toolbar', { name: '所选节点操作' })).toBeVisible()
  await page.waitForTimeout(250)

  expect(pageErrors).toEqual([])
})

test('box-selects, follows the viewport, groups, renames, and ungroups', async ({
  page,
}) => {
  await openCanvas(page)
  const edgeCount = await page.locator('.react-flow__edge').count()

  await dragSelectNearbyNodes(page)
  await expect
    .poll(() => page.locator('.react-flow__node.selected').count())
    .toBeGreaterThan(1)

  const toolbar = page.getByRole('toolbar', { name: '所选节点操作' })
  await expect(toolbar).toBeVisible()
  await expect(page.locator('[data-node-editor]')).toHaveCount(0)
  const beforeZoom = await toolbar.boundingBox()
  expect(beforeZoom).not.toBeNull()
  expect(beforeZoom!.y).toBeGreaterThanOrEqual(64)

  const workspace = page.getByTestId('canvas-workspace')
  const workspaceBox = await workspace.boundingBox()
  expect(workspaceBox).not.toBeNull()
  await page.mouse.move(
    workspaceBox!.x + workspaceBox!.width / 2,
    workspaceBox!.y + workspaceBox!.height / 2,
  )
  await page.mouse.wheel(0, -360)
  await page.waitForTimeout(150)
  const afterZoom = await toolbar.boundingBox()
  expect(afterZoom).not.toBeNull()
  expect(
    Math.abs(afterZoom!.x - beforeZoom!.x) +
      Math.abs(afterZoom!.y - beforeZoom!.y),
  ).toBeGreaterThan(2)

  await toolbar.getByRole('button', { name: '打组' }).click()
  const groupNode = page.locator('.react-flow__node-group.selected')
  await expect(groupNode).toHaveCount(1)
  await expect(toolbar.getByRole('button', { name: '解组' })).toBeVisible()
  await expect(page.locator('.react-flow__edge')).toHaveCount(edgeCount)
  await expect(groupNode.locator('.react-flow__resize-control')).toHaveCount(0)

  const groupName = `镜头分组-${Date.now()}`
  await groupNode.getByRole('button', { name: '重命名 节点分组' }).dblclick()
  const nameField = groupNode.getByRole('textbox', { name: '节点名称' })
  await nameField.fill(groupName)
  await nameField.press('Enter')
  await expect(
    groupNode.getByRole('button', { name: `重命名 ${groupName}` }),
  ).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute(
    'data-hydrated',
    'true',
  )
  const restoredGroup = page.locator('.react-flow__node-group', {
    has: page.getByRole('button', { name: `重命名 ${groupName}` }),
  })
  await expect(restoredGroup).toHaveCount(1)
  await restoredGroup.click()
  await page.getByRole('toolbar', { name: '所选节点操作' })
    .getByRole('button', { name: '解组' })
    .click()
  await expect(restoredGroup).toHaveCount(0)
  await expect(page.locator('.react-flow__edge')).toHaveCount(edgeCount)
})

test('renames image and special nodes while preserving node capabilities', async ({
  page,
}) => {
  await openCanvas(page)

  const imageNode = page.locator(
    '.react-flow__node[data-id="i-TFj65r3PHQ"]',
  )
  await imageNode.click()
  await expect(imageNode.locator('.react-flow__resize-control')).toHaveCount(0)
  await imageNode.getByRole('button', { name: '重命名 图片节点 12' }).dblclick()
  await imageNode.getByRole('textbox', { name: '节点名称' }).fill('院门全景')
  await imageNode.getByRole('textbox', { name: '节点名称' }).press('Enter')
  await expect(imageNode.getByRole('button', { name: '重命名 院门全景' })).toBeVisible()

  await page.getByTestId('canvas-workspace').click({ position: { x: 320, y: 220 } })
  await expect(page.locator('[data-node-editor]')).toHaveCount(0)
  await page.getByRole('button', { name: '资产管理' }).click()
  const manager = page.getByRole('complementary', { name: '项目文件' })
  await manager.getByRole('searchbox', { name: '搜索节点' }).fill('视频节点')
  await manager.getByRole('button', { name: /定位视频节点/ }).first().click()
  const visibleVideo = page.locator('.react-flow__node-video.selected')
  await expect(visibleVideo).toBeInViewport()
  await expect(visibleVideo.locator('.react-flow__resize-control')).not.toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '上传媒体 U' }).click()
  await page.getByRole('menuitem', { name: '导演台' }).click()
  const director = page.locator('.react-flow__node-director').last()
  await expect(director).toBeVisible()
  await director.getByRole('button', { name: '重命名 导演台' }).dblclick()
  await director.getByRole('textbox', { name: '节点名称' }).fill('主场景调度')
  await director.getByRole('textbox', { name: '节点名称' }).press('Enter')
  await expect(director).toHaveClass(/react-flow__node-director/)
  await expect(
    director.getByRole('button', { name: '重命名 主场景调度' }),
  ).toBeVisible()

  await page.reload()
  await expect(page.getByRole('button', { name: '重命名 院门全景' })).toBeVisible()
  await expect(
    page.locator('.react-flow__node-director', {
      has: page.getByRole('button', { name: '重命名 主场景调度' }),
    }),
  ).toHaveCount(1)
})
