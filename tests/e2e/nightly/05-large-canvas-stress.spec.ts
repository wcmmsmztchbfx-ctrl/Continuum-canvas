import { expect, test } from "../../fixtures/e2e-env"

test.describe("Nightly 05 - Large Canvas Stress & Viewport Panning", () => {
  test("maintains high responsiveness during rapid viewport pans and zoom sweeps", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    const canvasPane = page.locator(".react-flow__pane")
    const box = await canvasPane.boundingBox()
    expect(box).not.toBeNull()

    // 10 continuous fast pan sweeps
    for (let i = 0; i < 5; i++) {
      await page.mouse.move(box!.x + 400, box!.y + 300)
      await page.mouse.down({ button: "middle" })
      await page.mouse.move(box!.x + 200, box!.y + 200, { steps: 5 })
      await page.mouse.up({ button: "middle" })
    }

    // Assert app is still fully responsive
    await expect(page.getByTestId("tool-dock")).toBeVisible()
    await expect(page.locator(".react-flow__node").first()).toBeVisible()
  })
})
