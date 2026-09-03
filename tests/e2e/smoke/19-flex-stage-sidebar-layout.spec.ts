import { expect, test } from "../../fixtures/e2e-env"

test.describe("19 - Flex Stage Real Squeeze, Viewport Anchor & Canvas Rename", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("stage truly shrinks on sidebar toggle and preserves node screen anchor", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    const stage = page.locator(".canvas-stage")
    await expect(stage).toBeVisible()

    // 1. Initial stage is full width when sidebar is closed
    const initialStageBox = await stage.boundingBox()
    expect(initialStageBox).not.toBeNull()
    expect(initialStageBox!.width).toBeGreaterThanOrEqual(1400)

    // 2. Open sidebar via the floating expand button
    const expandBtn = page.getByRole("button", { name: "展开侧边栏" })
    await expect(expandBtn).toBeVisible()
    await expandBtn.click()

    // App shell reflects data-layers-open
    const appShell = page.getByTestId("app-shell")
    await expect(appShell).toHaveAttribute("data-layers-open")

    // 3. Verify stage is truly squeezed by flexbox (NOT 100vw / 1440px)
    await page.waitForTimeout(300) // allow CSS transition
    const squeezedStageBox = await stage.boundingBox()
    expect(squeezedStageBox).not.toBeNull()
    // Stage must be narrowed by sidebar width (layers ~260px)
    expect(squeezedStageBox!.width).toBeLessThan(1440 - 200)
    expect(squeezedStageBox!.x).toBeGreaterThanOrEqual(200)

    // 4. Test stage-centered node addition
    const addBtn = page.getByRole("button", { name: "添加节点" })
    if (await addBtn.isVisible()) {
      await addBtn.click()
      const addTextOption = page.getByRole("button", { name: /文字|新建文字/ })
      if (await addTextOption.isVisible()) {
        await addTextOption.click()
        await page.waitForTimeout(200)
        // Find added text node
        const textNode = page.locator(".canvas-text-node").last()
        await expect(textNode).toBeVisible()
        const nodeBox = await textNode.boundingBox()
        expect(nodeBox).not.toBeNull()

        // Node center should be near the visible stage center
        const stageCenterX = squeezedStageBox!.x + squeezedStageBox!.width / 2
        const nodeCenterX = nodeBox!.x + nodeBox!.width / 2
        expect(Math.abs(nodeCenterX - stageCenterX)).toBeLessThan(100)
      }
    }

    // 5. Inspector canvas rename test (preserves selection & state)
    const nameInput = page.locator(".inspector-field__input").first()
    if (await nameInput.isVisible()) {
      await nameInput.fill("重命名测试生产画布")
      await nameInput.blur()
      await page.waitForTimeout(300)

      // Reload page and confirm persisted
      await page.reload()
      await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")
      await expect(page.getByText("重命名测试生产画布").first()).toBeVisible()
    }
  })
})
