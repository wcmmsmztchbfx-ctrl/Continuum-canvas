import { describe, expect, it } from 'vitest'
import {
  createLanDevelopmentEnvironment,
  selectPrivateLanAddress,
} from '../scripts/dev-network.mjs'

describe('LAN development network', () => {
  it('prefers a physical private adapter over virtual adapters', () => {
    expect(selectPrivateLanAddress({
      'vEthernet (Default Switch)': [{ address: '172.27.144.1', family: 'IPv4', internal: false }],
      'VMware Network Adapter VMnet8': [{ address: '192.168.59.1', family: 'IPv4', internal: false }],
      Ethernet: [{ address: '192.168.1.4', family: 'IPv4', internal: false }],
    })).toBe('192.168.1.4')
  })

  it('preserves explicit configuration while filling LAN development defaults', () => {
    expect(createLanDevelopmentEnvironment({
      API_PROVIDER_AISTARTLAB_KEY: 'secret',
      CANVAS_PUBLIC_ORIGIN: 'http://192.168.1.99:4173',
    }, '192.168.1.4')).toEqual(expect.objectContaining({
      API_PROVIDER_AISTARTLAB_KEY: 'secret',
      CANVAS_VITE_HOST: '0.0.0.0',
      CANVAS_GATEWAY_HOST: '0.0.0.0',
      CANVAS_ALLOW_INSECURE_LAN: 'true',
      CANVAS_PUBLIC_ORIGIN: 'http://192.168.1.99:4173',
      CANVAS_ALLOWED_ORIGINS: 'http://192.168.1.99:4173,http://127.0.0.1:4173,http://localhost:4173',
    }))
  })

  it('falls back to loopback-only development when no private adapter is available', () => {
    expect(createLanDevelopmentEnvironment({}, null)).toEqual(expect.objectContaining({
      CANVAS_VITE_HOST: '127.0.0.1',
      CANVAS_GATEWAY_HOST: '127.0.0.1',
    }))
  })
})
