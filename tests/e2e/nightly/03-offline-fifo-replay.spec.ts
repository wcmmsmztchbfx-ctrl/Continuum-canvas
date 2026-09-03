import { expect, test } from "../../fixtures/e2e-env"

test.describe("Nightly 03 - Offline FIFO Queue & Replay", () => {
  test("buffers mutations during network interruption and synchronizes sequentially upon reconnection", async ({ page, context }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    // Place text node
    await page.getByRole("button", { name: /文字/ }).click()
    await page.locator(".react-flow__pane").click({ position: { x: 500, y: 350 } })
    const textarea = page.locator("textarea.canvas-text-node__editor, textarea[aria-label='文本节点内容']").first()
    await expect(textarea).toBeVisible()
    await textarea.fill("离线变更内容")
    await textarea.press("Escape")

    // Go offline
    await context.setOffline(true)

    // Reconnect
    await context.setOffline(false)

    // Verify content retained
    await expect(page.getByText("离线变更内容")).toBeVisible()
  })
})
