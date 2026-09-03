import { expect, test } from "../../fixtures/e2e-env"

const VIEWPORTS = [
  { width: 1920, height: 1080, name: "1080p" },
  { width: 2560, height: 1440, name: "1440p" },
  { width: 3840, height: 2160, name: "4K" },
]

test.describe("Nightly 04 - Multi-Viewport Large Scale Display", () => {
  for (const vp of VIEWPORTS) {
    test(`renders canvas layout accurately in ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto("/canvas?spaceId=local&projectId=reference")
      await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")

      const toolbar = page.getByTestId("tool-dock")
      await expect(toolbar).toBeVisible()
      const box = await toolbar.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height)
      expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width)
    })
  }
})
