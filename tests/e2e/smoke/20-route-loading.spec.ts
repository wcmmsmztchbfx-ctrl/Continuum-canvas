import { expect, test } from "../../fixtures/e2e-env"

test.describe("20 - Route Loading", () => {
  test("defers the editor until opening a canvas and restores its data after reload", async ({ page }) => {
    const editorRequests: string[] = []
    const pageErrors: Error[] = []
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/src/App.tsx") {
        editorRequests.push(request.url())
      }
    })
    page.on("pageerror", (error) => pageErrors.push(error))

    await page.goto("/")
    await expect(page.getByTestId("workspace-home")).toBeVisible()
    const referenceCanvas = page.getByRole("button", { name: "画布 1，37 个节点", exact: true })
    await expect(referenceCanvas).toBeVisible()
    await expect(page.getByTestId("app-shell")).toHaveCount(0)
    expect(editorRequests, "The workspace home must not download the canvas editor").toHaveLength(0)

    await referenceCanvas.click()
    await expect(page).toHaveURL(/\/canvas\?.*canvasId=e2e-reference-canvas(?:&|$)/)
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")
    await expect(page.getByTestId("canvas-workspace")).toBeVisible()
    await expect(page.locator(".react-flow__node")).toHaveCount(37)
    await expect(page.getByRole("article", { name: "图片节点 7", exact: true }))
      .toHaveAttribute("data-node-kind", "image")
    expect(editorRequests.length, "Opening a canvas must load the real editor module").toBeGreaterThan(0)

    const canvasUrl = page.url()
    await page.reload()
    await expect(page).toHaveURL(canvasUrl)
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")
    await expect(page.getByTestId("canvas-workspace")).toBeVisible()
    await expect(page.locator(".react-flow__node")).toHaveCount(37)
    await expect(page.getByRole("article", { name: "图片节点 7", exact: true }))
      .toHaveAttribute("data-node-kind", "image")

    await page.getByRole("button", { name: /^打开工作区菜单/ }).click()
    await page.getByRole("menuitem", { name: "返回工作区", exact: true }).click()
    await expect(page).toHaveURL("/")
    await expect(page.getByTestId("workspace-home")).toBeVisible()
    await expect(referenceCanvas).toBeVisible()
    await expect(page.getByTestId("app-shell")).toHaveCount(0)
    expect(pageErrors, "Opening, reloading, and closing the editor must not cause runtime errors").toHaveLength(0)
  })
})
