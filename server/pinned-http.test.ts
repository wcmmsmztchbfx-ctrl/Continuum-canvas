import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPinnedRemoteFetcher,
  createRuntimeAddressLookup,
  resolvePinnedPublicAddress,
} from './pinned-http.ts'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('createRuntimeAddressLookup', () => {
  it('falls back to the fixed DoH endpoint when every system address is an RFC2544 fake IP', async () => {
    const systemLookup = vi.fn(async () => [
      { address: '198.18.2.5', family: 4 },
      { address: '198.19.255.254', family: 4 },
    ])
    const dohFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://cloudflare-dns.com')
      expect(url.pathname).toBe('/dns-query')
      expect(url.searchParams.get('name')).toBe('cdn.example.test')
      if (url.searchParams.get('type') === 'A') {
        return Response.json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
      }
      return Response.json({ Status: 0, Answer: [{ type: 28, data: '2606:2800:220:1:248:1893:25c8:1946' }] })
    })

    const lookup = createRuntimeAddressLookup({ systemLookup, dohFetch })

    await expect(lookup('cdn.example.test')).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ])
    expect(systemLookup).toHaveBeenCalledOnce()
    expect(dohFetch).toHaveBeenCalledTimes(2)
  })

  it('supports a configurable HTTPS DoH endpoint for open-source deployments', async () => {
    const dohFetch = vi.fn<typeof fetch>(async (input) => {
      expect(new URL(String(input)).origin).toBe('https://resolver.example.test')
      return Response.json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
    })
    const lookup = createRuntimeAddressLookup({
      systemLookup: async () => [{ address: '198.18.2.5', family: 4 }],
      dohFetch,
      dohEndpoint: 'https://resolver.example.test/resolve',
    })

    await expect(lookup('cdn.example.test')).resolves.toContainEqual({
      address: '93.184.216.34', family: 4,
    })
    expect(dohFetch).toHaveBeenCalledTimes(2)
  })

  it('bounds a stalled DoH fallback and propagates its timeout', async () => {
    const lookup = createRuntimeAddressLookup({
      systemLookup: async () => [{ address: '198.18.2.5', family: 4 }],
      dohFetch: vi.fn((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })),
      dohTimeoutMs: 5,
    })

    await expect(lookup('cdn.example.test')).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('propagates caller cancellation while the DoH fallback is pending', async () => {
    const controller = new AbortController()
    const lookup = createRuntimeAddressLookup({
      systemLookup: async () => [{ address: '198.18.2.5', family: 4 }],
      dohFetch: vi.fn((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })),
      dohTimeoutMs: 10_000,
    })
    const pending = lookup('cdn.example.test', controller.signal)
    controller.abort(new DOMException('Gateway closed', 'AbortError'))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not wait for an abort-ignoring system resolver after caller cancellation', async () => {
    const controller = new AbortController()
    const lookup = createRuntimeAddressLookup({
      systemLookup: async () => new Promise(() => {}),
      dohFetch: vi.fn(),
    })
    const pending = lookup('cdn.example.test', controller.signal)
    controller.abort(new DOMException('Gateway closed', 'AbortError'))

    await expect(Promise.race([
      pending.then(() => 'resolved', (error) => (error as Error).name),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
    ])).resolves.toBe('AbortError')
  })

  it.each([
    ['a private result', [{ address: '10.0.0.4', family: 4 }]],
    ['mixed fake and private results', [
      { address: '198.18.2.5', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]],
    ['mixed fake and public results', [
      { address: '198.18.2.5', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ]],
  ])('does not use DoH for %s', async (_label, systemAddresses) => {
    const systemLookup = vi.fn(async () => systemAddresses)
    const dohFetch = vi.fn<typeof fetch>()
    const lookup = createRuntimeAddressLookup({ systemLookup, dohFetch })

    await expect(lookup('mixed.example.test')).resolves.toEqual(systemAddresses)
    expect(dohFetch).not.toHaveBeenCalled()
  })

  it('leaves normal public system results unchanged', async () => {
    const systemAddresses = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]
    const dohFetch = vi.fn<typeof fetch>()
    const lookup = createRuntimeAddressLookup({
      systemLookup: async () => systemAddresses,
      dohFetch,
    })

    await expect(lookup('public.example.test')).resolves.toEqual(systemAddresses)
    expect(dohFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty answer', () => Response.json({ Status: 0, Answer: [] })],
    ['a failed DNS status', () => Response.json({ Status: 2, Answer: [{ type: 1, data: '93.184.216.34' }] })],
    ['a non-IP answer', () => Response.json({ Status: 0, Answer: [{ type: 1, data: 'not-an-ip' }] })],
    ['invalid JSON', () => new Response('{', { headers: { 'content-type': 'application/dns-json' } })],
  ])('fails closed when DoH returns %s', async (_label, response) => {
    const fakeAddresses = [{ address: '198.18.2.5', family: 4 }]
    const lookup = createRuntimeAddressLookup({
      systemLookup: async () => fakeAddresses,
      dohFetch: vi.fn(async () => response()),
    })

    await expect(lookup('cdn.example.test')).resolves.toEqual(fakeAddresses)
  })

  it('fails closed when DoH transport fails', async () => {
    const fakeAddresses = [{ address: '198.18.2.5', family: 4 }]
    const lookup = createRuntimeAddressLookup({
      systemLookup: async () => fakeAddresses,
      dohFetch: vi.fn(async () => { throw new Error('proxy unavailable') }),
    })

    await expect(lookup('cdn.example.test')).resolves.toEqual(fakeAddresses)
  })

  it('rejects the original fake address after a failed fallback', async () => {
    const lookup = createRuntimeAddressLookup({
      systemLookup: async () => [{ address: '198.18.2.5', family: 4 }],
      dohFetch: vi.fn(async () => { throw new Error('resolver unavailable') }),
    })

    await expect(resolvePinnedPublicAddress(
      new URL('https://cdn.example.test/asset.png'),
      lookup,
    )).rejects.toThrow('resolve only to public addresses')
  })
})

describe('createPinnedRemoteFetcher', () => {
  it('connects to the validated address while preserving the URL host', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/plain')
      response.end(request.headers.host)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')

    const fetchPinned = createPinnedRemoteFetcher()
    const response = await fetchPinned(
      `http://media.public.test:${address.port}/asset`,
      { method: 'GET', redirect: 'manual' },
      '127.0.0.1',
    )

    expect(await response.text()).toBe(`media.public.test:${address.port}`)
  })

  it('honors abort signals without leaking a raw socket error', async () => {
    const server = createServer(() => {})
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    const controller = new AbortController()

    const pending = createPinnedRemoteFetcher()(
      `http://media.public.test:${address.port}/asset`,
      { signal: controller.signal },
      '127.0.0.1',
    )
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects redirects when redirect mode is error', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: 'http://127.0.0.1/private' })
      response.end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')

    await expect(createPinnedRemoteFetcher()(
      `http://media.public.test:${address.port}/asset`,
      { redirect: 'error' },
      '127.0.0.1',
    )).rejects.toThrow('redirect')
  })

  it('maps 205 responses without constructing an illegal response body', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(205)
      response.end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')

    const response = await createPinnedRemoteFetcher()(
      `http://media.public.test:${address.port}/asset`,
      {},
      '127.0.0.1',
    )
    expect(response.status).toBe(205)
    expect(response.body).toBeNull()
  })

  it('rejects status codes that cannot be represented by a Fetch response', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(600)
      response.end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')

    const pending = createPinnedRemoteFetcher()(
      `http://media.public.test:${address.port}/asset`,
      {},
      '127.0.0.1',
    )
    await expect(Promise.race([
      pending.then(() => 'resolved', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
    ])).resolves.toBe('rejected')
  })

  it('rejects protocol upgrades instead of leaving the request pending', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(101, { connection: 'upgrade', upgrade: 'test' })
      response.end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')

    const pending = createPinnedRemoteFetcher()(
      `http://media.public.test:${address.port}/asset`,
      {},
      '127.0.0.1',
    )
    await expect(Promise.race([
      pending.then(() => 'resolved', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
    ])).resolves.toBe('rejected')
  })

  it('preserves timeout reasons so the gateway can return 504', async () => {
    const server = createServer(() => {})
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')

    const pending = createPinnedRemoteFetcher()(
      `http://media.public.test:${address.port}/asset`,
      { signal: AbortSignal.timeout(5) },
      '127.0.0.1',
    )

    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('opens a fresh pinned connection for every validated request', async () => {
    const remotePorts: number[] = []
    const server = createServer((request, response) => {
      remotePorts.push(request.socket.remotePort ?? 0)
      response.end('ok')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    const fetchPinned = createPinnedRemoteFetcher()
    const url = `http://media.public.test:${address.port}/asset`

    await (await fetchPinned(url, {}, '127.0.0.1')).text()
    await (await fetchPinned(url, {}, '127.0.0.1')).text()

    expect(new Set(remotePorts).size).toBe(2)
  })

  it('pipes a readable request body without converting it to a whole buffer', async () => {
    let received = ''
    const server = createServer((request, response) => {
      request.setEncoding('utf8')
      request.on('data', (chunk) => { received += chunk })
      request.on('end', () => response.end('ok'))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')

    const response = await createPinnedRemoteFetcher()(
      `http://media.public.test:${address.port}/upload`,
      { method: 'PUT', body: Readable.from(['first-', 'second']) },
      '127.0.0.1',
    )

    expect(response.status).toBe(200)
    expect(received).toBe('first-second')
  })
})
