import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

const viewports = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]

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
  version: 'phase4-visual-v1',
  fetchedAt: provider.lastSyncedAt,
  stale: false,
  models: [{
    mediaType: 'image',
    channel: 46,
    channelTitle: '图片生成',
    model: 'gpt-image-2',
    title: 'GPT Image 2 Low',
    qualityOptions: [{
      value: '1K',
      label: '1K',
      pricing: { type: 'fixed_total', credits: 5 },
    }],
    aspectRatios: ['16:9', '1:1'],
    countOptions: [1],
    durationOptions: [],
    modes: ['text2image', 'image2image'],
    inputLimits: { images: 3, videos: 0, audios: 0 },
    raw: {},
  }],
}

async function mockGateway(page: Page) {
  await page.route('**/api/providers', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ providers: [provider] }),
  }))
  await page.route('**/api/catalog?providerId=*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ catalog }),
  }))
}

async function expectInsideSafeViewport(
  locator: Locator,
  viewport: { width: number; height: number },
) {
  await expect.poll(async () => {
    const box = await locator.boundingBox()
    return Boolean(
      box &&
      box.x >= 7 &&
      box.y >= 69 &&
      box.x + box.width <= viewport.width - 7 &&
      box.y + box.height <= viewport.height - 75,
    )
  }).toBe(true)
}

async function captureState(
  page: Page,
  viewport: { width: number; height: number },
  state: string,
) {
  const bytes = await page.screenshot({ animations: 'disabled' })
  const image = PNG.sync.read(bytes)
  expect({ width: image.width, height: image.height }).toEqual(viewport)
  let visibleSamples = 0
  for (let offset = 0; offset < image.data.length; offset += 40) {
    const delta = Math.max(
      Math.abs(image.data[offset] - 20),
      Math.abs(image.data[offset + 1] - 20),
      Math.abs(image.data[offset + 2] - 20),
    )
    if (delta > 8) visibleSamples += 1
  }
  expect(visibleSamples).toBeGreaterThan(500)
  const output = path.resolve(
    `tests/visual/current/phase4-${viewport.width}x${viewport.height}-${state}.png`,
  )
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, bytes)
}

async function waitForVisualIdle(locator: Locator) {
  await locator.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    )
  })
}

async function dragSelectNearbyNodes(page: Page) {
  const pane = page.locator('.react-flow__pane')
  const paneBox = await pane.boundingBox()
  expect(paneBox).not.toBeNull()
  const candidates = await page.locator('.react-flow__node:visible').evaluateAll(
    (elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
      }
    }),
  )
  let best:
    | { bottom: number; left: number; right: number; top: number; score: number }
    | undefined
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const leftNode = candidates[leftIndex]!
      const rightNode = candidates[rightIndex]!
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
      const score = (bounds.right - bounds.left) * (bounds.bottom - bounds.top)
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

for (const viewport of viewports) {
  test(`keeps Phase 4 overlays and selection geometry safe at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.setViewportSize(viewport)
    await mockGateway(page)
    await page.goto('/canvas?spaceId=local&projectId=reference')
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')

    await page.getByRole('button', { name: '上传媒体 U' }).click()
    await page
      .getByRole('menu', { name: '添加节点' })
      .getByRole('menuitem', { name: '图片', exact: true })
      .click()
    const editor = page.locator('[data-node-editor="image"]')
    const generator = editor.locator('.canvas-node-generator')
    await expect(generator).toBeVisible()
    await expectInsideSafeViewport(generator, viewport)
    await captureState(page, viewport, 'generator')

    const prompt = editor.getByRole('combobox', { name: '图片生成描述' })
    await expect(prompt).toBeVisible()
    await prompt.fill('镜头穿过院门，@')
    const mentions = page.getByRole('listbox', { name: '选择参考素材' })
    await expect(mentions).toBeVisible()
    await expectInsideSafeViewport(mentions, viewport)
    await captureState(page, viewport, 'mention')

    await prompt.press('Escape')
    await editor.getByRole('button', { name: /生成详情：/ }).click()
    const settings = page.getByRole('dialog', { name: '图片生成设置' })
    await expect(settings).toBeVisible()
    await expectInsideSafeViewport(settings, viewport)
    await captureState(page, viewport, 'settings')
    await editor.getByRole('button', { name: /生成详情：/ }).click()

    await dragSelectNearbyNodes(page)
    const workspace = page.getByTestId('canvas-workspace')
    await expect(workspace).toHaveAttribute('data-multiselect', 'true')
    const nativeBoundary = page.locator('.react-flow__nodesselection-rect')
    const toolbar = page.getByTestId('selection-toolbar-anchor')
    await expect(page.getByTestId('selection-union-boundary')).toHaveCount(0)
    await expect(nativeBoundary).toBeVisible()
    await expectInsideSafeViewport(nativeBoundary, viewport)
    await expectInsideSafeViewport(toolbar, viewport)
    const selectedFrameBorder = await page
      .locator('.react-flow__node.selected .canvas-media-node__frame')
      .first()
      .evaluate((element) => getComputedStyle(element).borderColor)
    expect(selectedFrameBorder).toBe('rgba(0, 0, 0, 0)')
    await captureState(page, viewport, 'multiselect')

    await page.getByRole('button', { name: '打开 API 接入' }).click()
    await page.getByRole('dialog', { name: 'API 接入' }).getByRole('button', {
      name: '管理接入',
    }).click()
    const drawer = page.getByRole('dialog', { name: '管理 API 接入' })
    await expect(drawer).toBeVisible()
    await waitForVisualIdle(drawer)
    const drawerBox = await drawer.boundingBox()
    expect(drawerBox).not.toBeNull()
    expect(drawerBox!.x).toBeGreaterThanOrEqual(7)
    expect(drawerBox!.y).toBeGreaterThanOrEqual(7)
    expect(drawerBox!.x + drawerBox!.width).toBeLessThanOrEqual(viewport.width - 7)
    expect(drawerBox!.y + drawerBox!.height).toBeLessThanOrEqual(viewport.height - 7)
    await captureState(page, viewport, 'api-drawer')
    expect(pageErrors).toEqual([])
  })
}
