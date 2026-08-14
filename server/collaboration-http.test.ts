import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as nodeRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasSnapshotV2 } from '../src/model/project.ts'
import type { GenerationRequest, ProviderCatalog } from '../src/contracts/generation.ts'
import { startGateway, type GatewayHandle } from './http-gateway.ts'
import type { ProviderAdapter } from './providers/provider-adapter.ts'

const gateways: GatewayHandle[] = []
const catalog: ProviderCatalog = {
  providerId: 'aistartlab', version: 'catalog-v1', fetchedAt: new Date().toISOString(), stale: false,
  models: [{
    mediaType: 'image', channel: 46, model: 'gpt-image-2',
    qualityOptions: [{ value: '1K', label: '1K', pricing: { type: 'fixed_total', credits: 5 } }],
    aspectRatios: ['16:9'], countOptions: [1], durationOptions: [],
    countRange: { min: 1, max: 1, options: [1] }, modes: [],
    inputLimits: { images: 6, videos: 0, audios: 0 }, raw: {},
  }],
}

function generationRequest(clientRequestId: string, targetNodeId = 'node-target'): GenerationRequest {
  return {
    clientRequestId, projectId: 'project-alpha', canvasId: 'canvas-alpha', targetNodeId,
    providerId: 'aistartlab', catalogVersion: 'catalog-v1', mediaType: 'image', channel: 46,
    model: 'gpt-image-2', prompt: 'A quiet courtyard', quality: '1K', aspectRatio: '16:9',
    n: 1, references: [],
  }
}

function snapshot(): CanvasSnapshotV2 {
  return {
    version: 2,
    canvasId: 'canvas-alpha',
    projectId: 'project-alpha',
    name: 'Shared canvas',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  }
}

async function start(options: Parameters<typeof startGateway>[0] = {}): Promise<GatewayHandle> {
  const dataDir = await mkdtemp(join(tmpdir(), 'libtv-collaboration-http-'))
  const gateway = await startGateway({
    dataDir,
    envFile: join(dataDir, '.env.local'),
    env: { API_PROVIDER_AISTARTLAB_KEY: 'test-key' },
    host: '127.0.0.1',
    port: 0,
    ...options,
  })
  gateways.push(gateway)
  return gateway
}

function cookie(response: Response): string {
  const value = response.headers.get('set-cookie')
  if (!value) throw new Error('Expected collaboration session cookie')
  return value.split(';', 1)[0]
}

async function body(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>
}

function rawGet(origin: string, path: string): Promise<{ status: number; payload: Record<string, any> }> {
  const url = new URL(origin)
  return new Promise((resolve, reject) => {
    const request = nodeRequest({ hostname: url.hostname, port: url.port, path }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

async function enable(gateway: GatewayHandle) {
  const response = await fetch(`${gateway.origin}/api/collaboration/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: gateway.origin },
    body: JSON.stringify({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    }),
  })
  return { response, payload: await body(response) }
}

async function inviteCookie(
  gateway: GatewayHandle,
  ownerResponse: Response,
  roomId: string,
  role: 'editor' | 'viewer',
): Promise<string> {
  const invited = await fetch(`${gateway.origin}/api/collaboration/rooms/${roomId}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: gateway.origin, cookie: cookie(ownerResponse) },
    body: JSON.stringify({ role }),
  })
  const invitation = await body(invited)
  const exchanged = await fetch(`${gateway.origin}/api/collaboration/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: gateway.origin },
    body: JSON.stringify({
      roomId, secret: invitation.secret, deviceId: `device-${role}`, displayName: role,
    }),
  })
  return cookie(exchanged)
}

afterEach(async () => {
  await Promise.allSettled(gateways.splice(0).map((gateway) => gateway.close()))
})

describe('collaboration REST gateway', () => {
  it('requires the collaboration owner and a matching room header for provider writes', async () => {
    const gateway = await start()
    const owner = await enable(gateway)
    const roomId = owner.payload.room.roomId as string
    const ownerCookie = cookie(owner.response)
    const editorCookie = await inviteCookie(gateway, owner.response, roomId, 'editor')
    const viewerCookie = await inviteCookie(gateway, owner.response, roomId, 'viewer')
    const provider = {
      name: 'AIStartLab', adapterType: 'aistartlab-openapi',
      baseUrl: 'https://api.video.aistarslab.com/openapi', enabled: true, preferred: true,
    }
    const update = (sessionCookie?: string, headerRoom?: string) => fetch(
      `${gateway.origin}/api/providers/aistartlab`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(sessionCookie ? { cookie: sessionCookie } : {}),
          ...(headerRoom ? { 'x-collaboration-room': headerRoom } : {}),
        },
        body: JSON.stringify(provider),
      },
    )

    expect((await update()).status).toBe(403)
    const bootstrap = await fetch(`${gateway.origin}/api/local-admin/session`, { method: 'POST' })
    const localAdminCookie = cookie(bootstrap)
    const localAdmin = await fetch(`${gateway.origin}/api/providers/aistartlab`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: localAdminCookie },
      body: JSON.stringify(provider),
    })
    expect(localAdmin.status).toBe(200)
    expect((await update(ownerCookie, roomId)).status).toBe(200)
    expect((await update(editorCookie, roomId)).status).toBe(403)
    expect((await update(viewerCookie, roomId)).status).toBe(403)
    expect((await update(ownerCookie)).status).toBe(403)
    expect((await update(ownerCookie, 'wrong-room')).status).toBe(403)
    const malformedCookie = await fetch(`${gateway.origin}/api/providers/aistartlab/test`, {
      method: 'POST',
      headers: {
        cookie: 'canvas_collaboration_room_!!!=forged',
        'x-local-admin-mode': '1',
      },
    })
    expect(malformedCookie.status).toBe(403)
    const viewerTest = await fetch(`${gateway.origin}/api/providers/aistartlab/test`, {
      method: 'POST', headers: { cookie: viewerCookie, 'x-collaboration-room': roomId },
    })
    expect(viewerTest.status).toBe(403)
  })

  it('authorizes collaborative generation and serializes one active job per target node', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const createGeneration = vi.fn(async () => { await gate; return 'task-one' })
    const adapter: ProviderAdapter = {
      testConnection: async () => {}, syncCatalog: async () => catalog,
      presignReference: async () => { throw new Error('unused') },
      uploadReference: async () => { throw new Error('unused') },
      completeReference: async () => { throw new Error('unused') },
      createGeneration, getGenerationStatus: async () => [],
      getGenerationDetail: async () => { throw new Error('unused') },
    }
    const gateway = await start({ adapterFactory: () => adapter })
    await gateway.runtime.catalogs.sync('aistartlab', async () => catalog)
    const owner = await enable(gateway)
    const roomId = owner.payload.room.roomId as string
    const ownerCookie = cookie(owner.response)
    const editorCookie = await inviteCookie(gateway, owner.response, roomId, 'editor')
    const viewerCookie = await inviteCookie(gateway, owner.response, roomId, 'viewer')
    const submit = (sessionCookie: string, body: Record<string, unknown>, headerRoom = roomId) => fetch(
      `${gateway.origin}/api/generation-jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', cookie: sessionCookie,
          'x-collaboration-room': headerRoom,
        },
        body: JSON.stringify(body),
      },
    )

    expect((await submit(viewerCookie, generationRequest('viewer-job'))).status).toBe(403)
    expect((await submit(ownerCookie, generationRequest('wrong-room'), 'wrong-room')).status).toBe(403)
    const missingTarget = { ...generationRequest('missing-target'), targetNodeId: undefined }
    expect((await submit(ownerCookie, missingTarget)).status).toBe(400)

    const first = submit(ownerCookie, generationRequest('owner-job'))
    const second = submit(editorCookie, generationRequest('editor-job'))
    await vi.waitFor(() => expect(createGeneration).toHaveBeenCalledTimes(1))
    release()
    const [firstResponse, secondResponse] = await Promise.all([first, second])
    expect(firstResponse.status).toBe(202)
    expect(secondResponse.status).toBe(409)
    const firstPayload = await body(firstResponse)
    expect((await body(secondResponse)).error.code).toBe('target_busy')
    const idempotent = await submit(ownerCookie, generationRequest('owner-job'))
    expect(idempotent.status).toBe(202)
    expect((await body(idempotent)).job.id).toBe(firstPayload.job.id)
    expect(createGeneration).toHaveBeenCalledTimes(1)
  })
  it('returns a redacted 409 conflict for a duplicate active canvas room', async () => {
    const gateway = await start()
    const first = await enable(gateway)
    const duplicate = await enable(gateway)
    const payload = duplicate.payload

    expect(duplicate.response.status).toBe(409)
    expect(payload).toEqual({
      error: {
        code: 'collaboration_conflict',
        message: 'Collaboration session conflicts with the current state',
        existingRoomId: first.payload.room.roomId,
      },
    })
    expect(JSON.stringify(payload)).not.toMatch(/secret|recovery|digest|hash/i)
  })

  it('creates a room, sets a strict HttpOnly cookie and returns no stored digests', async () => {
    const gateway = await start()
    const { response, payload } = await enable(gateway)

    expect(response.status).toBe(201)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).toContain('SameSite=Strict')
    expect(response.headers.get('set-cookie')).not.toContain('Secure')
    expect(payload.session.role).toBe('owner')
    expect(payload.recoverySecret).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(JSON.stringify(payload)).not.toContain('Digest')
    expect(JSON.stringify(payload)).not.toContain('sessionToken')

    const status = await fetch(
      `${gateway.origin}/api/collaboration/rooms/${payload.room.roomId}`,
      { headers: { cookie: cookie(response) } },
    )
    expect(status.status).toBe(200)
    expect((await body(status)).room.canvasId).toBe('canvas-alpha')
  })

  it('exchanges an invite into a cookie and enforces viewer REST permissions', async () => {
    const gateway = await start()
    const owner = await enable(gateway)
    const ownerCookie = cookie(owner.response)
    const roomId = owner.payload.room.roomId as string
    const inviteResponse = await fetch(
      `${gateway.origin}/api/collaboration/rooms/${roomId}/invites`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: gateway.origin, cookie: ownerCookie },
        body: JSON.stringify({ role: 'viewer' }),
      },
    )
    const invite = await body(inviteResponse)
    const exchange = await fetch(`${gateway.origin}/api/collaboration/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gateway.origin },
      body: JSON.stringify({
        roomId, secret: invite.secret, deviceId: 'device-viewer', displayName: 'Viewer',
      }),
    })
    const viewerCookie = cookie(exchange)
    expect((await body(exchange)).session.role).toBe('viewer')

    const forbidden = await fetch(
      `${gateway.origin}/api/collaboration/rooms/${roomId}/invites`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: gateway.origin, cookie: viewerCookie },
        body: JSON.stringify({ role: 'editor' }),
      },
    )
    expect(forbidden.status).toBe(403)
    expect(await body(forbidden)).toEqual({
      error: { code: 'collaboration_forbidden', message: 'Collaboration access is not allowed' },
    })
  })

  it('revokes the current session and rejects disallowed mutation origins', async () => {
    const gateway = await start()
    const owner = await enable(gateway)
    const roomId = owner.payload.room.roomId as string
    const ownerCookie = cookie(owner.response)
    const evil = await fetch(
      `${gateway.origin}/api/collaboration/rooms/${roomId}/invites`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: ownerCookie },
        body: JSON.stringify({ role: 'editor' }),
      },
    )
    expect(evil.status).toBe(403)

    const revoked = await fetch(`${gateway.origin}/api/collaboration/sessions/current?roomId=${roomId}`, {
      method: 'DELETE', headers: { origin: gateway.origin, cookie: ownerCookie },
    })
    expect(revoked.status).toBe(200)
    expect(revoked.headers.get('set-cookie')).toContain('Max-Age=0')
    const status = await fetch(`${gateway.origin}/api/collaboration/rooms/${roomId}`, {
      headers: { cookie: ownerCookie },
    })
    expect(status.status).toBe(403)
  })

  it('marks cookies Secure when a public HTTPS origin is configured', async () => {
    const gateway = await start({
      publicOrigin: 'https://canvas.example',
      allowedOrigins: ['https://canvas.example'],
    })
    const response = await fetch(`${gateway.origin}/api/collaboration/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://canvas.example' },
      body: JSON.stringify({
        canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
        deviceId: 'device-owner', displayName: 'Owner',
      }),
    })
    expect(response.status).toBe(201)
    expect(response.headers.get('set-cookie')).toContain('Secure')
  })

  it('keeps REST sessions for two rooms in isolated cookies', async () => {
    const gateway = await start()
    const first = await enable(gateway)
    const secondResponse = await fetch(`${gateway.origin}/api/collaboration/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gateway.origin },
      body: JSON.stringify({
        canvasId: 'canvas-beta', projectId: 'project-beta',
        snapshot: { ...snapshot(), canvasId: 'canvas-beta', projectId: 'project-beta', name: 'Beta' },
        deviceId: 'device-owner', displayName: 'Owner',
      }),
    })
    const second = await body(secondResponse)
    const firstCookie = cookie(first.response)
    const secondCookie = cookie(secondResponse)
    expect(firstCookie.split('=', 1)[0]).toMatch(/^canvas_collaboration_room_/)
    expect(secondCookie.split('=', 1)[0]).toMatch(/^canvas_collaboration_room_/)
    expect(firstCookie.split('=', 1)[0]).not.toBe(secondCookie.split('=', 1)[0])
    const combinedCookies = `${firstCookie}; ${secondCookie}`

    for (const roomId of [first.payload.room.roomId, second.room.roomId]) {
      const status = await fetch(`${gateway.origin}/api/collaboration/rooms/${roomId}`, {
        headers: { cookie: combinedCookies },
      })
      expect(status.status).toBe(200)
    }

    const revoked = await fetch(
      `${gateway.origin}/api/collaboration/sessions/current?roomId=${first.payload.room.roomId}`,
      { method: 'DELETE', headers: { origin: gateway.origin, cookie: combinedCookies } },
    )
    expect(revoked.status).toBe(200)
    expect(revoked.headers.get('set-cookie')).toContain(`${firstCookie.split('=', 1)[0]}=`)
    expect(revoked.headers.get('set-cookie')).not.toContain(secondCookie.split('=', 1)[0])
    const secondStatus = await fetch(
      `${gateway.origin}/api/collaboration/rooms/${second.room.roomId}`,
      { headers: { cookie: combinedCookies } },
    )
    expect(secondStatus.status).toBe(200)
  })

  it('never returns invite secrets, session cookies or digests from status responses', async () => {
    const gateway = await start()
    const owner = await enable(gateway)
    const ownerCookie = cookie(owner.response)
    const roomId = owner.payload.room.roomId as string
    const inviteResponse = await fetch(`${gateway.origin}/api/collaboration/rooms/${roomId}/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gateway.origin, cookie: ownerCookie },
      body: JSON.stringify({ role: 'editor' }),
    })
    const invitePayload = await body(inviteResponse)
    const status = await fetch(`${gateway.origin}/api/collaboration/rooms/${roomId}`, {
      headers: { cookie: ownerCookie },
    })
    const source = await status.text()

    expect(source).not.toContain(invitePayload.secret)
    expect(source).not.toContain(owner.payload.recoverySecret)
    expect(source).not.toContain(ownerCookie.split('=', 2)[1])
    expect(source).not.toMatch(/secretDigest|tokenDigest|recoverySecretDigest|api[_-]?key/i)
  })

  it('maps collaboration invite and session quotas to explicit HTTP errors', async () => {
    const gateway = await start()
    const owner = await enable(gateway)
    const ownerCookie = cookie(owner.response)
    const roomId = owner.payload.room.roomId as string
    let inviteSecret = ''
    for (let index = 0; index < 20; index += 1) {
      const response = await fetch(`${gateway.origin}/api/collaboration/rooms/${roomId}/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: gateway.origin, cookie: ownerCookie },
        body: JSON.stringify({ role: 'editor' }),
      })
      expect(response.status).toBe(201)
      inviteSecret ||= (await body(response)).secret
    }
    const inviteLimit = await fetch(`${gateway.origin}/api/collaboration/rooms/${roomId}/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gateway.origin, cookie: ownerCookie },
      body: JSON.stringify({ role: 'viewer' }),
    })
    expect(inviteLimit.status).toBe(429)
    expect((await body(inviteLimit)).error.code).toBe('collaboration_limit_reached')

    for (let index = 0; index < 3; index += 1) {
      const exchanged = await fetch(`${gateway.origin}/api/collaboration/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: gateway.origin },
        body: JSON.stringify({
          roomId, secret: inviteSecret, deviceId: 'device-shared', displayName: 'Shared',
        }),
      })
      expect(exchanged.status).toBe(200)
    }
    const sessionLimit = await fetch(`${gateway.origin}/api/collaboration/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: gateway.origin },
      body: JSON.stringify({
        roomId, secret: inviteSecret, deviceId: 'device-shared', displayName: 'Shared',
      }),
    })
    expect(sessionLimit.status).toBe(409)
    expect((await body(sessionLimit)).error.code).toBe('collaboration_conflict')
  })

  it.each([
    '/api/collaboration/rooms/%2e%2e',
    '/api/collaboration/rooms/..%2fmetadata.json',
    '/api/collaboration/rooms/%5c..%5croom',
  ])('rejects encoded collaboration path traversal: %s', async (path) => {
    const gateway = await start()
    const response = await rawGet(gateway.origin, path)
    expect(response.status).toBe(400)
    expect(response.payload).toEqual({
      error: { code: 'invalid_api_path', message: 'Encoded API paths are not allowed' },
    })
  })
})
