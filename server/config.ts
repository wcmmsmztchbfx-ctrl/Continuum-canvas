import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isIP } from 'node:net'

export type GatewayEnvironment = Record<string, string | undefined>

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const DEFAULT_ASSET_IMPORT_TIMEOUT_MS = 90_000
export const MAX_ASSET_IMPORT_TIMEOUT_MS = 600_000
export const DEFAULT_GENERATION_MAX_RUN_TIME_MS = 30 * 60_000
export const MIN_GENERATION_MAX_RUN_TIME_MS = 60_000
export const MAX_GENERATION_MAX_RUN_TIME_MS = 24 * 60 * 60_000

function loopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
  if (isIP(normalized) !== 4) return false
  return normalized.split('.')[0] === '127'
}

function privateLanHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  const family = isIP(normalized)
  if (family === 4) {
    const octets = normalized.split('.').map(Number)
    return octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254)
  }
  return family === 6 && (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8'))
}

function webOrigin(value: string, variable: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RangeError(`${variable} must contain valid HTTP or HTTPS origins`)
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    url.hostname.includes('*') || value.trim() !== url.origin
  ) {
    throw new RangeError(`${variable} must contain valid HTTP or HTTPS origins`)
  }
  return url.origin
}

export function resolveCollaborationNetworkConfig(
  host: string,
  env: GatewayEnvironment,
): { publicOrigin: string | undefined; allowedOrigins: string[] } {
  const publicInput = env.CANVAS_PUBLIC_ORIGIN?.trim()
  const allowedInput = env.CANVAS_ALLOWED_ORIGINS?.trim()
  if (loopbackHost(host) && !publicInput && !allowedInput) {
    return { publicOrigin: undefined, allowedOrigins: [] }
  }
  if (!publicInput) {
    throw new RangeError('CANVAS_PUBLIC_ORIGIN is required for a non-loopback gateway bind')
  }
  const publicOrigin = webOrigin(publicInput, 'CANVAS_PUBLIC_ORIGIN')
  if (!publicOrigin.startsWith('https://')) {
    const insecureLanEnabled = env.CANVAS_ALLOW_INSECURE_LAN?.trim().toLowerCase() === 'true'
    if (!insecureLanEnabled || !privateLanHost(new URL(publicOrigin).hostname)) {
      throw new RangeError(
        insecureLanEnabled
          ? 'CANVAS_PUBLIC_ORIGIN must use HTTPS or a private LAN address'
          : 'CANVAS_PUBLIC_ORIGIN must use HTTPS for public collaboration',
      )
    }
  }
  if (!allowedInput) {
    throw new RangeError('CANVAS_ALLOWED_ORIGINS is required for public collaboration')
  }
  const allowedOrigins = [...new Set(allowedInput.split(',').map((value) =>
    webOrigin(value.trim(), 'CANVAS_ALLOWED_ORIGINS'),
  ))]
  if (!publicOrigin.startsWith('https://') && allowedOrigins.some((origin) => {
    const url = new URL(origin)
    return url.protocol !== 'http:' || (!privateLanHost(url.hostname) && !loopbackHost(url.hostname))
  })) {
    throw new RangeError('CANVAS_ALLOWED_ORIGINS must contain only private LAN or loopback HTTP origins in insecure LAN mode')
  }
  if (!allowedOrigins.includes(publicOrigin)) {
    throw new RangeError('CANVAS_ALLOWED_ORIGINS must include CANVAS_PUBLIC_ORIGIN')
  }
  return { publicOrigin, allowedOrigins }
}

export function resolveAssetImportTimeoutMs(value: string | number | undefined): number {
  if (value === undefined) return DEFAULT_ASSET_IMPORT_TIMEOUT_MS
  const parsed = typeof value === 'number'
    ? value
    : /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_ASSET_IMPORT_TIMEOUT_MS) {
    throw new RangeError(
      `CANVAS_ASSET_IMPORT_TIMEOUT_MS must be a positive integer no greater than ${MAX_ASSET_IMPORT_TIMEOUT_MS}`,
    )
  }
  return parsed
}

export function resolveGenerationMaxRunTimeMs(value: string | number | undefined): number {
  if (value === undefined) return DEFAULT_GENERATION_MAX_RUN_TIME_MS
  const parsed = typeof value === 'number'
    ? value
    : /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_GENERATION_MAX_RUN_TIME_MS ||
    parsed > MAX_GENERATION_MAX_RUN_TIME_MS
  ) {
    throw new RangeError(
      `CANVAS_GENERATION_MAX_RUN_TIME_MS must be an integer between ${MIN_GENERATION_MAX_RUN_TIME_MS} and ${MAX_GENERATION_MAX_RUN_TIME_MS}`,
    )
  }
  return parsed
}

function parseEnvSource(source: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    const encoded = line.slice(separator + 1).trim()
    if (encoded.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(encoded)
        if (typeof parsed === 'string') values[name] = parsed
      } catch {
        // Ignore malformed local assignments instead of guessing at secret contents.
      }
    } else {
      values[name] = encoded
    }
  }
  return values
}

async function loadEnvFile(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvSource(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

export function resolveProjectPath(rootDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(rootDir, path)
}

export async function loadGatewayEnvironment(options: {
  rootDir?: string
  processEnv?: GatewayEnvironment
  env?: GatewayEnvironment
  envFile?: string
} = {}) {
  const rootDir = options.rootDir ?? PROJECT_ROOT
  const processEnv = options.processEnv ?? process.env
  const configuredEnvFile = options.envFile
    ?? options.env?.CANVAS_ENV_FILE
    ?? processEnv.CANVAS_ENV_FILE
    ?? 'data/secrets.env'
  const envFile = resolveProjectPath(rootDir, configuredEnvFile)
  const fileEnv = await loadEnvFile(envFile)
  const legacyEnv = await loadEnvFile(resolveProjectPath(rootDir, '.env.local'))
  return {
    rootDir,
    envFile,
    env: { ...legacyEnv, ...fileEnv, ...processEnv, ...options.env },
  }
}
