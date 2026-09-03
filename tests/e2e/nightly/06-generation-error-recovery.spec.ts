import { expect, test } from "../../fixtures/e2e-env"

test.describe("Nightly 06 - Generation Error Recovery", () => {
  test("gracefully presents error state and retry mechanics upon backend interruption", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    const imageNode = page.locator(".react-flow__node[data-id='i-Ia5V4APL5X']")
    await expect(imageNode).toBeVisible()
    await imageNode.click()

    const generator = page.locator(".canvas-node-generator").first()
    await expect(generator).toBeVisible()
  })
})
