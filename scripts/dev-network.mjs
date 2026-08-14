import { networkInterfaces } from 'node:os'

const VIRTUAL_ADAPTER = /(vmware|virtual|vethernet|hyper-v|wsl|docker|loopback|tunnel|vpn|tap|tun)/i

function isPrivateIpv4(address) {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return false
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
}

export function selectPrivateLanAddress(adapters = networkInterfaces()) {
  const candidates = Object.entries(adapters).flatMap(([name, addresses = []]) =>
    addresses
      .filter((entry) => entry.family === 'IPv4' && !entry.internal && isPrivateIpv4(entry.address))
      .map((entry) => ({ name, address: entry.address })),
  )
  return candidates.find((entry) => !VIRTUAL_ADAPTER.test(entry.name))?.address
    ?? candidates[0]?.address
}

export function createLanDevelopmentEnvironment(sourceEnv, lanAddress = selectPrivateLanAddress()) {
  if (!lanAddress) {
    return {
      ...sourceEnv,
      CANVAS_VITE_HOST: sourceEnv.CANVAS_VITE_HOST || '127.0.0.1',
      CANVAS_GATEWAY_HOST: sourceEnv.CANVAS_GATEWAY_HOST || '127.0.0.1',
    }
  }
  const publicOrigin = sourceEnv.CANVAS_PUBLIC_ORIGIN || `http://${lanAddress}:4173`
  return {
    ...sourceEnv,
    CANVAS_VITE_HOST: sourceEnv.CANVAS_VITE_HOST || '0.0.0.0',
    CANVAS_GATEWAY_HOST: sourceEnv.CANVAS_GATEWAY_HOST || '0.0.0.0',
    CANVAS_ALLOW_INSECURE_LAN: sourceEnv.CANVAS_ALLOW_INSECURE_LAN || 'true',
    CANVAS_PUBLIC_ORIGIN: publicOrigin,
    CANVAS_ALLOWED_ORIGINS: sourceEnv.CANVAS_ALLOWED_ORIGINS
      || `${publicOrigin},http://127.0.0.1:4173,http://localhost:4173`,
  }
}
