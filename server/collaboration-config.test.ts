import { describe, expect, it } from 'vitest'
import { resolveCollaborationNetworkConfig } from './config.ts'
import { resolveMainOptions } from './main.ts'
import { startGateway } from './http-gateway.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('collaboration network configuration', () => {
  it('keeps the default loopback gateway private without public settings', () => {
    expect(resolveCollaborationNetworkConfig('127.0.0.1', {})).toEqual({
      publicOrigin: undefined,
      allowedOrigins: [],
    })
  })

  it('requires an HTTPS public origin and explicit allowed origins for a non-loopback bind', () => {
    expect(() => resolveCollaborationNetworkConfig('0.0.0.0', {})).toThrow(
      'CANVAS_PUBLIC_ORIGIN',
    )
    expect(() => resolveCollaborationNetworkConfig('0.0.0.0', {
      CANVAS_PUBLIC_ORIGIN: 'https://canvas.example',
    })).toThrow('CANVAS_ALLOWED_ORIGINS')
    expect(() => resolveCollaborationNetworkConfig('0.0.0.0', {
      CANVAS_PUBLIC_ORIGIN: 'http://canvas.example',
      CANVAS_ALLOWED_ORIGINS: 'http://canvas.example',
    })).toThrow('HTTPS')
  })

  it('allows explicitly enabled HTTP collaboration on a private LAN address', () => {
    expect(resolveCollaborationNetworkConfig('0.0.0.0', {
      CANVAS_ALLOW_INSECURE_LAN: 'true',
      CANVAS_PUBLIC_ORIGIN: 'http://192.168.1.4:4173',
      CANVAS_ALLOWED_ORIGINS: 'http://192.168.1.4:4173,http://127.0.0.1:4173,http://localhost:4173',
    })).toEqual({
      publicOrigin: 'http://192.168.1.4:4173',
      allowedOrigins: [
        'http://192.168.1.4:4173',
        'http://127.0.0.1:4173',
        'http://localhost:4173',
      ],
    })
  })

  it('does not allow the LAN switch to weaken HTTP security for public hosts', () => {
    expect(() => resolveCollaborationNetworkConfig('0.0.0.0', {
      CANVAS_ALLOW_INSECURE_LAN: 'true',
      CANVAS_PUBLIC_ORIGIN: 'http://canvas.example',
      CANVAS_ALLOWED_ORIGINS: 'http://canvas.example',
    })).toThrow('private LAN')
  })

  it('normalizes and deduplicates configured web origins', () => {
    expect(resolveCollaborationNetworkConfig('0.0.0.0', {
      CANVAS_PUBLIC_ORIGIN: 'https://canvas.example',
      CANVAS_ALLOWED_ORIGINS: 'https://canvas.example, https://editor.example,https://editor.example',
    })).toEqual({
      publicOrigin: 'https://canvas.example',
      allowedOrigins: ['https://canvas.example', 'https://editor.example'],
    })
  })

  it.each([
    'https://user@canvas.example',
    'https://canvas.example/path',
    'file:///tmp/canvas',
    'https://*.example',
  ])('rejects a non-origin value: %s', (value) => {
    expect(() => resolveCollaborationNetworkConfig('0.0.0.0', {
      CANVAS_PUBLIC_ORIGIN: 'https://canvas.example',
      CANVAS_ALLOWED_ORIGINS: value,
    })).toThrow('CANVAS_ALLOWED_ORIGINS')
  })

  it('passes resolved public networking settings through the main startup options', async () => {
    await expect(resolveMainOptions([], {
      CANVAS_GATEWAY_HOST: '0.0.0.0',
      CANVAS_PUBLIC_ORIGIN: 'https://canvas.example',
      CANVAS_ALLOWED_ORIGINS: 'https://canvas.example,https://editor.example',
    }, 'D:/app')).resolves.toEqual(expect.objectContaining({
      publicOrigin: 'https://canvas.example',
      allowedOrigins: ['https://canvas.example', 'https://editor.example'],
    }))
  })

  it('refuses a direct non-loopback gateway bind without explicit public settings', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'libtv-public-gate-'))
    await expect(startGateway({
      host: '0.0.0.0', port: 0, dataDir, envFile: join(dataDir, '.env.local'),
    })).rejects.toThrow('CANVAS_PUBLIC_ORIGIN')
  })

  it('starts a directly configured private LAN gateway when insecure LAN mode is explicit', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'libtv-lan-gate-'))
    const gateway = await startGateway({
      host: '0.0.0.0',
      port: 0,
      dataDir,
      envFile: join(dataDir, '.env.local'),
      publicOrigin: 'http://192.168.1.4:4173',
      allowedOrigins: ['http://192.168.1.4:4173'],
      allowInsecureLan: true,
    })
    await gateway.close()
  })
})
