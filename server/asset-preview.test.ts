import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { AssetPreviewStore } from './asset-preview.ts'
import { AssetStore } from './asset-store.ts'

async function fixture(run: (store: AssetStore, dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-preview-'))
  try { await run(await AssetStore.open({ dataDir }), dataDir) }
  finally { await rm(dataDir, { recursive: true, force: true }) }
}
describe('local asset previews', () => {
  it('delivers actual lower resolution bytes on a cold cache and retains originals', () => fixture(async (store, dir) => {
    const original = await sharp({ create: { width: 4096, height: 2048, channels: 4, background: '#36aacc80' } }).webp().toBuffer()
    const asset = await store.save({ filename: 'large.webp', contentType: 'image/webp', bytes: original })
    for (const size of [128, 360, 960, 1920]) {
      const result = await store.getPreview(asset.id, size)
      expect(result).toMatchObject({ originalWidth: 4096, originalHeight: 2048 })
      const metadata = await sharp(result!.bytes).metadata()
      expect(metadata.width).toBe(size); expect(metadata.height).toBe(size / 2)
      expect(metadata.hasAlpha).toBe(true)
    }
    expect(Buffer.from(await store.readBytes(asset.id))).toEqual(original)
    const restarted = await AssetStore.open({ dataDir: dir })
    expect((await restarted.getPreview(asset.id, 128))!.bytes).toEqual((await store.getPreview(asset.id, 128))!.bytes)
    expect(await readdir(join(dir, 'assets', 'previews-v1'))).toHaveLength(4)
  }))
  it('coalesces simultaneous requests and rejects unsupported dimensions', () => fixture(async store => {
    const bytes = await sharp({ create: { width: 2048, height: 1024, channels: 3, background: '#2088ff' } }).png().toBuffer()
    const asset = await store.save({ filename: 'large.png', contentType: 'image/png', bytes })
    const results = await Promise.all(Array.from({ length: 8 }, () => store.getPreview(asset.id, 360)))
    expect(results.every(value => value === results[0])).toBe(true)
    await expect(store.getPreview(asset.id, 999999)).rejects.toThrow()
    await expect(store.getPreview(asset.id, 128, AbortSignal.abort())).rejects.toThrow()
  }))
  it('isolates cancellation of shared consumers and bounds disposable disk storage', () => fixture(async (store, dir) => {
    const bytes = await sharp({ create: { width: 2048, height: 1024, channels: 3, background: '#2088ff' } }).png().toBuffer()
    const asset = await store.save({ filename: 'cache.png', contentType: 'image/png', bytes })
    const controller = new AbortController()
    const cancelled = store.getPreview(asset.id, 128, controller.signal)
    const live = store.getPreview(asset.id, 128)
    controller.abort()
    await expect(cancelled).rejects.toThrow()
    expect(await live).toMatchObject({ width: 128, height: 64 })
    const disposable = new AssetPreviewStore(join(dir, 'tiny-cache'), 0)
    expect(await disposable.get(asset.id, join(dir, 'assets/files', asset.id + '.bin'), 360)).toMatchObject({ width: 360 })
    expect(await readdir(join(dir, 'tiny-cache'))).toEqual([])
    expect(Buffer.from(await store.readBytes(asset.id))).toEqual(bytes)
  }))
  it('preserves animated WebP instead of silently freezing its first frame', () => fixture(async store => {
    const pixels = Buffer.alloc(4 * 8 * 4, 255)
    pixels.fill(0, 4 * 4 * 4)
    const bytes = await sharp(pixels, { raw: { width: 4, height: 8, channels: 4, pageHeight: 4 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer()
    expect((await sharp(bytes).metadata()).pages).toBe(2)
    const asset = await store.save({ filename: 'animated.webp', contentType: 'image/webp', bytes })
    expect(await store.getPreview(asset.id, 128)).toBeUndefined()
    expect(Buffer.from(await store.readBytes(asset.id))).toEqual(bytes)
  }))
})
