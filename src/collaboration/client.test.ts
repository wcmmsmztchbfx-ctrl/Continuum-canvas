import { describe, expect, it, vi } from 'vitest'

import type {
  CollaborationRoom,
  CollaborationSession,
} from '../contracts/collaboration.ts'
import type { CanvasSnapshotV2 } from '../model/project.ts'
import {
  CollaborationClient,
  CollaborationClientError,
  getCollaborationDisplayName,
  getOrCreateCollaborationDeviceId,
  setCollaborationDisplayName,
} from './client.ts'

const room: CollaborationRoom = {
  roomId: 'room-alpha',
  canvasId: 'canvas-alpha',
  projectId: 'project-alpha',
  ownerId: 'member-owner',
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
  enabled: true,
  members: [{ id: 'member-owner', displayName: 'Owner', role: 'owner', removed: false }],
  invites: [],
}

const ownerSession: CollaborationSession = {
  roomId: room.roomId,
  canvasId: room.canvasId,
  projectId: room.projectId,
  memberId: room.ownerId,
  displayName: 'Owner',
  role: 'owner',
  status: 'connected',
}

const snapshot: CanvasSnapshotV2 = {
  version: 2,
  canvasId: room.canvasId,
  projectId: room.projectId,
  name: 'Shared canvas',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial))
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('CollaborationClient', () => {
  it('preserves only the validated existing room id from a conflict response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      error: {
        code: 'collaboration_conflict',
        message: 'internal detail must stay hidden',
        existingRoomId: 'room-existing',
        secret: 'must-not-leak',
      },
    }, { status: 409 }))
    const client = new CollaborationClient({ fetchImpl, storage: memoryStorage() })

    const error = await client.enableRoom({ snapshot, displayName: 'Owner' })
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      code: 'collaboration_conflict',
      existingRoomId: 'room-existing',
    })
    expect(JSON.stringify(error)).not.toContain('must-not-leak')
    expect(String(error)).not.toContain('internal detail')
  })

  it('keeps a stable device id and sends same-origin credentialed room requests', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      room,
      session: ownerSession,
      recoverySecret: 'owner-recovery-secret',
    }, { status: 201 }))
    const client = new CollaborationClient({
      fetchImpl,
      storage,
      createDeviceId: () => 'device-stable',
    })

    await expect(client.enableRoom({ snapshot, displayName: '  Owner  ' })).resolves.toEqual({
      room,
      session: ownerSession,
      recoverySecret: 'owner-recovery-secret',
    })
    expect(fetchImpl).toHaveBeenCalledWith('/api/collaboration/rooms', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({
        canvasId: room.canvasId,
        projectId: room.projectId,
        snapshot,
        deviceId: 'device-stable',
        displayName: 'Owner',
      }),
    }))
    expect(getOrCreateCollaborationDeviceId(storage, () => 'different-device')).toBe('device-stable')
    expect(JSON.stringify(storage)).not.toContain('owner-recovery-secret')
  })

  it('matches every existing room-management endpoint and validates responses', async () => {
    const editorSession = { ...ownerSession, memberId: 'member-editor', role: 'editor' as const }
    const invite = {
      id: 'invite-alpha', role: 'editor' as const,
      createdAt: '2026-07-18T00:01:00.000Z', revoked: false,
    }
    const responses = [
      Response.json({ room }),
      Response.json({ invite, secret: 'invite-secret' }, { status: 201 }),
      Response.json({ revoked: true }),
      Response.json({ session: editorSession }),
      Response.json({ updated: true }),
      Response.json({ removed: true }),
      Response.json({ revoked: true }),
      Response.json({ closed: true }),
    ]
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!)
    const client = new CollaborationClient({
      fetchImpl,
      storage: memoryStorage({ 'libtv-collaboration-device-id': 'device-editor' }),
    })

    await expect(client.getRoom(room.roomId)).resolves.toEqual(room)
    await expect(client.createInvite(room.roomId, 'editor')).resolves.toEqual({
      invite, secret: 'invite-secret',
    })
    await expect(client.revokeInvite(room.roomId, invite.id)).resolves.toBeUndefined()
    await expect(client.joinRoom({
      roomId: room.roomId, secret: 'invite-secret', displayName: 'Editor',
    })).resolves.toEqual(editorSession)
    await expect(client.setMemberRole(room.roomId, 'member-editor', 'viewer')).resolves.toBeUndefined()
    await expect(client.removeMember(room.roomId, 'member-editor')).resolves.toBeUndefined()
    await expect(client.leaveRoom(room.roomId)).resolves.toBeUndefined()
    await expect(client.closeRoom(room.roomId)).resolves.toBeUndefined()

    expect(fetchImpl.mock.calls.map(([path, init]) => [path, init?.method ?? 'GET'])).toEqual([
      ['/api/collaboration/rooms/room-alpha', 'GET'],
      ['/api/collaboration/rooms/room-alpha/invites', 'POST'],
      ['/api/collaboration/rooms/room-alpha/invites/invite-alpha', 'DELETE'],
      ['/api/collaboration/sessions', 'POST'],
      ['/api/collaboration/rooms/room-alpha/members/member-editor', 'PATCH'],
      ['/api/collaboration/rooms/room-alpha/members/member-editor', 'DELETE'],
      ['/api/collaboration/sessions/current?roomId=room-alpha', 'DELETE'],
      ['/api/collaboration/rooms/room-alpha', 'DELETE'],
    ])
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.credentials).toBe('same-origin')
    }
  })

  it('consumes an invite fragment only after a successful session exchange', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      session: { ...ownerSession, role: 'editor', memberId: 'member-editor' },
    }))
    const replaceState = vi.fn()
    const client = new CollaborationClient({
      fetchImpl,
      storage: memoryStorage(),
      createDeviceId: () => 'device-editor',
    })

    await expect(client.joinFromInviteFragment({
      roomId: room.roomId,
      displayName: 'Editor',
      location: {
        hash: '#invite=fragment-secret', pathname: '/canvas', search: '?canvasId=canvas-alpha',
      },
      history: { replaceState },
    })).resolves.toMatchObject({ role: 'editor' })

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      secret: 'fragment-secret',
    })
    expect(replaceState).toHaveBeenCalledWith(null, '', '/canvas?canvasId=canvas-alpha')
  })

  it('retains the invite fragment on failure and exposes only sanitized gateway errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      error: {
        code: 'collaboration_forbidden',
        message: 'Invite fragment-secret is invalid; must-not-leak',
        secret: 'must-not-leak',
      },
    }, { status: 403 }))
    const replaceState = vi.fn()
    const storage = memoryStorage()
    const client = new CollaborationClient({ fetchImpl, storage })

    const error = await client.joinFromInviteFragment({
      roomId: room.roomId,
      displayName: 'Editor',
      location: { hash: '#invite=fragment-secret', pathname: '/canvas', search: '' },
      history: { replaceState },
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(CollaborationClientError)
    expect(error).toMatchObject({
      status: 403,
      code: 'collaboration_forbidden',
      message: 'Collaboration access was denied',
    })
    expect((error as Error).stack).not.toMatch(/fragment-secret|must-not-leak/)
    expect(String(error)).not.toMatch(/fragment-secret|must-not-leak/)
    expect(JSON.stringify(error)).not.toMatch(/fragment-secret|must-not-leak/)
    expect(JSON.stringify(storage)).not.toContain('fragment-secret')
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('rejects missing invite fragments and display names beyond 32 characters locally', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new CollaborationClient({ fetchImpl, storage: memoryStorage() })

    await expect(client.joinFromInviteFragment({
      roomId: room.roomId,
      displayName: 'Editor',
      location: { hash: '', pathname: '/canvas', search: '' },
      history: { replaceState: vi.fn() },
    })).rejects.toMatchObject({ code: 'invite_missing' })
    await expect(client.joinRoom({
      roomId: room.roomId, secret: 'secret', displayName: 'x'.repeat(33),
    })).rejects.toMatchObject({ code: 'invalid_display_name' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('persists a trimmed nickname only after a successful join', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        session: { ...ownerSession, role: 'editor', memberId: 'member-editor', displayName: 'Editor' },
      }))
      .mockResolvedValueOnce(Response.json({
        error: { code: 'collaboration_forbidden', message: 'Rejected Secret Name' },
      }, { status: 403 }))
    const client = new CollaborationClient({
      fetchImpl,
      storage,
      createDeviceId: () => 'device-editor',
    })

    expect(getCollaborationDisplayName(storage)).toBeUndefined()
    await client.joinRoom({ roomId: room.roomId, secret: 'invite-1', displayName: '  Editor  ' })
    expect(getCollaborationDisplayName(storage)).toBe('Editor')

    await expect(client.joinRoom({
      roomId: room.roomId, secret: 'invite-2', displayName: 'Rejected Name',
    })).rejects.toMatchObject({ code: 'collaboration_forbidden' })
    expect(getCollaborationDisplayName(storage)).toBe('Editor')
  })

  it('validates nickname storage without overwriting the last valid value', () => {
    const storage = memoryStorage()

    expect(setCollaborationDisplayName(storage, '  Stable Name  ')).toBe('Stable Name')
    expect(getCollaborationDisplayName(storage)).toBe('Stable Name')
    expect(() => setCollaborationDisplayName(storage, '')).toThrow(/display name/i)
    expect(() => setCollaborationDisplayName(storage, 'x'.repeat(33))).toThrow(/display name/i)
    expect(getCollaborationDisplayName(storage)).toBe('Stable Name')
  })
})
