import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect, SAMPLE_IMAGE_PATH } from '../../fixtures/e2e-env'
import type { AgentRun } from '../../../src/contracts/agent'
import type { CanvasNode } from '../../../src/model/project'

const canvasId = 'e2e-reference-canvas'
const url = `/canvas?spaceId=local&projectId=reference&canvasId=${canvasId}`
async function emptyCanvas(request: APIRequestContext, nodes: CanvasNode[] = []) {
  const current = await (await request.get(`/api/canvases/${canvasId}`)).json()
  const response = await request.put(`/api/canvases/${canvasId}`, { data: {
    protocolVersion: 1, operationId: randomUUID(), kind: 'save-canvas', expectedRevision: current.revision,
    canvas: { ...current.canvas, nodes, edges: [], viewport: { x: 200, y: 140, zoom: 1 } },
  } })
  expect(response.ok(), await response.text()).toBe(true)
}
async function openAgent(page: Page) {
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  if (await page.getByRole('button', { name: '展开侧边栏', exact: true }).isVisible()) await page.getByRole('button', { name: '展开侧边栏', exact: true }).click()
  await page.getByRole('button', { name: 'Agent 助手', exact: true }).click()
  await expect(page.getByLabel('Agent 智能助手')).toBeVisible()
}
async function send(page: Page, prompt: string) {
  await page.getByLabel('Agent 指令输入框').fill(prompt)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByLabel(`任务：${prompt}`, { exact: true })).toBeVisible()
}
async function runs(request: APIRequestContext): Promise<AgentRun[]> {
  const response = await request.get(`/api/agent/canvases/${canvasId}/runs`, {
    headers: { referer: `http://127.0.0.1:4273${url}` },
  })
  expect(response.ok(), await response.text()).toBe(true)
  return (await response.json()).runs
}

test('browser progress reads without Origin recover completed responses after reload', async ({ page, request }) => {
  await emptyCanvas(request)
  const progress = page.waitForResponse(response => response.url().endsWith(`/api/agent/canvases/${canvasId}/runs`) && response.request().method() === 'GET')
  await page.goto(url)
  await openAgent(page)
  const response = await progress
  expect(response.request().headers().origin).toBeUndefined()
  expect(response.request().headers().referer).toContain('http://127.0.0.1:4273/canvas')
  expect(response.status()).toBe(200)
  await send(page, '检查引用')
  await expect(page.locator('.agent-runtime-response').filter({ hasText: '已查看 0 张引用图片' })).toBeVisible()
  await expect(page.getByText(/暂时无法更新任务状态/)).toHaveCount(0)
  await page.reload()
  await openAgent(page)
  await expect(page.locator('.agent-runtime-response').filter({ hasText: '已查看 0 张引用图片' })).toBeVisible()
  await expect(page.getByText(/Collaboration access is not allowed/)).toHaveCount(0)
  expect(await runs(page.context().request)).toEqual([expect.objectContaining({ status: 'complete', prompt: '检查引用' })])
})

test('backend finishes generation after closing the page; reopening restores events and generated canvas', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000)
  await emptyCanvas(request)
  await page.goto(url)
  await openAgent(page)
  await send(page, '缓慢生成一个苹果')
  await page.close()
  await expect.poll(async () => (await runs(page.context().request))[0]?.status, { timeout: 35_000 }).toBe('complete')
  const run = (await runs(page.context().request))[0]
  expect(run.outputs).toHaveLength(1)
  expect(run.events.some(event => event.type === 'skill')).toBe(true)
  const canvas = (await (await request.get(`/api/canvases/${canvasId}`)).json()).canvas
  expect(canvas.nodes).toHaveLength(1)
  expect(canvas.nodes[0].data.assetId).toBe(run.outputs[0].assetId)
  const reopened = await page.context().newPage()
  await reopened.goto(url)
  await openAgent(reopened)
  await expect(reopened.locator('.agent-runtime-response').filter({ hasText: '已生成 1 张苹果图片' })).toBeVisible()
  await reopened.getByRole('button', { name: '定位结果', exact: true }).click()
  await expect(reopened.locator(`.react-flow__node[data-id="${run.outputs[0].nodeId}"]`)).toBeVisible()
  await reopened.screenshot({ path: testInfo.outputPath('agent-completed.png') })
})

test('clarification survives reload and proceeds only after an explicit answer', async ({ page, request }) => {
  await emptyCanvas(request)
  await page.goto(url); await openAgent(page)
  await send(page, '先澄清苹果样式，只写提示词')
  await expect(page.getByLabel('等待你的回答')).toBeVisible()
  const before = (await runs(page.context().request))[0]
  expect(before.status).toBe('waiting_user')
  expect((await (await request.get(`/api/canvases/${canvasId}`)).json()).canvas.nodes).toHaveLength(0)
  await page.reload(); await openAgent(page)
  await page.getByRole('button', { name: '扁平插画', exact: true }).click()
  await page.getByRole('button', { name: '提交回答', exact: true }).click()
  await expect(page.locator('.agent-runtime-response').filter({ hasText: '已创建苹果节点并写入提示词' })).toBeVisible()
  expect((await runs(page.context().request))[0].id).toBe(before.id)
  expect((await runs(page.context().request))[0].outputs).toHaveLength(0)
  await expect(page.locator('.react-flow__node-image')).toHaveCount(1)
})

test('selected images remain ghosts until confirmed and actual image inputs reach the backend model', async ({ page, request }) => {
  const upload = await request.post('/api/assets', { headers: { 'content-type': 'image/png', 'x-filename': 'reference.png' }, data: await readFile(SAMPLE_IMAGE_PATH) })
  expect(upload.ok(), await upload.text()).toBe(true)
  const asset = (await upload.json()).asset
  await emptyCanvas(request, [0, 1].map(index => ({ id: `reference-${index}`, type: 'image', name: `参考图 ${index + 1}`, position: { x: index * 180, y: 0 }, size: { width: 160, height: 100 }, data: { assetId: asset.id, url: asset.url } })))
  await page.goto(url); await openAgent(page)
  await page.evaluate(() => window.__canvasStore!.getState().selectNodes(['reference-0', 'reference-1']))
  await expect(page.getByLabel('候选引用')).toBeVisible()
  await send(page, '检查引用，暂不附图')
  await expect(page.locator('.agent-runtime-response').filter({ hasText: '已查看 0 张引用图片' })).toBeVisible()
  expect((await runs(page.context().request))[0].attachments).toHaveLength(0)
  await page.getByRole('button', { name: '引用全部', exact: true }).click()
  await expect(page.getByLabel('已确认引用').locator('.agent-runtime-reference')).toHaveCount(2)
  await send(page, '检查引用，分析这两张图片')
  await expect(page.locator('.agent-runtime-response').filter({ hasText: '已查看 2 张引用图片' })).toBeVisible()
  expect((await runs(page.context().request)).at(-1)!.attachments).toHaveLength(2)
})

test('stop blocks future tools and task undo preserves later manual nodes', async ({ page, request }) => {
  await emptyCanvas(request)
  await page.goto(url); await openAgent(page)
  await send(page, '缓慢生成一个苹果，只写提示词')
  await page.getByRole('button', { name: '停止任务', exact: true }).click()
  await expect(page.getByText('已停止', { exact: true })).toBeVisible()
  await send(page, '生成一个苹果，只写提示词')
  await expect(page.locator('.agent-runtime-response').filter({ hasText: '已创建苹果节点并写入提示词' })).toBeVisible()
  await expect(page.locator('.react-flow__node-image')).toHaveCount(1)
  await page.evaluate(() => window.__canvasStore!.getState().addNode({ id: 'manual-kept', type: 'text', name: '手工内容', position: { x: 400, y: 200 }, size: { width: 150, height: 100 }, data: { text: '保留我的修改' } }))
  // A deliberate second task proves the save barrier includes the manual edit before undo.
  await send(page, '检查引用')
  await expect(page.locator('.agent-runtime-response').filter({ hasText: '已查看 0 张引用图片' })).toBeVisible()
  await page.getByRole('button', { name: '撤销本次操作', exact: true }).click()
  await expect(page.locator('.react-flow__node-image')).toHaveCount(0)
  await expect(page.locator('.react-flow__node[data-id="manual-kept"]')).toHaveCount(1)
  const completed = await runs(page.context().request)
  expect(completed[0].status).toBe('stopped')
})

test('background additions merge with manual edits and survive normal editor undo', async ({ page, request }) => {
  await emptyCanvas(request)
  await page.goto(url); await openAgent(page)
  await send(page, '缓慢生成一个苹果，只写提示词')
  await page.evaluate(() => window.__canvasStore!.getState().addNode({ id: 'manual-during-run', type: 'text', name: '我的草稿', position: { x: 450, y: 200 }, size: { width: 150, height: 100 }, data: { text: '编辑中' } }))
  await expect(page.locator('.agent-runtime-response').filter({ hasText: '已创建苹果节点并写入提示词' })).toBeVisible()
  await expect(page.locator('.react-flow__node-image')).toHaveCount(1)
  await expect(page.locator('.react-flow__node[data-id="manual-during-run"]')).toHaveCount(1)
  await page.evaluate(() => window.__canvasStore!.getState().undo())
  await expect(page.locator('.react-flow__node[data-id="manual-during-run"]')).toHaveCount(0)
  await expect(page.locator('.react-flow__node-image')).toHaveCount(1)
  await expect.poll(async () => (await (await request.get(`/api/canvases/${canvasId}`)).json()).canvas.nodes.map((node: CanvasNode) => node.name)).toEqual(['Agent 苹果'])
})
