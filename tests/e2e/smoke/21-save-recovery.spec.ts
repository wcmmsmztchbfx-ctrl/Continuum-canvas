import type { APIRequestContext, Page } from '@playwright/test'
import type { CanvasSnapshotV2 } from '../../../src/model/project'
import type { CanvasDocumentResponse, WorkspaceManifestResponse, WorkspaceMutation, WorkspaceMutationReceipt } from '../../../src/workspace/persistenceProtocol'
import { expect, test } from '../../fixtures/e2e-env'

const syncStatus = (page: Page) => page.getByRole('complementary', { name: '工作区保存状态' })
const textContents = (canvas: CanvasSnapshotV2) => canvas.nodes.flatMap((node) => node.type === 'text' ? [node.data.text] : [])

async function serverCanvas(request: APIRequestContext, canvasId: string): Promise<CanvasDocumentResponse> {
  const response = await request.get(`/api/canvases/${canvasId}`)
  expect(response.status()).toBe(200)
  return response.json()
}

async function createEmptyCanvas(page: Page) {
  await page.goto('/')
  await expect(page.getByTestId('workspace-home')).toBeVisible()
  await page.getByRole('button', { name: '新建画布', exact: true }).click()
  await page.getByRole('button', { name: '未命名画布，0 个节点', exact: true }).click()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  await expect(syncStatus(page)).toHaveAttribute('data-phase', 'synced')
  const canvasId = new URL(page.url()).searchParams.get('canvasId')
  expect(canvasId).toBeTruthy()
  return canvasId!
}

async function addText(page: Page, text: string) {
  await page.getByRole('button', { name: /文字/ }).click()
  await page.locator('.react-flow__pane').click({ position: { x: 420, y: 300 } })
  const editor = page.getByRole('textbox', { name: '文本节点内容' })
  await editor.fill(text)
  await editor.press('Escape')
  await expect(page.locator('.canvas-text-node__preview')).toHaveText(text)
}

async function editText(page: Page, text: string) {
  await page.locator('.canvas-text-node__preview').dblclick()
  const editor = page.getByRole('textbox', { name: '文本节点内容' })
  await editor.fill(text)
  await editor.press('Escape')
  await expect(page.locator('.canvas-text-node__preview')).toHaveText(text)
}

async function expectSavedText(page: Page, request: APIRequestContext, canvasId: string, text: string) {
  await expect.poll(async () => textContents((await serverCanvas(request, canvasId)).canvas)).toEqual([text])
  await expect(syncStatus(page)).toHaveAttribute('data-phase', 'synced')
}

test.describe('21 - Save recovery', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('failed loading cannot edit or save a canvas when returning home', async ({ page }) => {
    const canvasId = 'e2e-reference-canvas'
    const canvasWrites: unknown[] = []
    page.on('request', (request) => {
      if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/workspace/commit') return
      const body = request.postDataJSON() as WorkspaceMutation
      if (body.kind === 'save-canvas' && body.canvas.canvasId === canvasId ||
          body.kind === 'edit-workspace' && body.commit.putDocuments?.some((document) => document.canvasId === canvasId)) {
        canvasWrites.push(body)
      }
    })
    await page.route(`**/api/canvases/${canvasId}`, (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    )
    await page.goto('/')
    await page.getByRole('button', { name: '画布 1，37 个节点', exact: true }).click()
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-load-state', 'error')
    await expect(page.getByTestId('canvas-workspace')).toHaveCount(0)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.getByRole('button', { name: '返回工作区', exact: true }).click()
    await expect(page.getByTestId('workspace-home')).toBeVisible()
    await expect(page.getByRole('button', { name: '画布 1，37 个节点', exact: true })).toBeVisible()
    expect(canvasWrites).toEqual([])
  })

  test('retrying a failed load restores the existing canvas without replacing it', async ({ page }) => {
    const canvasId = 'e2e-reference-canvas'
    let failLoad = true
    await page.route(`**/api/canvases/${canvasId}`, async (route) => {
      if (failLoad) await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
      else await route.continue()
    })
    await page.goto('/')
    await page.getByRole('button', { name: '画布 1，37 个节点', exact: true }).click()
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-load-state', 'error')
    failLoad = false
    await page.getByRole('button', { name: '重新加载画布' }).click()
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
    await expect(page.locator('.react-flow__node')).toHaveCount(37)
    await page.reload()
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
    await expect(page.locator('.react-flow__node')).toHaveCount(37)
  })

  test('retains an offline edit across reload despite the older server document, then retries it', async ({ page, request }) => {
    const canvasId = await createEmptyCanvas(page)
    const before = await serverCanvas(request, canvasId)
    let offline = true
    await page.route('**/api/workspace/commit', async (route) => {
      if (offline) await route.abort('internetdisconnected')
      else await route.continue()
    })

    await addText(page, '离线刷新后仍保留的文本')
    await expect(syncStatus(page)).toHaveAttribute('data-phase', 'pending')
    expect((await serverCanvas(request, canvasId)).canvas.nodes).toEqual(before.canvas.nodes)
    await page.reload()
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
    await expect(page.locator('.canvas-text-node__preview')).toHaveText('离线刷新后仍保留的文本')
    await expect(syncStatus(page)).toHaveAttribute('data-phase', 'pending')
    expect((await serverCanvas(request, canvasId)).revision).toBe(before.revision)

    offline = false
    await syncStatus(page).getByRole('button', { name: '重试同步' }).click()
    await expectSavedText(page, request, canvasId, '离线刷新后仍保留的文本')
    await page.reload()
    await expect(page.locator('.canvas-text-node__preview')).toHaveText('离线刷新后仍保留的文本')
    await expect(syncStatus(page)).toHaveAttribute('data-phase', 'synced')
  })

  test('retries a lost successful response with the same operation ID and one revision increase', async ({ page, request }) => {
    const canvasId = await createEmptyCanvas(page)
    await addText(page, '响应丢失前的文本')
    await expectSavedText(page, request, canvasId, '响应丢失前的文本')
    const before = await serverCanvas(request, canvasId)
    const attempts: string[] = []
    let allowRetry = false
    let accepted: WorkspaceMutationReceipt | undefined
    await page.route('**/api/workspace/commit', async (route) => {
      const mutation = route.request().postDataJSON() as WorkspaceMutation
      if (mutation.kind !== 'save-canvas' || mutation.canvas.canvasId !== canvasId ||
          !textContents(mutation.canvas).includes('响应丢失后的文本')) {
        await route.continue()
        return
      }
      attempts.push(mutation.operationId)
      if (!accepted) {
        const response = await route.fetch()
        if (!response.ok()) { await route.fulfill({ response }); return }
        accepted = await response.json() as WorkspaceMutationReceipt
        await route.abort('connectionclosed')
      } else if (allowRetry) {
        await route.continue()
      } else {
        await route.abort('connectionclosed')
      }
    })

    await editText(page, '响应丢失后的文本')
    await expect(syncStatus(page)).toHaveAttribute('data-phase', 'pending')
    expect(accepted).toBeDefined()
    expect(accepted!.canvasRevisions[canvasId]).toBe(before.revision + 1)
    expect(textContents((await serverCanvas(request, canvasId)).canvas)).toEqual(['响应丢失后的文本'])
    await syncStatus(page).getByRole('button', { name: '重试同步' }).click()
    allowRetry = true
    await expect(syncStatus(page)).toHaveAttribute('data-phase', 'synced', { timeout: 10_000 })
    expect(attempts.length).toBeGreaterThanOrEqual(2)
    expect(new Set(attempts)).toEqual(new Set([accepted!.operationId]))
    expect((await serverCanvas(request, canvasId)).revision).toBe(before.revision + 1)
  })

  test('keeps a second context conflict local and preserves both versions when copying it', async ({ page, request, createTestContext }) => {
    const canvasId = await createEmptyCanvas(page)
    await addText(page, '两个窗口共同的初始文本')
    await expectSavedText(page, request, canvasId, '两个窗口共同的初始文本')
    const context = await createTestContext({ viewport: { width: 1440, height: 900 } })
    const peer = await context.newPage()
    await peer.goto(page.url())
    await expect(peer.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
    await expect(peer.locator('.canvas-text-node__preview')).toHaveText('两个窗口共同的初始文本')
    await expect(syncStatus(peer)).toHaveAttribute('data-phase', 'synced')

    await editText(page, '第一个窗口的已保存文本')
    await expectSavedText(page, request, canvasId, '第一个窗口的已保存文本')
    await editText(peer, '第二个窗口的本地冲突文本')
    await expect(syncStatus(peer)).toHaveAttribute('data-phase', 'conflict')
    await expect(peer.locator('.canvas-text-node__preview')).toHaveText('第二个窗口的本地冲突文本')
    expect(textContents((await serverCanvas(request, canvasId)).canvas)).toEqual(['第一个窗口的已保存文本'])
    await syncStatus(peer).getByRole('button', { name: '保留为副本' }).click()
    await expect(peer.locator('.canvas-text-node__preview')).toHaveText('第一个窗口的已保存文本')

    const manifestResponse = await request.get('/api/workspace/manifest')
    const { manifest } = await manifestResponse.json() as WorkspaceManifestResponse
    const copies = manifest.canvases.filter((canvas) => canvas.canvasId !== canvasId && canvas.canvasId !== 'e2e-reference-canvas')
    expect(copies.length).toBeGreaterThanOrEqual(1)
    expect(new Set(copies.map((copy) => copy.canvasId)).size).toBe(copies.length)
    const recovered = await Promise.all(copies.map(async (copy) => ({
      metadata: copy, document: (await serverCanvas(request, copy.canvasId)).canvas,
    })))
    const complete = recovered.find(({ document }) =>
      JSON.stringify(textContents(document)) === JSON.stringify(['第二个窗口的本地冲突文本']),
    )
    expect(complete).toBeDefined()
    const copy = complete!.metadata
    expect(textContents((await serverCanvas(request, canvasId)).canvas)).toEqual(['第一个窗口的已保存文本'])
    await peer.goto('/')
    await peer.locator(`[id="workspace-canvas-${copy.canvasId}"]`).getByRole('button', { name: `${copy.name}，1 个节点`, exact: true }).click()
    await expect(peer.locator('.canvas-text-node__preview')).toHaveText('第二个窗口的本地冲突文本')
  })

  test('persists deletion of the final node when reopening and refreshing the canvas', async ({ page, request }) => {
    const canvasId = await createEmptyCanvas(page)
    await addText(page, '即将删除的最后一个节点')
    await expectSavedText(page, request, canvasId, '即将删除的最后一个节点')
    const node = page.locator('.react-flow__node-text')
    await node.click()
    await expect(node).toHaveClass(/\bselected\b/)
    await page.keyboard.press('Delete')
    await expect(page.locator('.react-flow__node')).toHaveCount(0)
    await expect.poll(async () => (await serverCanvas(request, canvasId)).canvas.nodes.length).toBe(0)
    await expect(syncStatus(page)).toHaveAttribute('data-phase', 'synced')

    await page.getByRole('button', { name: /打开工作区菜单/ }).click()
    await page.getByRole('menuitem', { name: '返回工作区', exact: true }).click()
    await page.getByRole('button', { name: '未命名画布，0 个节点', exact: true }).click()
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
    await expect(page.locator('.react-flow__node')).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
    await expect(page.locator('.react-flow__node')).toHaveCount(0)
    expect((await serverCanvas(request, canvasId)).canvas.nodes).toEqual([])
  })

  test('checkpoints collaboration before closing and saves subsequent local edits with the refreshed revision', async ({ page, request }) => {
    const canvasId = await createEmptyCanvas(page)
    await addText(page, '开启协作前')
    await expectSavedText(page, request, canvasId, '开启协作前')
    await page.getByRole('button', { name: '多人协作', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '多人协作' })
    await dialog.getByRole('textbox', { name: '协作昵称' }).fill('交接验证')
    await dialog.getByRole('button', { name: '开启协作', exact: true }).click()
    await expect(page.getByTestId('top-bar')).toHaveAttribute('data-collaboration-status', 'synced')
    await dialog.getByRole('button', { name: '关闭多人协作' }).click()
    const before = await serverCanvas(request, canvasId)
    const ordinaryWrites: WorkspaceMutation[] = []
    page.on('request', (request) => {
      if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/workspace/commit') return
      const mutation = request.postDataJSON() as WorkspaceMutation
      if (mutation.kind === 'save-canvas' && mutation.canvas.canvasId === canvasId) ordinaryWrites.push(mutation)
    })
    await editText(page, '关闭前最后的协作修改')
    await page.getByRole('button', { name: '多人协作', exact: true }).click()
    await dialog.getByRole('button', { name: '关闭协作', exact: true }).click()
    await expect(page.getByTestId('top-bar')).toHaveAttribute('data-collaboration-status', 'inactive')
    expect(ordinaryWrites).toEqual([])
    const checkpoint = await serverCanvas(request, canvasId)
    expect(textContents(checkpoint.canvas)).toEqual(['关闭前最后的协作修改'])
    expect(checkpoint.revision).toBeGreaterThan(before.revision)
    await dialog.getByRole('button', { name: '关闭多人协作' }).click()

    await editText(page, '关闭后继续本地编辑')
    await expectSavedText(page, request, canvasId, '关闭后继续本地编辑')
    expect((await serverCanvas(request, canvasId)).revision).toBeGreaterThan(checkpoint.revision)
    expect(ordinaryWrites.length).toBeGreaterThan(0)
    await page.reload()
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
    await expect(page.locator('.canvas-text-node__preview')).toHaveText('关闭后继续本地编辑')
    await expect(page.getByTestId('top-bar')).toHaveAttribute('data-collaboration-status', 'inactive')
    await expect(syncStatus(page)).toHaveAttribute('data-phase', 'synced')
  })
})
