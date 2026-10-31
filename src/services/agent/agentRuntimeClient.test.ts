import { describe, expect, it, vi } from 'vitest'
import { AgentRuntimeClient, mergeAgentRuns, prepareAgentAttachment } from './agentRuntimeClient'
import type { AgentRun } from '../../contracts/agent'

const run = (sequence: number, title = '创建图片'): AgentRun => ({ id: 'r1', requestId: 'req1', canvasId: 'c1', projectId: 'p1', prompt: '苹果', attachments: [], status: 'running', createdAt: '2026-10-31', updatedAt: '2026-10-31', sequence, events: [{ id: 'e1', sequence: 1, type: 'tool', status: 'complete', title, createdAt: '2026-10-31' }], plan: [], outputs: [], canUndo: false })

describe('AgentRuntimeClient', () => {
  it('sends explicit references and stable identity with collaboration credentials', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ run: run(1) }))
    const client = new AgentRuntimeClient({ fetchImpl, getRoomId: () => 'room-1' })
    const input = { requestId: 'stable-1', canvasId: 'c1', expectedRevision: 5, prompt: '苹果', attachments: [] }
    await client.createRun(input)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/agent/runs')
    expect(JSON.parse(init.body as string)).toEqual(input)
    expect(new Headers(init.headers).get('x-collaboration-room')).toBe('room-1')
    expect(init.credentials).toBe('same-origin')
  })
  it('rejects absent canvas scope before a request', async () => {
    const fetchImpl = vi.fn()
    await expect(new AgentRuntimeClient({ fetchImpl }).listRuns('')).rejects.toThrow('请先打开画布')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('preserves backend errors and does not retry mutation requests', async () => {
    const fetchImpl = vi.fn(async (url: string) => url === '/api/local-admin/session' ? Response.json({ ok: true, created: false }) : Response.json({ error: { code: 'revision_conflict', message: '画布尚未同步' } }, { status: 409 }))
    await expect(new AgentRuntimeClient({ fetchImpl }).controlRun('r1', { action: 'stop', requestId: 'stop-1' })).rejects.toMatchObject({ status: 409, code: 'revision_conflict', message: '画布尚未同步' })
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith('/control'))).toHaveLength(1)
  })
  it('rejects stale snapshots, other canvases and duplicate event sequences', () => {
    const latest = run(4)
    expect(mergeAgentRuns([latest], [run(2, '旧事件')], 'c1')[0]).toBe(latest)
    const next = run(5); next.events.push({ ...next.events[0], id: 'duplicate' })
    const merged = mergeAgentRuns([latest], [next, { ...run(9), id: 'other', canvasId: 'c2' }], 'c1')
    expect(merged).toHaveLength(1)
    expect(merged[0].sequence).toBe(5)
    expect(merged[0].events).toHaveLength(1)
  })
  it('keeps stable local assets and imports remote image bytes', async () => {
    const assetId = '11111111-1111-4111-8111-111111111111'
    const gateway = { importAsset: vi.fn(async () => ({ id: assetId, url: `/api/assets/${assetId}` })), uploadAsset: vi.fn() }
    const remote = await prepareAgentAttachment({ nodeId: 'n1', name: '产品', url: 'https://example.test/a.png' }, gateway)
    expect(remote).toMatchObject({ nodeId: 'n1', assetId, mediaType: 'image', url: `/api/assets/${assetId}` })
    expect(gateway.importAsset).toHaveBeenCalledWith('https://example.test/a.png', '产品', expect.anything())
    await prepareAgentAttachment({ nodeId: 'n2', name: '已上传', url: `/api/assets/${assetId}`, assetId }, gateway)
    expect(gateway.importAsset).toHaveBeenCalledTimes(1)
  })
  it('uploads temporary blobs and rejects unsupported source schemes', async () => {
    const assetId = '11111111-1111-4111-8111-111111111111'
    const gateway = { importAsset: vi.fn(), uploadAsset: vi.fn(async () => ({ id: assetId, url: `/api/assets/${assetId}` })) }
    const bytes = new Blob(['pixels'], { type: 'image/png' })
    const fetchImpl = vi.fn(async () => new Response(bytes))
    const result = await prepareAgentAttachment({ nodeId: 'n1', name: '本地图片', url: 'blob:http://localhost/abc' }, gateway, undefined, fetchImpl)
    expect(result.assetId).toBe(assetId)
    expect(gateway.uploadAsset.mock.calls[0][0]).toBeInstanceOf(Blob)
    await expect(prepareAgentAttachment({ nodeId: 'n2', name: '错误', url: 'file:///x' }, gateway)).rejects.toThrow('图片来源')
  })
})

describe('AgentRuntimeClient local identity lifecycle', () => {
  it('establishes one cold local session before concurrent protected requests', async () => {
    let authorized = false
    const requests: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      requests.push(url)
      if (url === '/api/local-admin/session') { authorized = true; return Response.json({ ok: true, created: true }) }
      if (!authorized) return Response.json({ error: { code: 'local_admin_unauthorized', message: 'Denied' } }, { status: 403 })
      return Response.json({ runs: [] })
    })
    const first = new AgentRuntimeClient({ fetchImpl }), second = new AgentRuntimeClient({ fetchImpl })
    await Promise.all([first.listRuns('c1'), second.listRuns('c2')])
    expect(requests[0]).toBe('/api/local-admin/session')
    expect(requests.filter(url => url === '/api/local-admin/session')).toHaveLength(1)
    expect(requests).toHaveLength(3)
  })
  it('recovers a stale session once and replays the identical mutation with its request id', async () => {
    let bootstraps = 0
    let creates = 0
    const bodies: string[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/local-admin/session') { bootstraps++; return Response.json({ ok: true, created: bootstraps > 1 }) }
      bodies.push(String(init?.body)); creates++
      return creates === 1 ? Response.json({ error: { code: 'local_admin_unauthorized', message: 'Expired session' } }, { status: 403 }) : Response.json({ run: run(1) })
    })
    await new AgentRuntimeClient({ fetchImpl }).createRun({ requestId: 'stable', canvasId: 'c1', expectedRevision: 1, prompt: '苹果', attachments: [] })
    expect(bootstraps).toBe(2)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
  })
  it('does not rotate identity again for a delayed 403 from before a successful recovery', async () => {
    let bootstraps = 0, requests = 0
    let rejectSecond!: (response: Response) => void
    const denied = () => Response.json({ error: { code: 'local_admin_unauthorized', message: 'Expired' } }, { status: 403 })
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === '/api/local-admin/session') { bootstraps++; return Response.json({ ok: true, created: true }) }
      requests++
      if (requests === 1) return denied()
      if (requests === 2) return new Promise<Response>(resolve => { rejectSecond = resolve })
      return Response.json({ runs: [] })
    })
    const client = new AgentRuntimeClient({ fetchImpl })
    const first = client.listRuns('c1'), second = client.listRuns('c2')
    await first
    rejectSecond(denied())
    await second
    expect(bootstraps).toBe(2)
    expect(requests).toBe(4)
  })
  it('never bootstraps or falls back to admin for collaboration authorization failures', async () => {
    const requests: string[] = []
    const fetchImpl = vi.fn(async (url: string) => { requests.push(url); return Response.json({ error: { code: 'local_admin_unauthorized', message: 'Denied' } }, { status: 403 }) })
    await expect(new AgentRuntimeClient({ fetchImpl, getRoomId: () => 'room-one' }).listRuns('c1')).rejects.toMatchObject({ status: 403 })
    expect(requests).toEqual(['/api/agent/canvases/c1/runs'])
  })
  it('cancels local submission if collaboration scope changes during bootstrap', async () => {
    let roomId: string | undefined
    let finish!: (response: Response) => void
    const requests: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      requests.push(url)
      if (url === '/api/local-admin/session') return new Promise<Response>(resolve => { finish = resolve })
      return Response.json({ runs: [] })
    })
    const pending = new AgentRuntimeClient({ fetchImpl, getRoomId: () => roomId }).listRuns('c1')
    roomId = 'room-one'
    if (finish) finish(Response.json({ ok: true, created: true }))
    await expect(pending).rejects.toMatchObject({ code: 'scope_changed' })
    expect(requests).toEqual(['/api/local-admin/session'])
  })
})
