import { expect, test } from "../../fixtures/e2e-env"

test.describe("18 - Responsive Viewport Safe Bounds (1366x768)", () => {
  test.use({ viewport: { width: 1366, height: 768 } })

  test("panels and toolbars do not overlap or exceed safe boundaries on compact screens", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    // 1. Tool dock must be within 768px viewport height
    const toolbar = page.getByTestId("tool-dock")
    await expect(toolbar).toBeVisible()
    const toolbarBox = await toolbar.boundingBox()
    expect(toolbarBox).not.toBeNull()
    expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(768)
    expect(toolbarBox!.x).toBeGreaterThanOrEqual(0)
    expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(1366)

    // 2. Left sidebar / workspace button must be within bounds
    const logoBtn = page.getByRole("button", { name: "打开工作区菜单" })
    await expect(logoBtn).toBeVisible()
    const logoBox = await logoBtn.boundingBox()
    expect(logoBox).not.toBeNull()
    expect(logoBox!.x).toBeGreaterThanOrEqual(0)
    expect(logoBox!.y + logoBox!.height).toBeLessThanOrEqual(768)

    // 3. Status bar must be within bounds
    const statusBar = page.getByTestId("bottom-status-bar")
    await expect(statusBar).toBeVisible()
    const statusBox = await statusBar.boundingBox()
    expect(statusBox).not.toBeNull()
    expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(768)
    expect(Math.min(toolbarBox!.x + toolbarBox!.width, statusBox!.x + statusBox!.width) - Math.max(toolbarBox!.x, statusBox!.x)).toBeLessThanOrEqual(0)
  })
})
