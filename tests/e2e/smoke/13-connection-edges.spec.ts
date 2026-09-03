import { expect, test } from "../../fixtures/e2e-env"

test.describe("13 - Connection Edges", () => {
  test("creates edges between handles and restores connectivity after reload", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    const candidates = await page.locator(".react-flow__node").evaluateAll((nodes) => nodes
      .map((node) => {
        const rect = node.getBoundingClientRect()
        return {
          id: node.getAttribute("data-id"),
          kind: node.querySelector("[data-node-kind]")?.getAttribute("data-node-kind"),
          visible: rect.right > 80 && rect.left < innerWidth - 80 && rect.bottom > 100 && rect.top < innerHeight - 120,
        }
      })
      .filter((node) => node.id && node.visible && (node.kind === "image" || node.kind === "video")))
    expect(candidates.length).toBeGreaterThanOrEqual(2)
    const sourceId = candidates[0]!.id!
    const targetId = candidates[1]!.id!
    const source = page.locator(`.react-flow__node[data-id="${sourceId}"] .source .canvas-node-handle__hit`)
    const target = page.locator(`.react-flow__node[data-id="${targetId}"] .target .canvas-node-handle__hit`)
    const sourceBox = await source.boundingBox()
    const targetBox = await target.boundingBox()
    expect(sourceBox).not.toBeNull()
    expect(targetBox).not.toBeNull()
    const before = await page.locator(".react-flow__edge").count()
    const persisted = page.waitForResponse((response) => response.url().endsWith('/api/workspace/commit') && response.request().method() === 'POST' && response.ok())
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect(page.locator(".react-flow__edge")).toHaveCount(before + 1)
    await expect(page.getByLabel(`Edge from ${sourceId} to ${targetId}`)).toHaveCount(1)
    await persisted
    await page.reload()
    await expect(page.getByLabel(`Edge from ${sourceId} to ${targetId}`)).toHaveCount(1)
  })
})
