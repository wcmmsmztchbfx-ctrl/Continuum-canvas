import fs from 'node:fs'
import path from 'node:path'

import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'

const viewport = { width: 2552, height: 1308 }

test.use({ viewport })

test('stays within the primary screenshot fidelity budget', async ({ page }) => {
  test.setTimeout(75_000)
  await page.goto('/canvas?spaceId=local&projectId=reference')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(37)
  await page.waitForFunction(
    () => {
      const images = Array.from(document.querySelectorAll('img'))
      const videos = Array.from(document.querySelectorAll('video'))
      return (
        images.every((image) => image.complete && image.naturalWidth > 0) &&
        videos.every((video) => !video.currentSrc || video.readyState >= 1)
      )
    },
    undefined,
    { timeout: 60_000 },
  )

  await page.locator('img').evaluateAll(async (images) => {
    await Promise.all(images.map((image) => image.decode()))
  })

  await page.locator('video').evaluateAll((videos) => {
    for (const video of videos) video.pause()
  })
  await page.waitForTimeout(250)

  const actualBytes = await page.screenshot({ animations: 'disabled' })
  const referencePath = path.resolve(
    'tests/visual/reference/canvas-primary-2552x1308.png',
  )
  const currentPath = path.resolve(
    'tests/visual/current/canvas-primary-2552x1308.png',
  )
  fs.mkdirSync(path.dirname(currentPath), { recursive: true })
  fs.writeFileSync(currentPath, actualBytes)

  const expected = PNG.sync.read(fs.readFileSync(referencePath))
  const actual = PNG.sync.read(actualBytes)
  expect({ width: actual.width, height: actual.height }).toEqual(viewport)

  let absoluteDifference = 0
  let exactPixels = 0
  let maskIntersection = 0
  let maskUnion = 0
  const pixelCount = viewport.width * viewport.height

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4
    const redDiff = Math.abs(expected.data[offset] - actual.data[offset])
    const greenDiff = Math.abs(
      expected.data[offset + 1] - actual.data[offset + 1],
    )
    const blueDiff = Math.abs(
      expected.data[offset + 2] - actual.data[offset + 2],
    )
    absoluteDifference += redDiff + greenDiff + blueDiff
    if (redDiff === 0 && greenDiff === 0 && blueDiff === 0) exactPixels += 1

    const y = Math.floor(pixel / viewport.width)
    if (y < 80 || y >= 1200) continue

    const expectedMask = Math.max(
      Math.abs(expected.data[offset] - 20),
      Math.abs(expected.data[offset + 1] - 20),
      Math.abs(expected.data[offset + 2] - 20),
    ) > 20
    const actualMask = Math.max(
      Math.abs(actual.data[offset] - 20),
      Math.abs(actual.data[offset + 1] - 20),
      Math.abs(actual.data[offset + 2] - 20),
    ) > 20

    if (expectedMask || actualMask) maskUnion += 1
    if (expectedMask && actualMask) maskIntersection += 1
  }

  const meanAbsoluteError = absoluteDifference / (pixelCount * 3)
  const exactPixelRatio = exactPixels / pixelCount
  const canvasMaskIoU = maskIntersection / maskUnion

  expect(meanAbsoluteError).toBeLessThan(3)
  expect(exactPixelRatio).toBeGreaterThan(0.75)
  expect(canvasMaskIoU).toBeGreaterThan(0.75)
})
