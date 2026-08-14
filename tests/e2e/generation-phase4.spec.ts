import { expect, test, type Page } from '@playwright/test'

import type { GenerationRequest } from '../../src/contracts/generation'

const provider = {
  id: 'aistartlab',
  name: 'AIStartLab',
  adapterType: 'aistartlab-openapi',
  baseUrl: 'https://api.video.aistarslab.com/openapi',
  enabled: true,
  preferred: true,
  secretEnvName: 'API_PROVIDER_AISTARTLAB_KEY',
  secretConfigured: true,
  maskedSecret: 'sk-********1234',
  available: true,
  lastSyncedAt: new Date().toISOString(),
}

const catalog = {
  providerId: provider.id,
  version: 'phase4-e2e-v1',
  fetchedAt: provider.lastSyncedAt,
  stale: false,
  models: [
    {
      mediaType: 'image',
      channel: 46,
      channelTitle: '图片生成',
      model: 'gpt-image-2',
      title: 'GPT Image 2 Low',
      qualityOptions: [
        { value: '1K', label: '1K', pricing: { type: 'fixed_total', credits: 5 } },
        { value: '2K', label: '2K', pricing: { type: 'fixed_total', credits: 8 } },
      ],
      aspectRatios: ['16:9', '9:16', '1:1'],
      countOptions: [1],
      durationOptions: [],
      modes: ['text2image', 'image2image'],
      inputLimits: { images: 3, videos: 0, audios: 0 },
      raw: {},
    },
    {
      mediaType: 'video',
      channel: 27,
      channelTitle: '视频生成',
      model: 'grok-video-1',
      title: 'Grok 1.0',
      qualityOptions: [
        { value: '720P', label: '720P', pricing: { type: 'fixed_total', credits: 120 } },
      ],
      aspectRatios: ['16:9'],
      countOptions: [1],
      durationOptions: [6],
      modes: ['text2video', 'image2video', 'first_last_frame'],
      inputLimits: { images: 3, videos: 0, audios: 0 },
      raw: { supportsAudio: true },
    },
  ],
}

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

async function mockCatalogGateway(page: Page) {
  await page.route('**/api/local-admin/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, created: false }),
    })
  })
  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ providers: [provider] }),
    })
  })
  await page.route('**/api/catalog?providerId=*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ catalog }),
    })
  })
  await page.route('**/api/providers/*/sync', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ catalog }),
    })
  })
}

function job(
  id: string,
  request: GenerationRequest,
  status: 'queued' | 'running' | 'complete',
  progress: number,
  outputAssetId?: string,
) {
  return {
    id,
    clientRequestId: request.clientRequestId,
    requestDigest: 'phase4-e2e-digest',
    request,
    status,
    progress,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:01.000Z',
    outputs: outputAssetId
      ? [
          {
            assetId: outputAssetId,
            url: `/api/assets/${outputAssetId}`,
            contentType: 'image/png',
            size: png.byteLength,
          },
        ]
      : [],
  }
}

async function pasteImage(page: Page, name: string) {
  await page.evaluate(
    ({ fileName, bytes }) => {
      const transfer = new DataTransfer()
      transfer.items.add(
        new File([new Uint8Array(bytes)], fileName, { type: 'image/png' }),
      )
      document.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }),
      )
    },
    { fileName: name, bytes: [...png] },
  )
}

test.beforeEach(async ({ page }) => {
  await mockCatalogGateway(page)
})

test('completes reference pick, keyboard mention, dynamic settings, confirmation, progress, and refresh recovery', async ({
  page,
}) => {
  test.slow()
  const assetIds = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]
  const outputAssetId = '33333333-3333-4333-8333-333333333333'
  const jobId = '44444444-4444-4444-8444-444444444444'
  let assetUploads = 0
  let generationPosts = 0
  let jobReads = 0
  let submittedRequest: GenerationRequest | undefined

  await page.route('**/api/assets', async (route) => {
    const assetId = assetIds[assetUploads++]!
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        asset: {
          id: assetId,
          filename: route.request().headers()['x-filename'],
          contentType: 'image/png',
          size: png.byteLength,
          url: `/api/assets/${assetId}`,
          createdAt: '2026-07-17T00:00:00.000Z',
        },
      }),
    })
  })
  await page.route('**/api/assets/*', async (route) => {
    await route.fulfill({ contentType: 'image/png', body: png })
  })
  await page.route('**/api/generation-jobs', async (route) => {
    generationPosts += 1
    submittedRequest = route.request().postDataJSON() as GenerationRequest
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ job: job(jobId, submittedRequest, 'queued', 0) }),
    })
  })
  await page.route(`**/api/generation-jobs/${jobId}`, async (route) => {
    jobReads += 1
    const complete = jobReads >= 2
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        job: job(
          jobId,
          submittedRequest!,
          complete ? 'complete' : 'running',
          complete ? 100 : 42,
          complete ? outputAssetId : undefined,
        ),
      }),
    })
  })

  await page.goto('/canvas?spaceId=local&projectId=reference')
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')

  await pasteImage(page, 'phase4-target.png')
  const target = page.locator('.react-flow__node[aria-label="phase4-target.png"]')
  await expect(target).toBeVisible()
  const targetNodeId = await target.getAttribute('data-id')
  expect(targetNodeId).toBeTruthy()
  await pasteImage(page, 'phase4-reference.png')
  const reference = page.locator(
    '.react-flow__node[aria-label="phase4-reference.png"]',
  )
  await expect(reference).toBeVisible()

  const referenceBounds = await reference.boundingBox()
  expect(referenceBounds).not.toBeNull()
  await page.mouse.move(
    referenceBounds!.x + referenceBounds!.width / 2,
    referenceBounds!.y + referenceBounds!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    referenceBounds!.x + referenceBounds!.width / 2 + 500,
    referenceBounds!.y + referenceBounds!.height / 2 - 150,
    { steps: 8 },
  )
  await page.mouse.up()

  await target.click()
  const editor = page.locator('[data-node-editor="image"]')
  await expect(editor.getByText('GPT Image 2 Low')).toBeVisible()
  await editor.getByRole('button', { name: '参考拾取模式' }).click()
  await expect(page.getByTestId('canvas-workspace')).toHaveAttribute(
    'data-reference-pick-target',
  )
  await expect(reference.locator('[data-reference-candidate="true"]')).toBeVisible()
  await reference.click()
  await expect(editor.getByLabel('参考素材 1/3')).toBeVisible()
  await expect(editor.getByLabel('参考 @1：phase4-reference.png')).toBeVisible()

  const prompt = editor.getByRole('combobox', { name: '图片生成描述' })
  await expect(prompt).toBeVisible()
  await prompt.fill('人物从院门走入 @')
  await expect(page.getByRole('listbox', { name: '选择参考素材' })).toBeVisible()
  await prompt.press('Enter')
  await expect(prompt).toHaveValue('人物从院门走入 @1 ')

  await editor
    .getByRole('button', { name: '生成详情：16:9 · 1K · 1张' })
    .click()
  const settings = page.getByRole('dialog', { name: '图片生成设置' })
  await settings.getByRole('button', { name: '9:16' }).click()
  await settings.getByRole('button', { name: '2K' }).click()
  await editor.getByRole('button', { name: /生成详情：/ }).click()
  await expect(
    editor.getByRole('button', { name: '生成详情：9:16 · 2K · 1张' }),
  ).toBeVisible()

  await editor.getByRole('button', { name: '开始生成' }).click()
  await expect(page.getByRole('dialog', { name: '确认生成任务' })).toHaveCount(0)

  // A populated canvas is durably persisted before polling starts. Keep the
  // progress assertion, but allow that safety barrier to finish on slower disks.
  await expect(page.getByText('生成中 42%')).toBeVisible({ timeout: 15_000 })
  const generated = page.locator('[data-generation-status="generating"]')
  const generatedNodeId = await generated.evaluate((element) =>
    element.closest('.react-flow__node')?.getAttribute('data-id'),
  )
  expect(generatedNodeId).toBe(targetNodeId)
  expect(submittedRequest).toMatchObject({
    providerId: 'aistartlab',
    catalogVersion: 'phase4-e2e-v1',
    model: 'gpt-image-2',
    quality: '2K',
    aspectRatio: '9:16',
    prompt: '人物从院门走入 @1',
    references: [
      {
        alias: 1,
        assetId: assetIds[1],
        mediaType: 'image',
      },
    ],
  })

  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  const restored = page.locator(
    `.react-flow__node[data-id="${generatedNodeId}"] [data-generation-status]`,
  )
  await expect(restored).toHaveAttribute('data-generation-status', 'complete')
  await expect(restored.locator('img')).toHaveAttribute(
    'src',
    `/api/assets/${outputAssetId}`,
  )
  await target.click()
  const restoredEditor = page.locator('[data-node-editor="image"]')
  await expect(restoredEditor.getByLabel('参考 @1：phase4-reference.png')).toBeVisible()
  await expect(
    restoredEditor.getByRole('combobox', { name: '图片生成描述' }),
  ).toHaveValue('人物从院门走入 @1 ')
  expect(generationPosts).toBe(1)
})

test('recovers an ambiguous create with the same idempotency key and no new paid request semantics', async ({
  page,
}) => {
  const jobId = '55555555-5555-4555-8555-555555555555'
  const outputAssetId = '66666666-6666-4666-8666-666666666666'
  const submittedRequests: GenerationRequest[] = []

  await page.route('**/api/assets/*', async (route) => {
    await route.fulfill({ contentType: 'image/png', body: png })
  })
  await page.route('**/api/generation-jobs', async (route) => {
    const request = route.request().postDataJSON() as GenerationRequest
    submittedRequests.push(request)
    if (submittedRequests.length === 1) {
      await route.abort('failed')
      return
    }
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ job: job(jobId, request, 'queued', 0) }),
    })
  })
  await page.route(`**/api/generation-jobs/${jobId}`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        job: job(
          jobId,
          submittedRequests.at(-1)!,
          'complete',
          100,
          outputAssetId,
        ),
      }),
    })
  })

  await page.goto('/canvas?spaceId=local&projectId=reference')
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  await page.getByRole('button', { name: '上传媒体 U' }).click()
  await page
    .getByRole('menu', { name: '添加节点' })
    .getByRole('menuitem', { name: '图片', exact: true })
    .click()

  const source = page.locator('.react-flow__node-image.selected')
  const editor = page.locator('[data-node-editor="image"]')
  await expect(editor.getByText('GPT Image 2 Low')).toBeVisible()
  const prompt = editor.getByRole('combobox', { name: '图片生成描述' })
  await expect(prompt).toBeVisible()
  await prompt.fill('薄雾中的院落建立镜头')
  await editor.getByRole('button', { name: '开始生成' }).click()
  await expect(page.getByRole('dialog', { name: '确认生成任务' })).toHaveCount(0)

  const recover = editor.getByRole('button', { name: '恢复生成' })
  await expect(recover).toBeEnabled()
  await expect(editor.getByRole('alert')).toContainText(
    'retry manually with the same request',
  )
  await recover.click()

  const recovered = source.locator('[data-generation-status]')
  await expect(recovered).toHaveAttribute('data-generation-status', 'complete')
  await expect(recovered.locator('img')).toHaveAttribute(
    'src',
    `/api/assets/${outputAssetId}`,
  )
  expect(submittedRequests).toHaveLength(2)
  expect(submittedRequests[1]!.clientRequestId).toBe(
    submittedRequests[0]!.clientRequestId,
  )
})
