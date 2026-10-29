import type { IncomingMessage } from 'node:http'
import { BlockList, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

const LOOPBACK_ADDRESSES = new BlockList()
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6')
LOOPBACK_ADDRESSES.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase()
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized
}

export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = normalizeHost(address)
  const family = isIP(normalized)
  if (family === 4) return LOOPBACK_ADDRESSES.check(normalized, 'ipv4')
  if (family === 6) return LOOPBACK_ADDRESSES.check(normalized, 'ipv6')
  return false
}

export function isPrivateLanRemoteAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = normalizeHost(address)
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

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host)
  return normalized === 'localhost' || isLoopbackRemoteAddress(normalized)
}

export function isPrivateLanHost(host: string): boolean {
  const normalized = normalizeHost(host)
  return isPrivateLanRemoteAddress(normalized)
}

const VIRTUAL_ADAPTER = /(vmware|virtual|vethernet|hyper-v|wsl|docker|loopback|tunnel|vpn|tap|tun)/i

export function selectPrivateLanAddress(): string | undefined {
  const adapters = networkInterfaces()
  const candidates = Object.entries(adapters).flatMap(([name, addresses = []]) =>
    addresses
      .filter((entry) => entry.family === 'IPv4' && !entry.internal && isPrivateLanRemoteAddress(entry.address))
      .map((entry) => ({ name, address: entry.address })),
  )
  return candidates.find((entry) => !VIRTUAL_ADAPTER.test(entry.name))?.address
    ?? candidates[0]?.address
}

export function isAllowedHost(
  request: IncomingMessage,
  dynamicAllowedOrigins: readonly string[] = [],
  dynamicPublicOrigin?: string,
): boolean {
  const host = request.headers.host
  if (!host || host.includes('@')) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return false
  }
  if (isLoopbackHost(hostname) || isPrivateLanHost(hostname) || hostname === '0.0.0.0') return true
  if (dynamicPublicOrigin) {
    try {
      if (new URL(dynamicPublicOrigin).hostname.toLowerCase() === hostname) return true
    } catch {}
  }
  for (const origin of dynamicAllowedOrigins) {
    try {
      if (new URL(origin).hostname.toLowerCase() === hostname) return true
    } catch {}
  }
  return false
}

export function isAllowedRemoteAddress(
  address: string | undefined,
  hasPublicOrigin: boolean,
  localHostOnly: boolean,
): boolean {
  if (!localHostOnly || hasPublicOrigin) return true
  return isLoopbackRemoteAddress(address) || isPrivateLanRemoteAddress(address)
}

export function hasLoopbackBrowserOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (typeof origin !== 'string') return false
  try {
    const parsed = new URL(origin)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username && !parsed.password &&
      (isLoopbackHost(parsed.hostname) || isPrivateLanHost(parsed.hostname))
    )
  } catch {
    return false
  }
}

export function formatGatewayOrigin(host: string, port: number): string {
  const normalized = normalizeHost(host)
  if (normalized === '0.0.0.0') return `http://127.0.0.1:${port}`
  if (isIP(normalized) === 6) {
    const hostname = new URL(`http://[${normalized}]`).hostname
    return `http://${hostname === '[::]' ? '[::1]' : hostname}:${port}`
  }
  return `http://${normalized}:${port}`
}
