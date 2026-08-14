import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalAdminAuthorizationError, LocalAdminService } from './local-admin-service.ts'

describe('LocalAdminService', () => {
  it('persists only a SHA-256 digest and restores the same cookie after restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-admin-'))
    const service = await LocalAdminService.open({ dataDir })
    const registered = await service.registerOrResume()
    expect(registered.token).toBeTruthy()
    const persisted = await readFile(join(dataDir, 'local-admin.json'), 'utf8')
    expect(persisted).not.toContain(registered.token as string)
    expect(JSON.parse(persisted)).toEqual(expect.objectContaining({
      version: 1, tokenDigest: expect.stringMatching(/^[a-f0-9]{64}$/), createdAt: expect.any(String),
    }))
    const reopened = await LocalAdminService.open({ dataDir })
    expect(() => reopened.authorize(registered.token as string)).not.toThrow()
    expect(() => reopened.authorize('wrong')).toThrow(LocalAdminAuthorizationError)
  })

  it('serializes concurrent first registration so exactly one caller wins', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-admin-race-'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const writeJson = vi.fn(async () => { await gate })
    const service = await LocalAdminService.open({ dataDir, writeJson })
    const first = service.registerOrResume()
    const second = service.registerOrResume()
    await vi.waitFor(() => expect(writeJson).toHaveBeenCalledTimes(1))
    release()
    const results = await Promise.allSettled([first, second])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('rotates a lost session only when trusted local recovery is explicitly allowed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-admin-recovery-'))
    const tokens = ['a'.repeat(43), 'b'.repeat(43)]
    const service = await LocalAdminService.open({
      dataDir,
      createToken: () => tokens.shift() as string,
    })
    const first = await service.registerOrResume()

    await expect(service.registerOrResume()).rejects.toBeInstanceOf(LocalAdminAuthorizationError)
    const recovered = await service.registerOrResume('', { allowRecovery: true })

    expect(recovered).toEqual({ created: false, token: 'b'.repeat(43) })
    expect(() => service.authorize(first.token as string)).toThrow(LocalAdminAuthorizationError)
    expect(() => service.authorize(recovered.token as string)).not.toThrow()
  })
})
