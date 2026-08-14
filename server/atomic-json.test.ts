import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { atomicWriteJson, replaceFileWithRetry } from './atomic-json.ts'
import { GenerationJobStore } from './jobs.ts'
import type { GenerationRequest } from '../src/contracts/generation.ts'

describe('atomicWriteJson', () => {
  it('retries bounded transient Windows replacement failures', async () => {
    const transient = Object.assign(new Error('temporarily locked'), { code: 'EPERM' })
    const renameFile = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(undefined)
    const wait = vi.fn().mockResolvedValue(undefined)

    await replaceFileWithRetry('pending.tmp', 'state.json', { renameFile, wait })

    expect(renameFile).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it('does not retry permanent replacement failures', async () => {
    const permanent = Object.assign(new Error('invalid path'), { code: 'EINVAL' })
    const renameFile = vi.fn().mockRejectedValue(permanent)
    const wait = vi.fn().mockResolvedValue(undefined)

    await expect(
      replaceFileWithRetry('pending.tmp', 'state.json', { renameFile, wait }),
    ).rejects.toBe(permanent)
    expect(renameFile).toHaveBeenCalledOnce()
    expect(wait).not.toHaveBeenCalled()
  })

  it('serializes concurrent writes in call order using collision-free temporary names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'libtv-atomic-'))
    const file = join(directory, 'state.json')

    await Promise.all(Array.from({ length: 40 }, (_, value) => atomicWriteJson(file, { value })))

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ value: 39 })
    expect((await readdir(directory)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('keeps concurrent job updates as valid JSON without temp-name collisions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'libtv-job-atomic-'))
    const request: GenerationRequest = {
      clientRequestId: 'client-1', projectId: 'project-alpha', providerId: 'aistartlab', catalogVersion: 'v1',
      mediaType: 'image', channel: 46, model: 'gpt-image-2', prompt: 'test', quality: '1K',
      aspectRatio: '1:1', n: 1, references: [],
    }
    const store = await GenerationJobStore.open({ dataDir, id: () => 'job-1' })
    await store.create(request)

    await Promise.all(Array.from({ length: 20 }, (_, progress) => store.update('job-1', { progress })))

    const persisted = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8'))
    expect(persisted[0].progress).toBe(19)
  })
})
