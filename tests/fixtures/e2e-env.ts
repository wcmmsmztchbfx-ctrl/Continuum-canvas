import { test as base, expect, type BrowserContext, type BrowserContextOptions } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { referenceProjectSnapshot } from "../../src/fixtures/reference"
import { migrateLegacyProjects } from "../../src/workspace/migration"

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
    const isFixtureMediaFetch = request.resourceType() === 'fetch' &&
      (url.hostname === 'media.continuum.example' || url.hostname.endsWith('.aliyuncs.com'))
    if (request.resourceType() === "image" || isFixtureMediaFetch) {
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
    // Production starts empty; the suites explicitly own their reference dataset.
    const { manifest, documents } = migrateLegacyProjects([], {
      now: "2026-08-30T00:00:00.000Z",
      seedProject: referenceProjectSnapshot,
    })
    // The fixture is persisted on disk, so use a portable ID without Windows colons.
    const canvasId = "e2e-reference-canvas"
    manifest.canvases[0]!.canvasId = canvasId
    const versionResponse = await request.get('/api/workspace/manifest')
    expect(versionResponse.ok()).toBe(true)
    const versions = await versionResponse.json()
    const seedRes = await request.post("/api/workspace/commit", {
      data: {
        protocolVersion: 1,
        operationId: randomUUID(),
        kind: 'edit-workspace',
        expectedWorkspaceRevision: versions.workspaceRevision,
        expectedCanvasRevisions: { [canvasId]: 0 },
        commit: {
          manifest: JSON.stringify(manifest),
          putDocuments: documents.map((document) => ({
            canvasId,
            serialized: JSON.stringify({ ...document, canvasId }),
          })),
        },
      },
    })
    expect(seedRes.status(), `E2E reference dataset must be persisted: ${await seedRes.text()}`).toBe(200)
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
