import { appendFile, mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { GenerationJob } from '../src/contracts/generation.ts'
import type { CanvasSnapshotV2 } from '../src/model/project.ts'
import {
  applyCollaborativeEntityChanges,
  createCollaborativeCanvasDocument,
} from '../src/collaboration/document.ts'
import {
  CollaborationAuthorizationError,
  CollaborationConflictError,
  CollaborationLimitError,
  CollaborationNotFoundError,
  CollaborationPersistenceError,
  CollaborationService,
} from './collaboration-service.ts'
import { atomicWriteJson } from './atomic-json.ts'

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

const OLD_ASSET_ID = '11111111-1111-4111-8111-111111111111'
const NEW_ASSET_ID = '22222222-2222-4222-8222-222222222222'

function mediaSnapshot(): CanvasSnapshotV2 {
  return {
    ...snapshot(),
    nodes: [{
      id: 'image-target', type: 'image', name: 'Target image',
      position: { x: 20, y: 30 }, size: { width: 480, height: 270 },
      data: {
        assetId: OLD_ASSET_ID, url: `/api/assets/${OLD_ASSET_ID}`,
        generation: {
          prompt: 'new prompt', status: 'generating', phase: 'queued',
          clientRequestId: 'client-new',
        },
      },
    }],
  }
}

function collaborativeJob(roomId: string, patch: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: 'job-new', roomId, targetNodeId: 'image-target',
    clientRequestId: 'client-new', requestDigest: 'a'.repeat(64),
    request: {
      clientRequestId: 'client-new', projectId: 'project-alpha', canvasId: 'canvas-alpha',
      targetNodeId: 'image-target', providerId: 'aistartlab', catalogVersion: 'catalog-v1',
      mediaType: 'image', channel: 46, model: 'gpt-image-2', prompt: 'new prompt',
      quality: '1K', aspectRatio: '9:16', n: 1, references: [],
    },
    status: 'queued', progress: 0,
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
    outputs: [], ...patch,
  } as GenerationJob
}

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'libtv-collaboration-'))
}

function testPersistence(overrides: Partial<{
  append(path: string, bytes: Uint8Array): Promise<void>
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
  writeJson(path: string, value: unknown): Promise<void>
}> = {}) {
  return {
    append: (path: string, bytes: Uint8Array) => appendFile(path, bytes),
    writeBytes: (path: string, bytes: Uint8Array) => writeFile(path, bytes).then(() => undefined),
    writeJson: atomicWriteJson,
    ...overrides,
  }
}

describe('CollaborationService', () => {
  it('accepts an editor node deletion update with deletion backup roots', async () => {
    const service = await CollaborationService.open({ dataDir: await directory() })
    const seeded = snapshot()
    seeded.nodes = [
      {
        id: 'node-a', type: 'text', name: 'A',
        position: { x: 0, y: 0 }, size: { width: 100, height: 80 },
        data: { text: 'A' },
      },
      {
        id: 'node-b', type: 'text', name: 'B',
        position: { x: 200, y: 0 }, size: { width: 100, height: 80 },
        data: { text: 'B' },
      },
    ]
    seeded.edges = [{ id: 'edge-a-b', source: 'node-a', target: 'node-b', relation: 'flow' }]
    const owner = await service.enableRoom({
      canvasId: seeded.canvasId,
      projectId: seeded.projectId,
      snapshot: seeded,
      deviceId: 'device-owner',
      displayName: 'Owner',
    })
    const editorDoc = new Y.Doc()
    Y.applyUpdate(editorDoc, Y.encodeStateAsUpdate(service.documentForRoom(owner.room.roomId)))
    const editor = createCollaborativeCanvasDocument(undefined, { doc: editorDoc })
    const beforeDeletion = Y.encodeStateVector(editorDoc)

    editor.transact(() => applyCollaborativeEntityChanges(editor, {
      origin: 'local',
      nodes: { upserted: [], removed: ['node-a'] },
      edges: { upserted: [], removed: ['edge-a-b'] },
    }))

    expect(() => service.applyValidatedUpdate(
      owner.room.roomId,
      Y.encodeStateAsUpdate(editorDoc, beforeDeletion),
      'editor-connection',
    )).not.toThrow()
    expect(service.exportSnapshot(owner.room.roomId)).toMatchObject({
      nodes: [{ id: 'node-b' }],
      edges: [],
    })

    editor.destroy()
    await service.close()
  })

  it('applies generation stages as server-task transactions and replaces only the first completed output', async () => {
    const dataDir = await directory()
    const service = await CollaborationService.open({ dataDir })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: mediaSnapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const origins: unknown[] = []
    service.documentForRoom(owner.room.roomId).on('afterTransaction', (transaction) => {
      if (transaction.changed.size > 0) origins.push(transaction.origin)
    })

    expect(service.applyGenerationJobUpdate(collaborativeJob(owner.room.roomId))).toBe(true)
    expect(service.applyGenerationJobUpdate(collaborativeJob(owner.room.roomId, {
      status: 'running', progress: 47,
    }))).toBe(true)
    expect(service.applyGenerationJobUpdate(collaborativeJob(owner.room.roomId, {
      status: 'complete', progress: 100, upstreamTaskId: 'upstream-private-task',
      outputs: [
        { assetId: NEW_ASSET_ID, url: `/api/assets/${NEW_ASSET_ID}`, contentType: 'image/png', size: 42 },
        { assetId: '33333333-3333-4333-8333-333333333333', url: '/api/assets/33333333-3333-4333-8333-333333333333', contentType: 'image/png', size: 43 },
      ],
    }))).toBe(true)

    const target = service.exportSnapshot(owner.room.roomId).nodes[0]
    expect(target).toMatchObject({
      id: 'image-target', type: 'image',
      data: {
        assetId: NEW_ASSET_ID, url: `/api/assets/${NEW_ASSET_ID}`,
        generation: {
          jobId: 'job-new', clientRequestId: 'client-new', status: 'complete',
          phase: 'complete', progress: 100, providerId: 'aistartlab',
          actualSettings: {
            kind: 'image', model: 'gpt-image-2', aspectRatio: '9:16', quality: '1K',
          },
        },
      },
    })
    expect(target?.data.generation?.outputs).toHaveLength(2)
    expect(JSON.stringify(target)).not.toContain('upstream-private-task')
    expect(origins).toContain('server-task')
    await service.settlePersistence(owner.room.roomId)
    await service.close()
  })

  it('rejects completion when any output is not a strict local asset', async () => {
    const service = await CollaborationService.open({ dataDir: await directory() })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: mediaSnapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const roomId = owner.room.roomId
    expect(service.applyGenerationJobUpdate(collaborativeJob(roomId))).toBe(true)
    expect(() => service.applyGenerationJobUpdate(collaborativeJob(roomId, {
      status: 'complete', progress: 100,
      outputs: [
        { assetId: NEW_ASSET_ID, url: `/api/assets/${NEW_ASSET_ID}`, contentType: 'image/png', size: 42 },
        { assetId: '33333333-3333-4333-8333-333333333333', url: 'https://signed.example/output.png?token=secret', contentType: 'image/png', size: 43 },
      ],
    }))).toThrow('local asset')
    expect(JSON.stringify(service.exportSnapshot(roomId))).not.toContain('signed.example')
    await service.close()
  })

  it('writes the frozen video audio setting into collaborative actual settings', async () => {
    const service = await CollaborationService.open({ dataDir: await directory() })
    const video = mediaSnapshot()
    video.nodes[0] = { ...video.nodes[0]!, type: 'video' }
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: video,
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const roomId = owner.room.roomId
    const request = {
      ...collaborativeJob(roomId).request,
      mediaType: 'video' as const,
      mode: 'image2video', duration: 6, generateAudio: true,
    }
    expect(service.applyGenerationJobUpdate(collaborativeJob(roomId, {
      request, status: 'complete', progress: 100,
      outputs: [{ assetId: NEW_ASSET_ID, url: `/api/assets/${NEW_ASSET_ID}`, contentType: 'video/mp4', size: 42 }],
    }))).toBe(true)
    expect(service.exportSnapshot(roomId).nodes[0]?.data.generation?.actualSettings)
      .toMatchObject({ kind: 'video', durationSec: 6, generateAudio: true })
    await service.close()
  })

  it('ignores stale jobs, rejects mismatched scope and media, and preserves media on failure', async () => {
    const service = await CollaborationService.open({ dataDir: await directory() })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: mediaSnapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const roomId = owner.room.roomId
    expect(service.applyGenerationJobUpdate(collaborativeJob(roomId))).toBe(true)

    const nodeRecord = service.documentForRoom(roomId).getMap<any>('nodes').get('image-target')
    nodeRecord.get('data').get('generation').set('clientRequestId', 'client-next')
    expect(service.applyGenerationJobUpdate(collaborativeJob(roomId, {
      id: 'job-next', clientRequestId: 'client-next',
      request: { ...collaborativeJob(roomId).request, clientRequestId: 'client-next' },
    }))).toBe(true)
    expect(service.applyGenerationJobUpdate(collaborativeJob(roomId, {
      status: 'complete', progress: 100,
      outputs: [{ assetId: NEW_ASSET_ID, url: `/api/assets/${NEW_ASSET_ID}`, contentType: 'image/png', size: 42 }],
    }))).toBe(false)

    expect(() => service.applyGenerationJobUpdate(collaborativeJob(roomId, {
      id: 'job-wrong-scope',
      request: { ...collaborativeJob(roomId).request, projectId: 'other-project' },
    }))).toThrow('scope')
    expect(() => service.applyGenerationJobUpdate(collaborativeJob(roomId, {
      id: 'job-wrong-type', clientRequestId: 'client-next',
      request: { ...collaborativeJob(roomId).request, clientRequestId: 'client-next', mediaType: 'video' },
    }))).toThrow('media')

    expect(service.applyGenerationJobUpdate(collaborativeJob(roomId, {
      id: 'job-next', clientRequestId: 'client-next', status: 'failed', progress: 63,
      request: { ...collaborativeJob(roomId).request, clientRequestId: 'client-next' },
      error: { code: 'PROVIDER_FAILED', message: 'safe failure' },
    }))).toBe(true)
    expect(service.exportSnapshot(roomId).nodes[0]?.data).toMatchObject({
      assetId: OLD_ASSET_ID, url: `/api/assets/${OLD_ASSET_ID}`,
      generation: {
        jobId: 'job-next', status: 'failed', phase: 'failed', progress: 63,
        error: { code: 'PROVIDER_FAILED', message: 'safe failure' },
      },
    })
    await service.close()
  })
  it('serializes concurrent enables so one active room owns a canvas scope', async () => {
    const service = await CollaborationService.open({ dataDir: await directory() })
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, () =>
      service.enableRoom({
        canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
        deviceId: 'device-owner', displayName: 'Owner',
      }),
    ))
    const successes = attempts.filter((attempt) => attempt.status === 'fulfilled')
    const failures = attempts.filter((attempt) => attempt.status === 'rejected')

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(19)
    const existingRoomId = successes[0]!.value.room.roomId
    for (const failure of failures) {
      const error = failure.reason
      expect(error).toBeInstanceOf(CollaborationConflictError)
      expect(error.existingRoomId).toBe(existingRoomId)
      expect(Object.keys(error).sort()).toEqual(['code', 'existingRoomId'])
      expect(`${error.message}\n${error.stack ?? ''}`).not.toMatch(/secret|recovery|digest|hash/i)
    }
    await service.close()
  })

  it('rebuilds the active canvas scope index after restart', async () => {
    const dataDir = await directory()
    const first = await CollaborationService.open({ dataDir })
    const owner = await first.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    await first.close()

    const restored = await CollaborationService.open({ dataDir })
    await expect(restored.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-other', displayName: 'Other',
    })).rejects.toMatchObject({
      code: 'collaboration_conflict', existingRoomId: owner.room.roomId,
    })
    await restored.close()
  })

  it('rejects duplicate active room metadata during startup', async () => {
    const dataDir = await directory()
    const first = await CollaborationService.open({ dataDir })
    const alpha = await first.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const beta = await first.enableRoom({
      canvasId: 'canvas-beta', projectId: 'project-beta',
      snapshot: { ...snapshot(), canvasId: 'canvas-beta', projectId: 'project-beta' },
      deviceId: 'device-owner', displayName: 'Owner',
    })
    await first.close()
    const betaMetadataPath = join(
      dataDir, 'collaboration', beta.room.roomId, 'metadata.json',
    )
    const betaMetadata = JSON.parse(await readFile(betaMetadataPath, 'utf8'))
    betaMetadata.canvasId = 'canvas-alpha'
    betaMetadata.projectId = 'project-alpha'
    await writeFile(betaMetadataPath, JSON.stringify(betaMetadata))

    await expect(CollaborationService.open({ dataDir })).rejects.toMatchObject({
      code: 'collaboration_conflict',
      existingRoomId: expect.stringMatching(
        new RegExp(`^(${alpha.room.roomId}|${beta.room.roomId})$`),
      ),
    })
  })

  it('releases a closed room canvas scope so it can be enabled again', async () => {
    const service = await CollaborationService.open({ dataDir: await directory() })
    const first = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    await service.closeRoom({ roomId: first.room.roomId, sessionToken: first.sessionToken })

    const reopened = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    expect(reopened.room.roomId).not.toBe(first.room.roomId)
    await service.close()
  })

  it('creates a room while persisting only secret digests', async () => {
    const dataDir = await directory()
    const service = await CollaborationService.open({ dataDir })

    const enabled = await service.enableRoom({
      canvasId: 'canvas-alpha',
      projectId: 'project-alpha',
      snapshot: snapshot(),
      deviceId: 'device-owner',
      displayName: 'Owner',
    })

    expect(enabled.room.canvasId).toBe('canvas-alpha')
    expect(enabled.session.role).toBe('owner')
    expect(enabled.sessionToken).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(enabled.recoverySecret).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(JSON.stringify(enabled.room)).not.toContain(enabled.sessionToken)
    expect(JSON.stringify(enabled.room)).not.toContain(enabled.recoverySecret)

    const metadata = await readFile(
      join(dataDir, 'collaboration', enabled.room.roomId, 'metadata.json'),
      'utf8',
    )
    expect(metadata).not.toContain(enabled.sessionToken)
    expect(metadata).not.toContain(enabled.recoverySecret)
    expect(metadata).toMatch(/[a-f0-9]{64}/)
    await service.close()
  })

  it('exchanges editor and viewer invites and revokes their sessions', async () => {
    const service = await CollaborationService.open({ dataDir: await directory() })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const editorInvite = await service.createInvite({
      roomId: owner.room.roomId, sessionToken: owner.sessionToken, role: 'editor',
    })
    const viewerInvite = await service.createInvite({
      roomId: owner.room.roomId, sessionToken: owner.sessionToken, role: 'viewer',
    })

    const editor = await service.exchangeSession({
      roomId: owner.room.roomId, secret: editorInvite.secret,
      deviceId: 'device-editor', displayName: 'Editor',
    })
    const viewer = await service.exchangeSession({
      roomId: owner.room.roomId, secret: viewerInvite.secret,
      deviceId: 'device-viewer', displayName: 'Viewer',
    })
    expect(editor.session.role).toBe('editor')
    expect(viewer.session.role).toBe('viewer')
    expect(service.authorizeSession({
      roomId: owner.room.roomId, sessionToken: editor.sessionToken, write: true,
    }).role).toBe('editor')
    expect(() => service.authorizeSession({
      roomId: owner.room.roomId, sessionToken: viewer.sessionToken, write: true,
    })).toThrow(CollaborationAuthorizationError)

    await service.removeMember({
      roomId: owner.room.roomId,
      sessionToken: owner.sessionToken,
      memberId: editor.session.memberId,
    })
    expect(() => service.authorizeSession({
      roomId: owner.room.roomId, sessionToken: editor.sessionToken,
    })).toThrow(CollaborationAuthorizationError)
    await service.close()
  })

  it('allows owners to change roles and revoke durable invites', async () => {
    const service = await CollaborationService.open({ dataDir: await directory() })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const invite = await service.createInvite({
      roomId: owner.room.roomId, sessionToken: owner.sessionToken, role: 'editor',
    })
    const editor = await service.exchangeSession({
      roomId: owner.room.roomId, secret: invite.secret,
      deviceId: 'device-editor', displayName: 'Editor',
    })

    await service.setMemberRole({
      roomId: owner.room.roomId, sessionToken: owner.sessionToken,
      memberId: editor.session.memberId, role: 'viewer',
    })
    expect(service.authorizeSession({
      roomId: owner.room.roomId, sessionToken: editor.sessionToken,
    }).role).toBe('viewer')
    await service.revokeInvite({
      roomId: owner.room.roomId,
      sessionToken: owner.sessionToken,
      inviteId: invite.invite.id,
    })
    await expect(service.exchangeSession({
      roomId: owner.room.roomId, secret: invite.secret,
      deviceId: 'device-late', displayName: 'Late user',
    })).rejects.toBeInstanceOf(CollaborationAuthorizationError)
    await service.close()
  })

  it('caps active members at ten without changing durable metadata', async () => {
    const dataDir = await directory()
    const service = await CollaborationService.open({ dataDir })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const invite = await service.createInvite({
      roomId: owner.room.roomId, sessionToken: owner.sessionToken, role: 'editor',
    })
    for (let index = 1; index <= 9; index += 1) {
      await service.exchangeSession({
        roomId: owner.room.roomId, secret: invite.secret,
        deviceId: `device-${index}`, displayName: `Editor ${index}`,
      })
    }
    const metadataPath = join(dataDir, 'collaboration', owner.room.roomId, 'metadata.json')
    const before = await readFile(metadataPath, 'utf8')
    await expect(service.exchangeSession({
      roomId: owner.room.roomId, secret: invite.secret,
      deviceId: 'device-over-limit', displayName: 'Too many',
    })).rejects.toBeInstanceOf(CollaborationLimitError)
    expect(await readFile(metadataPath, 'utf8')).toBe(before)
    await service.close()
  })

  it('reuses a device member and caps it at three active sessions without writing metadata', async () => {
    const dataDir = await directory()
    const service = await CollaborationService.open({ dataDir })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const invite = await service.createInvite({
      roomId: owner.room.roomId, sessionToken: owner.sessionToken, role: 'editor',
    })
    const first = await service.exchangeSession({
      roomId: owner.room.roomId, secret: invite.secret,
      deviceId: 'device-shared', displayName: 'Shared device',
    })
    const second = await service.exchangeSession({
      roomId: owner.room.roomId, secret: invite.secret,
      deviceId: 'device-shared', displayName: 'Renamed device',
    })
    const third = await service.exchangeSession({
      roomId: owner.room.roomId, secret: invite.secret,
      deviceId: 'device-shared', displayName: 'Third session',
    })
    expect(second.session.memberId).toBe(first.session.memberId)
    expect(third.session.memberId).toBe(first.session.memberId)
    const metadataPath = join(dataDir, 'collaboration', owner.room.roomId, 'metadata.json')
    const before = await readFile(metadataPath, 'utf8')
    await expect(service.exchangeSession({
      roomId: owner.room.roomId, secret: invite.secret,
      deviceId: 'device-shared', displayName: 'Fourth session',
    })).rejects.toBeInstanceOf(CollaborationConflictError)
    expect(await readFile(metadataPath, 'utf8')).toBe(before)
    await service.close()
  })

  it('bounds revoked session history per member while keeping the newest session usable', async () => {
    const dataDir = await directory()
    const service = await CollaborationService.open({ dataDir })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const invite = await service.createInvite({
      roomId: owner.room.roomId, sessionToken: owner.sessionToken, role: 'editor',
    })
    const issuedTokens: string[] = []
    let memberId = ''
    let sizeAtLimit = 0
    const metadataPath = join(dataDir, 'collaboration', owner.room.roomId, 'metadata.json')
    for (let index = 0; index < 25; index += 1) {
      const exchanged = await service.exchangeSession({
        roomId: owner.room.roomId, secret: invite.secret,
        deviceId: 'device-bounded', displayName: 'Bounded device',
      })
      memberId = exchanged.session.memberId
      issuedTokens.push(exchanged.sessionToken)
      if (index < 24) await service.revokeSession(exchanged.sessionToken)
      if (index === 11) sizeAtLimit = (await readFile(metadataPath)).byteLength
    }

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    const memberSessions = metadata.sessions.filter((session: { memberId: string }) =>
      session.memberId === memberId,
    )
    expect(memberSessions).toHaveLength(12)
    expect(memberSessions.filter((session: { revokedAt?: string }) => !session.revokedAt)).toHaveLength(1)
    expect(service.authorizeSession({
      roomId: owner.room.roomId, sessionToken: issuedTokens.at(-1) ?? '',
    }).memberId).toBe(memberId)
    expect(() => service.authorizeSession({
      roomId: owner.room.roomId, sessionToken: issuedTokens[0],
    })).toThrow(CollaborationAuthorizationError)
    expect((await readFile(metadataPath)).byteLength).toBeLessThanOrEqual(sizeAtLimit + 32)
    await service.close()
  })

  it('caps active invites at twenty without writing metadata', async () => {
    const dataDir = await directory()
    const service = await CollaborationService.open({ dataDir })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    for (let index = 0; index < 20; index += 1) {
      await service.createInvite({
        roomId: owner.room.roomId, sessionToken: owner.sessionToken, role: 'editor',
      })
    }
    const metadataPath = join(dataDir, 'collaboration', owner.room.roomId, 'metadata.json')
    const before = await readFile(metadataPath, 'utf8')
    await expect(service.createInvite({
      roomId: owner.room.roomId, sessionToken: owner.sessionToken, role: 'viewer',
    })).rejects.toBeInstanceOf(CollaborationLimitError)
    expect(await readFile(metadataPath, 'utf8')).toBe(before)
    await service.close()
  })

  it('removes a closed room from memory and does not reactivate it after restart', async () => {
    const dataDir = await directory()
    let appendCount = 0
    const service = await CollaborationService.open({
      dataDir,
      persistence: testPersistence({
        async append(path, bytes) {
          appendCount += 1
          await appendFile(path, bytes)
        },
      }),
    })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const document = service.documentForRoom(owner.room.roomId)
    await service.closeRoom({ roomId: owner.room.roomId, sessionToken: owner.sessionToken })
    expect(() => service.getRoomStatus(owner.room.roomId, owner.sessionToken))
      .toThrow(CollaborationNotFoundError)
    document.getMap('meta').set('after-room-close', true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(appendCount).toBe(0)
    await service.close()

    const restored = await CollaborationService.open({ dataDir })
    expect(() => restored.getRoomStatus(owner.room.roomId, owner.sessionToken))
      .toThrow(CollaborationNotFoundError)
    await restored.close()
  })

  it('restores rooms, documents and sessions after restart', async () => {
    const dataDir = await directory()
    const first = await CollaborationService.open({ dataDir })
    const owner = await first.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    await first.close()

    const restored = await CollaborationService.open({ dataDir })
    expect(restored.getRoomStatus(owner.room.roomId, owner.sessionToken)).toMatchObject({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', enabled: true,
    })
    expect(restored.authorizeSession({
      roomId: owner.room.roomId, sessionToken: owner.sessionToken,
    }).role).toBe('owner')
    expect(restored.exportSnapshot(owner.room.roomId)).toEqual({ ...snapshot(), version: 3, comments: [] })
    await restored.close()
  })

  it('rejects invalid names, scopes and path-like identifiers', async () => {
    const service = await CollaborationService.open({ dataDir: await directory() })
    await expect(service.enableRoom({
      canvasId: '../canvas', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })).rejects.toThrow('canvasId')
    await expect(service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'x'.repeat(33),
    })).rejects.toThrow('displayName')
    expect(() => service.getRoomStatus('../room', 'secret')).toThrow('roomId')
    await service.close()
  })

  it('recovers uncompressed incremental Yjs updates after restart', async () => {
    const dataDir = await directory()
    const first = await CollaborationService.open({
      dataDir, compactAfterUpdates: 100, compactAfterBytes: 1024 * 1024,
    })
    const owner = await first.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    first.documentForRoom(owner.room.roomId).getMap('meta').set('name', 'Recovered name')
    await first.settlePersistence(owner.room.roomId)

    const second = await CollaborationService.open({ dataDir })
    expect(second.exportSnapshot(owner.room.roomId).name).toBe('Recovered name')
    await second.close()
    await first.close()
  })

  it('compacts a bounded update log and writes a compatible v2 snapshot', async () => {
    const dataDir = await directory()
    const service = await CollaborationService.open({
      dataDir, compactAfterUpdates: 2, compactAfterBytes: 1024 * 1024,
    })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const meta = service.documentForRoom(owner.room.roomId).getMap('meta')
    meta.set('name', 'First')
    meta.set('name', 'Compacted')
    const roomDir = join(dataDir, 'collaboration', owner.room.roomId)

    await service.settlePersistence(owner.room.roomId)
    await expect.poll(async () => (await stat(join(roomDir, 'updates.bin'))).size).toBe(0)
    expect(JSON.parse(await readFile(join(roomDir, 'canvas.snapshot.json'), 'utf8'))).toMatchObject({
      version: 3, canvasId: 'canvas-alpha', projectId: 'project-alpha', name: 'Compacted',
    })
    expect((await stat(join(roomDir, 'snapshot.bin'))).size).toBeGreaterThan(0)
    await service.close()
  })

  it('periodically exports dirty rooms as compatible v2 JSON', async () => {
    const dataDir = await directory()
    const service = await CollaborationService.open({
      dataDir, exportIntervalMs: 10, compactAfterUpdates: 100,
    })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    service.documentForRoom(owner.room.roomId).getMap('meta').set('name', 'Periodic export')
    const exported = join(dataDir, 'collaboration', owner.room.roomId, 'canvas.snapshot.json')
    await expect.poll(async () => JSON.parse(await readFile(exported, 'utf8')).name).toBe('Periodic export')
    await service.close()
  })

  it.each(['metadata', 'snapshot', 'updates'])(
    'rejects corrupt persisted %s data instead of partially opening a room',
    async (kind) => {
      const dataDir = await directory()
      const roomDir = join(dataDir, 'collaboration', 'room-corrupt')
      await mkdir(roomDir, { recursive: true })
      const metadata = {
        version: 1, roomId: 'room-corrupt', canvasId: 'canvas-alpha', projectId: 'project-alpha',
        ownerId: 'owner', recoverySecretDigest: '0'.repeat(64), createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), enabled: true, invites: [], members: [], sessions: [],
      }
      await writeFile(join(roomDir, 'metadata.json'), kind === 'metadata' ? '{broken' : JSON.stringify(metadata))
      await writeFile(join(roomDir, 'snapshot.bin'), kind === 'snapshot' ? new Uint8Array([255]) : new Uint8Array())
      await writeFile(join(roomDir, 'updates.bin'), kind === 'updates' ? new Uint8Array([0, 0, 0, 9, 1]) : new Uint8Array())

      await expect(CollaborationService.open({ dataDir })).rejects.toThrow()
    },
  )

  it('serializes periodic compaction with updates added while snapshot writing is paused', async () => {
    const dataDir = await directory()
    let pauseCompaction = false
    let releaseCompaction = () => {}
    const compactReleased = new Promise<void>((resolve) => { releaseCompaction = resolve })
    let reportCompactionStarted = () => {}
    const compactStarted = new Promise<void>((resolve) => { reportCompactionStarted = resolve })
    const persistence = testPersistence({
      async writeBytes(path, bytes) {
        if (pauseCompaction && path.endsWith('snapshot.bin')) {
          pauseCompaction = false
          reportCompactionStarted()
          await compactReleased
        }
        await writeFile(path, bytes)
      },
    })
    const first = await CollaborationService.open({
      dataDir, persistence, exportIntervalMs: 5, compactAfterUpdates: 100,
    })
    const owner = await first.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const meta = first.documentForRoom(owner.room.roomId).getMap('meta')
    pauseCompaction = true
    meta.set('first-during-race', true)
    await compactStarted
    meta.set('second-during-race', true)
    releaseCompaction()
    await first.settlePersistence(owner.room.roomId)
    await first.close()

    const restored = await CollaborationService.open({ dataDir })
    const restoredMeta = restored.documentForRoom(owner.room.roomId).getMap('meta')
    expect(restoredMeta.get('first-during-race')).toBe(true)
    expect(restoredMeta.get('second-during-race')).toBe(true)
    await restored.close()
  })

  it('rejects late writes and drains the final room queue before closing', async () => {
    const dataDir = await directory()
    let releaseAppend = () => {}
    const appendReleased = new Promise<void>((resolve) => { releaseAppend = resolve })
    let reportAppendStarted = () => {}
    const appendStarted = new Promise<void>((resolve) => { reportAppendStarted = resolve })
    let blockAppend = false
    const service = await CollaborationService.open({
      dataDir,
      compactAfterUpdates: 100,
      persistence: testPersistence({
        async append(path, bytes) {
          if (blockAppend) {
            blockAppend = false
            reportAppendStarted()
            await appendReleased
          }
          await appendFile(path, bytes)
        },
      }),
    })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const meta = service.documentForRoom(owner.room.roomId).getMap('meta')
    blockAppend = true
    meta.set('before-close', true)
    await appendStarted

    const closing = service.close()
    expect(() => service.authorizeSession({
      roomId: owner.room.roomId, sessionToken: owner.sessionToken, write: true,
    })).toThrow('closing')
    meta.set('late-write', true)
    await expect(Promise.race([
      closing.then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 20)),
    ])).resolves.toBe('waiting')

    releaseAppend()
    await closing
    const restored = await CollaborationService.open({ dataDir })
    const restoredMeta = restored.documentForRoom(owner.room.roomId).getMap('meta')
    expect(restoredMeta.get('before-close')).toBe(true)
    expect(restoredMeta.get('late-write')).toBeUndefined()
    await restored.close()
  })

  it.each(['append', 'compact'] as const)(
    'fails closed after a %s error without permanently rejecting the queue',
    async (failureKind) => {
      const dataDir = await directory()
      let fail = false
      const persistence = testPersistence({
        async append(path, bytes) {
          if (fail && failureKind === 'append') throw new Error('injected append failure')
          await appendFile(path, bytes)
        },
        async writeBytes(path, bytes) {
          if (fail && failureKind === 'compact' && path.endsWith('snapshot.bin')) {
            throw new Error('injected compact failure')
          }
          await writeFile(path, bytes)
        },
      })
      const service = await CollaborationService.open({
        dataDir, persistence, compactAfterUpdates: failureKind === 'compact' ? 1 : 100,
      })
      const owner = await service.enableRoom({
        canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
        deviceId: 'device-owner', displayName: 'Owner',
      })
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      fail = true
      service.documentForRoom(owner.room.roomId).getMap('meta').set('failed-write', true)

      await expect(service.settlePersistence(owner.room.roomId)).rejects.toBeInstanceOf(
        CollaborationPersistenceError,
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
      expect(() => service.authorizeSession({
        roomId: owner.room.roomId, sessionToken: owner.sessionToken, write: true,
      })).toThrow(CollaborationPersistenceError)
      await expect(service.createInvite({
        roomId: owner.room.roomId, sessionToken: owner.sessionToken, role: 'editor',
      })).rejects.toBeInstanceOf(CollaborationPersistenceError)
      expect(service.getRoomStatus(owner.room.roomId, owner.sessionToken).invites).toHaveLength(0)

      fail = false
      await service.recoverRoomPersistence(owner.room.roomId)
      service.documentForRoom(owner.room.roomId).getMap('meta').set('after-recovery', true)
      await service.settlePersistence(owner.room.roomId)
      process.off('unhandledRejection', unhandled)
      await service.close()

      const restored = await CollaborationService.open({ dataDir })
      expect(restored.documentForRoom(owner.room.roomId).getMap('meta').get('failed-write')).toBe(true)
      expect(restored.documentForRoom(owner.room.roomId).getMap('meta').get('after-recovery')).toBe(true)
      await restored.close()
    },
  )

  it('rolls back authorization metadata when its atomic write fails', async () => {
    const dataDir = await directory()
    let failMetadata = false
    const persistence = testPersistence({
      async writeJson(path, value) {
        if (failMetadata && path.endsWith('metadata.json')) {
          throw new Error('injected metadata failure')
        }
        await atomicWriteJson(path, value)
      },
    })
    const service = await CollaborationService.open({ dataDir, persistence })
    const owner = await service.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const created = await service.createInvite({
      roomId: owner.room.roomId, sessionToken: owner.sessionToken, role: 'editor',
    })

    failMetadata = true
    await expect(service.revokeInvite({
      roomId: owner.room.roomId,
      sessionToken: owner.sessionToken,
      inviteId: created.invite.id,
    })).rejects.toBeInstanceOf(CollaborationPersistenceError)
    expect(service.getRoomStatus(owner.room.roomId, owner.sessionToken).invites[0]?.revoked)
      .toBe(false)

    failMetadata = false
    await service.recoverRoomPersistence(owner.room.roomId)
    await service.close()
    const restored = await CollaborationService.open({ dataDir })
    await expect(restored.exchangeSession({
      roomId: owner.room.roomId,
      secret: created.secret,
      deviceId: 'device-restored-editor',
      displayName: 'Restored editor',
    })).resolves.toMatchObject({ session: { role: 'editor' } })
    await restored.close()
  })

  it.each([
    ['unknown key', (metadata: any) => { metadata.apiKey = 'must-not-load' }],
    ['invalid version', (metadata: any) => { metadata.version = 2 }],
    ['path room id', (metadata: any) => { metadata.roomId = '../room' }],
    ['invalid role', (metadata: any) => { metadata.members[0].role = 'admin' }],
    ['invalid digest', (metadata: any) => { metadata.sessions[0].tokenDigest = 'xyz' }],
    ['duplicate session', (metadata: any) => { metadata.sessions.push({ ...metadata.sessions[0] }) }],
    ['invalid timestamp', (metadata: any) => { metadata.updatedAt = 'yesterday' }],
    ['dangling member', (metadata: any) => { metadata.sessions[0].memberId = 'missing' }],
    ['too many member sessions', (metadata: any) => {
      const source = metadata.sessions[0]
      metadata.sessions = Array.from({ length: 13 }, (_, index) => ({
        ...source,
        id: `session-${index}`,
        tokenDigest: index.toString(16).padStart(64, '0'),
      }))
    }],
  ])('rejects stored room metadata with %s during startup', async (_label, corrupt) => {
    const dataDir = await directory()
    const first = await CollaborationService.open({ dataDir })
    const owner = await first.enableRoom({
      canvasId: 'canvas-alpha', projectId: 'project-alpha', snapshot: snapshot(),
      deviceId: 'device-owner', displayName: 'Owner',
    })
    await first.close()
    const path = join(dataDir, 'collaboration', owner.room.roomId, 'metadata.json')
    const metadata = JSON.parse(await readFile(path, 'utf8'))
    corrupt(metadata)
    await writeFile(path, JSON.stringify(metadata))

    await expect(CollaborationService.open({ dataDir })).rejects.toThrow(
      'Invalid collaboration room metadata',
    )
  })
})
