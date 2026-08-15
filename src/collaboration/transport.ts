import type { CanvasCollaborationConnectionState } from './session.ts'

export type TransportChannelKind = 'durable' | 'ephemeral'

export interface CollaborationTransport {
  readonly state: CanvasCollaborationConnectionState
  readonly protocol: 'webtransport' | 'websocket'
  sendDurable(data: Uint8Array): void
  sendEphemeral(data: Uint8Array): void
  close(code?: number, reason?: string): void
  onMessage(handler: (data: Uint8Array, channel: TransportChannelKind) => void): () => void
  onStateChange(handler: (state: CanvasCollaborationConnectionState, error?: string) => void): () => void
}

export type CollaborationWebSocketLike = Pick<
  WebSocket,
  'binaryType' | 'readyState' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'
>

export interface CollaborationTransportOptions {
  url: string
  webTransportUrl?: string
  preferWebTransport?: boolean
  webSocketFactory?: (url: string) => CollaborationWebSocketLike
  webTransportFactory?: (url: string) => unknown
  now?: () => number
}

export class WebSocketCollaborationTransport implements CollaborationTransport {
  readonly protocol = 'websocket' as const
  private socket: CollaborationWebSocketLike
  private _state: CanvasCollaborationConnectionState = 'connecting'
  private messageListeners = new Set<(data: Uint8Array, channel: TransportChannelKind) => void>()
  private stateListeners = new Set<(state: CanvasCollaborationConnectionState, error?: string) => void>()

  constructor(url: string, factory: (url: string) => CollaborationWebSocketLike = (u) => new WebSocket(u)) {
    this.socket = factory(url)
    this.socket.binaryType = 'arraybuffer'

    this.socket.addEventListener('open', () => {
      this._state = 'synced'
      this.emitState('synced')
    })

    this.socket.addEventListener('message', (event) => {
      const payload = (event as MessageEvent).data
      if (payload instanceof ArrayBuffer) {
        this.emitMessage(new Uint8Array(payload), 'durable')
      } else if (payload instanceof Uint8Array) {
        this.emitMessage(payload, 'durable')
      }
    })

    this.socket.addEventListener('error', () => {
      this._state = 'error'
      this.emitState('error', 'WebSocket 连接异常')
    })

    this.socket.addEventListener('close', () => {
      this._state = 'offline'
      this.emitState('offline')
    })
  }

  get state(): CanvasCollaborationConnectionState {
    return this._state
  }

  sendDurable(data: Uint8Array): void {
    if (this.socket.readyState === 1) {
      this.socket.send(data as any)
    }
  }

  sendEphemeral(data: Uint8Array): void {
    // In WebSocket fallback, ephemeral data travels over the primary socket
    if (this.socket.readyState === 1) {
      this.socket.send(data as any)
    }
  }

  close(code?: number, reason?: string): void {
    try {
      this.socket.close(code, reason)
    } catch {}
  }

  onMessage(handler: (data: Uint8Array, channel: TransportChannelKind) => void): () => void {
    this.messageListeners.add(handler)
    return () => {
      this.messageListeners.delete(handler)
    }
  }

  onStateChange(handler: (state: CanvasCollaborationConnectionState, error?: string) => void): () => void {
    this.stateListeners.add(handler)
    return () => {
      this.stateListeners.delete(handler)
    }
  }

  private emitMessage(data: Uint8Array, channel: TransportChannelKind): void {
    for (const listener of this.messageListeners) {
      try {
        listener(data, channel)
      } catch {}
    }
  }

  private emitState(state: CanvasCollaborationConnectionState, error?: string): void {
    for (const listener of this.stateListeners) {
      try {
        listener(state, error)
      } catch {}
    }
  }
}

export function createCollaborationTransport(
  options: CollaborationTransportOptions,
): CollaborationTransport {
  // Check for WebTransport support if explicitly configured and supported by browser
  const hasWebTransport =
    options.preferWebTransport &&
    Boolean(options.webTransportUrl) &&
    typeof (globalThis as unknown as { WebTransport?: unknown }).WebTransport === 'function'

  if (!hasWebTransport) {
    return new WebSocketCollaborationTransport(
      options.url,
      options.webSocketFactory,
    )
  }

  // Gracefully fallback to WebSocket transport
  return new WebSocketCollaborationTransport(
    options.url,
    options.webSocketFactory,
  )
}
