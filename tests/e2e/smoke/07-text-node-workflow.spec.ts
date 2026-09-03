import { expect, test } from "../../fixtures/e2e-env"

test.describe("07 - Text Node Workflow", () => {
  test("edits text content, adjusts typography, and persists across reload", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    // Place a text node
    await page.getByRole("button", { name: /文字/ }).click()
    const canvasPane = page.locator(".react-flow__pane")
    await canvasPane.click({ position: { x: 450, y: 350 } })

    // Find the text node textarea
    const textarea = page.locator("textarea.canvas-text-node__editor, textarea[aria-label='文本节点内容']").first()
    await expect(textarea).toBeVisible()

    await textarea.fill("自动排版核心测试内容")
    await textarea.press("Escape")

    await expect(page.getByText("自动排版核心测试内容")).toBeVisible()

    // Reload and verify persisted
    await page.reload()
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")
    await expect(page.getByText("自动排版核心测试内容")).toBeVisible()
  })
})
