import { expect, test } from "../../fixtures/e2e-env"

test.describe("10 - Frame Containment & Parentage", () => {
  test("drags node into frame, moves frame with children, and deletes frame cleanly", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    // Select frame tool
    const frameTool = page.getByRole("button", { name: /画框/ })
    await frameTool.click()

    // Click canvas pane to create frame
    await page.locator(".react-flow__pane").click({ position: { x: 300, y: 250 } })

    const frame = page.locator(".react-flow__node-frame").first()
    await expect(frame).toBeVisible()
    const frameId = await frame.getAttribute("data-id")
    expect(frameId).toBeTruthy()

    const frameBox = await frame.boundingBox()
    expect(frameBox).not.toBeNull()
    expect(frameBox!.width).toBeGreaterThan(50)

    await page.getByRole("button", { name: /图形/ }).click()
    const paneBox = await page.locator(".react-flow__pane").boundingBox()
    expect(paneBox).not.toBeNull()
    await page.mouse.click(paneBox!.x + paneBox!.width - 220, paneBox!.y + 180)
    const child = page.locator(".react-flow__node-shape.selected")
    await expect(child).toHaveCount(1)
    const childId = await child.getAttribute("data-id")
    expect(childId).toBeTruthy()
    const childById = page.locator(`.react-flow__node[data-id="${childId}"]`)
    const childOutside = await childById.boundingBox()
    await page.mouse.move(childOutside!.x + childOutside!.width / 2, childOutside!.y + childOutside!.height / 2)
    await page.keyboard.down("Control")
    await page.mouse.down()
    await page.mouse.move(frameBox!.x + frameBox!.width * 0.35, frameBox!.y + frameBox!.height / 2, { steps: 12 })
    await expect(page.getByTestId("canvas-workspace")).toHaveAttribute("data-frame-drop-target", frameId!)
    await page.mouse.up()
    await page.keyboard.up("Control")
    const childBefore = await childById.boundingBox()
    expect(childBefore).not.toBeNull()

    const frameBeforeMove = await frame.boundingBox()
    const dragPoint = await page.evaluate(({ id, bounds }) => {
      for (let y = bounds.y + 10; y < bounds.y + bounds.height - 10; y += 8) {
        for (let x = bounds.x + 10; x < bounds.x + bounds.width - 10; x += 8) {
          const hit = document.elementFromPoint(x, y)
          if (hit?.closest(".react-flow__node")?.getAttribute("data-id") === id && !hit.closest(".nodrag")) return { x, y }
        }
      }
      return null
    }, { id: frameId, bounds: frameBeforeMove! })
    expect(dragPoint).not.toBeNull()
    await page.mouse.move(dragPoint!.x, dragPoint!.y)
    await page.mouse.down()
    await page.mouse.move(dragPoint!.x + 80, dragPoint!.y + 50, { steps: 10 })
    await page.mouse.up()
    const frameAfterMove = await frame.boundingBox()
    const frameDelta = {
      x: frameAfterMove!.x - frameBeforeMove!.x,
      y: frameAfterMove!.y - frameBeforeMove!.y,
    }
    expect(Math.abs(frameDelta.x) + Math.abs(frameDelta.y)).toBeGreaterThan(20)
    const childAfter = await childById.boundingBox()
    expect(childAfter!.x - childBefore!.x).toBeCloseTo(frameDelta.x, 0)
    expect(childAfter!.y - childBefore!.y).toBeCloseTo(frameDelta.y, 0)

    await frame.click({ force: true })
    await page.keyboard.press("Delete")
    await expect(frame).toHaveCount(0)
    await expect(childById).toBeVisible()
  })
})
