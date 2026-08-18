import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import viteConfig from '../vite.config.ts'
import { PROJECT_ROOT, resolveMainOptions, runMain } from './main.ts'

describe('runtime bootstrap', () => {
  it('starts with resolved options and closes once when a termination signal arrives', async () => {
    const signals = new EventEmitter()
    const close = vi.fn(async () => {})
    const start = vi.fn(async () => ({ close, origin: 'http://127.0.0.1:4174' }))

    await runMain({
      args: [],
      env: {},
      rootDir: 'D:/app',
      start: start as never,
      signals,
      log: () => {},
    })
    signals.emit('SIGTERM')
    signals.emit('SIGINT')

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', port: 4174 }))
  })

  it('uses repository env file values when no higher-priority source is present', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'libtv-bootstrap-'))
    await writeFile(join(rootDir, '.env.local'), [
      'CANVAS_GATEWAY_HOST=127.0.0.9',
      'CANVAS_GATEWAY_PORT=5101',
      'CANVAS_DATA_DIR=file-data',
      'CANVAS_ASSET_IMPORT_TIMEOUT_MS=91000',
      'CANVAS_GENERATION_MAX_RUN_TIME_MS=1800001',
      'API_PROVIDER_AISTARTLAB_KEY=file-secret',
      '',
    ].join('\n'))

    const resolved = await resolveMainOptions([], {}, rootDir)

    expect(resolved).toEqual(expect.objectContaining({
      host: '127.0.0.9',
      port: 5101,
      dataDir: join(rootDir, 'file-data'),
      assetImportTimeoutMs: 91_000,
      generationMaxRunTimeMs: 1_800_001,
    }))
    expect(resolved.env.API_PROVIDER_AISTARTLAB_KEY).toBe('file-secret')
  })

  it('uses process env values over repository env file values', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'libtv-bootstrap-'))
    await writeFile(join(rootDir, '.env.local'), [
      'CANVAS_GATEWAY_HOST=127.0.0.9',
      'CANVAS_GATEWAY_PORT=5101',
      'CANVAS_DATA_DIR=file-data',
      'CANVAS_ASSET_IMPORT_TIMEOUT_MS=91000',
      'API_PROVIDER_AISTARTLAB_KEY=file-secret',
      '',
    ].join('\n'))

    const resolved = await resolveMainOptions([], {
      CANVAS_GATEWAY_HOST: '127.0.0.8',
      CANVAS_GATEWAY_PORT: '5102',
      CANVAS_DATA_DIR: 'process-data',
      CANVAS_ASSET_IMPORT_TIMEOUT_MS: '92000',
      CANVAS_GENERATION_MAX_RUN_TIME_MS: '1800002',
      API_PROVIDER_AISTARTLAB_KEY: 'process-secret',
    }, rootDir)

    expect(resolved).toEqual(expect.objectContaining({
      host: '127.0.0.8',
      port: 5102,
      dataDir: join(rootDir, 'process-data'),
      assetImportTimeoutMs: 92_000,
      generationMaxRunTimeMs: 1_800_002,
    }))
    expect(resolved.env.API_PROVIDER_AISTARTLAB_KEY).toBe('process-secret')
  })

  it('uses explicit startup options over process env values', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'libtv-bootstrap-'))
    await writeFile(join(rootDir, '.env.local'), [
      'CANVAS_GATEWAY_HOST=127.0.0.9',
      'CANVAS_GATEWAY_PORT=5101',
      'CANVAS_DATA_DIR=file-data',
      'CANVAS_ASSET_IMPORT_TIMEOUT_MS=91000',
      'API_PROVIDER_AISTARTLAB_KEY=file-secret',
      '',
    ].join('\n'))

    const resolved = await resolveMainOptions([], {
      CANVAS_GATEWAY_HOST: '127.0.0.8',
      CANVAS_GATEWAY_PORT: '5102',
      CANVAS_DATA_DIR: 'process-data',
      CANVAS_ASSET_IMPORT_TIMEOUT_MS: '92000',
      CANVAS_GENERATION_MAX_RUN_TIME_MS: '1800002',
      API_PROVIDER_AISTARTLAB_KEY: 'process-secret',
    }, rootDir, {
      host: '127.0.0.7',
      port: 5103,
      dataDir: 'explicit-data',
      assetImportTimeoutMs: 93_000,
      generationMaxRunTimeMs: 1_800_003,
      env: { API_PROVIDER_AISTARTLAB_KEY: 'explicit-secret' },
    })

    expect(resolved).toEqual(expect.objectContaining({
      rootDir,
      host: '127.0.0.7',
      port: 5103,
      dataDir: join(rootDir, 'explicit-data'),
      envFile: join(rootDir, 'data', 'secrets.env'),
      assetImportTimeoutMs: 93_000,
      generationMaxRunTimeMs: 1_800_003,
    }))
    expect(resolved.env.API_PROVIDER_AISTARTLAB_KEY).toBe('explicit-secret')
  })

  it('resolves configurable env and data paths from the project root', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'libtv-bootstrap-'))
    await mkdir(join(rootDir, 'config'))
    await writeFile(join(rootDir, 'config', 'gateway.env'), 'CANVAS_DATA_DIR=runtime-data\n')

    const resolved = await resolveMainOptions([], {
      CANVAS_ENV_FILE: 'config/gateway.env',
    }, rootDir)

    expect(resolved.envFile).toBe(join(rootDir, 'config', 'gateway.env'))
    expect(resolved.dataDir).toBe(join(rootDir, 'runtime-data'))
  })

  it('defaults to the module project root instead of the caller working directory', async () => {
    const start = vi.fn(async () => ({ close: async () => {}, origin: 'http://127.0.0.1:4174' }))

    await runMain({ args: [], processEnv: {}, start: start as never, signals: new EventEmitter() })

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: PROJECT_ROOT,
      dataDir: join(PROJECT_ROOT, 'data'),
      envFile: join(PROJECT_ROOT, 'data', 'secrets.env'),
      assetImportTimeoutMs: 90_000,
      generationMaxRunTimeMs: 1_800_000,
    }))
  })

  it.each(['0', '-1', '600001', 'Infinity'])(
    'rejects an unsafe remote asset timeout from the environment: %s',
    async (assetImportTimeoutMs) => {
      await expect(resolveMainOptions([], {
        CANVAS_ASSET_IMPORT_TIMEOUT_MS: assetImportTimeoutMs,
      })).rejects.toThrow('CANVAS_ASSET_IMPORT_TIMEOUT_MS')
    },
  )

  it.each(['0', '-1', '59999', '86400001', 'Infinity'])(
    'rejects an unsafe generation run-time limit from the environment: %s',
    async (generationMaxRunTimeMs) => {
      await expect(resolveMainOptions([], {
        CANVAS_GENERATION_MAX_RUN_TIME_MS: generationMaxRunTimeMs,
      })).rejects.toThrow('CANVAS_GENERATION_MAX_RUN_TIME_MS')
    },
  )

  it('configures the public scripts and Vite API proxy without changing the client port', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(packageJson.scripts).toEqual(expect.objectContaining({
      dev: 'node scripts/dev.mjs',
      server: 'node server/main.ts',
      start: 'node server/main.ts --production',
    }))
    expect(packageJson.engines).toEqual(expect.objectContaining({ node: '>=22.18.0' }))
    expect(Object.values(packageJson.scripts).every((script) => (
      typeof script === 'string' && !/^(set |export |rm |cp |mv |mkdir )/.test(script)
    ))).toBe(true)
    const config = typeof viteConfig === 'function' ? viteConfig({ command: 'serve', mode: 'development' } as never) : viteConfig
    expect(config.server).toEqual(expect.objectContaining({
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      proxy: { '/api': expect.objectContaining({ target: 'http://127.0.0.1:4174', ws: true }) },
    }))
  })

  it('keeps local data and secrets ignored and the lockfile on the public npm registry', async () => {
    const [gitignore, packageLockSource] = await Promise.all([
      readFile(new URL('../.gitignore', import.meta.url), 'utf8'),
      readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
    ])
    const packageLock = JSON.parse(packageLockSource)

    expect(gitignore).toMatch(/^data\/$/m)
    expect(gitignore).toMatch(/^secrets\/$/m)
    expect(gitignore).toMatch(/^\.env\.\*$/m)
    expect(gitignore).toMatch(/^!\.env\.example$/m)
    expect(packageLock.packages[''].engines).toEqual(expect.objectContaining({ node: '>=22.18.0' }))
    expect(packageLockSource).not.toContain('registry.npmmirror.com')
  })
})

describe('development process supervision', () => {
  it('terminates the sibling and resolves with the first failing child code', async () => {
    const { superviseChildren } = await import('../scripts/dev.mjs')
    const gateway = Object.assign(new EventEmitter(), { kill: vi.fn(), exitCode: null })
    const vite = Object.assign(new EventEmitter(), { kill: vi.fn(), exitCode: null })

    const result = superviseChildren([gateway, vite], new EventEmitter())
    gateway.emit('exit', 7, null)

    await expect(result).resolves.toBe(7)
    expect(vite.kill).toHaveBeenCalledTimes(1)
  })

  it('forwards a termination signal exactly once to each child', async () => {
    const { superviseChildren } = await import('../scripts/dev.mjs')
    const signals = new EventEmitter()
    const gateway = Object.assign(new EventEmitter(), { kill: vi.fn(), exitCode: null })
    const vite = Object.assign(new EventEmitter(), { kill: vi.fn(), exitCode: null })

    const result = superviseChildren([gateway, vite], signals)
    signals.emit('SIGINT')

    await expect(result).resolves.toBe(130)
    expect(gateway.kill).toHaveBeenCalledOnce()
    expect(gateway.kill).toHaveBeenCalledWith('SIGINT')
    expect(vite.kill).toHaveBeenCalledOnce()
    expect(vite.kill).toHaveBeenCalledWith('SIGINT')
  })
})
