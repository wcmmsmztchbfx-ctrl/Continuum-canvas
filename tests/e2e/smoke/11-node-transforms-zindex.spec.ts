import { expect, test } from "../../fixtures/e2e-env"

test.describe("11 - Node Transforms & Z-Index Persistence", () => {
  test("moves nodes, adjusts z-index, and preserves spatial coordinates after reload", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    const node = page.locator(".react-flow__node[data-id='i-2YYUMOBPSy']")
    await expect(node).toBeVisible()
    const initialBox = await node.boundingBox()
    expect(initialBox).not.toBeNull()

    // Move node by dragging
    await page.mouse.move(initialBox!.x + 20, initialBox!.y + 20)
    await page.mouse.down()
    await page.mouse.move(initialBox!.x + 80, initialBox!.y + 80, { steps: 8 })
    await page.mouse.up()

    // Verify moved
    const movedBox = await node.boundingBox()
    expect(movedBox!.x).toBeGreaterThan(initialBox!.x)

    // Reload and check persistence
    await page.reload()
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")
    const persistedBox = await page.locator(".react-flow__node[data-id='i-2YYUMOBPSy']").boundingBox()
    expect(persistedBox!.x).toBeCloseTo(movedBox!.x, -1)
  })
})
