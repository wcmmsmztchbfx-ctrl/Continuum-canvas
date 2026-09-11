import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentAccessError, AgentAccessStore } from './agent-access-store.ts'
import { CanvasDocumentService, CanvasRevisionConflictError } from './canvas-document-service.ts'
import { CanvasOperationService } from './canvas-operation-service.ts'
import { CanvasPersistenceService, defaultInitialCanvas } from './canvas-storage.ts'
import { CollaborationService } from './collaboration-service.ts'
import { WorkflowInputError, WorkflowService } from './workflow-service.ts'
import type { AssetStore } from './asset-store.ts'

const directories: string[] = []

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'continuum-agent-foundation-'))
  directories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function inactiveCollaboration(): CollaborationService {
  return {
    snapshotForCanvas: () => undefined,
    revisionForCanvas: () => undefined,
    applyCanvasSnapshot: () => undefined,
  } as unknown as CollaborationService
}

describe('external Agent foundation', () => {
  it('stores only scoped token metadata and rejects revoked or cross-canvas access', async () => {
    const dataDir = await directory()
    const store = await AgentAccessStore.open(dataDir)
    const created = await store.create({
      canvasId: 'canvas-a', projectId: 'project-a', name: 'Codex',
      scopes: ['canvas:read', 'canvas:write'],
    })

    expect(created.secret).toMatch(/^cva_/)
    expect(store.authorize(created.secret, { canvasId: 'canvas-a', scope: 'canvas:read' }).id)
      .toBe(created.token.id)
    expect(() => store.authorize(created.secret, { canvasId: 'canvas-b', scope: 'canvas:read' }))
      .toThrow(AgentAccessError)
    expect(() => store.authorize(created.secret, { canvasId: 'canvas-a', scope: 'canvas:delete' }))
      .toThrow(AgentAccessError)

    await store.revoke(created.token.id)
    expect(() => store.authorize(created.secret, { canvasId: 'canvas-a', scope: 'canvas:read' }))
      .toThrow(AgentAccessError)
  })

  it('commits an aliased node graph atomically and replays operation receipts idempotently', async () => {
    const dataDir = await directory()
    const canvases = new CanvasPersistenceService({ dataDir })
    await canvases.saveCanvas(defaultInitialCanvas('canvas-a', 'project-a'))
    const documents = await CanvasDocumentService.open({
      dataDir, canvases, collaboration: inactiveCollaboration(),
    })
    const operations = await CanvasOperationService.open(dataDir, documents)

    const first = await operations.execute('canvas-a', {
      operationId: 'create-script-graph', baseRevision: 0,
      operations: [
        { type: 'node.create', alias: 'script', node: { kind: 'text', name: '版本一', text: '完整文案' } },
        { type: 'node.create', alias: 'director', node: { kind: 'director', name: '导演台' } },
        { type: 'edge.create', edge: { source: '$script', target: '$director', relation: 'flow' } },
      ],
    }, 'agent-a')
    const replay = await operations.execute('canvas-a', {
      operationId: 'create-script-graph', baseRevision: 0,
      operations: [{ type: 'node.create', node: { kind: 'text', name: '不应创建' } }],
    }, 'agent-a')

    expect(first.revision).toBe(1)
    expect(first.createdNodeIds).toHaveLength(2)
    expect(first.createdEdgeIds).toHaveLength(1)
    expect(replay.replayed).toBe(true)
    expect(replay.createdNodeIds).toEqual(first.createdNodeIds)
    const document = await documents.get('canvas-a')
    expect(document?.snapshot.nodes).toHaveLength(2)
    expect(document?.snapshot.edges[0]).toMatchObject({
      source: first.aliases.script,
      target: first.aliases.director,
      relation: 'flow',
    })
  })

  it('rejects stale revisions without partially applying any operation', async () => {
    const dataDir = await directory()
    const canvases = new CanvasPersistenceService({ dataDir })
    await canvases.saveCanvas(defaultInitialCanvas('canvas-a', 'project-a'))
    const documents = await CanvasDocumentService.open({ dataDir, canvases, collaboration: inactiveCollaboration() })
    const operations = await CanvasOperationService.open(dataDir, documents)
    await operations.execute('canvas-a', {
      operationId: 'first', operations: [{ type: 'node.create', node: { kind: 'text', name: '一' } }],
    }, 'agent-a')

    await expect(operations.execute('canvas-a', {
      operationId: 'stale', baseRevision: 0,
      operations: [{ type: 'node.create', node: { kind: 'text', name: '二' } }],
    }, 'agent-a')).rejects.toBeInstanceOf(CanvasRevisionConflictError)
    expect((await documents.get('canvas-a'))?.snapshot.nodes.map((node) => node.name)).toEqual(['一'])
  })

  it('stages only complete timed scripts for approval', async () => {
    const dataDir = await directory()
    const canvases = new CanvasPersistenceService({ dataDir })
    const snapshot = defaultInitialCanvas('canvas-a', 'project-a')
    snapshot.nodes.push({
      id: 'script-complete', type: 'text', name: '版本一', position: { x: 0, y: 0 }, size: { width: 440, height: 520 },
      data: { nodeKind: 'script', text: [
        '版本一｜测试', '简版导演手册', '人物与场景：玄关', '钩子过程（00:00.00—00:03.00）：递出商品',
        '转入口播：第三秒开始', '主体与收尾：展示商品', '场景动作与台词时间轴',
        '00:00.00–00:03.00', '场景与动作：递出商品', '<主播·画外音>：“测试台词。”',
      ].join('\n') },
    })
    snapshot.nodes.push({
      id: 'script-short', type: 'text', name: '只有方向', position: { x: 500, y: 0 }, size: { width: 440, height: 200 },
      data: { nodeKind: 'script', text: '做一个送礼方向。' },
    })
    await canvases.saveCanvas(snapshot)
    const documents = await CanvasDocumentService.open({ dataDir, canvases, collaboration: inactiveCollaboration() })
    const workflows = await WorkflowService.open({
      dataDir, documents,
      assets: {} as AssetStore,
      adapterFor: (() => { throw new Error('not used') }) as never,
    })

    await expect(workflows.create({
      canvasId: 'canvas-a', projectId: 'project-a', candidates: [{ nodeId: 'script-short', title: '短稿' }],
      settings: { preferenceMode: 'video' },
    })).rejects.toBeInstanceOf(WorkflowInputError)
    const workflow = await workflows.create({
      canvasId: 'canvas-a', projectId: 'project-a', candidates: [{ nodeId: 'script-complete', title: '完整稿' }],
      settings: { preferenceMode: 'video' },
    })
    expect(workflow.status).toBe('awaiting_approval')
    expect(workflow.candidates[0]?.nodeId).toBe('script-complete')
    workflows.close()
  })

  it('applies Agent operations to the active Yjs room and publishes an incremental update', async () => {
    const dataDir = await directory()
    const canvases = new CanvasPersistenceService({ dataDir })
    const snapshot = defaultInitialCanvas('canvas-live', 'project-live')
    await canvases.saveCanvas(snapshot)
    const collaboration = await CollaborationService.open({ dataDir })
    const enabled = await collaboration.enableRoom({
      canvasId: snapshot.canvasId, projectId: snapshot.projectId, snapshot,
      deviceId: 'device-owner', displayName: 'Owner',
    })
    const updates: Uint8Array[] = []
    collaboration.documentForRoom(enabled.room.roomId).on('update', (update: Uint8Array) => updates.push(update))
    const documents = await CanvasDocumentService.open({ dataDir, canvases, collaboration })
    const operations = await CanvasOperationService.open(dataDir, documents)

    const receipt = await operations.execute(snapshot.canvasId, {
      operationId: 'live-create', baseRevision: 0,
      operations: [{ type: 'node.create', node: { kind: 'text', name: '实时节点', text: '无需刷新' } }],
    }, 'agent-live')

    expect(receipt.revision).toBe(1)
    expect(updates.length).toBeGreaterThan(0)
    expect(collaboration.exportSnapshot(enabled.room.roomId).nodes[0]?.name).toBe('实时节点')
    await collaboration.close()
  })

  it('fans approved scripts out to isolated Director runs and delivers every returned artifact', async () => {
    const dataDir = await directory()
    const canvases = new CanvasPersistenceService({ dataDir })
    const snapshot = defaultInitialCanvas('canvas-director', 'project-director')
    const scriptText = [
      '版本｜完整稿', '简版导演手册', '人物与场景：门口', '钩子过程（00:00.00—00:03.00）：递出商品',
      '转入口播：第三秒转入', '主体与收尾：展示商品', '场景动作与台词时间轴',
      '00:00.00–00:03.00', '场景与动作：商品入画', '<主播·画外音>：“完整台词。”',
    ].join('\n')
    snapshot.nodes.push(
      { id: 'script-a', type: 'text', name: '稿件A', position: { x: 0, y: 0 }, size: { width: 440, height: 520 }, data: { text: scriptText, nodeKind: 'script' } },
      { id: 'script-b', type: 'text', name: '稿件B', position: { x: 0, y: 700 }, size: { width: 440, height: 520 }, data: { text: scriptText, nodeKind: 'script' } },
    )
    await canvases.saveCanvas(snapshot)
    const documents = await CanvasDocumentService.open({ dataDir, canvases, collaboration: inactiveCollaboration() })
    let imported = 0
    const assets = {
      importRemote: async () => ({ id: `00000000-0000-4000-8000-${String(++imported).padStart(12, '0')}` }),
    } as unknown as AssetStore
    const adapter = {
      uploadAsset: async () => 'uploaded',
      checkRunStatus: async () => ({ reply: '完成', threadId: 'thread', runId: 'run', pending: false }),
      chat: async (_message: string, threadId?: string) => ({
        reply: '三张图片已完成', threadId: threadId ?? randomId('thread'), runId: randomId('run'), pending: false,
        imageUrls: ['https://example.test/a.png', 'https://example.test/b.png', 'https://example.test/c.png'],
        thinking: '已完成构图与一致性检查', executionSteps: [{ id: 'done', title: '生成三张图片', status: 'completed' as const }],
      }),
    }
    const workflows = await WorkflowService.open({
      dataDir, documents, assets,
      adapterFor: (() => adapter) as never,
    })
    const staged = await workflows.create({
      canvasId: snapshot.canvasId, projectId: snapshot.projectId,
      candidates: [{ nodeId: 'script-a', title: 'A' }, { nodeId: 'script-b', title: 'B' }],
      settings: { providerId: 'xiaoyunque', preferenceMode: 'image', aspectRatio: '9:16' },
    })
    let current = await workflows.approve(staged.id, ['script-a', 'script-b'])
    for (let attempts = 0; attempts < 20 && current.status === 'running'; attempts += 1) {
      current = await workflows.wait(current.id, current.updatedAt, 500)
    }

    expect(current.status).toBe('complete')
    expect(current.directorRuns).toHaveLength(2)
    expect(current.directorRuns.every((run) => run.artifacts.length === 3)).toBe(true)
    const finalCanvas = (await documents.get(snapshot.canvasId))!.snapshot
    expect(finalCanvas.nodes.filter((node) => node.type === 'group' && node.data.nodeKind === 'director')).toHaveLength(2)
    expect(finalCanvas.nodes.filter((node) => node.type === 'image')).toHaveLength(6)
    expect(finalCanvas.edges.filter((edge) => edge.relation === 'flow')).toHaveLength(8)
    workflows.close()
  })

  it('deduplicates a Director artifact when only its signed query parameters rotate', async () => {
    const dataDir = await directory()
    const canvases = new CanvasPersistenceService({ dataDir })
    const snapshot = defaultInitialCanvas('canvas-signed-artifact', 'project-signed-artifact')
    const scriptText = [
      '版本｜完整稿', '简版导演手册', '人物与场景：门口', '钩子过程（00:00.00—00:03.00）：递出商品',
      '转入口播：第三秒转入', '主体与收尾：展示商品', '场景动作与台词时间轴',
      '00:00.00–00:03.00', '场景与动作：商品入画', '<主播·画外音>：“完整台词。”',
    ].join('\n')
    snapshot.nodes.push({ id: 'script-a', type: 'text', name: '稿件A', position: { x: 0, y: 0 }, size: { width: 440, height: 520 }, data: { text: scriptText, nodeKind: 'script' } })
    await canvases.saveCanvas(snapshot)
    const documents = await CanvasDocumentService.open({ dataDir, canvases, collaboration: inactiveCollaboration() })
    let imported = 0
    const assets = {
      importRemote: async () => ({ id: `00000000-0000-4000-8000-${String(++imported).padStart(12, '0')}` }),
    } as unknown as AssetStore
    let checks = 0
    const artifactPath = 'https://cdn.example.test/generated/final.mp4'
    const adapter = {
      uploadAsset: async () => 'uploaded',
      chat: async () => ({ reply: '生成中', threadId: 'thread', runId: 'run', pending: true, videoUrls: [`${artifactPath}?token=one`] }),
      checkRunStatus: async () => ({
        reply: '成片已完成', threadId: 'thread', runId: 'run', pending: checks++ < 1,
        videoUrls: [`${artifactPath}?token=${checks + 1}`],
      }),
    }
    const workflows = await WorkflowService.open({ dataDir, documents, assets, adapterFor: (() => adapter) as never })
    const staged = await workflows.create({
      canvasId: snapshot.canvasId, projectId: snapshot.projectId,
      candidates: [{ nodeId: 'script-a', title: 'A' }],
      settings: { providerId: 'xiaoyunque', preferenceMode: 'video', aspectRatio: '9:16' },
    })
    let current = await workflows.approve(staged.id, ['script-a'])
    for (let attempts = 0; attempts < 20 && current.status === 'running'; attempts += 1) {
      current = await workflows.wait(current.id, current.updatedAt, 500)
    }

    expect(current.status).toBe('complete')
    expect(current.directorRuns[0]?.artifacts).toHaveLength(1)
    expect(current.directorRuns[0]?.artifacts[0]?.sourceKey).toBe(artifactPath)
    expect(imported).toBe(1)
    const finalCanvas = (await documents.get(snapshot.canvasId))!.snapshot
    expect(finalCanvas.nodes.filter((node) => node.type === 'video')).toHaveLength(1)
    workflows.close()
  }, 10_000)
})

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`
}
