import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as awarenessProtocol from 'y-protocols/awareness'

import { startGateway, type GatewayHandle } from './http-gateway.ts'

const handles: GatewayHandle[] = []
const dataDirs: string[] = []

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie')
  if (!header) throw new Error('Missing collaboration session cookie')
  return header.split(';', 1)[0]!
}

function messageFor(awareness: awarenessProtocol.Awareness): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
  )
  return encoding.toUint8Array(encoder)
}

async function openSocket(url: string, cookie: string, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie, origin } })
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 5_000)
    socket.once('open', () => { clearTimeout(timer); resolve(socket) })
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()))
  await Promise.allSettled(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('collaboration presence performance', () => {
  it('keeps ten clients sending 20Hz cursor and preview updates below 150ms p95', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'libtv-collaboration-perf-'))
    dataDirs.push(dataDir)
    const gateway = await startGateway({
      dataDir,
      envFile: join(dataDir, '.env.local'),
      env: {},
      host: '127.0.0.1',
      port: 0,
      collaborationHeartbeatMs: 2_000,
    })
    handles.push(gateway)
    const roomResponse = await fetch(`${gateway.origin}/api/collaboration/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gateway.origin },
      body: JSON.stringify({
        projectId: 'perf-project', canvasId: 'perf-canvas', deviceId: 'perf-owner',
        displayName: 'Performance owner',
        snapshot: {
          version: 2, projectId: 'perf-project', canvasId: 'perf-canvas', name: 'Performance',
          viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
        },
      }),
    })
    expect(roomResponse.status).toBe(201)
    const body = await roomResponse.json() as { room: { roomId: string } }
    const cookie = sessionCookie(roomResponse)
    const socketUrl = `${gateway.origin.replace(/^http/, 'ws')}/api/collaboration/ws?roomId=${body.room.roomId}`
    const sockets = await Promise.all(Array.from({ length: 10 }, () =>
      openSocket(socketUrl, cookie, gateway.origin),
    ))
    const awareness = sockets.map(() => {
      const value = new awarenessProtocol.Awareness(new Y.Doc())
      value.setLocalState(null)
      return value
    })
    const observed = new awarenessProtocol.Awareness(new Y.Doc())
    observed.setLocalState(null)
    const sentAt = new Map<string, number>()
    const lastSeen = new Map<number, number>()
    const latencies: number[] = []

    sockets[0]!.on('message', (raw) => {
      const decoder = decoding.createDecoder(new Uint8Array(raw as Buffer))
      if (decoding.readVarUint(decoder) !== 1) return
      awarenessProtocol.applyAwarenessUpdate(
        observed,
        decoding.readVarUint8Array(decoder),
        'server',
      )
      for (const [clientId, state] of observed.getStates()) {
        const cursor = (state as { cursor?: { x?: number } }).cursor
        const sequence = cursor?.x
        if (!Number.isInteger(sequence) || clientId === awareness[0]!.clientID) continue
        if ((lastSeen.get(clientId) ?? -1) >= sequence!) continue
        const started = sentAt.get(`${clientId}:${sequence}`)
        if (started !== undefined) latencies.push(performance.now() - started)
        lastSeen.set(clientId, sequence!)
      }
    })

    for (let sequence = 0; sequence < 20; sequence += 1) {
      const started = performance.now()
      for (let index = 0; index < sockets.length; index += 1) {
        const local = awareness[index]!
        local.setLocalState({
          cursor: { x: sequence, y: index },
          interactionPreview: {
            kind: 'drag', coordinateSpace: 'canvas-absolute',
            nodes: [{ nodeId: `node-${index}`, position: { x: sequence, y: index } }],
          },
        })
        sentAt.set(`${local.clientID}:${sequence}`, started)
        sockets[index]!.send(messageFor(local))
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const deadline = performance.now() + 5_000
    while (latencies.length < 9 * 18 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const sorted = latencies.toSorted((left, right) => left - right)
    const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? Infinity
    console.info(`collaboration presence p95=${p95.toFixed(2)}ms samples=${sorted.length}`)
    expect(sorted.length).toBeGreaterThanOrEqual(9 * 18)
    expect(p95).toBeLessThan(150)

    sockets.forEach((socket) => socket.close())
    awareness.forEach((value) => value.destroy())
    observed.destroy()
  }, 15_000)
})
