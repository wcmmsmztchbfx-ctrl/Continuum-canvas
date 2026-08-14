import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  loadGatewayEnvironment,
  PROJECT_ROOT,
  resolveAssetImportTimeoutMs,
  resolveGenerationMaxRunTimeMs,
  resolveCollaborationNetworkConfig,
  resolveProjectPath,
  type GatewayEnvironment,
} from './config.ts'
import { startGateway } from './http-gateway.ts'

export { PROJECT_ROOT } from './config.ts'

interface ExplicitMainOptions {
  env?: GatewayEnvironment
  envFile?: string
  dataDir?: string
  host?: string
  port?: number
  assetImportTimeoutMs?: number
  generationMaxRunTimeMs?: number
  publicOrigin?: string
  allowedOrigins?: string[]
  allowInsecureLan?: boolean
}

function validPort(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined
}

export async function resolveMainOptions(
  args: string[],
  processEnv: GatewayEnvironment,
  rootDir: string = PROJECT_ROOT,
  explicit: ExplicitMainOptions = {},
) {
  const production = args.includes('--production')
  const loaded = await loadGatewayEnvironment({
    rootDir,
    processEnv,
    env: explicit.env,
    envFile: explicit.envFile,
  })
  const env = loaded.env
  const configuredDataDir = explicit.dataDir ?? env.CANVAS_DATA_DIR ?? 'data'
  const host = explicit.host ?? env.CANVAS_GATEWAY_HOST ?? env.GATEWAY_HOST ?? '127.0.0.1'
  const collaborationNetwork = explicit.publicOrigin || explicit.allowedOrigins
    ? {
        publicOrigin: explicit.publicOrigin,
        allowedOrigins: explicit.allowedOrigins ?? [],
      }
    : resolveCollaborationNetworkConfig(host, env)
  return {
    rootDir,
    dataDir: resolveProjectPath(rootDir, configuredDataDir),
    envFile: loaded.envFile,
    env,
    host,
    port: explicit.port
      ?? validPort(env.CANVAS_GATEWAY_PORT ?? env.GATEWAY_PORT)
      ?? (production ? 4173 : 4174),
    assetImportTimeoutMs: resolveAssetImportTimeoutMs(
      explicit.assetImportTimeoutMs ?? env.CANVAS_ASSET_IMPORT_TIMEOUT_MS,
    ),
    generationMaxRunTimeMs: resolveGenerationMaxRunTimeMs(
      explicit.generationMaxRunTimeMs ?? env.CANVAS_GENERATION_MAX_RUN_TIME_MS,
    ),
    distDir: production ? join(rootDir, 'dist') : undefined,
    allowInsecureLan: explicit.allowInsecureLan
      ?? env.CANVAS_ALLOW_INSECURE_LAN?.trim().toLowerCase() === 'true',
    ...collaborationNetwork,
  }
}

interface SignalSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

interface MainHandle {
  origin: string
  close(): Promise<void>
}

export async function runMain(options: {
  args?: string[]
  processEnv?: GatewayEnvironment
  env?: GatewayEnvironment
  rootDir?: string
  envFile?: string
  dataDir?: string
  host?: string
  port?: number
  assetImportTimeoutMs?: number
  generationMaxRunTimeMs?: number
  publicOrigin?: string
  allowedOrigins?: string[]
  allowInsecureLan?: boolean
  start?: (options: Awaited<ReturnType<typeof resolveMainOptions>>) => Promise<MainHandle>
  signals?: SignalSource
  log?: (message: string) => void
} = {}): Promise<MainHandle> {
  const args = options.args ?? process.argv.slice(2)
  const processEnv = options.processEnv ?? process.env
  const rootDir = options.rootDir ?? PROJECT_ROOT
  const start = options.start ?? startGateway
  const signals = options.signals ?? process
  const resolved = await resolveMainOptions(args, processEnv, rootDir, {
    env: options.env,
    envFile: options.envFile,
    dataDir: options.dataDir,
    host: options.host,
    port: options.port,
    assetImportTimeoutMs: options.assetImportTimeoutMs,
    generationMaxRunTimeMs: options.generationMaxRunTimeMs,
    publicOrigin: options.publicOrigin,
    allowedOrigins: options.allowedOrigins,
    allowInsecureLan: options.allowInsecureLan,
  })
  const handle = await start(resolved)
  let closing: Promise<void> | undefined
  const shutdown = () => {
    closing ??= handle.close()
    void closing.catch(() => {})
  }
  signals.once('SIGINT', shutdown)
  signals.once('SIGTERM', shutdown)
  options.log?.(`Canvas gateway listening at ${handle.origin}`)
  return handle
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (entry === import.meta.url) {
  void runMain({ log: console.log }).catch((error: unknown) => {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'startup_failed'
    console.error(`Canvas gateway failed to start (${code})`, error)
    process.exitCode = 1
  })
}
