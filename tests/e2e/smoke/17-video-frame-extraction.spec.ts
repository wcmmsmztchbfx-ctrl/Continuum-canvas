import { expect, test } from "../../fixtures/e2e-env"

test.describe("17 - Video Frame Extraction", () => {
  test("extracts current video frame into adjacent image node with timestamp", async ({ page }) => {
    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

    // Pan canvas left to bring video nodes into view
    const canvasPane = page.locator(".react-flow__pane")
    const box = await canvasPane.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down({ button: "middle" })
    await page.mouse.move(box!.x + box!.width / 2 - 500, box!.y + box!.height / 2, { steps: 8 })
    await page.mouse.up({ button: "middle" })

    const videoNode = page.locator(".react-flow__node-video, [data-id='v-mILO4KlxPK'], [data-id='v-z04Z1IjdX8']").first()
    await expect(videoNode).toBeVisible()
    await videoNode.click()

    const generator = page.locator(".canvas-node-generator").first()
    await expect(generator).toBeVisible()
    const video = videoNode.locator("video")
    await expect.poll(() => video.evaluate((element) => ({
      width: (element as HTMLVideoElement).videoWidth,
      height: (element as HTMLVideoElement).videoHeight,
      duration: Math.round((element as HTMLVideoElement).duration * 10) / 10,
    }))).toEqual({ width: 320, height: 180, duration: 1.5 })
    await video.evaluate((element) => { (element as HTMLVideoElement).currentTime = 0.75 })
    const imageIdsBefore = await page.locator(".react-flow__node-image").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")))
    await generator.getByRole("button", { name: "截取当前帧" }).click()
    await expect(page.locator(".react-flow__node-image")).toHaveCount(imageIdsBefore.length + 1)
    const imageIdsAfter = await page.locator(".react-flow__node-image").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")))
    const capturedId = imageIdsAfter.find((id) => !imageIdsBefore.includes(id))
    expect(capturedId).toBeTruthy()
    const captured = page.locator(`.react-flow__node-image[data-id="${capturedId}"]`)
    await expect(captured.getByRole("article", { name: /关键帧/ })).toBeVisible()
    await expect(captured.locator("img.canvas-image-highres")).toHaveAttribute("data-source-url", /\/api\/assets\//)
  })
})
