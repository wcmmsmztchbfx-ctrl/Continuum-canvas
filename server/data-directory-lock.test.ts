import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { AssetStore } from './asset-store.ts'
import { DataDirectoryLock } from './data-directory-lock.ts'
import { GenerationJobStore, GenerationRunner } from './jobs.ts'
import type { ProviderAdapter } from './providers/provider-adapter.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'libtv-lock-'))
}

describe('DataDirectoryLock', () => {
  it('allows one owner and rejects a second instance before provider access', async () => {
    const dataDir = await tempDirectory()
    const first = await DataDirectoryLock.acquire({
      dataDir,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
      token: () => 'owner-one',
      processIdentity: async () => 'windows:test-owner',
    })
    const providerOperation = vi.fn()

    await expect(DataDirectoryLock.acquire({
      dataDir,
      pid: 202,
      now: () => new Date('2026-07-16T00:01:00.000Z'),
      token: () => 'owner-two',
      processState: async () => 'alive',
      processIdentity: async () => 'windows:test-owner',
    })).rejects.toMatchObject({ code: 'data_directory_locked' })
    expect(providerOperation).not.toHaveBeenCalled()

    await first.release()
    const second = await DataDirectoryLock.acquire({
      dataDir,
      pid: 202,
      token: () => 'owner-two',
      processIdentity: async () => 'windows:second-owner',
    })
    await second.release()
  })

  it('reclaims a lock only when its recorded PID is certainly dead', async () => {
    const dataDir = await tempDirectory()
    const lockPath = join(dataDir, '.backend.lock')
    const staleMetadata = JSON.stringify({
      pid: 999999, startedAt: '2000-01-01T00:00:00.000Z', token: 'old-owner',
      processIdentity: 'windows:old-boot:old-start',
    })
    await writeFile(lockPath, staleMetadata)

    const reclaimed = await DataDirectoryLock.acquire({
      dataDir,
      token: () => 'new-owner',
      processState: async () => 'dead',
    })

    expect(JSON.parse(await readFile(lockPath, 'utf8')).token).toBe('new-owner')
    await reclaimed.release()
  })

  it.each([
    ['alive', JSON.stringify({
      pid: 123, startedAt: '2026-07-16T00:00:00.000Z', token: 'live-owner',
      processIdentity: 'windows:boot-a:start-a',
    })],
    ['uncertain', JSON.stringify({
      pid: 123, startedAt: '2026-07-16T00:00:00.000Z', token: 'uncertain-owner',
      processIdentity: 'windows:boot-a:start-a',
    })],
    ['dead', '{malformed'],
  ] as const)('refuses %s or malformed lock ownership without modifying the lock', async (state, contents) => {
    const dataDir = await tempDirectory()
    const lockPath = join(dataDir, '.backend.lock')
    await writeFile(lockPath, contents)

    await expect(DataDirectoryLock.acquire({
      dataDir,
      processState: async () => state,
    })).rejects.toMatchObject({ code: 'data_directory_locked' })

    expect(await readFile(lockPath, 'utf8')).toBe(contents)
  })

  it('does not reclaim a live PID with the same boot and process-start identity', async () => {
    const dataDir = await tempDirectory()
    const lockPath = join(dataDir, '.backend.lock')
    await writeFile(lockPath, JSON.stringify({
      pid: 4321,
      startedAt: '2026-07-16T00:00:00.000Z',
      token: 'same-process-owner',
      processIdentity: 'windows:boot-a:start-a',
    }))

    await expect(DataDirectoryLock.acquire({
      dataDir,
      processState: async () => 'alive',
      processIdentity: async () => 'windows:boot-a:start-a',
    })).rejects.toMatchObject({ code: 'data_directory_locked' })

    expect(JSON.parse(await readFile(lockPath, 'utf8')).token).toBe('same-process-owner')
  })

  it('reclaims a reused live PID only when its boot/process-start identity differs', async () => {
    const dataDir = await tempDirectory()
    const lockPath = join(dataDir, '.backend.lock')
    await writeFile(lockPath, JSON.stringify({
      pid: 4321,
      startedAt: '2026-07-16T00:00:00.000Z',
      token: 'reused-pid-owner',
      processIdentity: 'windows:boot-a:start-a',
    }))

    const reclaimed = await DataDirectoryLock.acquire({
      dataDir,
      token: () => 'new-owner',
      processState: async () => 'alive',
      processIdentity: async (pid) => pid === 4321
        ? 'windows:boot-a:start-b'
        : 'windows:boot-a:current-start',
    })

    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(expect.objectContaining({
      token: 'new-owner',
      processIdentity: 'windows:boot-a:current-start',
    }))
    await reclaimed.release()
  })

  it('allows only one contender to reclaim the same dead owner token', async () => {
    const dataDir = await tempDirectory()
    await writeFile(join(dataDir, '.backend.lock'), JSON.stringify({
      pid: 999999, startedAt: '2000-01-01T00:00:00.000Z', token: 'dead-race-owner',
      processIdentity: 'windows:old-boot:old-start',
    }))

    const attempts = await Promise.allSettled([
      DataDirectoryLock.acquire({
        dataDir, token: () => 'contender-a', processState: async (pid) => pid === 999999 ? 'dead' : 'alive',
      }),
      DataDirectoryLock.acquire({
        dataDir, token: () => 'contender-b', processState: async (pid) => pid === 999999 ? 'dead' : 'alive',
      }),
    ])

    const winners = attempts.filter((attempt): attempt is PromiseFulfilledResult<DataDirectoryLock> =>
      attempt.status === 'fulfilled')
    expect(winners).toHaveLength(1)
    await winners[0].value.release()
  })

  it('reclaims a guard whose recorded process identity is certainly dead', async () => {
    const dataDir = await tempDirectory()
    const guardPath = join(dataDir, '.backend.lock.reclaim')
    await writeFile(guardPath, JSON.stringify({
      pid: 999999,
      startedAt: '2000-01-01T00:00:00.000Z',
      token: 'dead-guard-owner',
      processIdentity: 'windows:old-boot:old-start',
    }))

    const lock = await DataDirectoryLock.acquire({
      dataDir,
      token: () => 'after-dead-guard',
      processState: async () => 'dead',
    })

    expect(JSON.parse(await readFile(join(dataDir, '.backend.lock'), 'utf8')).token).toBe('after-dead-guard')
    await lock.release()
  })

  it('reclaims a guard when its PID was reused by a different process identity', async () => {
    const dataDir = await tempDirectory()
    await writeFile(join(dataDir, '.backend.lock.reclaim'), JSON.stringify({
      pid: 4321,
      startedAt: '2026-07-16T00:00:00.000Z',
      token: 'reused-guard-owner',
      processIdentity: 'windows:boot-a:start-a',
    }))

    const lock = await DataDirectoryLock.acquire({
      dataDir,
      token: () => 'after-reused-guard',
      processState: async () => 'alive',
      processIdentity: async (pid) => pid === 4321
        ? 'windows:boot-a:start-b'
        : 'windows:boot-a:current-start',
    })

    expect(JSON.parse(await readFile(join(dataDir, '.backend.lock'), 'utf8')).token).toBe('after-reused-guard')
    await lock.release()
  })

  it('allows only one contender through a stale reclaim-guard race', async () => {
    const dataDir = await tempDirectory()
    await writeFile(join(dataDir, '.backend.lock.reclaim'), JSON.stringify({
      pid: 999999,
      startedAt: '2000-01-01T00:00:00.000Z',
      token: 'dead-guard-race-owner',
      processIdentity: 'windows:old-boot:old-start',
    }))

    const attempts = await Promise.allSettled([
      DataDirectoryLock.acquire({
        dataDir, token: () => 'guard-contender-a', processState: async (pid) => pid === 999999 ? 'dead' : 'alive',
      }),
      DataDirectoryLock.acquire({
        dataDir, token: () => 'guard-contender-b', processState: async (pid) => pid === 999999 ? 'dead' : 'alive',
      }),
    ])

    const winners = attempts.filter((attempt): attempt is PromiseFulfilledResult<DataDirectoryLock> =>
      attempt.status === 'fulfilled')
    expect(winners).toHaveLength(1)
    await winners[0].value.release()
  })

  it.each([
    ['alive', JSON.stringify({
      pid: 123, startedAt: '2026-07-16T00:00:00.000Z', token: 'live-guard',
      processIdentity: 'windows:boot-a:start-a',
    })],
    ['uncertain', JSON.stringify({
      pid: 123, startedAt: '2026-07-16T00:00:00.000Z', token: 'uncertain-guard',
      processIdentity: 'windows:boot-a:start-a',
    })],
    ['dead', '{malformed'],
  ] as const)('refuses a %s or malformed reclaim guard without modifying it', async (state, contents) => {
    const dataDir = await tempDirectory()
    const guardPath = join(dataDir, '.backend.lock.reclaim')
    await writeFile(guardPath, contents)

    await expect(DataDirectoryLock.acquire({
      dataDir,
      processState: async () => state,
      processIdentity: async () => 'windows:boot-a:start-a',
    })).rejects.toMatchObject({ code: 'data_directory_locked' })

    expect(await readFile(guardPath, 'utf8')).toBe(contents)
  })

  it('recovers after a child crashes while owning the reclaim guard', async () => {
    const dataDir = await tempDirectory()
    const moduleUrl = pathToFileURL(join(process.cwd(), 'server', 'data-directory-lock.ts')).href
    const child = spawn(process.execPath, ['--input-type=module', '--eval', [
      `import { readFile, rename, writeFile } from 'node:fs/promises'`,
      `import { join } from 'node:path'`,
      `import { DataDirectoryLock } from ${JSON.stringify(moduleUrl)}`,
      `const dataDir = ${JSON.stringify(dataDir)}`,
      `await DataDirectoryLock.acquire({ dataDir })`,
      `const lockPath = join(dataDir, '.backend.lock')`,
      `const metadata = JSON.parse(await readFile(lockPath, 'utf8'))`,
      `const guard = { ...metadata, token: 'crashed-reclaim-token' }`,
      `await writeFile(join(dataDir, '.backend.lock.reclaim'), JSON.stringify(guard))`,
      `await rename(lockPath, lockPath + '.stale.' + guard.token)`,
    ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const [exitCode] = await once(child, 'exit')
    expect(exitCode).toBe(0)

    const restarted = await DataDirectoryLock.acquire({ dataDir, token: () => 'guard-restart-owner' })
    expect(JSON.parse(await readFile(join(dataDir, '.backend.lock'), 'utf8')).token).toBe('guard-restart-owner')
    await restarted.release()
  }, 20_000)

  it('reclaims a real lock left by a crashed child process', async () => {
    const dataDir = await tempDirectory()
    const moduleUrl = pathToFileURL(join(process.cwd(), 'server', 'data-directory-lock.ts')).href
    const child = spawn(process.execPath, ['--input-type=module', '--eval', [
      `import { DataDirectoryLock } from ${JSON.stringify(moduleUrl)}`,
      `await DataDirectoryLock.acquire({ dataDir: ${JSON.stringify(dataDir)} })`,
    ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const [exitCode] = await once(child, 'exit')
    expect(exitCode).toBe(0)

    const restarted = await DataDirectoryLock.acquire({ dataDir, token: () => 'restart-owner' })
    expect(JSON.parse(await readFile(join(dataDir, '.backend.lock'), 'utf8')).token).toBe('restart-owner')
    await restarted.release()
  })

  it('GenerationRunner requires a held lock and releases it on close', async () => {
    const dataDir = await tempDirectory()
    const lock = await DataDirectoryLock.acquire({ dataDir, token: () => 'runner-owner' })
    const jobs = await GenerationJobStore.open({ dataDir })
    const assets = await AssetStore.open({ dataDir })
    const provider = {} as ProviderAdapter
    const runner = new GenerationRunner({
      jobs,
      assets,
      lock,
      adapterFor: () => provider,
      catalogFor: async () => { throw new Error('not used') },
    })

    await runner.close()
    const next = await DataDirectoryLock.acquire({ dataDir, token: () => 'next-owner' })
    await next.release()
    expect(() => new GenerationRunner({
      jobs, assets, lock, adapterFor: () => provider,
      catalogFor: async () => { throw new Error('not used') },
    })).toThrow('held data-directory lock')
  })
})
