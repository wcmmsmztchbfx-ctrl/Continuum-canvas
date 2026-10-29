import { expect, test } from "../../fixtures/e2e-env"

test.describe("09 - Group Operations & Hit-Testing", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("groups a mouse selection, moves its children, selects through the group, and undoes ungrouping", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    // Select two visible nodes
    const node1 = page.locator(".react-flow__node[data-id='i-2YYUMOBPSy']")
    const node2 = page.locator(".react-flow__node[data-id='i-TFj65r3PHQ']")
    await node1.click()
    await page.keyboard.down("Shift")
    await node2.click()
    await page.keyboard.up("Shift")
    await expect(node1).toHaveClass(/\bselected\b/)
    await expect(node2).toHaveClass(/\bselected\b/)
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(2)

    // Group (Ctrl+G)
    await page.keyboard.press("ControlOrMeta+g")

    // Assert group container exists
    const groupNode = page.locator(".react-flow__node-group")
    await expect(groupNode).toBeVisible()
    await expect(groupNode).toHaveClass(/\bselected\b/)
    const groupBefore = (await groupNode.boundingBox())!
    const firstBefore = (await node1.boundingBox())!
    const secondBefore = (await node2.boundingBox())!

    // The frame has padding above its children, so this drag starts on the group.
    const grab = { x: groupBefore.x + groupBefore.width / 2, y: groupBefore.y + 5 }
    await page.mouse.move(grab.x, grab.y)
    await page.mouse.down()
    await page.mouse.move(grab.x + 60, grab.y - 45, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => Math.abs((await groupNode.boundingBox())!.x - groupBefore.x)).toBeGreaterThan(20)
    const groupAfter = (await groupNode.boundingBox())!
    const firstAfter = (await node1.boundingBox())!
    const secondAfter = (await node2.boundingBox())!
    const delta = { x: groupAfter.x - groupBefore.x, y: groupAfter.y - groupBefore.y }
    for (const [before, after] of [[firstBefore, firstAfter], [secondBefore, secondAfter]]) {
      expect(Math.abs(after.x - before.x - delta.x)).toBeLessThan(1)
      expect(Math.abs(after.y - before.y - delta.y)).toBeLessThan(1)
    }

    // Clicking a visible child must reach the child rather than its group frame.
    await node1.click()
    await expect(node1).toHaveClass(/\bselected\b/)
    await expect(groupNode).not.toHaveClass(/\bselected\b/)
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(1)

    // Ungroup (Ctrl+Shift+G)
    await page.mouse.click(groupAfter.x + groupAfter.width / 2, groupAfter.y + 5)
    await expect(groupNode).toHaveClass(/\bselected\b/)
    await page.keyboard.press("ControlOrMeta+Shift+g")
    await expect(page.locator(".canvas-group-node")).toHaveCount(0)
    const firstUngrouped = (await node1.boundingBox())!
    expect(Math.abs(firstUngrouped.x - firstAfter.x)).toBeLessThan(1)
    expect(Math.abs(firstUngrouped.y - firstAfter.y)).toBeLessThan(1)

    await page.keyboard.press("ControlOrMeta+z")
    await expect(groupNode).toBeVisible()
    const firstRestored = (await node1.boundingBox())!
    expect(Math.abs(firstRestored.x - firstAfter.x)).toBeLessThan(1)
    expect(Math.abs(firstRestored.y - firstAfter.y)).toBeLessThan(1)
    await page.keyboard.press("ControlOrMeta+Shift+z")
    await expect(groupNode).toHaveCount(0)
  })
})
