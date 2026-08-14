import { describe, expect, it } from 'vitest'
import { resolveCanvasPublicOrigin, resolveViteHost } from './vite.config'

describe('Vite network configuration', () => {
  it('stays loopback-only by default and accepts an explicit LAN bind', () => {
    expect(resolveViteHost({})).toBe('127.0.0.1')
    expect(resolveViteHost({ CANVAS_VITE_HOST: '0.0.0.0' })).toBe('0.0.0.0')
  })

  it('exposes the configured canvas origin to client-side invite links', () => {
    expect(resolveCanvasPublicOrigin({})).toBe('')
    expect(resolveCanvasPublicOrigin({
      CANVAS_PUBLIC_ORIGIN: ' http://192.168.1.4:4173 ',
    })).toBe('http://192.168.1.4:4173')
  })
})
