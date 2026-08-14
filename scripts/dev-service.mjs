import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { selectPrivateLanAddress } from './dev-network.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultRootDir = join(scriptDir, '..')

export function createDetachedSpawnOptions(rootDir, env, stdoutFd, stderrFd) {
  return {
    cwd: rootDir,
    detached: true,
    windowsHide: true,
    env,
    stdio: ['ignore', stdoutFd, stderrFd],
  }
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function inspectService(state, dependencies = {}) {
  const alive = dependencies.isAlive ?? isProcessAlive
  if (!state || !alive(state.pid)) {
    return { status: 'stopped', ...(state?.pid ? { pid: state.pid } : {}) }
  }
  const healthy = await (dependencies.healthCheck ?? checkDevelopmentHealth)()
  return { status: healthy ? 'running' : 'unhealthy', pid: state.pid }
}

function servicePaths(rootDir = defaultRootDir) {
  const runtimeDir = join(rootDir, '.runtime')
  return {
    runtimeDir,
    stateFile: join(runtimeDir, 'dev-service.json'),
    stdoutLog: join(runtimeDir, 'dev-service.out.log'),
    stderrLog: join(runtimeDir, 'dev-service.err.log'),
  }
}

function readState(paths) {
  if (!existsSync(paths.stateFile)) return undefined
  try {
    const state = JSON.parse(readFileSync(paths.stateFile, 'utf8'))
    return Number.isSafeInteger(state.pid) ? state : undefined
  } catch {
    return undefined
  }
}

function writeState(paths, state) {
  mkdirSync(paths.runtimeDir, { recursive: true })
  const temporaryFile = `${paths.stateFile}.${process.pid}.tmp`
  writeFileSync(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporaryFile, paths.stateFile)
}

async function endpointIsHealthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

export async function checkDevelopmentHealth(env = process.env) {
  const gatewayPort = env.CANVAS_GATEWAY_PORT ?? env.GATEWAY_PORT ?? '4174'
  const results = await Promise.all([
    endpointIsHealthy('http://127.0.0.1:4173/'),
    endpointIsHealthy(`http://127.0.0.1:${gatewayPort}/api/health`),
  ])
  return results.every(Boolean)
}

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await checkDevelopmentHealth()) return true
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

function terminateProcessTree(pid) {
  if (!isProcessAlive(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    process.kill(pid, 'SIGTERM')
  }
}

async function startService(rootDir = defaultRootDir) {
  const paths = servicePaths(rootDir)
  const existing = readState(paths)
  const existingStatus = await inspectService(existing)
  if (existingStatus.status === 'running') {
    console.log(`Development service is already running (PID ${existingStatus.pid}).`)
    return
  }
  if (existingStatus.status === 'unhealthy') {
    terminateProcessTree(existingStatus.pid)
  }
  rmSync(paths.stateFile, { force: true })
  mkdirSync(paths.runtimeDir, { recursive: true })

  const stdoutFd = openSync(paths.stdoutLog, 'a')
  const stderrFd = openSync(paths.stderrLog, 'a')
  let child
  try {
    child = spawn(
      process.execPath,
      [join(rootDir, 'scripts', 'dev.mjs')],
      createDetachedSpawnOptions(rootDir, process.env, stdoutFd, stderrFd),
    )
    child.unref()
  } finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  }

  writeState(paths, {
    version: 1,
    pid: child.pid,
    startedAt: new Date().toISOString(),
  })

  if (!await waitForHealth()) {
    terminateProcessTree(child.pid)
    rmSync(paths.stateFile, { force: true })
    throw new Error(`Development service did not become healthy. See ${paths.stderrLog}`)
  }
  console.log(`Development service started (PID ${child.pid}).`)
  console.log('Frontend: http://127.0.0.1:4173/')
  const lanAddress = selectPrivateLanAddress()
  if (lanAddress) {
    console.log(`LAN share: http://${lanAddress}:4173/`)
    console.log('If another device cannot connect, allow TCP port 4173 through Windows Firewall.')
  } else {
    console.log('LAN share unavailable: no private IPv4 network adapter was detected.')
  }
  console.log(`Logs: ${paths.runtimeDir}`)
}

async function statusService(rootDir = defaultRootDir) {
  const paths = servicePaths(rootDir)
  const state = readState(paths)
  const status = await inspectService(state)
  console.log(JSON.stringify({ ...status, logs: paths.runtimeDir }))
  if (status.status !== 'running') process.exitCode = 1
}

async function stopService(rootDir = defaultRootDir) {
  const paths = servicePaths(rootDir)
  const state = readState(paths)
  if (state?.pid) terminateProcessTree(state.pid)
  rmSync(paths.stateFile, { force: true })
  console.log('Development service stopped.')
}

async function main() {
  const command = process.argv[2] ?? 'status'
  if (command === 'start') return startService()
  if (command === 'status') return statusService()
  if (command === 'stop') return stopService()
  throw new Error(`Unknown command: ${command}`)
}

const isMainModule = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
