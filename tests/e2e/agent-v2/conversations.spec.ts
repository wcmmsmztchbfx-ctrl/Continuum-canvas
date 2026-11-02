import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { test, expect } from '../../fixtures/e2e-env'

const canvasId = 'e2e-reference-canvas'
const url = `/canvas?spaceId=local&projectId=reference&canvasId=${canvasId}`
async function open(page: Page) {
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  if (await page.getByRole('button', { name: '展开侧边栏', exact: true }).isVisible()) await page.getByRole('button', { name: '展开侧边栏', exact: true }).click()
  await page.getByRole('button', { name: 'Agent 助手', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '选择对话' })).toBeVisible()
}
async function send(page: Page, text: string) {
  await page.getByLabel('Agent 指令输入框').fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}
test.beforeEach(async ({ request }) => {
  test.skip(process.env.CANVAS_AGENT_RUNTIME_VERSION !== '2', 'Run with CANVAS_AGENT_RUNTIME_VERSION=2')
  const current = await (await request.get(`/api/canvases/${canvasId}`)).json()
  const response = await request.put(`/api/canvases/${canvasId}`, { data: { protocolVersion: 1, operationId: randomUUID(), kind: 'save-canvas', expectedRevision: current.revision, canvas: { ...current.canvas, nodes: [], edges: [] } } })
  expect(response.ok()).toBe(true)
})
test('new answers animate; conversations keep independent history, drafts and context across reload', async ({ page }, info) => {
  await page.goto(url); await open(page)
  await send(page, '对话验收：记住角色叫小林')
  const response = page.locator('.agent-runtime-response[data-typing="true"]').last()
  await expect(response).toBeVisible()
  const visible = response.locator('[data-agent-visible-text]')
  await expect.poll(async () => (await visible.innerText()).length).toBeGreaterThan(0)
  expect((await visible.innerText()).length).toBeLessThan(350)
  await page.getByRole('button', { name: '显示全文', exact: true }).click()
  await expect(page.locator('[data-agent-visible-text]').last()).toContainText('角色叫小林')
  const firstId = await page.getByRole('combobox', { name: '选择对话' }).inputValue()
  await page.getByRole('button', { name: '新建对话', exact: true }).click()
  const secondId = await page.getByRole('combobox', { name: '选择对话' }).inputValue()
  expect(secondId).not.toBe(firstId)
  await expect(page.locator('.agent-runtime-response')).toHaveCount(0)
  await page.getByLabel('Agent 指令输入框').fill('这个对话的草稿')
  await page.getByRole('combobox', { name: '选择对话' }).selectOption(firstId)
  await expect(page.locator('.agent-runtime-response')).toHaveCount(1)
  await expect(page.locator('.agent-runtime-response[data-typing="true"]')).toHaveCount(0)
  await page.getByRole('combobox', { name: '选择对话' }).selectOption(secondId)
  await expect(page.getByLabel('Agent 指令输入框')).toHaveValue('这个对话的草稿')
  await send(page, '对话验收：角色叫什么？')
  await expect(page.locator('[data-agent-visible-text]').last()).toHaveText('这个新对话没有之前的角色记忆。')
  await page.getByRole('combobox', { name: '选择对话' }).selectOption(firstId)
  await send(page, '对话验收：角色叫什么？')
  await expect(page.locator('[data-agent-visible-text]').last()).toHaveText('角色叫小林，我保留了本对话的上下文。')
  await page.reload(); await open(page)
  await expect(page.getByRole('combobox', { name: '选择对话' })).toHaveValue(firstId)
  await expect(page.locator('.agent-runtime-response')).toHaveCount(2)
  await expect(page.locator('.agent-runtime-response[data-typing="true"]')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('agent-conversations.png') })
})
test('budget exhaustion produces a complete closing answer, folds the trace and permits a separate chat', async ({ page }, info) => {
  await page.goto(url); await open(page); await send(page, '预算验收：只读取画布，不要修改，不要生成')
  await expect(page.locator('[data-agent-visible-text]').last()).toHaveText('本轮已核对画布，操作预算结束后已暂停。已提交的内容已保留，可以继续处理剩余步骤。')
  await expect(page.getByRole('button', { name: '继续任务', exact: true })).toBeVisible()
  await expect(page.locator('.agent-runtime-activity')).not.toHaveAttribute('open')
  await page.getByRole('button', { name: '新建对话', exact: true }).click()
  await send(page, '对话验收：角色叫什么？')
  await expect(page.locator('[data-agent-visible-text]').last()).toHaveText('这个新对话没有之前的角色记忆。')
  await page.screenshot({ path: info.outputPath('agent-budget-closing.png') })
})
