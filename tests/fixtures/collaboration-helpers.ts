import { expect, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test'

type ContextFactory = (options?: BrowserContextOptions) => Promise<BrowserContext>

async function addTextNode(page: Page, position: { x: number; y: number }): Promise<string> {
  await page.getByRole('button', { name: /文字/ }).click()
  await page.locator('.react-flow__pane').click({ position })
  const node = page.locator('.react-flow__node-text.selected')
  await expect(node).toHaveCount(1)
  const id = await node.getAttribute('data-id')
  expect(id).toBeTruthy()
  await page.getByRole('textbox', { name: '文本节点内容' }).fill(`初始内容-${id}`)
  await page.keyboard.press('Escape')
  return id!
}

async function openCollaboration(page: Page) {
  await page.getByRole('button', { name: '多人协作' }).click()
  const dialog = page.getByRole('dialog', { name: '多人协作' })
  await expect(dialog).toBeVisible()
  return dialog
}

export async function createCollaborativePair(createTestContext: ContextFactory) {
  const ownerContext = await createTestContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const editorContext = await createTestContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const owner = await ownerContext.newPage()
  const editor = await editorContext.newPage()

  await owner.goto('/')
  await owner.getByRole('button', { name: '新建画布' }).click()
  await owner.getByRole('textbox', { name: '名称' }).fill(`协作门禁-${Date.now()}`)
  await owner.getByRole('textbox', { name: '名称' }).press('Enter')
  await expect(owner.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  const nodeIds = [
    await addTextNode(owner, { x: 420, y: 310 }),
    await addTextNode(owner, { x: 720, y: 410 }),
  ]

  const ownerDialog = await openCollaboration(owner)
  await ownerDialog.getByRole('textbox', { name: '协作昵称' }).fill('所有者甲')
  await ownerDialog.getByRole('button', { name: '开启协作' }).click()
  await expect(owner.getByTestId('top-bar')).toHaveAttribute('data-collaboration-status', 'synced')
  await ownerDialog.getByRole('button', { name: '创建编辑链接' }).click()
  const copy = ownerDialog.getByRole('button', { name: '复制可编辑链接' }).last()
  await expect(copy).toBeEnabled()
  await copy.click()
  await ownerDialog.getByRole('button', { name: '关闭多人协作' }).click()
  await expect(ownerDialog).toBeHidden()
  const inviteUrl = await owner.evaluate(() => navigator.clipboard.readText())
  expect(inviteUrl).toContain('collabRoom=')

  const parsedUrl = new URL(inviteUrl)
  parsedUrl.host = '127.0.0.1:4273'
  await editor.goto(parsedUrl.toString())
  const join = editor.getByRole('dialog', { name: '加入协作画布' })
  await expect(join).toBeVisible()
  await join.getByRole('textbox', { name: '协作显示名称' }).fill('编辑者乙')
  await join.getByRole('button', { name: '加入画布' }).click()
  await expect(editor.getByTestId('top-bar')).toHaveAttribute('data-collaboration-status', 'synced')
  await expect(editor.locator(`.react-flow__node[data-id="${nodeIds[0]}"]`)).toBeVisible()
  return { owner, editor, ownerContext, editorContext, nodeIds }
}

export async function beginTextEdit(page: Page, nodeId: string) {
  const node = page.locator(`.react-flow__node-text[data-id="${nodeId}"]`)
  await node.click()
  const textarea = node.getByRole('textbox', { name: '文本节点内容' })
  if (!await textarea.isVisible()) {
    const preview = node.locator('.canvas-text-node__preview')
    if (await preview.isVisible()) {
      await preview.dblclick()
    }
  }
  await expect(textarea).toBeVisible()
  return textarea
}
