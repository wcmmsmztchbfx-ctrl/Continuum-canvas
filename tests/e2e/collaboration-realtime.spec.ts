import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const stepTimeout = 5_000

async function isolatedContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: 'http://127.0.0.1:4273',
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1440, height: 900 },
  })
}

async function createCanvas(page: Page, name: string, textNodes = 2): Promise<string[]> {
  await page.goto('/')
  await page.locator('.workspace-home__topbar').getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('textbox', { name: '名称' }).fill(name)
  await page.getByRole('textbox', { name: '名称' }).press('Enter')
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true', {
    timeout: stepTimeout,
  })
  for (let index = 0; index < textNodes; index += 1) {
    await page.getByRole('button', { name: '上传媒体 U' }).click()
    await page.getByRole('menu', { name: '添加节点' })
      .getByRole('menuitem', { name: '文本', exact: true }).click()
    const selected = page.locator('.react-flow__node-text.selected')
    await expect(selected).toHaveCount(1)
    const bounds = await selected.boundingBox()
    expect(bounds).not.toBeNull()
    const offset = index === 0 ? -220 : 220 * index
    await page.mouse.move(
      bounds!.x + bounds!.width / 2,
      bounds!.y + bounds!.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(
      bounds!.x + bounds!.width / 2 + offset,
      bounds!.y + bounds!.height / 2,
      { steps: 8 },
    )
    await page.mouse.up()
  }
  const nodes = page.locator('.react-flow__node-text')
  await expect(nodes).toHaveCount(textNodes)
  return nodes.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-id')!))
}

async function openCollaboration(page: Page) {
  await page.getByRole('button', { name: '打开多人协作' }).click()
  return page.getByRole('dialog', { name: '多人协作' })
}

async function enableCollaboration(page: Page, displayName: string) {
  const dialog = await openCollaboration(page)
  await dialog.getByRole('textbox', { name: '协作昵称' }).fill(displayName)
  await dialog.getByRole('button', { name: '开启协作' }).click()
  await expect(page.getByTestId('top-bar')).toHaveAttribute('data-collaboration-status', 'synced', {
    timeout: stepTimeout,
  })
  const dismiss = dialog.getByRole('button', { name: '已保存并隐藏' })
  if (await dismiss.isVisible()) await dismiss.click()
  return dialog
}

async function createInvite(page: Page, role: 'editor' | 'viewer'): Promise<string> {
  const dialog = page.getByRole('dialog', { name: '多人协作' })
  const label = role === 'editor' ? '可编辑' : '可查看'
  await dialog.getByRole('button', { name: role === 'editor' ? '创建编辑链接' : '创建查看链接' }).click()
  const copy = dialog.getByRole('button', { name: `复制${label}链接` }).last()
  await expect(copy).toBeEnabled({ timeout: stepTimeout })
  await copy.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), {
    timeout: stepTimeout,
  }).toContain('collabRoom=')
  return page.evaluate(() => navigator.clipboard.readText())
}

async function joinInvite(page: Page, inviteUrl: string, displayName: string) {
  await page.goto(inviteUrl)
  const dialog = page.getByRole('dialog', { name: '加入协作画布' })
  await expect(dialog).toBeVisible({ timeout: stepTimeout })
  await dialog.getByRole('textbox', { name: '协作显示名称' }).fill(displayName)
  await dialog.getByRole('button', { name: '加入画布' }).click()
  await expect(page.getByTestId('top-bar')).toHaveAttribute('data-collaboration-status', 'synced', {
    timeout: stepTimeout,
  })
  await expect(page).not.toHaveURL(/#invite=/)
}

async function beginTextEdit(page: Page, nodeId: string) {
  const node = page.locator(`.react-flow__node-text[data-id="${nodeId}"]`)
  await node.click()
  await node.locator('.canvas-text-node__preview').dblclick()
  return node.getByRole('textbox', { name: '文本节点内容' })
}

test.describe('realtime collaboration acceptance', () => {
  test('supports invite presence, independent edits, soft locks, follow, roles, revoke and refresh', async ({ browser }) => {
    test.setTimeout(90_000)
    const ownerContext = await isolatedContext(browser)
    const editorContext = await isolatedContext(browser)
    const viewerContext = await isolatedContext(browser)
    const rejectedContext = await isolatedContext(browser)
    const owner = await ownerContext.newPage()
    const editor = await editorContext.newPage()
    const viewer = await viewerContext.newPage()
    const rejected = await rejectedContext.newPage()
    try {
      const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
      const [firstId, secondId] = await createCanvas(owner, `协作验收-${suffix}`)
      await enableCollaboration(owner, '所有者甲')
      const editorInvite = await createInvite(owner, 'editor')
      await owner.getByRole('button', { name: '关闭多人协作' }).click()
      await joinInvite(editor, editorInvite, '编辑者乙')

      await expect(owner.locator('.topbar-collaboration-presence__avatars [title="编辑者乙"]')).toBeVisible({ timeout: stepTimeout })

      await editor.locator(`.react-flow__node[data-id="${firstId}"]`).click()
      await expect(owner.locator(`[data-remote-selection="${firstId}"]`)).toBeVisible({ timeout: stepTimeout })
      const pane = editor.locator('.react-flow__pane')
      const paneBox = await pane.boundingBox()
      expect(paneBox).not.toBeNull()
      await editor.mouse.move(paneBox!.x + 400, paneBox!.y + 260)
      await expect(owner.locator('[data-remote-cursor]')).toBeVisible({ timeout: stepTimeout })

      const ownerText = await beginTextEdit(owner, firstId)
      const editorText = await beginTextEdit(editor, secondId)
      await expect(ownerText).toBeVisible()
      await expect(editorText).toBeVisible()
      await Promise.all([
        ownerText.fill('所有者独立编辑'),
        editorText.fill('编辑者独立编辑'),
      ])
      await ownerText.press('Escape')
      await editorText.press('Escape')
      await expect(owner.locator(`.react-flow__node[data-id="${secondId}"]`)).toContainText('编辑者独立编辑', { timeout: stepTimeout })
      await expect(editor.locator(`.react-flow__node[data-id="${firstId}"]`)).toContainText('所有者独立编辑', { timeout: stepTimeout })

      const heldEditor = await beginTextEdit(owner, firstId)
      await expect(heldEditor).toBeVisible()
      const sameNode = editor.locator(`.react-flow__node-text[data-id="${firstId}"]`)
      await sameNode.click()
      await sameNode.locator('.canvas-text-node__preview').dblclick()
      await expect(sameNode.getByRole('status')).toContainText('所有者甲 正在编辑', { timeout: stepTimeout })
      await expect(sameNode.getByRole('textbox', { name: '文本节点内容' })).toHaveCount(0)
      await heldEditor.press('Escape')

      const editorPane = editor.locator('.react-flow__pane')
      const beforeFollow = await owner.locator('.react-flow__viewport').getAttribute('style')
      await editorPane.hover({ position: { x: 600, y: 400 } })
      await editor.mouse.down({ button: 'middle' })
      await editor.mouse.move(paneBox!.x + 700, paneBox!.y + 470, { steps: 6 })
      await editor.mouse.up({ button: 'middle' })
      const ownerDialog = await openCollaboration(owner)
      await ownerDialog.getByRole('button', { name: '跟随 编辑者乙' }).click()
      await expect.poll(() => owner.locator('.react-flow__viewport').getAttribute('style'), { timeout: stepTimeout }).not.toBe(beforeFollow)
      await owner.locator('.react-flow__pane').hover({ position: { x: 500, y: 350 } })
      await owner.mouse.wheel(0, -120)
      await expect(ownerDialog.getByRole('button', { name: '跟随 编辑者乙' })).toBeVisible({ timeout: stepTimeout })

      const viewerInvite = await createInvite(owner, 'viewer')
      await joinInvite(viewer, viewerInvite, '查看者丙')
      const viewerNodes = viewer.locator('.react-flow__node')
      const viewerCount = await viewerNodes.count()
      await viewer.locator(`.react-flow__node[data-id="${firstId}"]`).click()
      await viewer.keyboard.press('Delete')
      await expect(viewerNodes).toHaveCount(viewerCount)

      await ownerDialog.getByRole('combobox', { name: '设置 编辑者乙 的角色' }).selectOption('viewer')
      const editorDialog = await openCollaboration(editor)
      await expect(editorDialog.getByRole('listitem').filter({ hasText: '编辑者乙' })).toContainText('可查看', { timeout: 8_000 })
      await editorDialog.getByRole('button', { name: '关闭多人协作' }).click()
      const editorCount = await editor.locator('.react-flow__node').count()
      await editor.locator(`.react-flow__node[data-id="${secondId}"]`).click()
      await editor.keyboard.press('Delete')
      await expect(editor.locator('.react-flow__node')).toHaveCount(editorCount)
      await editor.getByRole('button', { name: '上传媒体 U' }).click()
      await expect(editor.getByRole('menu', { name: '添加节点' })).toHaveCount(0)

      const revokedUrl = await createInvite(owner, 'editor')
      await ownerDialog.getByRole('button', { name: '撤销可编辑链接' }).last().click()
      await rejected.goto(revokedUrl)
      const rejectedDialog = rejected.getByRole('dialog', { name: '加入协作画布' })
      await expect(rejectedDialog).toBeVisible({ timeout: stepTimeout })
      await rejectedDialog.getByRole('textbox', { name: '协作显示名称' }).fill('被撤销成员')
      await rejectedDialog.getByRole('button', { name: '加入画布' }).click()
      await expect(rejected.getByRole('alert')).toBeVisible({ timeout: stepTimeout })

      await editor.reload()
      await expect(editor.getByTestId('top-bar')).toHaveAttribute('data-collaboration-status', 'synced', { timeout: 8_000 })
      await expect(editor.locator(`.react-flow__node[data-id="${firstId}"]`)).toContainText('所有者独立编辑')
    } finally {
      await Promise.allSettled([
        ownerContext.close(), editorContext.close(), viewerContext.close(), rejectedContext.close(),
      ])
    }
  })

  test('merges offline text edits after reconnect without changing either personal viewport', async ({ browser }) => {
    test.setTimeout(60_000)
    const ownerContext = await isolatedContext(browser)
    const editorContext = await isolatedContext(browser)
    const owner = await ownerContext.newPage()
    const editor = await editorContext.newPage()
    try {
      const [firstId, secondId] = await createCanvas(
        owner,
        `离线合并-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      await enableCollaboration(owner, '在线所有者')
      const editorInvite = await createInvite(owner, 'editor')
      await owner.getByRole('button', { name: '关闭多人协作' }).click()
      await joinInvite(editor, editorInvite, '离线编辑者')

      const ownerViewportBefore = await owner
        .locator('.react-flow__viewport')
        .getAttribute('style')
      await editorContext.setOffline(true)
      await expect(editor.getByTestId('top-bar')).toHaveAttribute(
        'data-collaboration-status',
        'offline',
        { timeout: 8_000 },
      )
      const offlineText = await beginTextEdit(editor, secondId)
      await offlineText.fill('离线期间写入的第二段文本')
      await offlineText.press('Escape')

      const ownerText = await beginTextEdit(owner, firstId)
      await ownerText.fill('在线期间写入的第一段文本')
      await ownerText.press('Escape')

      await editorContext.setOffline(false)
      await expect(editor.getByTestId('top-bar')).toHaveAttribute(
        'data-collaboration-status',
        'synced',
        { timeout: 12_000 },
      )
      await expect.poll(async () => ({
        ownerFirst: await owner.locator(`.react-flow__node[data-id="${firstId}"]`).innerText(),
        ownerSecond: await owner.locator(`.react-flow__node[data-id="${secondId}"]`).innerText(),
        editorFirst: await editor.locator(`.react-flow__node[data-id="${firstId}"]`).innerText(),
        editorSecond: await editor.locator(`.react-flow__node[data-id="${secondId}"]`).innerText(),
        editorStatus: await editor.getByTestId('top-bar').getAttribute('data-collaboration-status'),
      }), { timeout: 12_000 }).toMatchObject({
        ownerFirst: expect.stringContaining('在线期间写入的第一段文本'),
        ownerSecond: expect.stringContaining('离线期间写入的第二段文本'),
        editorFirst: expect.stringContaining('在线期间写入的第一段文本'),
        editorSecond: expect.stringContaining('离线期间写入的第二段文本'),
        editorStatus: 'synced',
      })
      await expect(owner.locator('.react-flow__viewport')).toHaveAttribute(
        'style',
        ownerViewportBefore ?? '',
      )
    } finally {
      await Promise.allSettled([ownerContext.close(), editorContext.close()])
    }
  })

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    test(`captures collaboration topbar and popover at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
      test.setTimeout(30_000)
      const context = await isolatedContext(browser)
      const page = await context.newPage()
      try {
        await page.setViewportSize(viewport)
        await createCanvas(page, `视觉协作-${viewport.width}-${Date.now()}`, 1)
        await enableCollaboration(page, '视觉所有者')
        const dialog = page.getByRole('dialog', { name: '多人协作' })
        await expect(dialog).toBeVisible()
        const dialogBounds = await dialog.boundingBox()
        const topbarBounds = await page.getByTestId('top-bar').boundingBox()
        expect(dialogBounds).not.toBeNull()
        expect(topbarBounds).not.toBeNull()
        expect(dialogBounds!.x).toBeGreaterThanOrEqual(0)
        expect(dialogBounds!.y).toBeGreaterThanOrEqual(topbarBounds!.y)
        expect(dialogBounds!.x + dialogBounds!.width).toBeLessThanOrEqual(viewport.width)
        expect(dialogBounds!.y + dialogBounds!.height).toBeLessThanOrEqual(viewport.height)
        const bytes = await page.screenshot({ animations: 'disabled' })
        const output = path.resolve(`tests/visual/current/collaboration-${viewport.width}x${viewport.height}.png`)
        fs.mkdirSync(path.dirname(output), { recursive: true })
        fs.writeFileSync(output, bytes)
      } finally {
        await context.close()
      }
    })
  }
})
