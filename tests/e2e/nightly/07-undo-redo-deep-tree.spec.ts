import { expect, test } from "../../fixtures/e2e-env"

test.describe("Nightly 07 - Undo/Redo Complex Deep Graph", () => {
  test("maintains state integrity across sequential compound operations and deep undo/redo cycles", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    const initialNodes = await page.locator(".react-flow__node").count()

    // 1. Select a node and duplicate twice
    const targetNode = page.locator(".react-flow__node[data-id='i-Ia5V4APL5X']")
    await targetNode.click()
    await page.keyboard.press("ControlOrMeta+d")
    await expect(page.locator(".react-flow__node")).toHaveCount(initialNodes + 1)

    await page.keyboard.press("ControlOrMeta+d")
    await expect(page.locator(".react-flow__node")).toHaveCount(initialNodes + 2)

    // 2. Undo step 2
    await page.keyboard.press("ControlOrMeta+z")
    await expect(page.locator(".react-flow__node")).toHaveCount(initialNodes + 1)

    // 3. Undo step 1
    await page.keyboard.press("ControlOrMeta+z")
    await expect(page.locator(".react-flow__node")).toHaveCount(initialNodes)

    // 4. Redo step 1
    await page.keyboard.press("ControlOrMeta+Shift+z")
    await expect(page.locator(".react-flow__node")).toHaveCount(initialNodes + 1)
  })
})
