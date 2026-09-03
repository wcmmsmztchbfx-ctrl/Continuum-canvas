import { expect, test } from "../../fixtures/e2e-env"

test.describe("05 - Node Creation & Auto Select Reset", () => {
  test("creating shapes, frames, and text resets active tool and selects each new node", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    const toolbar = page.getByTestId("tool-dock")
    await expect(toolbar).toBeVisible()

    const canvasPane = page.locator(".react-flow__pane")
    const selectTool = page.getByRole("button", { name: /选择/ })
    for (const entry of [
      { name: /画框/, type: "frame", x: 300 },
      { name: /图形/, type: "shape", x: 520 },
      { name: /文字/, type: "text", x: 740 },
    ]) {
      const before = await page.locator(`.react-flow__node-${entry.type}`).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")))
      const tool = page.getByRole("button", { name: entry.name })
      await tool.click()
      await expect(tool).toHaveAttribute("aria-pressed", "true")
      await canvasPane.click({ position: { x: entry.x, y: 300 } })
      await expect(selectTool).toHaveAttribute("aria-pressed", "true")
      const created = page.locator(`.react-flow__node-${entry.type}.selected`)
      await expect(created).toHaveCount(1)
      expect(await created.getAttribute("data-id")).not.toBeNull()
      expect(before).not.toContain(await created.getAttribute("data-id"))
      if (entry.type === "text") await page.keyboard.press("Escape")
    }
  })
})
