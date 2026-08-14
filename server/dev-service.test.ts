import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'

describe('persistent development service', () => {
  it('builds a detached child that cannot inherit the launching terminal', async () => {
    const { createDetachedSpawnOptions } = await import('../scripts/dev-service.mjs')
    const options = createDetachedSpawnOptions('D:\\workspace', { TEST_FLAG: 'yes' }, 11, 12)

    expect(options).toEqual(expect.objectContaining({
      cwd: 'D:\\workspace',
      detached: true,
      windowsHide: true,
      env: expect.objectContaining({ TEST_FLAG: 'yes' }),
      stdio: ['ignore', 11, 12],
    }))
  })

  it('distinguishes running, unhealthy, and stopped services', async () => {
    const { inspectService } = await import('../scripts/dev-service.mjs')
    const alive = vi.fn().mockReturnValue(true)

    await expect(inspectService({ pid: 42 }, { isAlive: alive, healthCheck: async () => true }))
      .resolves.toEqual({ status: 'running', pid: 42 })
    await expect(inspectService({ pid: 42 }, { isAlive: alive, healthCheck: async () => false }))
      .resolves.toEqual({ status: 'unhealthy', pid: 42 })
    await expect(inspectService({ pid: 42 }, { isAlive: () => false, healthCheck: async () => true }))
      .resolves.toEqual({ status: 'stopped', pid: 42 })
  })

  it('exposes portable service commands and ignores runtime state', async () => {
    const [packageSource, gitignore] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../.gitignore', import.meta.url), 'utf8'),
    ])
    const packageJson = JSON.parse(packageSource)

    expect(packageJson.scripts).toEqual(expect.objectContaining({
      'dev:service': 'node scripts/dev-service.mjs start',
      'dev:status': 'node scripts/dev-service.mjs status',
      'dev:stop': 'node scripts/dev-service.mjs stop',
    }))
    expect(gitignore).toMatch(/^\.runtime\/$/m)
  })
})
