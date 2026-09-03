import { expect, test } from "../../fixtures/e2e-env"

test.describe("12 - Media DOM Stability During Drag", () => {
  test("maintains media DOM element identity and prevents remounting during drag", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    const mediaNode = page.locator(".react-flow__node").filter({ has: page.locator("img, video") }).first()
    await expect(mediaNode).toBeVisible()
    await mediaNode.evaluate((el) => el.setAttribute("data-test-dom-identity", "stable-id-123"))
    const box = await mediaNode.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + 20, box!.y + 20)
    await page.mouse.down()
    await page.mouse.move(box!.x + 120, box!.y + 60, { steps: 10 })
    await expect(mediaNode).toHaveAttribute("data-test-dom-identity", "stable-id-123")
    await page.mouse.up()
    await expect(mediaNode).toHaveAttribute("data-test-dom-identity", "stable-id-123")
  })
})
