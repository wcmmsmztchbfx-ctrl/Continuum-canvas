import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { defaultInitialCanvas } from './canvas-storage.ts'
import { startGateway, type GatewayHandle } from './http-gateway.ts'

const directories: string[] = []
const gateways: GatewayHandle[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function gateway() {
  const dataDir = await mkdtemp(join(tmpdir(), 'continuum-agent-api-'))
  directories.push(dataDir)
  const handle = await startGateway({ dataDir, port: 0 })
  gateways.push(handle)
  await handle.runtime.canvases.saveCanvas(defaultInitialCanvas('canvas-a', 'project-a'))
  return handle
}

async function token(handle: GatewayHandle) {
  const session = await fetch(`${handle.origin}/api/local-admin/session`, { method: 'POST' })
  expect(session.ok).toBe(true)
  const cookie = session.headers.get('set-cookie')?.split(';', 1)[0]
  expect(cookie).toBeTruthy()
  const response = await fetch(`${handle.origin}/api/agent/v1/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie! },
    body: JSON.stringify({ canvasId: 'canvas-a', projectId: 'project-a', name: 'Test Agent' }),
  })
  expect(response.status).toBe(201)
  return (await response.json() as { secret: string }).secret
}

describe('Agent REST v1', () => {
  it('requires a canvas-scoped bearer token and returns idempotent operation receipts', async () => {
    const handle = await gateway()
    const secret = await token(handle)
    const unauthorized = await fetch(`${handle.origin}/api/agent/v1/canvases/canvas-a`)
    expect(unauthorized.status).toBe(403)

    const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }
    const body = {
      operationId: 'http-create-script', baseRevision: 0,
      operations: [{ type: 'node.create', alias: 'script', node: { kind: 'text', name: '版本一', text: '正文' } }],
    }
    const first = await fetch(`${handle.origin}/api/agent/v1/canvases/canvas-a/operations`, {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    expect(first.status).toBe(200)
    const firstJson = await first.json() as any
    expect(firstJson.receipt.replayed).toBe(false)
    expect(firstJson.receipt.revision).toBe(1)

    const replay = await fetch(`${handle.origin}/api/agent/v1/canvases/canvas-a/operations`, {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    expect((await replay.json() as any).receipt.replayed).toBe(true)

    const context = await fetch(`${handle.origin}/api/agent/v1/canvases/canvas-a`, { headers })
    const contextJson = await context.json() as any
    expect(contextJson.revision).toBe(1)
    expect(contextJson.canvas.nodes).toHaveLength(1)
  })

  it('does not grant destructive operations in the default token', async () => {
    const handle = await gateway()
    const secret = await token(handle)
    const response = await fetch(`${handle.origin}/api/agent/v1/canvases/canvas-a/operations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'delete-denied', operations: [{ type: 'node.delete', nodeId: 'missing' }] }),
    })
    expect(response.status).toBe(403)
  })
})
