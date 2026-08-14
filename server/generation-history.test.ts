import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenerationHistoryEntry, GenerationJob } from '../src/contracts/generation.ts'
import type { AssetRecord } from './asset-store.ts'
import { atomicWriteJson } from './atomic-json.ts'
import { GenerationHistoryStore } from './generation-history.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'libtv-history-'))
}

function asset(id: string, contentType = 'image/png'): AssetRecord {
  return {
    id,
    filename: `${id}.${contentType === 'video/mp4' ? 'mp4' : 'png'}`,
    contentType,
    size: 12,
    url: `/api/assets/${id}`,
    createdAt: '2026-07-17T00:00:00.000Z',
  }
}

function historyShardPath(dataDir: string, projectId: string): string {
  const hash = createHash('sha256').update(projectId).digest('hex')
  return join(dataDir, 'generation-history', `${hash}.json`)
}

function job(options: {
  id: string
  asset: AssetRecord
  projectId?: string
  canvasId?: string
  mediaType?: 'image' | 'video'
  completedAt?: string
}): GenerationJob {
  return {
    id: options.id,
    clientRequestId: `client-${options.id}`,
    requestDigest: 'a'.repeat(64),
    request: {
      clientRequestId: `client-${options.id}`,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.canvasId ? { canvasId: options.canvasId } : {}),
      providerId: 'aistartlab',
      catalogVersion: 'catalog-v1',
      mediaType: options.mediaType ?? 'image',
      channel: 46,
      model: 'gpt-image-2',
      prompt: 'portrait with reference',
      quality: '2K',
      aspectRatio: '9:16',
      n: 2,
      duration: options.mediaType === 'video' ? 6 : undefined,
      mode: options.mediaType === 'video' ? 'image2video' : undefined,
      references: [{
        alias: 1,
        assetId: '99999999-9999-4999-8999-999999999999',
        mediaType: 'image',
      }],
    },
    status: 'complete',
    progress: 100,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: options.completedAt ?? '2026-07-17T01:00:00.000Z',
    upstreamTaskId: 'upstream-secret-task',
    outputs: [{
      assetId: options.asset.id,
      url: options.asset.url,
      contentType: options.asset.contentType,
      size: options.asset.size,
    }],
  }
}

function historyEntry(options: {
  id: string
  asset: AssetRecord
  projectId: string
  canvasId?: string
  mediaType?: 'image' | 'video'
  completedAt?: string
}): GenerationHistoryEntry {
  const completed = job(options)
  return {
    id: createHash('sha256').update(`${completed.id}\0${0}`).digest('hex'),
    projectId: options.projectId,
    ...(options.canvasId ? { canvasId: options.canvasId } : {}),
    jobId: completed.id,
    outputIndex: 0,
    mediaType: options.mediaType ?? 'image',
    asset: options.asset,
    prompt: completed.request.prompt,
    providerId: completed.request.providerId,
    channel: completed.request.channel,
    model: completed.request.model,
    settings: {
      quality: completed.request.quality,
      aspectRatio: completed.request.aspectRatio,
      count: completed.request.n,
      ...(completed.request.duration ? { duration: completed.request.duration } : {}),
      ...(completed.request.mode ? { mode: completed.request.mode } : {}),
    },
    references: completed.request.references.map(({ alias, assetId, mediaType }) => ({
      alias, ...(assetId ? { assetId } : {}), mediaType,
    })),
    completedAt: options.completedAt ?? completed.updatedAt,
  }
}

describe('generation history store', () => {
  it('records canvas ownership for new jobs while accepting legacy entries without it', async () => {
    const dataDir = await tempDirectory()
    const store = await GenerationHistoryStore.open({ dataDir })
    const localAsset = asset('10111111-1111-4111-8111-111111111111')

    const recorded = await store.recordOutput({
      job: job({
        id: 'job-canvas-owned',
        asset: localAsset,
        projectId: 'project-alpha',
        canvasId: 'canvas-alpha',
      }),
      outputIndex: 0,
      asset: localAsset,
    })

    expect(recorded).toEqual(expect.objectContaining({
      projectId: 'project-alpha',
      canvasId: 'canvas-alpha',
    }))
    const reopened = await GenerationHistoryStore.open({ dataDir })
    expect(reopened.list({ projectId: 'project-alpha', limit: 20 }).entries[0]?.canvasId)
      .toBe('canvas-alpha')
  })

  it('reassigns only one canvas history and persists an idempotent operation across restarts', async () => {
    const dataDir = await tempDirectory()
    const store = await GenerationHistoryStore.open({ dataDir })
    for (const [id, canvasId, assetId] of [
      ['job-canvas-a', 'canvas-a', '20111111-1111-4111-8111-111111111111'],
      ['job-canvas-b', 'canvas-b', '30111111-1111-4111-8111-111111111111'],
    ] as const) {
      const localAsset = asset(assetId)
      await store.recordOutput({
        job: job({ id, asset: localAsset, projectId: 'project-source', canvasId }),
        outputIndex: 0,
        asset: localAsset,
      })
    }

    const input = {
      operationId: 'move-canvas-a-to-target',
      canvasId: 'canvas-a',
      fromProjectId: 'project-source',
      toProjectId: 'project-target',
    }
    await expect(store.reassignCanvas(input)).resolves.toEqual({ moved: 1, bound: 0 })
    const reopened = await GenerationHistoryStore.open({ dataDir })
    await expect(reopened.reassignCanvas(input)).resolves.toEqual({ moved: 1, bound: 0 })
    expect(reopened.list({ projectId: 'project-source', limit: 20 }).entries.map((entry) => entry.canvasId))
      .toEqual(['canvas-b'])
    expect(reopened.list({ projectId: 'project-target', limit: 20 }).entries.map((entry) => entry.canvasId))
      .toEqual(['canvas-a'])
  })

  it('binds legacy project history only when it can belong to one canvas safely', async () => {
    const dataDir = await tempDirectory()
    const legacyAsset = asset('40111111-1111-4111-8111-111111111111')
    await writeFile(join(dataDir, 'generation-history.json'), JSON.stringify([
      historyEntry({ id: 'job-legacy-bind', asset: legacyAsset, projectId: 'project-legacy' }),
    ]))
    const store = await GenerationHistoryStore.open({ dataDir })

    await expect(store.reassignCanvas({
      operationId: 'bind-project-legacy',
      canvasId: 'canvas-only',
      fromProjectId: 'project-legacy',
      toProjectId: 'project-legacy',
    })).resolves.toEqual({ moved: 0, bound: 1 })
    expect(store.list({ projectId: 'project-legacy', limit: 20 }).entries[0]?.canvasId)
      .toBe('canvas-only')

    await expect(store.reassignCanvas({
      operationId: 'bind-project-legacy-to-other',
      canvasId: 'canvas-other',
      fromProjectId: 'project-legacy',
      toProjectId: 'project-legacy',
    })).rejects.toMatchObject({ code: 'history_conflict' })
  })
  it('atomically persists one idempotent entry per job output without upstream data', async () => {
    const dataDir = await tempDirectory()
    const store = await GenerationHistoryStore.open({ dataDir })
    const localAsset = asset('11111111-1111-4111-8111-111111111111')
    const completed = job({ id: 'job-1', asset: localAsset, projectId: 'project-alpha' })

    const first = await store.recordOutput({ job: completed, outputIndex: 0, asset: localAsset })
    const second = await store.recordOutput({ job: completed, outputIndex: 0, asset: localAsset })

    expect(second).toEqual(first)
    expect(store.list({ projectId: 'project-alpha', limit: 20 }).entries).toEqual([expect.objectContaining({
      id: first?.id,
      jobId: 'job-1',
      outputIndex: 0,
      mediaType: 'image',
      asset: localAsset,
      settings: {
        quality: '2K', aspectRatio: '9:16', count: 2,
      },
      references: [{
        alias: 1, assetId: '99999999-9999-4999-8999-999999999999', mediaType: 'image',
      }],
    })])
    const persisted = await readFile(historyShardPath(dataDir, 'project-alpha'), 'utf8')
    expect(persisted).not.toContain('temporary.example')
    expect(persisted).not.toContain('secret')
    expect((await GenerationHistoryStore.open({ dataDir })).list({
      projectId: 'project-alpha', limit: 20,
    }).entries).toHaveLength(1)
  })

  it('migrates the legacy monolithic file into project shards exactly once without data loss', async () => {
    const dataDir = await tempDirectory()
    const alphaAsset = asset('12121212-1212-4212-8212-121212121212')
    const betaAsset = asset('13131313-1313-4313-8313-131313131313', 'video/mp4')
    await writeFile(join(dataDir, 'generation-history.json'), JSON.stringify([
      historyEntry({ id: 'job-alpha-legacy', asset: alphaAsset, projectId: 'project-alpha' }),
      historyEntry({
        id: 'job-beta-legacy', asset: betaAsset, projectId: 'project-beta', mediaType: 'video',
      }),
    ]))

    const migrated = await GenerationHistoryStore.open({ dataDir })

    expect(migrated.list({ projectId: 'project-alpha', limit: 20 }).entries.map((entry) => entry.jobId))
      .toEqual(['job-alpha-legacy'])
    expect(migrated.list({ projectId: 'project-beta', limit: 20 }).entries.map((entry) => entry.jobId))
      .toEqual(['job-beta-legacy'])
    expect(JSON.parse(await readFile(historyShardPath(dataDir, 'project-alpha'), 'utf8')).projectId)
      .toBe('project-alpha')
    expect(JSON.parse(await readFile(historyShardPath(dataDir, 'project-beta'), 'utf8')).projectId)
      .toBe('project-beta')
    expect((await readdir(dataDir)).filter((name) => name.startsWith('generation-history.json.migrated.')))
      .toHaveLength(1)

    const writes = vi.fn(atomicWriteJson)
    const reopened = await GenerationHistoryStore.open({ dataDir, writeHistory: writes })
    expect(reopened.list({ projectId: 'project-alpha', limit: 20 }).entries).toHaveLength(1)
    expect(writes).not.toHaveBeenCalled()
  })

  it('does not mutate memory when an atomic history write fails', async () => {
    const dataDir = await tempDirectory()
    const writeHistory = vi.fn(async (filePath: string, value: unknown) => {
      if (writeHistory.mock.calls.length === 1) throw new Error('injected history write failure')
      await atomicWriteJson(filePath, value)
    })
    const store = await GenerationHistoryStore.open({ dataDir, writeHistory })
    const localAsset = asset('22222222-2222-4222-8222-222222222222')
    const completed = job({ id: 'job-2', asset: localAsset, projectId: 'project-alpha' })

    await expect(store.recordOutput({ job: completed, outputIndex: 0, asset: localAsset }))
      .rejects.toThrow('injected history write failure')
    expect(store.list({ projectId: 'project-alpha', limit: 20 }).entries).toEqual([])

    await store.recordOutput({ job: completed, outputIndex: 0, asset: localAsset })
    expect(store.list({ projectId: 'project-alpha', limit: 20 }).entries).toHaveLength(1)
  })

  it('provides stable newest-first project and media pagination', async () => {
    const dataDir = await tempDirectory()
    const store = await GenerationHistoryStore.open({ dataDir })
    const records = [
      { id: 'job-a', projectId: 'project-alpha', mediaType: 'image' as const, completedAt: '2026-07-17T03:00:00.000Z' },
      { id: 'job-b', projectId: 'project-alpha', mediaType: 'video' as const, completedAt: '2026-07-17T02:00:00.000Z' },
      { id: 'job-c', projectId: 'project-alpha', mediaType: 'image' as const, completedAt: '2026-07-17T01:00:00.000Z' },
      { id: 'job-d', projectId: 'project-beta', mediaType: 'image' as const, completedAt: '2026-07-17T04:00:00.000Z' },
    ]
    for (const [index, record] of records.entries()) {
      const localAsset = asset(
        `${index + 3}3333333-3333-4333-8333-333333333333`,
        record.mediaType === 'video' ? 'video/mp4' : 'image/png',
      )
      await store.recordOutput({
        job: job({ ...record, asset: localAsset }), outputIndex: 0, asset: localAsset,
      })
    }

    const first = store.list({ projectId: 'project-alpha', limit: 1 })
    expect(first.entries.map((entry) => entry.jobId)).toEqual(['job-a'])
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = store.list({ projectId: 'project-alpha', limit: 1, cursor: first.nextCursor })
    expect(second.entries.map((entry) => entry.jobId)).toEqual(['job-b'])
    expect(store.list({
      projectId: 'project-alpha', mediaType: 'image', limit: 20,
    }).entries.map((entry) => entry.jobId)).toEqual(['job-a', 'job-c'])
    expect(store.list({ projectId: 'project-beta', limit: 20 }).entries.map((entry) => entry.jobId))
      .toEqual(['job-d'])
  })

  it('normalizes timestamps to UTC and sorts equivalent offsets by epoch', async () => {
    const dataDir = await tempDirectory()
    const store = await GenerationHistoryStore.open({ dataDir })
    const earlierAsset = asset('14141414-1414-4414-8414-141414141414')
    const laterAsset = asset('15151515-1515-4515-8515-151515151515')
    await store.recordOutput({
      job: job({
        id: 'job-offset-earlier', asset: earlierAsset, projectId: 'project-alpha',
        completedAt: '2026-07-17T02:00:00+02:00',
      }),
      outputIndex: 0,
      asset: earlierAsset,
      completedAt: '2026-07-17T02:00:00+02:00',
    })
    await store.recordOutput({
      job: job({
        id: 'job-utc-later', asset: laterAsset, projectId: 'project-alpha',
        completedAt: '2026-07-17T00:30:00Z',
      }),
      outputIndex: 0,
      asset: laterAsset,
      completedAt: '2026-07-17T00:30:00Z',
    })

    const entries = store.list({ projectId: 'project-alpha', limit: 20 }).entries
    expect(entries.map((entry) => entry.jobId)).toEqual(['job-utc-later', 'job-offset-earlier'])
    expect(entries.map((entry) => entry.completedAt)).toEqual([
      '2026-07-17T00:30:00.000Z', '2026-07-17T00:00:00.000Z',
    ])
  })

  it('excludes legacy jobs without projectId from automatic history', async () => {
    const dataDir = await tempDirectory()
    const store = await GenerationHistoryStore.open({ dataDir })
    const localAsset = asset('77777777-7777-4777-8777-777777777777')

    const entry = await store.recordOutput({
      job: job({ id: 'job-legacy', asset: localAsset }), outputIndex: 0, asset: localAsset,
    })

    expect(entry).toBeUndefined()
    expect(store.list({ projectId: 'project-alpha', limit: 20 }).entries).toEqual([])
  })

  it('validates a backfill batch before one atomic write', async () => {
    const dataDir = await tempDirectory()
    const writeHistory = vi.fn(atomicWriteJson)
    const store = await GenerationHistoryStore.open({ dataDir, writeHistory })
    const firstAsset = asset('88888888-8888-4888-8888-888888888888')
    const secondAsset = asset('99999999-9999-4999-8999-999999999999')
    const firstJob = job({ id: 'job-batch-1', asset: firstAsset, projectId: 'project-alpha' })
    const secondJob = job({ id: 'job-batch-2', asset: secondAsset, projectId: 'project-alpha' })

    await expect(store.recordOutputs([
      { job: firstJob, outputIndex: 0, asset: firstAsset },
      { job: secondJob, outputIndex: 1, asset: secondAsset },
    ])).rejects.toThrow('History asset does not match')
    expect(writeHistory).not.toHaveBeenCalled()
    expect(store.list({ projectId: 'project-alpha', limit: 20 }).entries).toEqual([])

    await store.recordOutputs([
      { job: firstJob, outputIndex: 0, asset: firstAsset },
      { job: secondJob, outputIndex: 0, asset: secondAsset },
    ])
    expect(writeHistory).toHaveBeenCalledTimes(1)
    expect(store.list({ projectId: 'project-alpha', limit: 20 }).entries).toHaveLength(2)
  })

  it('rewrites only the affected project shard as history grows', async () => {
    const dataDir = await tempDirectory()
    const writeHistory = vi.fn(atomicWriteJson)
    const store = await GenerationHistoryStore.open({ dataDir, writeHistory })
    const betaAsset = asset('16161616-1616-4616-8616-161616161616')
    const alphaFirst = asset('17171717-1717-4717-8717-171717171717')
    const alphaSecond = asset('18181818-1818-4818-8818-181818181818')
    await store.recordOutput({
      job: job({ id: 'job-beta', asset: betaAsset, projectId: 'project-beta' }),
      outputIndex: 0, asset: betaAsset,
    })
    await store.recordOutput({
      job: job({ id: 'job-alpha-first', asset: alphaFirst, projectId: 'project-alpha' }),
      outputIndex: 0, asset: alphaFirst,
    })
    const betaBefore = await readFile(historyShardPath(dataDir, 'project-beta'), 'utf8')
    writeHistory.mockClear()

    await store.recordOutput({
      job: job({ id: 'job-alpha-second', asset: alphaSecond, projectId: 'project-alpha' }),
      outputIndex: 0, asset: alphaSecond,
    })

    expect(writeHistory).toHaveBeenCalledTimes(1)
    expect(writeHistory.mock.calls[0][0]).toBe(historyShardPath(dataDir, 'project-alpha'))
    expect(await readFile(historyShardPath(dataDir, 'project-beta'), 'utf8')).toBe(betaBefore)
  })

  it('quarantines corrupt or internally inconsistent history and starts empty', async () => {
    const dataDir = await tempDirectory()
    const localAsset = asset('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    const completed = job({ id: 'job-corrupt', asset: localAsset, projectId: 'project-alpha' })
    const store = await GenerationHistoryStore.open({ dataDir })
    const entry = await store.recordOutput({ job: completed, outputIndex: 0, asset: localAsset })
    const shardPath = historyShardPath(dataDir, 'project-alpha')
    const persisted = JSON.parse(await readFile(shardPath, 'utf8'))
    persisted.entries[0].id = createHash('sha256').update('wrong').digest('hex')
    await writeFile(shardPath, JSON.stringify(persisted))

    const recovered = await GenerationHistoryStore.open({ dataDir })

    expect(entry).toBeDefined()
    expect(recovered.list({ projectId: 'project-alpha', limit: 20 }).entries).toEqual([])
    expect((await readdir(join(dataDir, 'generation-history')))
      .filter((name) => name.includes('.json.corrupt.')))
      .toHaveLength(1)
  })

  it('rejects duplicate deterministic entry IDs and output keys on load', async () => {
    const dataDir = await tempDirectory()
    const localAsset = asset('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    const completed = job({ id: 'job-duplicate', asset: localAsset, projectId: 'project-alpha' })
    const store = await GenerationHistoryStore.open({ dataDir })
    await store.recordOutput({ job: completed, outputIndex: 0, asset: localAsset })
    const shardPath = historyShardPath(dataDir, 'project-alpha')
    const persisted = JSON.parse(await readFile(shardPath, 'utf8'))
    persisted.entries.push(structuredClone(persisted.entries[0]))
    await writeFile(shardPath, JSON.stringify(persisted))

    const recovered = await GenerationHistoryStore.open({ dataDir })

    expect(recovered.list({ projectId: 'project-alpha', limit: 20 }).entries).toEqual([])
    expect((await readdir(join(dataDir, 'generation-history')))
      .some((name) => name.includes('.json.corrupt.'))).toBe(true)
  })
})
