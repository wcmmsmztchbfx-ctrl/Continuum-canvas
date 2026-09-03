import { expect, test } from "../../fixtures/e2e-env"

test.describe("08 - Selection, Clipboard & Undo/Redo", () => {
  test("supports selection, duplication, deletion, and undo/redo cycles", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    const initialNodes = await page.locator(".react-flow__node").count()
    expect(initialNodes).toBeGreaterThan(0)

    // 1. Select a visible node and duplicate via hotkey Ctrl+D / Ctrl+C + Ctrl+V
    const targetNode = page.locator(".react-flow__node[data-id='i-2YYUMOBPSy']")
    await targetNode.click()
    await page.keyboard.press("ControlOrMeta+d")
    await expect(page.locator(".react-flow__node")).toHaveCount(initialNodes + 1)

    // 2. Delete
    await page.keyboard.press("Delete")
    await expect(page.locator(".react-flow__node")).toHaveCount(initialNodes)

    // 3. Undo
    await page.keyboard.press("ControlOrMeta+z")
    await expect(page.locator(".react-flow__node")).toHaveCount(initialNodes + 1)

    // 4. Redo
    await page.keyboard.press("ControlOrMeta+Shift+z")
    await expect(page.locator(".react-flow__node")).toHaveCount(initialNodes)
  })
})
