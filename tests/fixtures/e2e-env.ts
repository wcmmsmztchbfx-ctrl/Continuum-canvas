import { test as base, expect, type BrowserContext, type BrowserContextOptions } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const TEST_ASSETS_DIR = path.resolve(__dirname, "test-assets")
export const SAMPLE_IMAGE_PATH = path.join(TEST_ASSETS_DIR, "sample-image.png")
export const SAMPLE_VIDEO_PATH = path.join(TEST_ASSETS_DIR, "sample-video.mp4")

async function installNetworkIsolation(context: BrowserContext): Promise<void> {
  const image = await readFile(SAMPLE_IMAGE_PATH)
  const video = await readFile(SAMPLE_VIDEO_PATH)
  await context.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol)) {
      await route.continue()
      return
    }
    if (request.resourceType() === "image") {
      await route.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: image })
      return
    }
    if (request.resourceType() === "media") {
      await route.fulfill({ status: 200, contentType: "video/mp4", headers: { "access-control-allow-origin": "*" }, body: video })
      return
    }
    await route.abort("blockedbyclient")
  })
}

export const test = base.extend<{
  resetEnvironment: void
  createTestContext: (options?: BrowserContextOptions) => Promise<BrowserContext>
}>({
  resetEnvironment: [async ({ request }, run) => {
    const resetRes = await request.post("/api/dev/reset-e2e-fixtures")
    expect(resetRes.status(), "E2E Fixture reset must return HTTP 200").toBe(200)
    const payload = await resetRes.json() as { state?: Record<string, number> }
    expect(payload.state).toEqual({ rooms: 0, jobs: 0, assets: 0, workspaceDocuments: 0 })
    await run()
  }, { auto: true }],
  page: async ({ page }, run) => {
    await installNetworkIsolation(page.context())
    await run(page)
  },
  createTestContext: async ({ browser }, run) => {
    const contexts: BrowserContext[] = []
    await run(async (options = {}) => {
      const context = await browser.newContext({ baseURL: "http://127.0.0.1:4273", ...options })
      contexts.push(context)
      await installNetworkIsolation(context)
      return context
    })
    await Promise.all(contexts.map((context) => context.close()))
  },
})

export { expect }
