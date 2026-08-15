interface BrowserRandomSource {
  randomUUID?: () => string
  getRandomValues?: (bytes: Uint8Array) => Uint8Array
}

export function createBrowserUuid(source?: BrowserRandomSource): string {
  const bytes = new Uint8Array(16)
  if (source) {
    if (typeof source.randomUUID === 'function') return source.randomUUID()
    if (typeof source.getRandomValues === 'function') source.getRandomValues(bytes)
    else for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  } else if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  } else if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}

export function createCanvasId(prefix: 'i' | 'v' | 't' | 'g' | 'e'): string {
  const randomPart = createBrowserUuid()
  return `${prefix}-canvas-${randomPart}`
}
