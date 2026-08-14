import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { loadEnv } from 'vite'
import { createLanDevelopmentEnvironment } from './dev-network.mjs'

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : 143
}

export function superviseChildren(children, signals = process) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (code, signal, source, terminateSiblings = true) => {
      if (settled) return
      settled = true
      if (terminateSiblings) {
        for (const child of children) {
          if (child !== source && child.exitCode === null) child.kill('SIGTERM')
        }
      }
      resolve(typeof code === 'number' ? code : signal ? signalExitCode(signal) : 1)
    }
    for (const child of children) {
      child.once('exit', (code, signal) => finish(code, signal, child))
      child.once('error', () => finish(1, null, child))
    }
    for (const signal of ['SIGINT', 'SIGTERM']) {
      signals.once(signal, () => {
        for (const child of children) {
          if (child.exitCode === null) child.kill(signal)
        }
        finish(null, signal, undefined, false)
      })
    }
  })
}

export async function runDevelopment(rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  const env = createLanDevelopmentEnvironment({
    ...loadEnv('development', rootDir, ''),
    ...process.env,
  })
  const gateway = spawn(process.execPath, ['server/main.ts'], {
    cwd: rootDir,
    env,
    stdio: 'inherit',
    windowsHide: true,
  })
  const vite = spawn(process.execPath, [join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js')], {
    cwd: rootDir,
    env,
    stdio: 'inherit',
    windowsHide: true,
  })
  return superviseChildren([gateway, vite])
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runDevelopment()
}
