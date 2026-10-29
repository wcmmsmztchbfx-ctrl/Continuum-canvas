import { describe, expect, it } from 'vitest'
import { createCanvasSaveSession } from './canvasSaveSession'
import type { CanvasSnapshotV2, ProjectSnapshotV1 } from '../model/project'

const document = (): CanvasSnapshotV2 => ({
  version: 3, canvasId: 'canvas', projectId: 'project', name: '原稿',
  viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
})
const project = (name = '已修改'): ProjectSnapshotV1 => ({ ...document(), version: 1, name })
const createSession = (owner = {}) => createCanvasSaveSession({ canvasId: 'canvas', projectId: 'project', owner })

describe('canvas save session', () => {
  it('only accepts the requested canvas and project before allowing capture', () => {
    const session = createSession()
    expect(session.capture(project())).toBeUndefined()
    expect(() => session.acceptLoaded({ ...document(), canvasId: 'other' })).toThrow()
    expect(() => session.acceptLoaded({ ...document(), projectId: 'other' })).toThrow()
    expect(session.close()).toBeUndefined()
  })

  it('does not save an unchanged loaded document on close', () => {
    const session = createSession()
    session.acceptLoaded(document())
    expect(session.close()).toBeUndefined()
    expect(session.capture(project())).toBeUndefined()
  })

  it('captures owned contents for close instead of reading a later global store', () => {
    const session = createSession()
    session.acceptLoaded(document())
    const source = project()
    const pending = session.capture(source)!
    source.name = '另一个画布'
    source.viewport.x = 100
    expect(session.capture({ ...project(), projectId: 'other' })).toBeUndefined()
    expect(session.close()).toEqual(pending)
    expect(pending.document).toMatchObject({ canvasId: 'canvas', projectId: 'project', name: '已修改', viewport: { x: 0 } })
  })

  it('an earlier completion cannot acknowledge a later unsaved edit', () => {
    const session = createSession()
    session.acceptLoaded(document())
    const first = session.capture(project('第一版'))!
    session.markQueued(first)
    const last = session.capture(project('第二版'))!
    expect(session.succeed(first)).toBe(true)
    expect(session.close()).toEqual(last)
  })

  it('keeps in-flight saves alive on close without submitting them twice', () => {
    const session = createSession()
    session.acceptLoaded(document())
    const pending = session.capture(project())!
    session.markQueued(pending)
    expect(session.close()).toBeUndefined()
    expect(session.succeed(pending)).toBe(true)
  })

  it('retries the latest failed contents on close', () => {
    const session = createSession()
    session.acceptLoaded(document())
    const pending = session.capture(project())!
    session.markQueued(pending)
    expect(session.fail(pending)).toBe(true)
    expect(session.close()).toEqual(pending)
  })

  it('a newer confirmed save prevents older completion side effects across sessions', () => {
    const owner = {}
    const old = createSession(owner)
    old.acceptLoaded(document())
    const pending = old.capture(project())!
    old.markQueued(pending)
    old.close()
    const current = createSession(owner)
    current.acceptLoaded(document())
    const latest = current.capture(project('最新版本'))!
    current.markQueued(latest)
    expect(current.succeed(latest)).toBe(true)
    expect(old.succeed(pending)).toBe(false)
    expect(current.close()).toBeUndefined()
  })

  it('keeps the latest queued publication valid after closing behind an earlier request', async () => {
    const session = createSession()
    session.acceptLoaded(document())
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const firstStarted = new Promise<void>((resolve) => { started = resolve })
    const published: string[] = []
    const first = session.capture(project('第一版'))!
    session.markQueued(first)
    session.succeed(first)
    const firstPublication = session.publish(first, async () => {
      started()
      await gate
      published.push(first.document.name)
    })
    await firstStarted
    const last = session.capture(project('第二版'))!
    session.markQueued(last)
    session.succeed(last)
    const lastPublication = session.publish(last, async () => { published.push(last.document.name) })
    expect(session.close()).toBeUndefined()
    release()
    await Promise.all([firstPublication, lastPublication])
    expect(published).toEqual(['第一版', '第二版'])
  })

  it('reopening without editing does not drop the latest persisted publication', async () => {
    const owner = {}
    const session = createSession(owner)
    session.acceptLoaded(document())
    const pending = session.capture(project())!
    session.markQueued(pending)
    session.close()
    const reopened = createSession(owner)
    reopened.acceptLoaded(pending.document)
    expect(session.succeed(pending)).toBe(true)
    const published: string[] = []
    await session.publish(pending, async () => { published.push(pending.document.name) })
    expect(published).toEqual(['已修改'])
    reopened.close()
  })
})
