// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSidebarPanel } from './AgentSidebarPanel'
import { createCanvasStore, EMPTY_CANVAS_SNAPSHOT } from '../../store/canvas-store'
import type { AgentRun } from '../../contracts/agent'
import type { ImageNode } from '../../model/project'

vi.mock('../canvas/ManagedMediaImage', () => ({ ManagedMediaImage: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} /> }))
const assetId = '11111111-1111-4111-8111-111111111111'
const { importAsset } = vi.hoisted(() => ({ importAsset: vi.fn() }))
vi.mock('../../services/gatewayClient', async () => ({ ...await vi.importActual<typeof import('../../services/gatewayClient')>('../../services/gatewayClient'), gatewayClient: { getCollaborationRoomId: () => undefined, ensureLocalAdminSession: async () => undefined, importAsset, uploadAsset: vi.fn() } }))
function imageNode(id: string): ImageNode { return { id, type: 'image', name: `图片${id}`, position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, data: { url: `/api/assets/${assetId}`, assetId } } }
function makeRun(overrides: Partial<AgentRun> = {}): AgentRun { return { id: 'r1', requestId: 'req1', canvasId: 'c1', projectId: 'p1', prompt: '生成苹果', attachments: [], status: 'running', createdAt: '2026-10-31', updatedAt: '2026-10-31', sequence: 1, events: [], plan: [], outputs: [], canUndo: false, ...overrides } }
const posted: Array<{ url: string; body: Record<string, unknown> }> = []
let runs: AgentRun[] = []
let configured = true
let legacy: unknown[] = []
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  localStorage.clear(); posted.length = 0; runs = []; configured = true; legacy = []
  importAsset.mockReset().mockResolvedValue({ id: assetId, url: `/api/assets/${assetId}` })
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string); posted.push({ url, body })
      const result = makeRun({ prompt: body.prompt ?? runs[0]?.prompt ?? '生成苹果', requestId: body.requestId, attachments: body.attachments ?? [], status: body.action === 'pause' ? 'paused' : body.action === 'stop' ? 'stopped' : 'running', sequence: (runs[0]?.sequence ?? 0) + 1 })
      runs = [result]; return Response.json({ run: result })
    }
    if (url === '/api/agent/status') return Response.json({ configured, model: '测试模型' })
    if (url === '/api/agent/skills') return Response.json({ skills: [{ id: 'base', name: '画布基础操作', description: '读取与编辑节点', version: '1' }] })
    if (url.endsWith('/runs')) return Response.json({ runs })
    if (url.endsWith('/agent-chat')) return Response.json({ messages: legacy })
    return Response.json({ revision: 3 })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })
describe('AgentSidebarPanel backend runs', () => {
  it('retains configuration entry and disables writes for collaborators', async () => {
    configured = false
    const open = vi.fn()
    const view = render(<AgentSidebarPanel canvasId="c1" onOpenProviderDrawer={open} />)
    fireEvent.click(await screen.findByRole('button', { name: /前往配置 API/ }))
    expect(open).toHaveBeenCalledOnce()
    view.rerender(<AgentSidebarPanel canvasId="c1" readOnly />)
    expect(screen.getByText('仅房主可用')).toBeInTheDocument()
    expect(screen.getByLabelText('Agent 指令输入框')).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  })
  it('reports missing canvas scope instead of running a local harness', async () => {
    render(<AgentSidebarPanel />)
    fireEvent.change(screen.getByLabelText('Agent 指令输入框'), { target: { value: '生成苹果' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('请先打开画布后再使用 Agent')).toBeInTheDocument()
    expect(posted).toHaveLength(0)
  })
  it('sends only individually confirmed images and waits for confirmed canvas revision', async () => {
    const store = createCanvasStore({ ...EMPTY_CANVAS_SNAPSHOT, nodes: [imageNode('1'), imageNode('2')] })
    store.getState().selectNodes(['1', '2'])
    render(<AgentSidebarPanel canvasId="c1" store={store} onBeforeRun={async () => ({ expectedRevision: 7 })} />)
    expect(screen.getByRole('button', { name: '引用 图片1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '引用 图片2' }))
    expect(await screen.findByRole('button', { name: '移除引用 图片2' })).toBeInTheDocument()
    act(() => store.getState().selectNodes([]))
    expect(screen.queryByRole('button', { name: '引用 图片1' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Agent 指令输入框'), { target: { value: '分析图片' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].body.expectedRevision).toBe(7)
    expect(posted[0].body.attachments).toEqual([expect.objectContaining({ nodeId: '2', assetId, mediaType: 'image' })])
  })
  it('offers reference all but sends no unconfirmed ghost attachments', async () => {
    const store = createCanvasStore({ ...EMPTY_CANVAS_SNAPSHOT, nodes: [imageNode('1'), imageNode('2')] })
    store.getState().selectNodes(['1', '2'])
    render(<AgentSidebarPanel canvasId="c1" store={store} />)
    expect(screen.getByRole('button', { name: '引用全部' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Agent 指令输入框'), { target: { value: '整理节点' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].body.attachments).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '新任务' }))
    fireEvent.click(screen.getByRole('button', { name: '引用全部' }))
    expect(await screen.findByRole('button', { name: '移除引用 图片1' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '移除引用 图片2' })).toBeInTheDocument()
  })
  it('imports confirmed remote images and keeps independent canvas drafts', async () => {
    const node = imageNode('1'); node.data = { url: 'https://example.test/photo.png' }
    const store = createCanvasStore({ ...EMPTY_CANVAS_SNAPSHOT, nodes: [node] }); store.getState().selectNodes(['1'])
    const view = render(<AgentSidebarPanel canvasId="c1" store={store} />)
    fireEvent.click(screen.getByRole('button', { name: '引用 图片1' }))
    await screen.findByRole('button', { name: '移除引用 图片1' })
    fireEvent.change(screen.getByLabelText('Agent 指令输入框'), { target: { value: '第一张画布的草稿' } })
    view.rerender(<AgentSidebarPanel canvasId="c2" store={store} />)
    expect(screen.getByLabelText('Agent 指令输入框')).toHaveValue('')
    expect(screen.queryByRole('button', { name: '移除引用 图片1' })).not.toBeInTheDocument()
    view.rerender(<AgentSidebarPanel canvasId="c1" store={store} />)
    expect(screen.getByLabelText('Agent 指令输入框')).toHaveValue('第一张画布的草稿')
    expect(screen.getByRole('button', { name: '移除引用 图片1' })).toBeInTheDocument()
    expect(importAsset).toHaveBeenCalledOnce()
  })
  it('restores events, plan and question after remount and answers options plus text', async () => {
    runs = [makeRun({ status: 'waiting_user', question: { id: 'q1', title: '选择广告主体', options: ['水果苹果', 'Apple 产品'] }, plan: [{ id: 'p1', title: '确认主体', status: 'running' }], events: [{ id: 'e1', sequence: 1, type: 'skill', status: 'complete', title: '读取技能 · 画布基础操作', createdAt: '2026-10-31' }] })]
    const view = render(<AgentSidebarPanel canvasId="c1" />)
    expect(await screen.findByText('选择广告主体')).toBeInTheDocument()
    expect(screen.getByText('读取技能 · 画布基础操作')).toBeInTheDocument()
    expect(screen.getByText('确认主体')).toBeInTheDocument()
    view.unmount(); render(<AgentSidebarPanel canvasId="c1" />)
    fireEvent.click(await screen.findByRole('button', { name: '水果苹果' }))
    fireEvent.change(screen.getByLabelText('补充回答'), { target: { value: '红色苹果' } })
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ url: '/api/agent/runs/r1/answer', body: { questionId: 'q1', answer: '水果苹果\n红色苹果' } })
  })
  it('supplements current run and persists pause, resume and stop', async () => {
    runs = [makeRun()]
    render(<AgentSidebarPanel canvasId="c1" />)
    await screen.findByText('补充当前任务')
    fireEvent.change(screen.getByLabelText('Agent 指令输入框'), { target: { value: '改成白色背景' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(posted[0]?.body).toMatchObject({ action: 'message', message: '改成白色背景' }))
    fireEvent.click(screen.getByRole('button', { name: '暂停任务' }))
    fireEvent.click(await screen.findByRole('button', { name: '继续任务' }))
    await screen.findByRole('button', { name: '暂停任务' })
    fireEvent.click(screen.getByRole('button', { name: '停止任务' }))
    await waitFor(() => expect(posted.map(item => item.body.action)).toEqual(['message', 'pause', 'resume', 'stop']))
  })
  it.each(['partial', 'failed'] as const)('continues a %s run through its existing backend control endpoint', async status => {
    runs = [makeRun({ status })]
    render(<AgentSidebarPanel canvasId="c1" />)
    fireEvent.click(await screen.findByRole('button', { name: '继续处理未完成部分' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ url: '/api/agent/runs/r1/control', body: { action: 'resume' } })
    expect(posted[0].body).not.toHaveProperty('message')
    expect(posted[0].body).not.toHaveProperty('prompt')
    expect(await screen.findByText('补充当前任务')).toBeInTheDocument()
  })
  it('does not submit Enter during Chinese composition', async () => {
    render(<AgentSidebarPanel canvasId="c1" />)
    const input = screen.getByLabelText('Agent 指令输入框')
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '苹果' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 229 })
    await act(async () => {})
    expect(posted).toHaveLength(0)
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(posted).toHaveLength(1))
  })
  it('discards late history after switching canvases', async () => {
    let finish!: (response: Response) => void
    const normal = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === '/api/agent/canvases/c1/runs' ? new Promise<Response>(resolve => { finish = resolve }) : normal(url, init))
    const view = render(<AgentSidebarPanel canvasId="c1" />)
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    view.rerender(<AgentSidebarPanel canvasId="c2" />)
    await act(async () => finish(Response.json({ runs: [makeRun({ prompt: '旧画布任务' })] })))
    expect(screen.queryByText('旧画布任务')).not.toBeInTheDocument()
  })
  it('reads legacy summaries without thought chains or old rollback and lists real skills', async () => {
    legacy = [{ id: 'old1', role: 'assistant', content: '历史执行摘要', thoughts: '隐藏推理', canRollback: true, rollbackSnapshot: '{}' }]
    render(<AgentSidebarPanel canvasId="c1" />)
    expect(await screen.findByText('历史执行摘要')).toBeInTheDocument()
    expect(screen.queryByText('隐藏推理')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /撤销/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看可用技能' }))
    expect(await screen.findByText('画布基础操作')).toBeInTheDocument()
    expect(screen.getByText('读取与编辑节点')).toBeInTheDocument()
  })
})

// Additional boundaries: preparation, lifecycle, idempotency and large-canvas UI isolation.
describe('AgentSidebarPanel lifecycle boundaries', () => {
  it('waits for local save and refuses to submit when save fails', async () => {
    const view = render(<AgentSidebarPanel canvasId="c1" onBeforeRun={async () => { throw new Error('画布保存冲突') }} />)
    fireEvent.change(screen.getByLabelText('Agent 指令输入框'), { target: { value: '生成苹果' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('画布保存冲突')).toBeInTheDocument()
    expect(posted).toHaveLength(0)
    expect(screen.getByLabelText('Agent 指令输入框')).toHaveValue('生成苹果')
    view.unmount()
  })
  it('does not submit after canvas change or read-only revocation during save', async () => {
    let finish!: (value: { expectedRevision: number }) => void
    const beforeRun = () => new Promise<{ expectedRevision: number }>(resolve => { finish = resolve })
    const view = render(<AgentSidebarPanel canvasId="c1" onBeforeRun={beforeRun} />)
    fireEvent.change(screen.getByLabelText('Agent 指令输入框'), { target: { value: '生成苹果' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    view.rerender(<AgentSidebarPanel canvasId="c1" readOnly onBeforeRun={beforeRun} />)
    await act(async () => finish({ expectedRevision: 3 }))
    expect(posted).toHaveLength(0)
    view.rerender(<AgentSidebarPanel canvasId="c1" onBeforeRun={beforeRun} />)
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    view.rerender(<AgentSidebarPanel canvasId="c2" onBeforeRun={beforeRun} />)
    await act(async () => finish({ expectedRevision: 3 }))
    expect(posted).toHaveLength(0)
  })
  it('retries an uncertain create using the exact persisted request after remount', async () => {
    const normal = fetchMock.getMockImplementation()!
    let failed = false
    const creates: unknown[] = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/agent/runs' && init?.method === 'POST') {
        creates.push(JSON.parse(init.body as string))
        if (!failed) { failed = true; return Promise.reject(new Error('连接中断')) }
      }
      return normal(url, init)
    })
    const view = render(<AgentSidebarPanel canvasId="c1" />)
    fireEvent.change(screen.getByLabelText('Agent 指令输入框'), { target: { value: '生成苹果' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('连接中断')
    view.unmount(); render(<AgentSidebarPanel canvasId="c1" />)
    fireEvent.click(screen.getByRole('button', { name: '重试提交' }))
    await waitFor(() => expect(creates).toHaveLength(2))
    expect(creates[1]).toEqual(creates[0])
  })
  it('limits explicit image references before exceeding the backend vision budget', async () => {
    const nodes = ['1', '2', '3', '4', '5'].map(imageNode)
    const store = createCanvasStore({ ...EMPTY_CANVAS_SNAPSHOT, nodes }); store.getState().selectNodes(nodes.map(node => node.id))
    render(<AgentSidebarPanel canvasId="c1" store={store} />)
    fireEvent.click(screen.getByRole('button', { name: '引用全部' }))
    await screen.findByRole('button', { name: '移除引用 图片4' })
    expect(screen.queryByRole('button', { name: '移除引用 图片5' })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('最多引用 4 张')
    fireEvent.change(screen.getByLabelText('Agent 指令输入框'), { target: { value: '分析已引用的图片' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].body.attachments).toHaveLength(4)
  })
  it('keeps late create results out of a newly opened canvas', async () => {
    const normal = fetchMock.getMockImplementation()!
    let finish!: (response: Response) => void
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === '/api/agent/runs' && init?.method === 'POST' ? new Promise<Response>(resolve => { finish = resolve }) : normal(url, init))
    const view = render(<AgentSidebarPanel canvasId="c1" />)
    fireEvent.change(screen.getByLabelText('Agent 指令输入框'), { target: { value: '旧画布苹果' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    view.rerender(<AgentSidebarPanel canvasId="c2" />)
    await act(async () => finish(Response.json({ run: makeRun({ prompt: '旧画布苹果' }) })))
    expect(screen.queryByText('旧画布苹果')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Agent 指令输入框')).toHaveValue('')
  })
  it('does not stop a backend run or keep polling after panel unmount', async () => {
    vi.useFakeTimers()
    runs = [makeRun()]
    const view = render(<AgentSidebarPanel canvasId="c1" />)
    await act(async () => {})
    view.unmount()
    const count = fetchMock.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(fetchMock.mock.calls.length).toBe(count)
    expect(posted).toHaveLength(0)
  })
  it('does not request or rerender images when only camera moves', async () => {
    const store = createCanvasStore({ ...EMPTY_CANVAS_SNAPSHOT, nodes: [imageNode('1')] }); store.getState().selectNodes(['1'])
    render(<AgentSidebarPanel canvasId="c1" store={store} />)
    await act(async () => {})
    const candidate = screen.getByRole('button', { name: '引用 图片1' })
    const html = candidate.innerHTML
    const observer = new MutationObserver(() => {})
    observer.observe(candidate, { subtree: true, attributes: true, childList: true })
    const requests = fetchMock.mock.calls.length
    act(() => { for (let x = 0; x < 50; x++) store.getState().setViewport({ x, y: x, zoom: 1.3 }) })
    expect(observer.takeRecords()).toHaveLength(0)
    expect(candidate.innerHTML).toBe(html)
    expect(fetchMock.mock.calls.length).toBe(requests)
    observer.disconnect()
  })
  it('uses backend undo without replacing unrelated canvas edits', async () => {
    runs = [makeRun({ status: 'complete', canUndo: true })]
    const store = createCanvasStore({ ...EMPTY_CANVAS_SNAPSHOT, nodes: [imageNode('manual')] })
    render(<AgentSidebarPanel canvasId="c1" store={store} />)
    fireEvent.click(await screen.findByRole('button', { name: '撤销本次操作' }))
    await waitFor(() => expect(posted[0]?.body.action).toBe('undo'))
    expect(store.getState().snapshot.nodes[0].id).toBe('manual')
  })
})

describe('Agent reference ordering and pending uploads', () => {
  it('keeps explicit reference order even when a later upload finishes first', async () => {
    let firstDone!: (value: { id: string; url: string }) => void
    let secondDone!: (value: { id: string; url: string }) => void
    importAsset.mockImplementation((url: string) => new Promise(resolve => { if (url.endsWith('one.png')) firstDone = resolve; else secondDone = resolve }))
    const first = imageNode('1'); first.data = { url: 'https://example.test/one.png' }
    const second = imageNode('2'); second.data = { url: 'https://example.test/two.png' }
    const store = createCanvasStore({ ...EMPTY_CANVAS_SNAPSHOT, nodes: [first, second] }); store.getState().selectNodes(['1', '2'])
    render(<AgentSidebarPanel canvasId="c1" store={store} />)
    fireEvent.click(screen.getByRole('button', { name: '引用全部' }))
    fireEvent.change(screen.getByLabelText('Agent 指令输入框'), { target: { value: '图1作主体，图2作风格' } })
    await act(async () => secondDone({ id: assetId, url: `/api/assets/${assetId}` }))
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    await act(async () => firstDone({ id: assetId, url: `/api/assets/${assetId}` }))
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect((posted[0].body.attachments as Array<{ nodeId: string }>).map(item => item.nodeId)).toEqual(['1', '2'])
  })
  it('keeps older legacy messages accessible on demand', async () => {
    legacy = Array.from({ length: 45 }, (_, index) => ({ id: `old-${index}`, role: 'assistant', content: `历史消息 ${index}` }))
    render(<AgentSidebarPanel canvasId="c1" />)
    await screen.findByText('历史消息 44')
    expect(screen.queryByText('历史消息 0')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '显示更早对话' }))
    expect(screen.getByText('历史消息 0')).toBeInTheDocument()
  })
})

describe('Agent result navigation', () => {
  it('locates nested output in canvas coordinates without altering document nodes', async () => {
    const output = imageNode('child'); output.parentId = 'parent'; output.position = { x: 10, y: 20 }
    const parent = { id: 'parent', type: 'group' as const, name: '组', position: { x: 1000, y: 2000 }, size: { width: 500, height: 500 }, data: {} }
    const store = createCanvasStore({ ...EMPTY_CANVAS_SNAPSHOT, nodes: [parent, output] })
    runs = [makeRun({ status: 'complete', outputs: [{ nodeId: 'child', assetId, url: `/api/assets/${assetId}`, mediaType: 'image' }] })]
    render(<AgentSidebarPanel canvasId="c1" store={store} />)
    fireEvent.click(await screen.findByRole('button', { name: '定位结果' }))
    expect(store.getState().snapshot.viewport).toEqual({ x: -660, y: -1770, zoom: 1 })
    expect(store.getState().snapshot.nodes[1].position).toEqual({ x: 10, y: 20 })
  })
})
