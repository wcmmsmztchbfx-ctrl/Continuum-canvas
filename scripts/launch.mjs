import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const NODE_HELP = '需要 Node.js 22.18 或更高版本及 npm 10+。请安装 https://nodejs.org/ 的受支持 LTS 版本，然后重新启动。'

export function assertRuntime(nodeVersion, npmVersion) {
  const [major, minor] = nodeVersion.replace(/^v/, '').split('.').map(Number)
  if (!Number.isInteger(major) || major < 22 || (major === 22 && minor < 18)) throw new Error(NODE_HELP)
  if (npmVersion !== undefined && (!/^\d+\./.test(npmVersion) || Number(npmVersion.split('.')[0]) < 10)) throw new Error('需要 npm 10 或更高版本；重新安装 Node.js LTS 会同时安装 npm。')
}

export function npmCommand(args, platform = process.platform) {
  // Windows .cmd files require cmd.exe. Only fixed commands enter shell text;
  // project paths are passed via cwd, never interpolated into a command.
  const allowed = ['--version', 'ci --include=dev', 'run build']
  if (!allowed.includes(args.join(' '))) throw new Error('Unsupported npm command')
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', `npm ${args.join(' ')}`] }
    : { command: 'npm', args }
}

function runNpm(args, cwd, capture = false) {
  const command = npmCommand(args)
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, { cwd, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk; if (output.length > 100_000) child.kill() })
    child.stderr?.resume()
    const interrupt = () => child.kill('SIGTERM')
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt) }
    child.once('error', error => { cleanup(); reject(new Error(`无法运行 npm，请检查 Node.js 安装。(${error.code || 'spawn_failed'})`)) })
    child.once('close', (code, signal) => {
      cleanup()
      if (code === 0) resolve(output.trim())
      else reject(new Error(`npm ${args.join(' ')} 未完成 (${signal || code})；请检查上方错误、网络连接及目录写入权限。`))
    })
  })
}

async function exists(path) { try { await access(path); return true } catch { return false } }

export async function prepareApplication(projectRoot, { npmVersion, log = console.log } = {}) {
  const lock = await readFile(join(projectRoot, 'package-lock.json'), 'utf8')
  const packages = JSON.parse(lock).packages
  const fingerprint = createHash('sha256').update(JSON.stringify([lock, process.versions.node, npmVersion, process.platform, process.arch])).digest('hex')
  const stateFile = join(projectRoot, '.runtime', 'launch-install.json')
  let state
  try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch { /* First run or interrupted marker write. */ }
  const hasDependencies = Object.keys(packages).some(path => path.startsWith('node_modules/'))
  const installed = state?.fingerprint !== fingerprint || (hasDependencies && !await exists(join(projectRoot, 'node_modules', '.package-lock.json')))
  if (installed) {
    log('安装锁定版本的依赖，首次启动需要联网，请等待…')
    await runNpm(['ci', '--include=dev'], projectRoot)
    await mkdir(join(projectRoot, '.runtime'), { recursive: true })
    const temporary = `${stateFile}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify({ fingerprint }) + '\n')
    await rename(temporary, stateFile)
  } else log('依赖检查完成，复用已安装的版本。')
  log('构建当前版本…')
  await runNpm(['run', 'build'], projectRoot)
  return { installed }
}

export async function assertPortAvailable(host, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CANVAS_GATEWAY_PORT 必须是 1–65535 之间的端口。')
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(new Error(error.code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用。如果 Continuum 已启动，请打开现有页面；否则关闭占用程序，或在 .env.local 设置 CANVAS_GATEWAY_PORT 后重试。`
      : `无法监听 ${host}:${port} (${error.code})；请检查本机地址和权限。`)))
    server.listen(port, host, () => server.close(error => error ? reject(error) : resolve()))
  })
}

export async function withStartupLock(projectRoot, action) {
  const { DataDirectoryLock } = await import('../server/data-directory-lock.ts')
  let lock
  try { lock = await DataDirectoryLock.acquire({ dataDir: join(projectRoot, '.runtime', 'launcher') }) }
  catch (error) {
    if (error.code === 'data_directory_locked') throw new Error('另一个启动窗口正在准备此项目，请等待它完成；不要重复启动。')
    throw error
  }
  try { return await action() }
  finally { await lock.release() }
}

export function browserAddress(origin) {
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^[a-z0-9.:[\]-]+$/i.test(url.hostname)) throw new Error('Invalid browser address')
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
  if (url.hostname === '[::]') url.hostname = '[::1]'
  url.pathname = '/'
  return url.href
}

function openBrowser(address) {
  const command = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', `start "" "${address}"`]]
    : process.platform === 'darwin' ? ['open', [address]] : ['xdg-open', [address]]
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true })
  child.once('error', () => console.log(`浏览器未能自动打开，请手动访问 ${address}`))
  child.once('exit', code => { if (code) console.log(`请在浏览器中打开 ${address}`) })
  child.unref()
}

export async function launch() {
  assertRuntime(process.versions.node)
  console.log('\nContinuum · 连点成片\n检查启动环境…')
  const npmVersion = await runNpm(['--version'], root, true)
  assertRuntime(process.versions.node, npmVersion)
  const { loadGatewayEnvironment } = await import('../server/config.ts')
  const loaded = await loadGatewayEnvironment({ rootDir: root })
  const env = { ...loaded.env, CANVAS_AGENT_RUNTIME_VERSION: loaded.env.CANVAS_AGENT_RUNTIME_VERSION?.trim() || '2' }
  const port = Number(env.CANVAS_GATEWAY_PORT || env.GATEWAY_PORT || 4173)
  return withStartupLock(root, async () => {
    await assertPortAvailable(env.CANVAS_GATEWAY_HOST || env.GATEWAY_HOST || '127.0.0.1', port)
    await prepareApplication(root, { npmVersion })
    const { runMain } = await import('../server/main.ts')
    const handle = await runMain({ rootDir: root, args: ['--production'], env })
    const address = browserAddress(handle.origin)
    console.log(`\n已启动：${address}\n请保持本窗口打开；按 Ctrl+C 停止服务。\n首次进入：新建画布 → 点击画布卡片进入 → API 设置 → 分别配置生成服务与 Agent 对话模型。\n`)
    if (env.CANVAS_OPEN_BROWSER !== '0') openBrowser(address)
    return handle
  })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  launch().catch(error => {
    console.error(`\n启动失败：${error.code === 'data_directory_locked' ? '数据目录正在被另一个服务使用，请先停止原服务。' : error.message}\n`)
    process.exitCode = 1
  })
}
