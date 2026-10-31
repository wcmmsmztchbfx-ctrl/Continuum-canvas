import { expect, test } from '../../fixtures/e2e-env'
import type { TunnelStatus } from '../../../src/contracts/collaboration'

test('an HTTPS tunnel keeps the local owner connected and allows another browser to join', async ({ page, createTestContext }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/canvas?spaceId=local&projectId=fixture-project&canvasId=e2e-reference-canvas')
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  const saved = await (await page.request.get('/api/canvases/e2e-reference-canvas')).json()
  await page.getByRole('button', { name: '缩放选项', exact: true }).click()
  await page.getByRole('textbox', { name: '缩放比例' }).fill('10')
  await page.getByRole('textbox', { name: '缩放比例' }).press('Enter')
  await expect(page.getByRole('button', { name: '缩放选项', exact: true })).toContainText('10%')
  const started = await page.evaluate(async () => {
    await fetch('/api/local-admin/session', { method: 'POST' })
    const response = await fetch('/api/collaboration/tunnel/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'custom', customUrl: 'https://collaboration.continuum.example' }),
    })
    return { status: response.status, payload: await response.json() }
  })
  expect(started.status).toBe(200)
  expect(started.payload.status).toBe('running')
  try {
    await page.getByRole('button', { name: '多人协作', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '多人协作' })
    await dialog.getByRole('button', { name: '远程互联网', exact: true }).click()
    await dialog.getByRole('textbox', { name: '协作昵称' }).fill('本机房主')
    const [created] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/collaboration/rooms'),
      dialog.getByRole('button', { name: '开启协作', exact: true }).click(),
    ])
    expect(created.status(), await created.text()).toBe(201)
    expect(created.request().postDataJSON().snapshot.viewport.zoom).toBe(0.1)
    await expect(page.getByTestId('top-bar')).toHaveAttribute('data-collaboration-status', 'synced')
    expect((await (await page.request.get('/api/canvases/e2e-reference-canvas')).json()).revision).toBe(saved.revision)
    await expect(page.getByRole('button', { name: '缩放选项', exact: true })).toContainText('10%')
    const cookies = await page.context().cookies()
    const roomCookie = cookies.find(cookie => cookie.name.startsWith('canvas_collaboration_'))
    expect(roomCookie).toBeDefined()
    expect(roomCookie!.secure).toBe(false)
    await dialog.getByRole('button', { name: '创建编辑链接' }).click()
    await dialog.getByRole('button', { name: '复制可编辑链接' }).last().click()
    const inviteUrl = new URL(await page.evaluate(() => navigator.clipboard.readText()))
    expect(inviteUrl.origin).toBe('https://collaboration.continuum.example')
    inviteUrl.host = '127.0.0.1:4273'
    inviteUrl.protocol = 'http:'
    const editor = await (await createTestContext()).newPage()
    await editor.goto(inviteUrl.toString())
    const join = editor.getByRole('dialog', { name: '加入协作画布' })
    await join.getByRole('textbox', { name: '协作显示名称' }).fill('受邀编辑者')
    await join.getByRole('button', { name: '加入画布' }).click()
    await expect(editor.getByTestId('top-bar')).toHaveAttribute('data-collaboration-status', 'synced')
    await expect(page.getByTestId('top-bar')).toHaveAttribute('data-collaboration-status', 'synced')
    await editor.close()
    await dialog.getByRole('button', { name: '关闭协作', exact: true }).click()
    await expect(page.getByTestId('top-bar')).toHaveAttribute('data-collaboration-status', 'inactive')
  } finally {
    if (!page.isClosed()) await page.evaluate(() => fetch('/api/collaboration/tunnel/stop', { method: 'POST' }))
  }
})

test('remote sharing shows progress during download, offers retry and stays within a narrow dialog', async ({ page }) => {
  let status: TunnelStatus = { enabled: false, mode: 'auto', status: 'stopped' }
  let completeDownload!: () => void
  let starts = 0
  await page.route('**/api/collaboration/tunnel', route => route.fulfill({ json: status }))
  await page.route('**/api/collaboration/tunnel/start', async route => {
    starts++
    status = { enabled: true, mode: 'auto', status: 'downloading', downloadProgress: 38 }
    await new Promise<void>(resolve => { completeDownload = resolve })
    await route.fulfill({ json: status })
  })
  await page.goto('/canvas?spaceId=local&projectId=reference')
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  await page.getByRole('button', { name: '多人协作', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '多人协作' })
  await dialog.getByRole('button', { name: '远程互联网', exact: true }).click()
  await dialog.getByRole('button', { name: /开启远程通道/ }).click()
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '38')
  status = { ...status, status: 'error', error: '组件下载未完成，请检查后端网络后重试；也可以手动安装 Cloudflare 组件。' }
  completeDownload()
  const retry = dialog.getByRole('button', { name: '重试下载 / 连接' })
  await expect(retry).toBeEnabled()
  await expect(dialog.getByRole('link', { name: '手动安装组件' })).toBeVisible()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(dialog).toBeVisible()
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`remote-error-${width}.png`) })
  }
  await retry.click()
  await expect.poll(() => starts).toBe(2)
  status = { ...status, status: 'starting', error: undefined }
  completeDownload()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await dialog.getByRole('button', { name: '关闭多人协作' }).click()
})

test('sidebar rail keeps its tools accessible with smaller icons and consistent spacing', async ({ page }) => {
  await page.goto('/canvas?spaceId=local&projectId=reference')
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click()
  const rail = page.locator('.app-layer-sidebar__rail')
  await expect(rail).toBeVisible()
  for (const label of ['演化', '资产管理', 'Agent 助手', '图层']) {
    await rail.getByRole('button', { name: label, exact: true }).click()
    await expect(rail.getByRole('button', { name: label, exact: true })).toHaveClass(/rail-btn--active/)
  }
  await rail.getByRole('button', { name: '设置', exact: true }).click({ trial: true })
  const metrics = await rail.evaluate(element => {
    const buttons = [...element.querySelectorAll('.app-layer-sidebar__rail-btn')].slice(0, 4)
    const rects = buttons.map(button => button.getBoundingClientRect())
    return { icon: buttons[0].querySelector('svg')!.getBoundingClientRect().width, gap: rects[1].top - rects[0].bottom }
  })
  expect(metrics.icon).toBeLessThanOrEqual(16)
  expect(metrics.gap).toBeGreaterThanOrEqual(8)
  await page.screenshot({ path: test.info().outputPath('sidebar.png') })
})
