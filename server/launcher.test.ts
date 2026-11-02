import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { assertRuntime, prepareApplication, assertPortAvailable, browserAddress, npmCommand } from '../scripts/launch.mjs'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('source download launcher', () => {
  it('serializes same-folder startup and releases its lock after success or failure', async () => {
    const { withStartupLock } = await import('../scripts/launch.mjs')
    expect(withStartupLock).toBeTypeOf('function')
    const directory = await mkdtemp(join(tmpdir(), 'continuum-startup-lock-')); directories.push(directory)
    let enter!: () => void; let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = withStartupLock(directory, async () => { enter(); await gate; return 'started' })
    await entered
    try { await expect(withStartupLock(directory, async () => 'second install')).rejects.toThrow(/另一个启动窗口/) }
    finally { release() }
    await expect(first).resolves.toBe('started')
    await expect(withStartupLock(directory, async () => { throw new Error('build failed') })).rejects.toThrow('build failed')
    await expect(withStartupLock(directory, async () => 'recovered')).resolves.toBe('recovered')
  })
  it('explains unsupported Node and npm versions before installing anything', () => {
    expect(() => assertRuntime('22.17.0', '10.9.0')).toThrow(/Node.js 22.18/)
    expect(() => assertRuntime('20.19.0', '10.9.0')).toThrow(/Node.js 22.18/)
    expect(() => assertRuntime('22.18.0', '9.9.0')).toThrow(/npm 10/)
    expect(() => assertRuntime('22.18.0', '10.0.0')).not.toThrow()
    expect(() => assertRuntime('24.0.0', '11.0.0')).not.toThrow()
  })

  it('uses fixed npm commands on Windows without embedding the project directory in shell text', () => {
    expect(npmCommand(['ci', '--include=dev'], 'win32')).toEqual({ command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm ci --include=dev'] })
    expect(npmCommand(['run', 'build'], 'linux')).toEqual({ command: 'npm', args: ['run', 'build'] })
    expect(() => npmCommand(['run', 'build & echo injected'], 'win32')).toThrow()
  })

  it('installs from the lockfile, skips a valid install on restart, rebuilds, and preserves local data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum launcher 空格 & '))
    directories.push(root)
    await mkdir(join(root, 'data')); await writeFile(join(root, 'data', 'kept.txt'), 'canvas content')
    await writeFile(join(root, '.env.local'), 'CANVAS_AGENT_RUNTIME_VERSION=1\n')
    const pkg = { name: 'launcher-fixture', version: '1.0.0', private: true, scripts: { build: 'node -e "require(\'fs\').writeFileSync(\'built.txt\', Date.now().toString())"' } }
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg))
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version } } }))
    const first = await prepareApplication(root, { npmVersion: '10.0.0', log: () => {} })
    expect(first.installed).toBe(true)
    const built = await readFile(join(root, 'built.txt'), 'utf8')
    const again = await prepareApplication(root, { npmVersion: '10.0.0', log: () => {} })
    expect(again.installed).toBe(false)
    expect(await readFile(join(root, 'built.txt'), 'utf8')).not.toBe(built)
    await writeFile(join(root, '.runtime', 'launch-install.json'), '{}')
    expect((await prepareApplication(root, { npmVersion: '10.0.0', log: () => {} })).installed).toBe(true)
    await writeFile(join(root, 'package-lock.json'), (await readFile(join(root, 'package-lock.json'), 'utf8')) + '\n')
    expect((await prepareApplication(root, { npmVersion: '10.0.0', log: () => {} })).installed).toBe(true)
    expect(await readFile(join(root, 'data', 'kept.txt'), 'utf8')).toBe('canvas content')
    expect(await readFile(join(root, '.env.local'), 'utf8')).toBe('CANVAS_AGENT_RUNTIME_VERSION=1\n')
  }, 30_000)

  it('does not cache a failed dependency installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-launch-fail-'))
    directories.push(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'failed-install', version: '1.0.0', scripts: { preinstall: 'node -e "process.exit(42)"' } }))
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'failed-install', version: '1.0.0' } } }))
    await expect(prepareApplication(root, { npmVersion: '10.0.0', log: () => {} })).rejects.toThrow()
    await expect(readFile(join(root, '.runtime', 'launch-install.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('reports an occupied port and leaves its existing server alive', async () => {
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try { await expect(assertPortAvailable('127.0.0.1', port)).rejects.toThrow(/已被占用/); expect(server.listening).toBe(true) }
    finally { await new Promise<void>(resolve => server.close(() => resolve())) }
    await expect(assertPortAvailable('127.0.0.1', port)).resolves.toBeUndefined()
  })

  it('runs the platform entry script and reports a port conflict before installing dependencies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-wrapper-')); directories.push(directory)
    const envFile = join(directory, 'empty.env'); await writeFile(envFile, '')
    const projectRoot = fileURLToPath(new URL('../', import.meta.url))
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const windows = process.platform === 'win32'
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(windows ? 'cmd.exe' : 'sh', windows ? ['/d', '/s', '/c', 'start.bat'] : [join(projectRoot, 'start.sh')], {
          cwd: windows ? projectRoot : directory,
          env: { ...process.env, CANVAS_ENV_FILE: envFile, CANVAS_GATEWAY_HOST: '127.0.0.1', CANVAS_GATEWAY_PORT: String(port), CANVAS_OPEN_BROWSER: '0' },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
        child.stdin.end(); child.once('error', reject); child.once('close', code => resolve({ code, output }))
      })
      expect(result.code).toBe(1)
      expect(result.output).toContain(`端口 ${port} 已被占用`)
      expect(result.output).not.toContain('安装锁定版本')
      expect(server.listening).toBe(true)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  }, 15_000)

  it('opens a usable loopback address for wildcard listeners and rejects shell metacharacters', () => {
    expect(browserAddress('http://0.0.0.0:4173')).toBe('http://127.0.0.1:4173/')
    expect(browserAddress('http://[::]:4173')).toBe('http://[::1]:4173/')
    expect(() => browserAddress('http://localhost:4173/?x=&echo')).toThrow()
  })
})
