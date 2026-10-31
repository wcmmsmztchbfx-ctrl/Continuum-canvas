import { describe, expect, it } from 'vitest'
import { readMediaPreview, writeMediaPreview } from './mediaPreviewStorage'
describe('disposable preview storage', () => {
  it('degrades safely when IndexedDB is unavailable', async () => {
    expect(await readMediaPreview('missing')).toBeUndefined()
    await expect(writeMediaPreview('new', new Blob(['preview']))).resolves.toBeUndefined()
  })
})
