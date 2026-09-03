import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JimengAdapter } from './providers/jimeng-adapter.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'continuum-jimeng-'))
}

describe('JimengAdapter', () => {
  it('syncs Jimeng 3.0 and 2.1 model catalog', async () => {
    const adapter = new JimengAdapter({
      stagingDir: await tempDirectory(),
    })

    const catalog = await adapter.syncCatalog()
    expect(catalog.providerId).toBe('jimeng')
    expect(catalog.models.some((m) => m.model === 'jimeng-image-v3.0')).toBe(true)
    expect(catalog.models.some((m) => m.model === 'jimeng-video-v3.0')).toBe(true)
  })

  it('rejects with installation guidance when CLI executable is missing', async () => {
    const adapter = new JimengAdapter({
      cliPath: 'non-existent-dreamina-binary-xyz',
      stagingDir: await tempDirectory(),
    })

    await expect(adapter.testConnection()).rejects.toThrow('dreamina CLI')
  })
})
