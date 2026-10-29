import { describe, expect, it } from 'vitest'

import { WorkspaceMutationQueue } from './workspaceMutationQueue'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}

describe('WorkspaceMutationQueue', () => {
  it('serializes the entire operation and returns each result', async () => {
    const queue = new WorkspaceMutationQueue()
    const paused = deferred()
    const started = deferred()
    const events: string[] = []
    const first = queue.run(async () => {
      events.push('first read')
      started.resolve()
      await paused.promise
      events.push('first commit')
      return 1
    })
    await started.promise
    const second = queue.run(async () => {
      events.push('second read')
      events.push('second commit')
      return 2
    })
    await Promise.resolve()
    expect(events).toEqual(['first read'])
    paused.resolve()

    expect(await Promise.all([first, second])).toEqual([1, 2])
    expect(events).toEqual(['first read', 'first commit', 'second read', 'second commit'])
  })

  it('keeps a rejection with its caller while allowing later work to finish', async () => {
    const queue = new WorkspaceMutationQueue()
    const error = new Error('commit failed')
    const failed = queue.run(async () => { throw error })
    const failure = expect(failed).rejects.toBe(error)
    const succeeded = queue.run(async () => 'saved')

    await failure
    await expect(succeeded).resolves.toBe('saved')
    await expect(queue.flush()).resolves.toBeUndefined()
  })

  it('flushes all work queued before the call', async () => {
    const queue = new WorkspaceMutationQueue()
    const paused = deferred()
    const started = deferred()
    let committed = false
    let flushed = false
    const mutation = queue.run(async () => {
      started.resolve()
      await paused.promise
      committed = true
    })
    await started.promise
    const flush = queue.flush().then(() => { flushed = true })
    await Promise.resolve()
    expect(flushed).toBe(false)
    paused.resolve()
    await Promise.all([mutation, flush])

    expect(committed).toBe(true)
    expect(flushed).toBe(true)
  })
})
