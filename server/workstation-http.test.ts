import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startGateway, type GatewayHandle } from './http-gateway.ts'

const gateways: GatewayHandle[] = []

async function startWorkstation(): Promise<GatewayHandle> {
  const dataDir = await mkdtemp(join(tmpdir(), 'continuum-workstation-http-'))
  const gateway = await startGateway({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    processEnv: { CANVAS_OPERATION_MODE: 'workstation' },
  })
  gateways.push(gateway)
  return gateway
}

async function startHost(): Promise<GatewayHandle> {
  const dataDir = await mkdtemp(join(tmpdir(), 'continuum-host-http-'))
  const gateway = await startGateway({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    processEnv: { CANVAS_OPERATION_MODE: 'host' },
  })
  gateways.push(gateway)
  return gateway
}

function sessionCookie(response: Response): string {
  const value = response.headers.get('set-cookie')
  if (!value) throw new Error('Expected workstation cookie')
  return value.split(';', 1)[0]!
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()))
})

describe('workstation access boundary', () => {
  it('requires a nickname and keeps each workspace in its own namespace', async () => {
    const gateway = await startWorkstation()
    const context = await fetch(`${gateway.origin}/api/access/context`)
    expect(context.status).toBe(200)
    expect(await context.json()).toMatchObject({
      operationMode: 'workstation',
      workstation: { authenticated: false },
    })

    const blocked = await fetch(`${gateway.origin}/api/workspace/manifest`)
    expect(blocked.status).toBe(401)

    const aliceSession = await fetch(`${gateway.origin}/api/workstation/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice' }),
    })
    const aliceCookie = sessionCookie(aliceSession)
    expect(aliceSession.status).toBe(200)
    const aliceManifest = await (await fetch(`${gateway.origin}/api/workspace/manifest`, {
      headers: { cookie: aliceCookie },
    })).json() as { manifest: { projects: Array<{ projectId: string }>; canvases: Array<{ canvasId: string }> } }
    const aliceProject = aliceManifest.manifest.projects[0]!
    const aliceCanvas = aliceManifest.manifest.canvases[0]!
    const aliceSnapshot = {
      version: 3,
      canvasId: aliceCanvas.canvasId,
      projectId: aliceProject.projectId,
      name: 'Alice canvas',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      comments: [],
    }
    const saved = await fetch(`${gateway.origin}/api/canvases/${aliceCanvas.canvasId}`, {
      method: 'PUT',
      headers: { cookie: aliceCookie, 'content-type': 'application/json' },
      body: JSON.stringify(aliceSnapshot),
    })
    expect(saved.status).toBe(200)

    const bobSession = await fetch(`${gateway.origin}/api/workstation/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Bob' }),
    })
    const bobCookie = sessionCookie(bobSession)
    const bobManifest = await (await fetch(`${gateway.origin}/api/workspace/manifest`, {
      headers: { cookie: bobCookie },
    })).json() as { manifest: { projects: Array<{ projectId: string }>; canvases: Array<{ canvasId: string }> } }
    expect(bobManifest.manifest.projects[0]!.projectId).not.toBe(aliceProject.projectId)
    expect(bobManifest.manifest.canvases[0]!.canvasId).not.toBe(aliceCanvas.canvasId)
    const bobCanvas = await (await fetch(`${gateway.origin}/api/canvases/${aliceCanvas.canvasId}`, {
      headers: { cookie: bobCookie },
    })).json() as { canvas?: unknown }
    expect(bobCanvas.canvas).toBeUndefined()
  })

  it('keeps provider API keys scoped to a workstation canvas', async () => {
    const gateway = await startWorkstation()
    const session = await fetch(`${gateway.origin}/api/workstation/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice' }),
    })
    const aliceCookie = sessionCookie(session)
    const bobSession = await fetch(`${gateway.origin}/api/workstation/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Bob' }),
    })
    const bobCookie = sessionCookie(bobSession)
    const context = await (await fetch(`${gateway.origin}/api/workspace/manifest`, {
      headers: { cookie: aliceCookie },
    })).json() as { manifest: { projects: Array<{ projectId: string }>; canvases: Array<{ canvasId: string }> } }
    const projectId = context.manifest.projects[0]!.projectId
    const canvasId = context.manifest.canvases[0]!.canvasId
    const scope = `?projectId=${encodeURIComponent(projectId)}&canvasId=${encodeURIComponent(canvasId)}`

    const saved = await fetch(`${gateway.origin}/api/providers/aistartlab/secret${scope}`, {
      method: 'PUT',
      headers: { cookie: aliceCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'alice-canvas-secret' }),
    })
    expect(saved.status).toBe(200)
    const aliceProviders = await (await fetch(`${gateway.origin}/api/providers${scope}`, {
      headers: { cookie: aliceCookie },
    })).json() as { providers: Array<{ id: string; secretConfigured: boolean }> }
    expect(aliceProviders.providers.find((provider) => provider.id === 'aistartlab')?.secretConfigured).toBe(true)

    const bobProviders = await (await fetch(`${gateway.origin}/api/providers${scope}`, {
      headers: { cookie: bobCookie },
    })).json() as { providers: Array<{ id: string; secretConfigured: boolean }> }
    expect(bobProviders.providers.find((provider) => provider.id === 'aistartlab')?.secretConfigured).toBe(false)
  })

  it('keeps an invitation behind the workstation nickname gate', async () => {
    const gateway = await startWorkstation()
    const session = await fetch(`${gateway.origin}/api/workstation/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice' }),
    })
    const aliceCookie = sessionCookie(session)
    const manifest = await (await fetch(`${gateway.origin}/api/workspace/manifest`, {
      headers: { cookie: aliceCookie },
    })).json() as { manifest: { projects: Array<{ projectId: string }>; canvases: Array<{ canvasId: string; name: string }> } }
    const projectId = manifest.manifest.projects[0]!.projectId
    const canvas = manifest.manifest.canvases[0]!
    const snapshot = {
      version: 3,
      canvasId: canvas.canvasId,
      projectId,
      name: canvas.name,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      comments: [],
    }
    const roomResponse = await fetch(`${gateway.origin}/api/collaboration/rooms`, {
      method: 'POST',
      headers: { cookie: aliceCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, canvasId: canvas.canvasId, deviceId: 'alice', displayName: 'Alice', snapshot }),
    })
    expect(roomResponse.status).toBe(201)
    const room = await roomResponse.json() as { room: { roomId: string } }
    const blocked = await fetch(`${gateway.origin}/api/workspace/manifest`, {
      headers: { 'x-collaboration-room': room.room.roomId },
    })
    expect(blocked.status).toBe(401)
    const allowed = await fetch(`${gateway.origin}/api/workspace/manifest`, {
      headers: { cookie: aliceCookie, 'x-collaboration-room': room.room.roomId },
    })
    expect(allowed.status).toBe(200)
    const filtered = await allowed.json() as { manifest: { canvases: unknown[] } }
    expect(filtered.manifest.canvases).toHaveLength(1)
  })

  it('allows a remote editor to update canvas API config but blocks viewers', async () => {
    const gateway = await startHost()
    const manifest = await (await fetch(`${gateway.origin}/api/workspace/manifest`)).json() as {
      manifest: { projects: Array<{ projectId: string }>; canvases: Array<{ canvasId: string; name: string }> }
    }
    const projectId = manifest.manifest.projects[0]!.projectId
    const canvasId = manifest.manifest.canvases[0]!.canvasId
    const snapshot = {
      version: 3,
      canvasId,
      projectId,
      name: manifest.manifest.canvases[0]!.name,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      comments: [],
    }
    const roomResponse = await fetch(`${gateway.origin}/api/collaboration/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, canvasId, deviceId: 'owner', displayName: 'Owner', snapshot }),
    })
    expect(roomResponse.status).toBe(201)
    const roomPayload = await roomResponse.json() as { room: { roomId: string }; recoverySecret: string }
    const ownerCookie = sessionCookie(roomResponse)
    const inviteResponse = await fetch(`${gateway.origin}/api/collaboration/rooms/${roomPayload.room.roomId}/invites`, {
      method: 'POST',
      headers: {
        cookie: ownerCookie,
        'x-collaboration-room': roomPayload.room.roomId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'viewer' }),
    })
    const viewerInvite = await inviteResponse.json() as { secret: string }
    const viewerSession = await fetch(`${gateway.origin}/api/collaboration/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: roomPayload.room.roomId,
        secret: viewerInvite.secret,
        deviceId: 'viewer',
        displayName: 'Viewer',
      }),
    })
    const viewerCookie = sessionCookie(viewerSession)
    const path = `${gateway.origin}/api/providers/aistartlab/secret?projectId=${projectId}&canvasId=${canvasId}`
    const blocked = await fetch(path, {
      method: 'PUT',
      headers: {
        cookie: viewerCookie,
        'x-collaboration-room': roomPayload.room.roomId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiKey: 'viewer-secret' }),
    })
    expect(blocked.status).toBe(403)

    const editorInviteResponse = await fetch(`${gateway.origin}/api/collaboration/rooms/${roomPayload.room.roomId}/invites`, {
      method: 'POST',
      headers: {
        cookie: ownerCookie,
        'x-collaboration-room': roomPayload.room.roomId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'editor' }),
    })
    const editorInvite = await editorInviteResponse.json() as { secret: string }
    const editorSession = await fetch(`${gateway.origin}/api/collaboration/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: roomPayload.room.roomId,
        secret: editorInvite.secret,
        deviceId: 'editor',
        displayName: 'Editor',
      }),
    })
    const editorCookie = sessionCookie(editorSession)
    const allowed = await fetch(path, {
      method: 'PUT',
      headers: {
        cookie: editorCookie,
        'x-collaboration-room': roomPayload.room.roomId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiKey: 'editor-secret' }),
    })
    expect(allowed.status).toBe(200)
  })

  it('exposes administration on a loopback-only port', async () => {
    const gateway = await startWorkstation()
    expect(gateway.adminOrigin).toMatch(/^http:\/\/127\.0\.0\.1:/)
    const response = await fetch(`${gateway.adminOrigin}/api/system/settings`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ operationMode: 'workstation' })
    const context = await fetch(`${gateway.adminOrigin}/api/access/context`)
    expect(context.status).toBe(200)
    expect(await context.json()).toMatchObject({ canManageSettings: true })
    const publicVersion = await fetch(`${gateway.origin}/api/system/version`)
    expect(publicVersion.status).toBe(200)
    expect(await publicVersion.json()).toEqual({ version: '1.2.0', name: 'Continuum Canvas' })
    const adminVersion = await fetch(`${gateway.adminOrigin}/api/system/version`)
    expect(adminVersion.status).toBe(200)
    expect(await adminVersion.json()).toMatchObject({
      version: '1.2.0',
      name: 'Continuum Canvas',
      nodeVersion: expect.any(String),
      uptimeSeconds: expect.any(Number),
    })
    const manifest = await fetch(`${gateway.adminOrigin}/api/workspace/manifest`)
    expect(manifest.status).toBe(200)
    const update = await fetch(`${gateway.adminOrigin}/api/system/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationMode: 'workstation' }),
    })
    expect(update.status).toBe(200)
  })
})
