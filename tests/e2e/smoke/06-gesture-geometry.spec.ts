import { expect, test } from "../../fixtures/e2e-env"

test.describe("06 - Gesture Geometry & Reverse Dragging", () => {
  test("drag-creation and reverse dragging produce positive dimensions and valid bounds", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    // Select shape tool
    const shapeTool = page.getByRole("button", { name: /^图形/ })
    await expect(shapeTool).toBeVisible()
    const before = await page.locator(".react-flow__node-shape").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")))
    await shapeTool.click()

    // Drag from (600, 400) to (450, 300) [reverse drag]
    await page.mouse.move(600, 400)
    await page.mouse.down()
    await page.mouse.move(450, 300, { steps: 8 })
    await page.mouse.up()

    // Assert shape node exists and has positive dimensions
    const created = page.locator(".react-flow__node-shape.selected")
    await expect(created).toHaveCount(1)
    expect(before).not.toContain(await created.getAttribute("data-id"))
    const box = await created.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeCloseTo(150, -1)
    expect(box!.height).toBeCloseTo(100, -1)
  })
})
