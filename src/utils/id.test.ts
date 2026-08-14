import { describe, expect, it, vi } from 'vitest'

import { createBrowserUuid } from './id'

describe('createBrowserUuid', () => {
  it('uses randomUUID when the secure-context API is available', () => {
    const randomUUID = vi.fn(() => 'native-uuid')
    expect(createBrowserUuid({ randomUUID })).toBe('native-uuid')
    expect(randomUUID).toHaveBeenCalledOnce()
  })

  it('creates an RFC 4122 UUID from getRandomValues on insecure LAN origins', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0)
      return bytes
    })
    expect(createBrowserUuid({ getRandomValues })).toBe('00000000-0000-4000-8000-000000000000')
    expect(getRandomValues).toHaveBeenCalledOnce()
  })
})
