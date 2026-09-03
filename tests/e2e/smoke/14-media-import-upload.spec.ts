import { readFile } from "node:fs/promises"
import { expect, test, SAMPLE_IMAGE_PATH } from "../../fixtures/e2e-env"

test.describe("14 - Media Import & Upload", () => {
  test("imports local image file to create image node on canvas", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    const nodesBefore = await page.locator(".react-flow__node").count()
    const bytes = [...await readFile(SAMPLE_IMAGE_PATH)]
    await page.evaluate((png) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(png)], "continuum-e2e.png", { type: "image/png" }))
      document.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }))
    }, bytes)
    await expect(page.locator(".react-flow__node")).toHaveCount(nodesBefore + 1)
    const imported = page.locator(".react-flow__node-image.selected")
    await expect(imported).toHaveCount(1)
    const image = imported.locator("img.canvas-image-highres")
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate((element) => ({
      width: (element as HTMLImageElement).naturalWidth,
      height: (element as HTMLImageElement).naturalHeight,
      local: new URL((element as HTMLImageElement).src).pathname.startsWith("/api/assets/"),
    }))).toEqual({ width: 320, height: 180, local: true })
  })
})
