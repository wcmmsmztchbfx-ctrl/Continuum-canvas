import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'

export type AddressLookup = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<Array<{ address: string; family: number }>>

const DEFAULT_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'
const DEFAULT_DOH_TIMEOUT_MS = 5_000
const DEFAULT_SYSTEM_LOOKUP_TIMEOUT_MS = 5_000

interface DnsJsonResponse {
  Status?: unknown
  Answer?: unknown
}

function isRfc2544FakeIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false
  const [first, second] = address.split('.').map(Number)
  return first === 198 && (second === 18 || second === 19)
}

async function queryDoh(
  endpoint: URL,
  hostname: string,
  type: 'A' | 'AAAA',
  dohFetch: typeof fetch,
  signal: AbortSignal,
) {
  const url = new URL(endpoint)
  url.searchParams.set('name', hostname)
  url.searchParams.set('type', type)
  const response = await dohFetch(url, {
    headers: { accept: 'application/dns-json' },
    redirect: 'error',
    signal,
  })
  if (!response.ok) throw new Error('DNS over HTTPS lookup failed')
  const payload = await response.json() as DnsJsonResponse
  if (payload.Status !== 0 || (payload.Answer !== undefined && !Array.isArray(payload.Answer))) {
    throw new Error('DNS over HTTPS returned an invalid response')
  }
  if (!Array.isArray(payload.Answer)) return []
  return payload.Answer.flatMap((answer) => {
    if (!answer || typeof answer !== 'object') return []
    const { type: answerType, data } = answer as { type?: unknown; data?: unknown }
    if (typeof data !== 'string' || (answerType !== 1 && answerType !== 28)) return []
    const family = isIP(data)
    if ((answerType === 1 && family !== 4) || (answerType === 28 && family !== 6)) return []
    return [{ address: data, family }]
  })
}

function waitForAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal))
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}

export function createRuntimeAddressLookup(options: {
  systemLookup?: AddressLookup
  dohFetch?: typeof fetch
  dohEndpoint?: string | URL
  dohTimeoutMs?: number
  systemLookupTimeoutMs?: number
} = {}): AddressLookup {
  const systemLookup = options.systemLookup ??
    (async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }))
  const dohFetch = options.dohFetch ?? globalThis.fetch
  const dohEndpoint = new URL(options.dohEndpoint ?? DEFAULT_DOH_ENDPOINT)
  if (
    dohEndpoint.protocol !== 'https:' ||
    dohEndpoint.username ||
    dohEndpoint.password ||
    dohEndpoint.hash
  ) {
    throw new Error('DoH endpoint must use HTTPS without credentials or fragments')
  }
  const dohTimeoutMs = options.dohTimeoutMs ?? DEFAULT_DOH_TIMEOUT_MS
  if (!Number.isFinite(dohTimeoutMs) || dohTimeoutMs <= 0 || dohTimeoutMs > 30_000) {
    throw new Error('DoH timeout must be between 1 and 30000 milliseconds')
  }
  const systemLookupTimeoutMs = options.systemLookupTimeoutMs ?? DEFAULT_SYSTEM_LOOKUP_TIMEOUT_MS
  if (
    !Number.isFinite(systemLookupTimeoutMs) ||
    systemLookupTimeoutMs <= 0 ||
    systemLookupTimeoutMs > 30_000
  ) {
    throw new Error('System lookup timeout must be between 1 and 30000 milliseconds')
  }

  return async (hostname, signal) => {
    signal?.throwIfAborted()
    const systemDeadline = AbortSignal.timeout(systemLookupTimeoutMs)
    const systemSignal = signal
      ? AbortSignal.any([signal, systemDeadline])
      : systemDeadline
    const systemAddresses = await waitForAbortable(
      systemLookup(hostname, systemSignal),
      systemSignal,
    )
    signal?.throwIfAborted()
    if (systemAddresses.length === 0 || !systemAddresses.every(({ address }) => isRfc2544FakeIPv4(address))) {
      return systemAddresses
    }

    const deadline = AbortSignal.timeout(dohTimeoutMs)
    const attempt = new AbortController()
    const dohSignal = signal
      ? AbortSignal.any([signal, deadline, attempt.signal])
      : AbortSignal.any([deadline, attempt.signal])
    try {
      const resolved = (await Promise.all([
        queryDoh(dohEndpoint, hostname, 'A', dohFetch, dohSignal),
        queryDoh(dohEndpoint, hostname, 'AAAA', dohFetch, dohSignal),
      ])).flat()
      if (resolved.length === 0) return systemAddresses
      return resolved.filter((entry, index) =>
        resolved.findIndex((candidate) => candidate.address === entry.address) === index)
    } catch (error) {
      attempt.abort()
      if (signal?.aborted) throw signal.reason ?? error
      if (deadline.aborted) throw deadline.reason ?? error
      return systemAddresses
    } finally {
      attempt.abort()
    }
  }
}

export interface PinnedRequestInit {
  method?: string
  headers?: ConstructorParameters<typeof Headers>[0]
  body?: string | Uint8Array | ArrayBuffer | ArrayBufferView | Readable
  signal?: AbortSignal
  redirect?: 'manual' | 'error'
}

export type PinnedRemoteFetcher = (
  url: string,
  init: PinnedRequestInit,
  pinnedAddress: string,
) => Promise<Response>

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function byteBody(body: PinnedRequestInit['body']): Uint8Array | string | undefined {
  if (body === undefined || body === null || body instanceof Readable) return undefined
  if (typeof body === 'string' || body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  throw new TypeError('Pinned HTTP transport received an unsupported request body')
}

function publicIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 88 && parts[2] === 99 && parts[3] === 2) return false
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100))) return false
  if (a === 203 && b === 0 && parts[2] === 113) return false
  return true
}

function parseIPv6(address: string): number[] | undefined {
  if (address.includes('%')) return undefined
  let normalized = address.toLowerCase()
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':')
    const ipv4 = normalized.slice(lastColon + 1)
    const parts = ipv4.split('.').map(Number)
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined
    normalized = `${normalized.slice(0, lastColon)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`
  }
  const halves = normalized.split('::')
  if (halves.length > 2) return undefined
  const parseHalf = (half: string) => half
    ? half.split(':').map((part) => /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : NaN)
    : []
  const left = parseHalf(halves[0])
  const right = parseHalf(halves[1] ?? '')
  if ([...left, ...right].some(Number.isNaN)) return undefined
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined
  return [...left, ...Array.from({ length: missing }, () => 0), ...right]
}

function addressHasPrefix(bytes: number[], prefix: number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8)
  if (prefix.slice(0, fullBytes).some((value, index) => bytes[index] !== value)) return false
  const remaining = bits % 8
  if (remaining === 0) return true
  const mask = 0xff << (8 - remaining) & 0xff
  return (bytes[fullBytes] & mask) === (prefix[fullBytes] & mask)
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return publicIPv4(address)
  if (isIP(address) !== 6) return false
  const words = parseIPv6(address)
  if (!words) return false
  const bytes = words.flatMap((word) => [word >> 8, word & 0xff])
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return publicIPv4(bytes.slice(12).join('.'))
  }
  if (!addressHasPrefix(bytes, [0x20, 0, 0, 0], 3)) return false
  if (addressHasPrefix(bytes, [0x20, 0x01, 0, 0], 23)) return false
  if (addressHasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return false
  if (addressHasPrefix(bytes, [0x20, 0x02], 16)) return false
  if (addressHasPrefix(bytes, [0x3f, 0xff, 0, 0], 20)) return false
  return true
}

export async function resolvePinnedPublicAddress(
  url: URL,
  lookup: AddressLookup,
  signal?: AbortSignal,
): Promise<string> {
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('Remote URL must be public HTTP(S)')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(hostname)
  signal?.throwIfAborted()
  const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, signal)
  signal?.throwIfAborted()
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error('Remote URL must resolve only to public addresses')
  }
  return addresses[0].address
}

export function createPinnedRemoteFetcher(): PinnedRemoteFetcher {
  return async (input, init, pinnedAddress) => {
    const url = new URL(input)
    const family = isIP(pinnedAddress)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || family === 0) {
      throw new TypeError('Pinned HTTP transport requires HTTP(S) and a literal IP address')
    }
    const signal = init.signal
    if (signal?.aborted) throw abortError(signal)
    const headers = Object.fromEntries(new Headers(init.headers))
    const streamBody = init.body instanceof Readable ? init.body : undefined
    const requestBody = byteBody(init.body)

    return new Promise<Response>((resolve, reject) => {
      let settled = false
      const settleResolve = (response: Response) => {
        if (settled) return
        settled = true
        resolve(response)
      }
      const settleReject = (error: unknown) => {
        if (settled) return
        settled = true
        reject(error)
      }
      const tlsHostname = url.hostname.replace(/^\[|\]$/g, '')
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        agent: false,
        method: init.method ?? 'GET',
        headers,
        signal,
        ...(url.protocol === 'https:' && isIP(tlsHostname) === 0 ? { servername: tlsHostname } : {}),
        lookup(hostname, options, callback) {
          if (hostname !== url.hostname) {
            if (options.all) callback(new Error('Pinned hostname changed during connection'), [])
            else callback(new Error('Pinned hostname changed during connection'), '', 0)
            return
          }
          if (options.all) callback(null, [{ address: pinnedAddress, family }])
          else callback(null, pinnedAddress, family)
        },
      }, (incoming) => {
        try {
          const responseHeaders = new Headers()
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item)
            else if (value !== undefined) responseHeaders.set(name, value)
          }
          const status = incoming.statusCode ?? 502
          if (status < 200 || status > 599) {
            incoming.resume()
            settleReject(new TypeError('Pinned HTTP transport received an unsupported status'))
            return
          }
          if (init.redirect === 'error' && status >= 300 && status < 400) {
            incoming.resume()
            settleReject(new TypeError('Pinned HTTP transport rejected a redirect'))
            return
          }
          const noBody = init.method === 'HEAD' || status === 204 || status === 205 || status === 304
          settleResolve(new Response(noBody ? null : Readable.toWeb(incoming) as ReadableStream, {
            status,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }))
        } catch (error) {
          settleReject(error)
          incoming.destroy()
        }
      })
      request.once('upgrade', (incoming, socket) => {
        incoming.destroy()
        socket.destroy()
        settleReject(new TypeError('Pinned HTTP transport rejected a protocol upgrade'))
      })
      request.once('error', (error) => settleReject(signal?.aborted ? abortError(signal) : error))
      request.once('close', () => {
        if (!settled) settleReject(new Error('Pinned HTTP transport closed before receiving a response'))
      })
      if (streamBody) {
        streamBody.once('error', (error) => request.destroy(error))
        request.once('close', () => {
          if (!streamBody.destroyed) streamBody.destroy(signal?.aborted ? abortError(signal) as Error : undefined)
        })
        streamBody.pipe(request)
      } else if (requestBody !== undefined) {
        request.end(requestBody)
      } else {
        request.end()
      }
    })
  }
}
