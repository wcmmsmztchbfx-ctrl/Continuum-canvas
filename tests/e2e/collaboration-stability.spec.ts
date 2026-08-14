import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const baseURL = 'http://127.0.0.1:4273'
const stepTimeout = 10_000
const nodeIds = Array.from({ length: 50 }, (_, index) => `stability-node-${index}`)
const edgeIds = Array.from({ length: 40 }, (_, index) => `stability-edge-${index}`)
// Keep probes inside the initial viewport. React Flow legitimately virtualizes
// far off-screen edges, which is not a visible flicker or identity regression.
const stableNodeIds = nodeIds.slice(20, 25)
const stableEdgeIds = edgeIds.slice(20, 25)

type BrowserIssue = { page: string; type: 'pageerror' | 'react-flow'; message: string }

async function isolatedContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL,
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1440, height: 900 },
  })
}

function listenForBrowserIssues(page: Page, label: string, issues: BrowserIssue[]) {
  page.on('pageerror', (error) => {
    issues.push({ page: label, type: 'pageerror', message: error.stack ?? error.message })
  })
  page.on('console', (message) => {
    if (
      (message.type() === 'warning' || message.type() === 'error') &&
      /react[ -]?flow|xyflow/i.test(message.text())
    ) {
      issues.push({ page: label, type: 'react-flow', message: message.text() })
    }
  })
}

async function createSeededCanvas(page: Page, name: string) {
  await page.goto('/')
  await page.locator('.workspace-home__topbar').getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('textbox', { name: '名称' }).fill(name)
  await page.getByRole('textbox', { name: '名称' }).press('Enter')
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true', {
    timeout: stepTimeout,
  })

  const canvasId = new URL(page.url()).searchParams.get('canvasId')
  expect(canvasId).toBeTruthy()
  await expect.poll(() => page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('libtv-canvas')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('canvas-documents', 'readonly')
    const record = await new Promise<unknown>((resolve, reject) => {
      const request = transaction.objectStore('canvas-documents').get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return Boolean(record)
  }, canvasId!)).toBe(true)

  await page.evaluate(async ({ canvasId, edgeIds, nodeIds }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('libtv-canvas')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('canvas-documents', 'readwrite')
    const store = transaction.objectStore('canvas-documents')
    const record = await new Promise<{ canvasId: string; serialized: string }>((resolve, reject) => {
      const request = store.get(canvasId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const snapshot = JSON.parse(record.serialized) as Record<string, unknown>
    snapshot.viewport = { x: 120, y: 150, zoom: 0.7 }
    snapshot.nodes = nodeIds.map((id, index) => ({
      id,
      type: 'text',
      name: `稳定性节点 ${index}`,
      position: { x: (index % 5) * 260, y: Math.floor(index / 5) * 160 },
      size: { width: 180, height: 100 },
      data: { text: `稳定性节点 ${index}`, fontSize: 18 },
    }))
    snapshot.edges = edgeIds.map((id, index) => ({
      id,
      source: nodeIds[index],
      target: nodeIds[index + 1],
      sourceHandle: 'source',
      targetHandle: 'target',
      type: 'canvas',
      relation: 'flow',
    }))
    snapshot.comments = []
    record.serialized = JSON.stringify(snapshot)
    store.put(record)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
  }, { canvasId: canvasId!, edgeIds, nodeIds })

  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true', {
    timeout: stepTimeout,
  })
  await expect(page.locator('.react-flow__node')).toHaveCount(50)
  await expect(page.locator('.react-flow__edge')).toHaveCount(40)
}

async function enableCollaboration(page: Page, displayName: string) {
  await page.getByRole('button', { name: '打开多人协作' }).click()
  const dialog = page.getByRole('dialog', { name: '多人协作' })
  await dialog.getByRole('textbox', { name: '协作昵称' }).fill(displayName)
  await dialog.getByRole('button', { name: '开启协作' }).click()
  await expect(page.getByTestId('top-bar')).toHaveAttribute('data-collaboration-status', 'synced', {
    timeout: stepTimeout,
  })
}

async function createEditorInvite(page: Page) {
  const dialog = page.getByRole('dialog', { name: '多人协作' })
  await dialog.getByRole('button', { name: '创建编辑链接' }).click()
  const copy = dialog.getByRole('button', { name: '复制可编辑链接' }).last()
  await expect(copy).toBeEnabled({ timeout: stepTimeout })
  await copy.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('collabRoom=')
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
  await expect(page.locator('.react-flow__node')).toHaveCount(50, { timeout: stepTimeout })
  await expect(page.locator('.react-flow__edge')).toHaveCount(40, { timeout: stepTimeout })
}

async function installStabilityProbe(page: Page, probeNodeIds: string[], probeEdgeIds: string[]) {
  await page.evaluate(({ probeEdgeIds, probeNodeIds }) => {
    const edgeLayer = document.querySelector('.react-flow__edges')
    const viewport = document.querySelector('.react-flow__viewport')
    const selectors = [
      ...probeNodeIds.map((id) => `.react-flow__node[data-id="${id}"]`),
      ...probeEdgeIds.map((id) => `[data-testid="rf__edge-${id}"]`),
    ]
    const refs = selectors.map((selector) => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`Missing stability probe element: ${selector}`)
      return { selector, element }
    })
    const result = {
      detached: [] as string[],
      hidden: [] as string[],
      refs,
      edgeLayer,
      viewport,
      minEdgeCount: document.querySelectorAll('.react-flow__edge').length,
      edgeCounts: [] as number[],
      running: true,
    }
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const removed of record.removedNodes) {
          if (!(removed instanceof Element)) continue
          for (const ref of refs) {
            if (removed === ref.element || removed.contains(ref.element)) result.detached.push(ref.selector)
          }
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    const sample = () => {
      const edgeCount = document.querySelectorAll('.react-flow__edge').length
      result.minEdgeCount = Math.min(result.minEdgeCount, edgeCount)
      if (result.edgeCounts.at(-1) !== edgeCount) result.edgeCounts.push(edgeCount)
      for (const ref of refs) {
        const style = getComputedStyle(ref.element)
        if (
          !ref.element.isConnected || style.display === 'none' || style.visibility === 'hidden' ||
          Number(style.opacity) === 0
        ) result.hidden.push(ref.selector)
      }
      if (result.running) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    ;(window as typeof window & { __collaborationStabilityProbe?: unknown }).__collaborationStabilityProbe = {
      result,
      stop() {
        result.running = false
        observer.disconnect()
      },
    }
  }, { probeEdgeIds, probeNodeIds })
}

async function readStabilityProbe(page: Page, stop = true) {
  return page.evaluate(() => {
    const probe = (window as typeof window & {
      __collaborationStabilityProbe?: {
        result: {
          detached: string[]
          hidden: string[]
          refs: Array<{ selector: string; element: Element }>
          edgeLayer: Element | null
          viewport: Element | null
          minEdgeCount: number
          edgeCounts: number[]
        }
        stop(): void
      }
    }).__collaborationStabilityProbe
    if (!probe) throw new Error('Stability probe was not installed')
    if (stop) probe.stop()
    return {
      detached: [...new Set(probe.result.detached)],
      hidden: [...new Set(probe.result.hidden)],
      replaced: probe.result.refs
        .filter((ref) => document.querySelector(ref.selector) !== ref.element)
        .map((ref) => ref.selector),
      disconnected: probe.result.refs
        .filter((ref) => !ref.element.isConnected)
        .map((ref) => ref.selector),
      edgeLayerReplaced: document.querySelector('.react-flow__edges') !== probe.result.edgeLayer,
      viewportReplaced: document.querySelector('.react-flow__viewport') !== probe.result.viewport,
      minEdgeCount: probe.result.minEdgeCount,
      edgeCounts: probe.result.edgeCounts,
    }
  })
}

async function expectStableProbe(page: Page, phase: string) {
  const result = await readStabilityProbe(page, false)
  expect(result.edgeLayerReplaced, phase).toBe(false)
  expect(result.viewportReplaced, phase).toBe(false)
  expect(result.minEdgeCount, phase).toBe(40)
  expect(result.edgeCounts, phase).toEqual([40])
  const isNode = (selector: string) => selector.startsWith('.react-flow__node')
  expect(result.detached.filter(isNode), phase).toEqual([])
  expect(result.hidden.filter(isNode), phase).toEqual([])
  expect(result.replaced.filter(isNode), phase).toEqual([])
  expect(result.disconnected.filter(isNode), phase).toEqual([])
}

async function emitPresenceBurst(page: Page) {
  const pane = page.locator('.react-flow__pane')
  const bounds = await pane.boundingBox()
  expect(bounds).not.toBeNull()
  for (let index = 0; index < 80; index += 1) {
    await page.mouse.move(
      bounds!.x + 180 + (index % 20) * 18,
      bounds!.y + 180 + (index % 8) * 16,
      { steps: 1 },
    )
  }
  for (let index = 0; index < 20; index += 1) {
    await page.locator(`.react-flow__node[data-id="${nodeIds[index % 5]}"]`).click({ force: true })
  }
}

async function dragNode(page: Page, nodeId: string, delta: { x: number; y: number }) {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  const bounds = await node.boundingBox()
  expect(bounds).not.toBeNull()
  const start = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: 12 })
  await page.mouse.up()
}

async function nodeTransform(page: Page, nodeId: string) {
  return page.locator(`.react-flow__node[data-id="${nodeId}"]`).evaluate((element) => {
    const match = (element as HTMLElement).style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null
  })
}

async function renderedGraph(page: Page) {
  return page.evaluate(() => ({
    nodes: [...document.querySelectorAll('.react-flow__node')]
      .map((element) => element.getAttribute('data-id')).filter(Boolean).sort(),
    edges: [...document.querySelectorAll('.react-flow__edge')]
      .map((element) => element.getAttribute('data-id')).filter(Boolean).sort(),
  }))
}

test('keeps a dense collaborative canvas stable through presence, move, and editor delete', async ({ browser }) => {
  test.setTimeout(120_000)
  const ownerContext = await isolatedContext(browser)
  const editorContext = await isolatedContext(browser)
  const owner = await ownerContext.newPage()
  const editor = await editorContext.newPage()
  const browserIssues: BrowserIssue[] = []
  listenForBrowserIssues(owner, 'owner', browserIssues)
  listenForBrowserIssues(editor, 'editor', browserIssues)

  try {
    await createSeededCanvas(owner, `协作稳定性-${Date.now()}`)
    await installStabilityProbe(owner, stableNodeIds, stableEdgeIds)
    await enableCollaboration(owner, '稳定性所有者')
    await expectStableProbe(owner, 'owner edges after enabling collaboration')
    const invite = await createEditorInvite(owner)
    await owner.getByRole('button', { name: '关闭多人协作' }).click()
    await joinInvite(editor, invite, '稳定性编辑者')
    await expectStableProbe(owner, 'owner edges after editor joins')
    await installStabilityProbe(editor, stableNodeIds, stableEdgeIds)
    await expectStableProbe(editor, 'editor edges after join')

    await emitPresenceBurst(editor)
    await expectStableProbe(editor, 'editor edges after presence burst')
    const editorPane = editor.locator('.react-flow__pane')
    const editorPaneBounds = await editorPane.boundingBox()
    expect(editorPaneBounds).not.toBeNull()
    await editor.mouse.move(editorPaneBounds!.x + 520, editorPaneBounds!.y + 340)
    await expect(owner.locator('[data-remote-cursor]')).toBeVisible({ timeout: stepTimeout })

    const movedNodeId = nodeIds[7]
    const ownerTransformBefore = await nodeTransform(owner, movedNodeId)
    await editor.locator(`.react-flow__node[data-id="${movedNodeId}"]`).click({ force: true })
    await expectStableProbe(editor, 'editor edges after selecting moved node')
    await dragNode(editor, movedNodeId, { x: 90, y: 55 })
    await expect.poll(() => nodeTransform(owner, movedNodeId), { timeout: stepTimeout })
      .not.toBe(ownerTransformBefore)
    await expect.poll(async () => ({
      editor: await nodeTransform(editor, movedNodeId),
      owner: await nodeTransform(owner, movedNodeId),
    }), { timeout: stepTimeout }).toEqual({
      editor: await nodeTransform(editor, movedNodeId),
      owner: await nodeTransform(editor, movedNodeId),
    })
    await expectStableProbe(editor, 'editor edges after moving one node')
    await expectStableProbe(owner, 'owner edges after remote move')
    await readStabilityProbe(owner)
    await readStabilityProbe(editor)

    const deletedNodeId = nodeIds[12]
    await editor.locator(`.react-flow__node[data-id="${deletedNodeId}"]`).click()
    await editor.keyboard.press('Delete')
    await expect(editor.locator(`.react-flow__node[data-id="${deletedNodeId}"]`)).toHaveCount(0, {
      timeout: stepTimeout,
    })
    await expect(owner.locator(`.react-flow__node[data-id="${deletedNodeId}"]`)).toHaveCount(0, {
      timeout: stepTimeout,
    })
    await expect(owner.locator('.react-flow__node')).toHaveCount(49)
    await expect(editor.locator('.react-flow__node')).toHaveCount(49)
    await expect(owner.locator('.react-flow__edge')).toHaveCount(38)
    await expect(editor.locator('.react-flow__edge')).toHaveCount(38)

    await expect.poll(async () => ({
      editor: await renderedGraph(editor),
      owner: await renderedGraph(owner),
    }), { timeout: stepTimeout }).toEqual({
      editor: await renderedGraph(editor),
      owner: await renderedGraph(editor),
    })

    expect(browserIssues).toEqual([])
  } finally {
    await Promise.allSettled([ownerContext.close(), editorContext.close()])
  }
})
