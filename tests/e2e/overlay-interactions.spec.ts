import { expect, test, type Page } from '@playwright/test'

const provider = {
  id: 'aistartlab',
  name: 'AIStartLab',
  adapterType: 'aistartlab-openapi',
  baseUrl: 'https://api.video.aistarslab.com/openapi',
  enabled: true,
  preferred: true,
  secretEnvName: 'API_PROVIDER_AISTARTLAB_KEY',
  secretConfigured: true,
  maskedSecret: 'sk-********1234',
  available: true,
  lastSyncedAt: new Date().toISOString(),
}

const catalog = {
  providerId: provider.id,
  version: 'overlay-e2e-v1',
  fetchedAt: provider.lastSyncedAt,
  stale: false,
  models: [
    {
      mediaType: 'image',
      channel: 46,
      model: 'image-primary',
      title: 'Image Primary',
      qualityOptions: [
        { value: '1K', label: '1K', pricing: { type: 'fixed_total', credits: 5 } },
      ],
      aspectRatios: ['16:9'],
      countOptions: [1],
      durationOptions: [],
      modes: ['text2image'],
      inputLimits: { images: 0, videos: 0, audios: 0 },
      raw: {},
    },
    {
      mediaType: 'video',
      channel: 27,
      model: 'video-primary',
      title: 'Video Primary',
      qualityOptions: [
        { value: '720P', label: '720P', pricing: { type: 'fixed_total', credits: 80 } },
      ],
      aspectRatios: ['16:9'],
      countOptions: [1],
      durationOptions: [6],
      modes: ['text2video'],
      inputLimits: { images: 0, videos: 0, audios: 0 },
      raw: {},
    },
  ],
}

async function mockProviderGateway(page: Page, savedSecrets: string[]) {
  await page.route('**/api/local-admin/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, created: false }),
    })
  })
  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ providers: [provider] }),
    })
  })
  await page.route('**/api/catalog?providerId=*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ catalog }),
    })
  })
  await page.route('**/api/providers/*/test', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, provider }),
    })
  })
  await page.route('**/api/providers/*/sync', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ catalog }),
    })
  })
  await page.route('**/api/providers/*/secret', async (route) => {
    const body = route.request().postDataJSON() as { apiKey?: string }
    if (body.apiKey) savedSecrets.push(body.apiKey)
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(provider),
    })
  })
}

test.beforeEach(async ({ page }) => {
  await mockProviderGateway(page, [])
  await page.goto('/canvas?spaceId=local&projectId=reference')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test('opens the workspace and add-node menus through the application shell', async ({
  page,
}) => {
  await expect(page.getByTestId('workspace-control')).toHaveCount(1)
  await page.getByTestId('workspace-control').click()
  await expect(page.getByRole('menu', { name: '工作区菜单' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: '工作区菜单' })).toBeHidden()

  await page.getByRole('button', { name: '上传媒体 U' }).click()
  const addMenu = page.getByRole('menu', { name: '添加节点' })
  await expect(addMenu).toBeVisible()
  await expect(addMenu.getByRole('menuitem')).toHaveCount(10)
  await addMenu.getByRole('menuitem', { name: '文本' }).click()
  await expect(page.locator('.react-flow__node-text.selected')).toHaveCount(1)
  await expect(page.getByText('已准备添加文本节点')).toHaveCount(0)
})

test('resizes the layers sidebar and restores its width after refresh', async ({ page }) => {
  await page.locator('.layers-panel-toggle').click()
  const sidebar = page.getByTestId('layers-sidebar')
  const handle = page.getByRole('separator', { name: '调整图层侧栏宽度' })
  await expect(sidebar).toBeVisible()
  await expect(sidebar).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')

  const bounds = await handle.boundingBox()
  expect(bounds).not.toBeNull()
  const startX = bounds!.x + 3
  await page.mouse.move(startX, 300)
  await page.mouse.down()
  await page.mouse.move(startX + 120, 300, { steps: 8 })
  await page.mouse.up()

  await expect(sidebar).toHaveCSS('width', '360px')
  await page.reload()
  await expect(page.getByTestId('layers-sidebar')).toHaveCSS('width', '360px')
})

test('opens generation history from the bottom status bar', async ({ page }) => {
  await page.getByRole('button', { name: '历史记录' }).click()
  await expect(page.getByRole('dialog', { name: /生成历史/ })).toBeVisible()
})

test('opens add-node on blank double click and replaces it on right click', async ({
  page,
}) => {
  const workspace = page.getByTestId('canvas-workspace')
  await workspace.dblclick({ position: { x: 320, y: 220 } })

  const addMenu = page.getByRole('menu', { name: '添加节点' })
  await expect(addMenu).toBeVisible()
  const addBounds = await addMenu.boundingBox()
  expect(addBounds).not.toBeNull()
  expect(addBounds!.x).toBeGreaterThanOrEqual(312)
  expect(addBounds!.x).toBeLessThanOrEqual(328)
  expect(addBounds!.y).toBeGreaterThanOrEqual(212)
  expect(addBounds!.y).toBeLessThanOrEqual(228)

  await workspace.click({
    button: 'right',
    position: { x: 720, y: 520 },
  })
  await expect(addMenu).toBeHidden()
  await expect(
    page.getByRole('menu', { name: '画布快捷菜单' }),
  ).toBeVisible()
})

test('completes provider API, collaboration, and Agent shell workflows without external requests', async ({
  page,
}) => {
  const savedSecrets: string[] = []
  await page.unroute('**/api/providers/*/secret')
  await mockProviderGateway(page, savedSecrets)
  const actionRequests: string[] = []
  page.on('request', (request) => {
    if (request.resourceType() === 'fetch' || request.resourceType() === 'xhr') {
      actionRequests.push(request.url())
    }
  })

  const apiButton = page.getByRole('button', { name: '打开 API 接入' })
  await apiButton.click()
  const apiDialog = page.getByRole('dialog', { name: 'API 接入' })
  await expect(apiDialog).toBeVisible()
  await expect(apiDialog).toContainText('AIStartLab')
  await expect(apiDialog).toContainText('已配置密钥')
  await expect(apiDialog).toContainText('2 个模型')
  await apiDialog.getByRole('button', { name: '快速测试' }).click()
  await apiDialog.getByRole('button', { name: '同步配置' }).click()
  await apiDialog.getByRole('button', { name: '管理接入' }).click()

  const providerDrawer = page.getByRole('dialog', { name: '管理 API 接入' })
  await expect(providerDrawer).toBeVisible()
  const secret = providerDrawer.getByLabel('替换 API Key')
  await secret.fill('local-secret')
  expect(savedSecrets).toEqual([])
  await providerDrawer.getByRole('button', { name: '保存新密钥' }).click()
  await expect(secret).toHaveValue('')
  expect(savedSecrets).toEqual(['local-secret'])
  expect(
    await page.evaluate(() => JSON.stringify(window.localStorage)),
  ).not.toContain('local-secret')
  await providerDrawer
    .getByRole('button', { name: '关闭管理 API 接入' })
    .click()
  await expect(apiButton).toBeFocused()

  const collaborationButton = page.getByRole('button', {
    name: '打开多人协作',
  })
  await collaborationButton.click()
  await expect(apiDialog).toBeHidden()
  const collaborationDialog = page.getByRole('dialog', { name: '多人协作' })
  await expect(collaborationDialog).toBeVisible()
  await expect(collaborationDialog.getByRole('textbox', { name: '协作昵称' })).toBeVisible()
  await expect(collaborationDialog.getByRole('button', { name: '开启协作' })).toBeVisible()
  await expect(collaborationDialog.getByLabel('邀请成员')).toHaveCount(0)
  expect(actionRequests.some((url) => url.includes('/api/providers/aistartlab/test'))).toBe(true)
  expect(actionRequests.some((url) => url.includes('/api/providers/aistartlab/sync'))).toBe(true)
  expect(actionRequests.every((url) => !url.includes('aistarslab.com'))).toBe(true)

  await collaborationDialog
    .getByRole('button', { name: '关闭多人协作' })
    .click()
  await expect(collaborationButton).toBeFocused()
  await expect(page.getByText('会员中心')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '分享' })).toHaveCount(0)

  await page.getByRole('button', { name: '打开 Agent' }).click()
  await expect(page.getByRole('complementary', { name: 'Agent' })).toBeVisible()
  await page.getByRole('button', { name: '关闭Agent' }).click()
})

test('exposes blank, node, and selection contextual controls', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const workspace = page.getByTestId('canvas-workspace')

  await workspace.click({
    button: 'right',
    position: { x: 320, y: 220 },
  })
  const blankMenu = page.getByRole('menu', { name: '画布快捷菜单' })
  await expect(blankMenu).toBeVisible()
  await page.mouse.click(1200, 700)
  await expect(blankMenu).toBeHidden()

  await workspace.click({ button: 'right', position: { x: 320, y: 220 } })
  await page.mouse.dblclick(1200, 700)
  await expect(blankMenu).toBeHidden()
  await expect(page.getByRole('menu', { name: '添加节点' })).toBeHidden()

  await workspace.click({ button: 'right', position: { x: 320, y: 220 } })
  await page.keyboard.press('Escape')
  await expect(blankMenu).toBeHidden()
  await workspace.click({ button: 'right', position: { x: 1180, y: 680 } })
  await expect(blankMenu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('app-shell')).toBeVisible()

  const visibleNode = page.locator(
    '.react-flow__node[data-id="i-TFj65r3PHQ"]',
  )
  await expect(visibleNode).toBeVisible()
  await visibleNode.click({ button: 'right' })
  await expect(page.getByRole('menu', { name: '节点快捷菜单' })).toBeVisible()
  expect(pageErrors).toEqual([])
  await page.keyboard.press('Escape')
  expect(pageErrors).toEqual([])
  await expect(page.getByTestId('app-shell')).toBeVisible()

  await page.keyboard.press('Control+A')
  expect(pageErrors).toEqual([])
  const selectionToolbar = page.getByRole('toolbar', { name: '所选节点操作' })
  await expect(selectionToolbar).toBeVisible()
  await expect(selectionToolbar.getByRole('button', { name: '整理选区' })).toBeVisible()
  await expect(selectionToolbar.getByRole('button', { name: '保存到资产' })).toBeVisible()
  await expect(selectionToolbar.getByRole('button', { name: '创建副本' })).toBeVisible()
  await expect(selectionToolbar.getByRole('button', { name: '复制' })).toBeVisible()
  await expect(selectionToolbar.getByRole('button', { name: '打组' })).toBeVisible()
  await expect(selectionToolbar.getByRole('button', { name: '添加到 Chat' })).toBeDisabled()
  expect(pageErrors).toEqual([])
})

test('keeps a pointer menu inside the lower-right viewport edge', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.getByTestId('canvas-workspace').click({
    button: 'right',
    position: { x: 1334, y: 704 },
  })
  const menu = page.getByRole('menu', { name: '画布快捷菜单' })
  await expect(menu).toBeVisible()
  const bounds = await menu.boundingBox()

  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(8)
  expect(bounds!.y).toBeGreaterThanOrEqual(8)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1358)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(760)
})

test('creates core objects and uses layers, comments, and asset management', async ({
  page,
}) => {
  const initialNodeCount = await page.locator('.react-flow__node').count()

  await page.getByRole('button', { name: '图形 R' }).click()
  const workspace = page.getByTestId('canvas-workspace')
  await workspace.hover({ position: { x: 300, y: 180 } })
  await page.mouse.down()
  await page.mouse.move(510, 330, { steps: 5 })
  await expect(page.locator('.canvas-creation-preview')).toBeVisible()
  await page.mouse.up()
  await expect(page.locator('.react-flow__node')).toHaveCount(initialNodeCount + 1)
  await expect(page.locator('.react-flow__node-shape')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '选择 V' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('toolbar', { name: '对象属性' })).toBeVisible()

  await page.getByRole('button', { name: '画框 F' }).click()
  await page.getByTestId('canvas-workspace').click({ position: { x: 680, y: 180 } })
  await expect(page.locator('.react-flow__node')).toHaveCount(initialNodeCount + 2)
  await expect(page.locator('.react-flow__node-frame')).toHaveCount(1)

  await page.getByRole('button', { name: '文字 T' }).click()
  await page.getByTestId('canvas-workspace').click({ position: { x: 360, y: 700 } })
  await expect(page.locator('.react-flow__node')).toHaveCount(initialNodeCount + 3)
  const plainText = page.locator('.canvas-text-node--plain')
  await expect(plainText.getByRole('textbox', { name: '文本节点内容' })).toBeVisible()
  await expect(plainText.locator('svg')).toHaveCount(0)

  await page.getByRole('button', { name: '画笔 B' }).click()
  await workspace.hover({ position: { x: 520, y: 420 } })
  await page.mouse.down()
  await page.mouse.move(620, 470, { steps: 5 })
  await expect(page.locator('.canvas-brush-preview path')).toBeVisible()
  await page.mouse.up()
  await expect(page.locator('.react-flow__node-path')).toHaveCount(1)

  await page.getByRole('button', { name: '展开图层' }).click()
  const layers = page.getByRole('complementary', { name: '图层' })
  await expect(layers).toBeVisible()
  await layers.getByRole('button', { name: '文本' }).first().dblclick()
  await layers.getByRole('textbox', { name: '重命名 文本' }).fill('分镜标题')
  await layers.getByRole('textbox', { name: '重命名 文本' }).press('Enter')
  await expect(layers.getByRole('button', { name: '分镜标题' })).toBeVisible()

  await page.getByRole('button', { name: '打开评论' }).click()
  const comments = page.getByRole('complementary', { name: '评论' })
  await comments.getByRole('textbox', { name: '新评论' }).fill('这里需要团队确认')
  await comments.getByRole('button', { name: '发布评论' }).click()
  await expect(comments.getByText('这里需要团队确认')).toBeVisible()
  await comments.getByRole('button', { name: '关闭评论' }).click()

  await page.getByRole('button', { name: '资产管理' }).click()
  const manager = page.getByRole('complementary', { name: '项目文件' })
  await expect(manager.getByRole('tab', { name: '画布' })).toBeVisible()
  await expect(manager.getByRole('tab', { name: '资产' })).toBeVisible()
  await manager.getByRole('searchbox', { name: '搜索节点' }).fill('图片节点')
  await expect(manager.getByText(/个节点/)).toBeVisible()
  await manager.getByRole('button', { name: /定位图片节点/ }).first().click()
})

test('removes obsolete shells while keeping real service entry points', async ({
  page,
}) => {
  const workspace = page.getByTestId('canvas-workspace')
  const initialNodeCount = await page.locator('.react-flow__node').count()

  await expect(page.getByRole('button', { name: '故事板' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开工具箱' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '角色库' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '教程' })).toHaveCount(0)
  await expect(workspace).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(initialNodeCount)

  await expect(page.getByText('会员中心')).toHaveCount(0)
  await expect(page.getByText('1,555')).toHaveCount(0)
  await expect(page.getByText('限时')).toHaveCount(0)

  await page.getByRole('button', { name: 'API 接入' }).click()
  await expect(page.getByRole('dialog', { name: 'API 接入' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '打开 Agent' }).click()
  await expect(page.getByRole('complementary', { name: 'Agent' })).toBeVisible()
})
