// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun, AgentRunEvent } from '../../../contracts/agent'
import { AgentRunCard } from './AgentRunCard'

afterEach(cleanup)
function event(sequence: number, overrides: Partial<AgentRunEvent> = {}): AgentRunEvent {
  return { id: `e${sequence}`, sequence, type: 'tool', status: 'running', title: `步骤 ${sequence}`, createdAt: '2026-10-31', ...overrides }
}
function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return { id: 'run1', requestId: 'req1', canvasId: 'c1', projectId: 'p1', prompt: '整理画布', attachments: [], status: 'running', createdAt: '2026-10-31', updatedAt: '2026-10-31', sequence: 5, events: [], plan: [], outputs: [], canUndo: false, ...overrides }
}
function card(current: AgentRun, overrides: { readOnly?: boolean; busy?: boolean } = {}) {
  const onControl = vi.fn()
  return { ...render(<AgentRunCard run={current} readOnly={false} busy={false} onControl={onControl} onAnswer={vi.fn()} onLocate={vi.fn()} {...overrides} />), onControl }
}

describe('AgentRunCard persisted lifecycle', () => {
  it('keeps a waiting question answerable without offering pause', () => {
    card(run({ status: 'waiting_user', question: { id: 'q1', title: '继续生成吗？', options: ['继续', '先停止'] } }))
    expect(screen.getByRole('region', { name: '等待你的回答' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交回答' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '暂停任务' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止任务' })).toBeInTheDocument()
  })

  it.each(['partial', 'failed'] as const)('resumes the same %s run and respects busy/read-only controls', status => {
    const current = run({ status })
    const view = card(current)
    fireEvent.click(screen.getByRole('button', { name: '继续处理未完成部分' }))
    expect(view.onControl).toHaveBeenCalledWith(current, 'resume')
    view.unmount()
    const busy = card(current, { busy: true })
    expect(screen.getByRole('button', { name: '继续处理未完成部分' })).toBeDisabled()
    busy.unmount()
    card(current, { readOnly: true })
    expect(screen.queryByRole('button', { name: '继续处理未完成部分' })).not.toBeInTheDocument()
  })

  it('shows the newest operation state per type while retaining distinct work and stage messages', () => {
    const view = card(run({ events: [
      event(1, { operationId: 'op1', title: '正在创建节点' }),
      event(2, { type: 'message', operationId: 'op1', status: 'complete', title: '已选好布局' }),
      event(3, { type: 'generation', operationId: 'op1', title: '等待图片结果' }),
      event(4, { operationId: 'op1', status: 'complete', title: '节点创建完成', detail: '新建 2 个节点' }),
      event(5, { type: 'message', operationId: 'op1', status: 'complete', title: '正在核对版面' }),
      event(6, { operationId: 'op2', title: '正在创建另一个节点' }),
    ] }))
    expect(screen.queryByText('正在创建节点')).not.toBeInTheDocument()
    expect(screen.getByText('节点创建完成')).toBeInTheDocument()
    expect(screen.getByText('新建 2 个节点')).toBeInTheDocument()
    expect(screen.getByText('等待图片结果')).toBeInTheDocument()
    expect(screen.getByText('正在创建另一个节点')).toBeInTheDocument()
    expect(screen.getByText('已选好布局')).toBeInTheDocument()
    expect(screen.getByText('正在核对版面')).toBeInTheDocument()
    expect(view.container.querySelectorAll('.agent-runtime-event')).toHaveLength(5)
  })

  it.each(['complete', 'partial', 'failed', 'stopped'] as const)('retains old event history without perpetual busy indicators for %s', status => {
    const view = card(run({ status, plan: [{ id: 'p1', title: '未完成的步骤', status: 'running' }], events: [
      event(1, { title: '旧版开始记录' }),
      event(2, { status: 'complete', title: '旧版完成记录' }),
      event(3, { operationId: 'interrupted', title: '中断的操作' }),
    ] }))
    expect(screen.getByText('旧版开始记录')).toBeInTheDocument()
    expect(screen.getByText('旧版完成记录')).toBeInTheDocument()
    expect(screen.getByText('中断的操作')).toBeInTheDocument()
    expect(view.container.querySelector('.agent-runtime-spin')).not.toBeInTheDocument()
  })

  it('renders an identical final response once without hiding earlier stage messages', () => {
    card(run({ status: 'complete', response: '画布已整理完成', events: [
      event(1, { type: 'message', status: 'complete', title: '准备对齐图片' }),
      event(2, { type: 'message', status: 'complete', title: '画布已整理完成' }),
      event(3, { type: 'status', status: 'complete', title: '任务结束' }),
    ] }))
    expect(screen.getAllByText('画布已整理完成')).toHaveLength(1)
    expect(screen.getByText('画布已整理完成').tagName).toBe('P')
    expect(screen.getByText('准备对齐图片')).toBeInTheDocument()
    expect(screen.getByText('任务结束')).toBeInTheDocument()
  })

  it('uses readable tool labels and concise details instead of a raw result object', () => {
    const detail = JSON.stringify({ nodeId: 'image-one', model: 'image-model', aspectRatio: '16:9', nodes: Array.from({ length: 20 }, () => ({ name: '内部节点原始内容', data: { text: '长对象内容'.repeat(20) } })) })
    card(run({ events: [
      event(1, { toolName: 'create_node', title: 'create_node', status: 'complete', detail }),
      event(2, { toolName: 'request_generation', title: 'request_generation', status: 'failed', detail: JSON.stringify({ error: { code: 'failed', message: '模型暂时不可用' } }) }),
      event(3, { toolName: 'view_image', title: '查看图片 · 苹果参考', status: 'complete' }),
    ] }))
    expect(screen.getByText('创建节点')).toBeInTheDocument()
    expect(screen.getByText('提交生成')).toBeInTheDocument()
    expect(screen.getByText(/节点：image-one/)).toBeInTheDocument()
    expect(screen.getByText(/模型：image-model/)).toBeInTheDocument()
    expect(screen.getByText(/画幅：16:9/)).toBeInTheDocument()
    expect(screen.getByText('模型暂时不可用')).toBeInTheDocument()
    expect(screen.getByText('查看图片 · 苹果参考')).toBeInTheDocument()
    expect(screen.queryByText(detail)).not.toBeInTheDocument()
    expect(screen.queryByText(/内部节点原始内容/)).not.toBeInTheDocument()
  })
})
