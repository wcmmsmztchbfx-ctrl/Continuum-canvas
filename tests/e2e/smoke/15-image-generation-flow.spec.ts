import { readFile } from 'node:fs/promises'
import type { GenerationRequest } from '../../../src/contracts/generation'
import { expect, SAMPLE_IMAGE_PATH, test } from '../../fixtures/e2e-env'

const provider = {
  id: 'aistartlab', name: 'E2E Fake Provider', adapterType: 'aistartlab-openapi',
  baseUrl: 'http://127.0.0.1/fake', enabled: true, preferred: true,
  secretEnvName: 'E2E_FAKE_KEY', secretConfigured: true, maskedSecret: 'e2e-****',
  available: true, lastSyncedAt: '2026-08-30T00:00:00.000Z',
}
const catalog = {
  providerId: provider.id, version: 'e2e-v1', fetchedAt: provider.lastSyncedAt, stale: false,
  models: [{
    mediaType: 'image', channel: 46, channelTitle: '图片生成', model: 'e2e-image', title: 'E2E Image',
    qualityOptions: [{ value: '1K', label: '1K', pricing: { type: 'fixed_total', credits: 1 } }],
    aspectRatios: ['16:9'], countOptions: [1], durationOptions: [], modes: ['text2image', 'image2image'],
    inputLimits: { images: 3, videos: 0, audios: 0 }, raw: {},
  }],
}

test.describe('15 - Image Generation Flow', () => {
  test('submits to the local fake provider and persists the completed image asset', async ({ page }) => {
    const outputAssetId = '33333333-3333-4333-8333-333333333333'
    const jobId = '44444444-4444-4444-8444-444444444444'
    const png = await readFile(SAMPLE_IMAGE_PATH)
    let submitted: GenerationRequest | undefined
    let polls = 0
    await page.route('**/api/providers', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ providers: [provider] }) }))
    await page.route('**/api/catalog?providerId=*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ catalog }) }))
    await page.route('**/api/providers/*/sync', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ catalog }) }))
    await page.route('**/api/assets/*', (route) => route.fulfill({ contentType: 'image/png', body: png }))
    await page.route('**/api/generation-jobs', async (route) => {
      submitted = route.request().postDataJSON() as GenerationRequest
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ job: makeJob(jobId, submitted, 'queued', 0) }) })
    })
    await page.route(`**/api/generation-jobs/${jobId}`, async (route) => {
      polls += 1
      const complete = polls >= 2
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ job: makeJob(jobId, submitted!, complete ? 'complete' : 'running', complete ? 100 : 42, complete ? outputAssetId : undefined, png.length) }) })
    })

    await page.goto('/canvas?spaceId=local&projectId=reference')
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
    const imageNode = page.locator(".react-flow__node[data-id='i-Ia5V4APL5X']")
    await imageNode.click()
    const generator = page.locator('[data-node-editor="image"]')
    await expect(generator.getByText('E2E Image')).toBeVisible()
    await generator.getByRole('combobox', { name: '图片生成描述' }).fill('本地假服务生成测试')
    await generator.getByRole('button', { name: '开始生成' }).click()
    await expect(imageNode.locator('[data-generation-status="generating"]')).toBeVisible({ timeout: 15_000 })
    await expect(imageNode.locator('[data-generation-status="complete"]')).toBeVisible({ timeout: 15_000 })
    await expect(imageNode.getByRole('link', { name: /下载图片/ })).toHaveAttribute('href', `/api/assets/${outputAssetId}`)
    expect(submitted).toMatchObject({ prompt: '本地假服务生成测试', providerId: provider.id, model: 'e2e-image' })
    await page.reload()
    await expect(imageNode.locator('[data-generation-status="complete"]')).toBeVisible()
    await expect(imageNode.getByRole('link', { name: /下载图片/ })).toHaveAttribute('href', `/api/assets/${outputAssetId}`)
  })
})

function makeJob(id: string, request: GenerationRequest, status: 'queued' | 'running' | 'complete', progress: number, assetId?: string, size = 0) {
  return {
    id, clientRequestId: request.clientRequestId, requestDigest: 'e2e-digest', request, status, progress,
    createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:01.000Z',
    outputs: assetId ? [{ assetId, url: `/api/assets/${assetId}`, contentType: 'image/png', size }] : [],
  }
}
