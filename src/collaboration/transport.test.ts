import { describe, expect, it, vi } from 'vitest'
import {
  createCollaborationTransport,
  WebSocketCollaborationTransport,
} from './transport.ts'

interface FakeSocket {
  binaryType: string
  readyState: number
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  listeners: Record<string, ((...args: unknown[]) => void)[]>
  addEventListener: (event: string, cb: (...args: unknown[]) => void) => void
  removeEventListener: (event: string, cb: (...args: unknown[]) => void) => void
  emit: (event: string, payload?: unknown) => void
}

function createFakeSocket(): FakeSocket {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  return {
    binaryType: 'blob',
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    listeners,
    addEventListener: (event, cb) => {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(cb)
    },
    removeEventListener: (event, cb) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((l) => l !== cb)
      }
    },
    emit: (event, payload) => {
      for (const listener of listeners[event] ?? []) {
        listener(payload)
      }
    },
  }
}

describe('WebSocketCollaborationTransport', () => {
  it('initializes with connecting state and transitions to synced on open', () => {
    const socket = createFakeSocket()
    const transport = new WebSocketCollaborationTransport('ws://localhost:1234', () => socket as unknown as WebSocket)

    const stateHistory: string[] = []
    transport.onStateChange((state) => stateHistory.push(state))

    expect(transport.protocol).toBe('websocket')
    socket.emit('open')

    expect(transport.state).toBe('synced')
    expect(stateHistory).toEqual(['synced'])
  })

  it('routes incoming messages to onMessage listeners', () => {
    const socket = createFakeSocket()
    const transport = new WebSocketCollaborationTransport('ws://localhost:1234', () => socket as unknown as WebSocket)

    const messages: Uint8Array[] = []
    transport.onMessage((data) => messages.push(data))

    const sample = new Uint8Array([1, 2, 3])
    socket.emit('message', { data: sample.buffer })

    expect(messages).toHaveLength(1)
    expect(Array.from(messages[0]!)).toEqual([1, 2, 3])
  })

  it('sends durable and ephemeral messages through ready socket', () => {
    const socket = createFakeSocket()
    const transport = new WebSocketCollaborationTransport('ws://localhost:1234', () => socket as unknown as WebSocket)

    const durableData = new Uint8Array([10, 20])
    const ephemeralData = new Uint8Array([30, 40])

    transport.sendDurable(durableData)
    transport.sendEphemeral(ephemeralData)

    expect(socket.send).toHaveBeenCalledTimes(2)
    expect(socket.send).toHaveBeenNthCalledWith(1, durableData)
    expect(socket.send).toHaveBeenNthCalledWith(2, ephemeralData)
  })

  it('falls back gracefully when WebTransport is not configured or available', () => {
    const socket = createFakeSocket()
    const transport = createCollaborationTransport({
      url: 'ws://localhost:1234',
      preferWebTransport: true,
      webSocketFactory: () => socket as unknown as WebSocket,
    })

    expect(transport.protocol).toBe('websocket')
  })
})
