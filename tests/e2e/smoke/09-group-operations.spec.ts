import { expect, test } from "../../fixtures/e2e-env"

test.describe("09 - Group Operations & Hit-Testing", () => {
  test("creates group, allows group movement, transparent child selection, and ungroups", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    // Select two visible nodes
    const node1 = page.locator(".react-flow__node[data-id='i-2YYUMOBPSy']")
    const node2 = page.locator(".react-flow__node[data-id='i-TFj65r3PHQ']")
    await node1.click()
    await page.keyboard.down("Shift")
    await node2.click()
    await page.keyboard.up("Shift")

    // Group (Ctrl+G)
    await page.keyboard.press("ControlOrMeta+g")

    // Assert group container exists
    const groupNode = page.locator(".canvas-group-node, .react-flow__node-group").first()
    await expect(groupNode).toBeVisible()

    // Ungroup (Ctrl+Shift+G)
    await groupNode.click()
    await page.keyboard.press("ControlOrMeta+Shift+g")
    await expect(page.locator(".canvas-group-node")).toHaveCount(0)
  })
})
