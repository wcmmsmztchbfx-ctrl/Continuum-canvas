import type { Locator, Page } from "@playwright/test"
import { expect, test } from "../../fixtures/e2e-env"

const anchorSelector = '.react-flow__node[data-id="i-TFj65r3PHQ"]'

async function nextPaint(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function box(locator: Locator) {
  const value = await locator.boundingBox()
  expect(value).not.toBeNull()
  return value!
}

async function openCanvas(page: Page) {
  await page.goto("/canvas?spaceId=local&projectId=reference")
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")
  await expect(page.locator(anchorSelector)).toBeAttached()
  await nextPaint(page)
}

async function assertAnchor(page: Page, origin: { x: number; y: number }) {
  await nextPaint(page)
  const current = await box(page.locator(anchorSelector))
  expect(Math.abs(current.x - origin.x), "node screen X drift").toBeLessThanOrEqual(1)
  expect(Math.abs(current.y - origin.y), "node screen Y drift").toBeLessThanOrEqual(1)
}

async function openSidebars(page: Page) {
  await page.getByRole("button", { name: "展开侧边栏", exact: true }).click()
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-layers-open")
  await expect(page.getByTestId("inspector-panel")).toBeVisible()
  await page.locator(".app-layer-sidebar").evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
  })
  await nextPaint(page)
}

async function closeSidebars(page: Page) {
  await page.getByRole("button", { name: "收起图层", exact: true }).click()
  await expect(page.getByTestId("app-shell")).not.toHaveAttribute("data-layers-open")
  await page.locator(".app-layer-sidebar").evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
  })
  await nextPaint(page)
}

test.describe("19 - Flex stage layout and screen anchors", () => {
  test("sidebar transitions keep the rendered node steady on every frame", async ({ page }) => {
    await openCanvas(page)
    const origin = await box(page.locator(anchorSelector))
    for (const label of ['展开侧边栏', '收起图层']) {
      await page.evaluate((selector) => {
        const samples: Array<{ x: number; y: number }> = []
        const sample = () => {
          const rect = document.querySelector(selector)!.getBoundingClientRect()
          samples.push({ x: rect.x, y: rect.y })
          if (samples.length < 40) requestAnimationFrame(sample)
        }
        ;(window as unknown as { sidebarFrames: typeof samples }).sidebarFrames = samples
        requestAnimationFrame(sample)
      }, anchorSelector)
      await page.getByRole('button', { name: label, exact: true }).click()
      await expect.poll(() => page.evaluate(() => (window as unknown as { sidebarFrames: unknown[] }).sidebarFrames.length)).toBe(40)
      const samples = await page.evaluate(() => (window as unknown as { sidebarFrames: Array<{ x: number; y: number }> }).sidebarFrames)
      expect(Math.max(...samples.map(point => Math.abs(point.x - origin.x))), `${label}: maximum frame X drift`).toBeLessThanOrEqual(1)
      expect(Math.max(...samples.map(point => Math.abs(point.y - origin.y))), `${label}: maximum frame Y drift`).toBeLessThanOrEqual(1)
    }
  })

  for (const width of [900, 780, 390]) {
  test(`${width}px bottom controls remain inside the visible stage and clickable with both sidebars open`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await openCanvas(page)
    await openSidebars(page)
    const stage = await box(page.locator('.canvas-stage'))
    const controls = page.getByTestId('bottom-status-bar')
    const bounds = await box(controls)
    expect(bounds.x).toBeGreaterThanOrEqual(stage.x)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(stage.x + stage.width)
    for (const label of ['历史记录', '整理画布，Alt+Shift+F', '切换小地图', '隐藏节点连线', '智能吸附', '缩放选项']) {
      await controls.getByRole('button', { name: label, exact: true }).click({ trial: true })
    }
    await controls.getByRole('button', { name: '缩放选项', exact: true }).click()
    await page.getByRole('menuitem', { name: '缩放至100%', exact: true }).click()
    await expect(controls.getByRole('button', { name: '缩放选项' })).toContainText('100%')
    await page.screenshot({ path: test.info().outputPath('controls-open.png') })
  })
  }

  test("a saved workspace hides its status with either sidebar layout", async ({ page }) => {
    await openCanvas(page)
    const status = page.getByTestId('workspace-sync-status')
    await expect(status).toHaveAttribute('data-phase', 'synced')
    await expect(status).toBeHidden()
    await openSidebars(page)
    await expect(status).toBeHidden()
    await expect(page.getByTestId('workspace-control-sidebar')).toBeVisible()
  })

  for (const width of [1440, 900]) {
    test(`${width}px desktop toggles and continuously resizes both sidebars without moving existing nodes`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await openCanvas(page)
      const stage = page.locator(".canvas-stage")
      expect((await box(stage)).width).toBe(width)
      const origin = await box(page.locator(anchorSelector))
      await openSidebars(page)
      const left = await box(page.locator(".app-layer-sidebar"))
      const right = await box(page.getByTestId("inspector-panel"))
      const openedStage = await box(stage)
      expect(openedStage.x).toBeCloseTo(left.width, 1)
      expect(openedStage.width).toBeCloseTo(width - left.width - right.width, 1)
      expect(openedStage.width).toBeGreaterThanOrEqual(220)
      await assertAnchor(page, origin)

      for (const [label, selector, resizingAttribute, moves] of [
        ["调整图层侧栏宽度", ".app-layer-sidebar__content", "data-layers-resizing", [15, 30, 50, 25, -10]],
        ["调整属性面板宽度", ".inspector-panel", "data-inspector-resizing", [-10, -25, -40, -15, 10]],
      ] as const) {
        const initialWidth = (await box(page.locator(selector))).width
        const handle = await box(page.getByRole("separator", { name: label }))
        const startX = handle.x + handle.width / 2
        const startY = handle.y + 250
        await page.mouse.move(startX, startY)
        await page.mouse.down()
        await expect(page.getByTestId("app-shell")).toHaveAttribute(resizingAttribute)
        for (const delta of moves) {
          await page.mouse.move(startX + delta, startY)
          await assertAnchor(page, origin)
          expect((await box(stage)).width).toBeGreaterThanOrEqual(220)
        }
        await page.mouse.up()
        await assertAnchor(page, origin)
        expect(initialWidth - (await box(page.locator(selector))).width).toBeCloseTo(10, 0)
      }

      await closeSidebars(page)
      expect((await box(stage)).width).toBe(width)
      await expect(page.getByTestId("inspector-panel")).not.toBeVisible()
      await assertAnchor(page, origin)
    })
  }

  test("mobile overlays and crossing the desktop breakpoint preserve the same screen anchor", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 820 })
    await openCanvas(page)
    const stage = page.locator(".canvas-stage")
    const origin = await box(page.locator(anchorSelector))
    await openSidebars(page)
    expect((await box(stage)).x).toBe(0)
    expect((await box(stage)).width).toBe(640)
    await assertAnchor(page, origin)
    await expect(page.getByRole("separator", { name: "调整图层侧栏宽度" })).not.toBeVisible()
    await expect(page.getByRole("separator", { name: "调整属性面板宽度" })).not.toBeVisible()
    await closeSidebars(page)
    await assertAnchor(page, origin)
    await openSidebars(page)
    await page.setViewportSize({ width: 900, height: 820 })
    await assertAnchor(page, origin)
    expect((await box(stage)).x).toBeGreaterThan(0)
    await page.setViewportSize({ width: 640, height: 820 })
    await assertAnchor(page, origin)
    expect((await box(stage)).width).toBe(640)
  })

  test("oversized saved sidebar preferences are constrained and resizing persists the rendered width", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 })
    await page.addInitScript(() => {
      const key = 'libtv.ui-preferences.v1'
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ layersOpen: true, layersWidth: 3000, inspectorWidth: 560 }))
    })
    await openCanvas(page)
    expect((await box(page.locator('.canvas-stage'))).width).toBeGreaterThanOrEqual(220)
    const origin = await box(page.locator(anchorSelector))
    const before = await box(page.getByTestId("layers-sidebar"))
    const handle = await box(page.getByRole("separator", { name: "调整图层侧栏宽度" }))
    await page.mouse.move(handle.x + handle.width / 2, 250)
    await page.mouse.down()
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-layers-resizing")
    await page.mouse.move(handle.x + handle.width / 2 - 50, 250)
    await assertAnchor(page, origin)
    await page.mouse.up()
    await assertAnchor(page, origin)
    const after = await box(page.getByTestId("layers-sidebar"))
    expect(before.width - after.width).toBeCloseTo(50, 0)
    await page.reload()
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")
    expect((await box(page.getByTestId("layers-sidebar"))).width).toBeCloseTo(after.width, 1)
  })

  test("adding a text node uses the visible stage center with both sidebars open", async ({ page }) => {
    await openCanvas(page)
    await openSidebars(page)
    const stage = await box(page.locator(".canvas-stage"))
    await page.getByRole("button", { name: "上传媒体 U", exact: true }).click()
    await page.getByRole("menuitem", { name: "文本", exact: true }).click()
    const created = page.locator(".react-flow__node-text.selected")
    await expect(created).toHaveCount(1)
    await nextPaint(page)
    const node = await box(created)
    expect(Math.abs(node.x + node.width / 2 - stage.x - stage.width / 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(node.y + node.height / 2 - stage.y - stage.height / 2)).toBeLessThanOrEqual(1)
  })

  test("renaming from the inspector persists across refresh with the sidebars open", async ({ page, request }) => {
    await openCanvas(page)
    await openSidebars(page)
    const nameInput = page.getByTestId("inspector-panel").locator(".inspector-field__input").first()
    await expect(nameInput).toBeVisible()
    await nameInput.fill("侧栏布局重命名测试")
    await nameInput.press("Enter")
    await expect.poll(async () => {
      const response = await request.get('/api/canvases/e2e-reference-canvas')
      const data = await response.json()
      return data.canvas?.name
    }).toBe("侧栏布局重命名测试")
    await page.reload()
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")
    await expect(nameInput).toHaveValue("侧栏布局重命名测试")
  })
})


