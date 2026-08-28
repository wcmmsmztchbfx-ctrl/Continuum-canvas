import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startGateway } from './http-gateway.ts'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'continuum-sys-test-'))
}

describe('System Routes', () => {
  it('returns storage info and clears cache', async () => {
    const dataDir = await tempDir()
    const stagingDir = join(dataDir, 'staging')
    await mkdir(stagingDir, { recursive: true })
    await writeFile(join(stagingDir, 'temp-image-1.png'), Buffer.from('hello-world-12345'))

    const gateway = await startGateway({
      dataDir,
      host: '127.0.0.1',
      port: 0,
    })

    try {
      // 1. GET /api/system/storage-info
      const infoRes = await fetch(`${gateway.origin}/api/system/storage-info`)
      expect(infoRes.status).toBe(200)
      const info = await infoRes.json()
      expect(info.fileCount).toBeGreaterThanOrEqual(1)
      expect(info.totalCacheBytes).toBeGreaterThan(0)

      // 2. GET /api/system/version
      const verRes = await fetch(`${gateway.origin}/api/system/version`)
      expect(verRes.status).toBe(200)
      const ver = await verRes.json()
      expect(ver.version).toBe('1.2.0')
      expect(ver.name).toBe('Continuum Canvas')

      // Obtain local admin cookie
      const sessionRes = await fetch(`${gateway.origin}/api/local-admin/session`, { method: 'POST' })
      const cookie = sessionRes.headers.get('set-cookie') ?? ''

      // 3. POST /api/system/clear-cache
      const clearRes = await fetch(`${gateway.origin}/api/system/clear-cache`, {
        method: 'POST',
        headers: cookie ? { cookie } : {},
      })
      expect(clearRes.status).toBe(200)
      const clearData = await clearRes.json()
      expect(clearData.success).toBe(true)
      expect(clearData.freedBytes).toBeGreaterThan(0)

      // 4. Verify storage is now cleared
      const afterInfoRes = await fetch(`${gateway.origin}/api/system/storage-info`)
      const afterInfo = await afterInfoRes.json()
      expect(afterInfo.stagingBytes).toBe(0)
    } finally {
      await gateway.close()
    }
  })
})
