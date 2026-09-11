// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { referenceProjectSnapshot } from '../../fixtures/reference'
import { createCanvasStore } from '../../store/canvas-store'
import { AgentSidebarPanel } from './AgentSidebarPanel'

describe('AgentSidebarPanel', () => {
  afterEach(cleanup)

  it('renders unconfigured state when no LLM is available and provides config button', async () => {
    const onNotify = vi.fn()
    const onOpenProviderDrawer = vi.fn()

    // mock fetch returning unconfigured
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/agent/status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ configured: false }),
        } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    })

    render(
      <AgentSidebarPanel
        onNotify={onNotify}
        onOpenProviderDrawer={onOpenProviderDrawer}
      />,
    )

    expect(await screen.findByText('尚未接入 Agent 大模型')).toBeInTheDocument()
    const configBtn = screen.getByRole('button', { name: /前往配置 API/ })
    fireEvent.click(configBtn)
    expect(onOpenProviderDrawer).toHaveBeenCalled()

    globalThis.fetch = originalFetch
  })

  it('renders Figure 1 empty state with collapsible capsule groups when configured', async () => {
    const onNotify = vi.fn()

    // mock fetch returning configured
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/agent/status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ configured: true, providerId: 'openai' }),
        } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    })

    render(<AgentSidebarPanel onNotify={onNotify} />)

    expect(await screen.findByText('下一步做什么？')).toBeInTheDocument()
    expect(screen.getByText('排版与优化')).toBeInTheDocument()
    expect(screen.getByText('生成设计与分镜')).toBeInTheDocument()
    expect(screen.getByText('工作流与模板')).toBeInTheDocument()

    // 点击折叠胶囊展开
    const tidyBtn = screen.getByRole('button', { name: /排版与优化/ })
    fireEvent.click(tidyBtn)

    expect(await screen.findByText('📐 水平分镜故事流排版')).toBeInTheDocument()

    // 点击子指令触发执行
    const subItemBtn = screen.getByRole('button', { name: /水平分镜故事流排版/ })
    fireEvent.click(subItemBtn)

    expect(await screen.findByText(/帮我把画布上的所有节点/)).toBeInTheDocument()
    expect(screen.queryByText('任务规划与进度')).not.toBeInTheDocument()

    globalThis.fetch = originalFetch
  })

  it('allows user to type custom ideas and send messages', async () => {
    const onNotify = vi.fn()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/agent/status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ configured: true, providerId: 'openai' }),
        } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    })

    render(<AgentSidebarPanel onNotify={onNotify} />)

    const input = await screen.findByLabelText('Agent 指令输入框')
    fireEvent.change(input, { target: { value: '帮我创建3个科幻分镜' } })

    const sendBtn = screen.getByRole('button', { name: '发送' })
    fireEvent.click(sendBtn)

    expect(await screen.findByText('帮我创建3个科幻分镜')).toBeInTheDocument()

    globalThis.fetch = originalFetch
  })

  it('renders collaborator lock state and disables inputs when readOnly', async () => {
    const onNotify = vi.fn()
    render(<AgentSidebarPanel onNotify={onNotify} readOnly />)

    expect(await screen.findByText('多人协作模式已启用')).toBeInTheDocument()
    expect(screen.getByText('仅房主可用')).toBeInTheDocument()
    expect(screen.getByText('已锁定')).toBeInTheDocument()

    const input = screen.getByLabelText('Agent 指令输入框')
    expect(input).toBeDisabled()

    const sendBtn = screen.getByRole('button', { name: '发送' })
    expect(sendBtn).toBeDisabled()
  })

  it('loads and persists chat history for a specific canvasId', async () => {
    const onNotify = vi.fn()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/agent/status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ configured: true, providerId: 'openai' }),
        } as Response)
      }
      if (url === '/api/canvases/canvas-test-123/agent-chat') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            messages: [
              { id: 'm1', role: 'user', content: '历史问题：生成赛博朋克城市', timestamp: 1000 },
              { id: 'm2', role: 'assistant', content: '已为你创建该分镜。', timestamp: 2000 },
            ],
          }),
        } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    })

    render(<AgentSidebarPanel canvasId="canvas-test-123" onNotify={onNotify} />)

    expect(await screen.findByText('历史问题：生成赛博朋克城市')).toBeInTheDocument()
    expect(screen.getByText('已为你创建该分镜。')).toBeInTheDocument()

    globalThis.fetch = originalFetch
  })

  it('receives referenced nodes via event, renders reference chip, and supports removal', async () => {
    const onNotify = vi.fn()
    const targetNode = referenceProjectSnapshot.nodes[0]!
    const store = createCanvasStore(referenceProjectSnapshot)

    render(<AgentSidebarPanel onNotify={onNotify} store={store} />)

    // Dispatch reference event
    act(() => {
      window.dispatchEvent(
        new CustomEvent('continuum-agent-reference-nodes', {
          detail: { nodeIds: [targetNode.id] },
        }),
      )
    })

    expect(await screen.findByText(`已引用画布节点 (1)`)).toBeInTheDocument()
    expect(screen.getByText(targetNode.name)).toBeInTheDocument()

    // Remove the chip
    const removeBtn = screen.getByRole('button', { name: `移除「${targetNode.name}」` })
    fireEvent.click(removeBtn)

    expect(screen.queryByText(`已引用画布节点 (1)`)).toBeNull()
  })
})
