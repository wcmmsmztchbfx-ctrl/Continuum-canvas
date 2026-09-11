// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DirectorNode } from './DirectorNode'
import { canvasStore } from '../../store/canvas-store'
import { ProviderCatalogProvider } from '../providers/ProviderCatalogContext'
import type { GatewayClient } from '../../services/gatewayClient'
import type { ProviderCatalog } from '../../contracts/catalog'

afterEach(cleanup)

function mockGateway(): GatewayClient {
  const directorCatalog: ProviderCatalog = {
    providerId: 'xiaoyunque',
    name: '小云雀 (Seedance 2.0)',
    adapterType: 'xiaoyunque-video',
    models: [
      {
        providerId: 'xiaoyunque',
        model: 'seedance-2.0-speed',
        mediaType: 'video',
        title: 'Seedance 2.0 极速视觉',
        description: '快速生成分镜视频',
        modes: ['text-to-video', 'image-to-video'],
        aspectRatios: ['16:9', '9:16'],
        durations: [5, 10],
        inputLimits: { images: 4, videos: 1 },
      },
    ],
  }

  return {
    listProviders: vi.fn().mockResolvedValue([
      {
        id: 'xiaoyunque',
        name: '小云雀 (Seedance 2.0 视频智能体)',
        baseUrl: 'https://xyq.jianying.com',
        adapterType: 'xiaoyunque-video',
        enabled: true,
        secretConfigured: true,
        available: true,
        rateLimit: { requestsPerMinute: 60 },
      },
    ]),
    listCapabilities: vi.fn().mockResolvedValue([]),
    getCatalog: vi.fn().mockImplementation(async (providerId: string) => {
      if (providerId === 'xiaoyunque') return directorCatalog
      return { providerId, name: providerId, adapterType: 'xiaoyunque-video', models: [] }
    }),
    createGenerationJob: vi.fn(),
    getGenerationJob: vi.fn(),
  } as unknown as GatewayClient
}

describe('DirectorNode Agent Delivery Console', () => {
  beforeEach(() => {
    canvasStore.setState({
      snapshot: {
        version: 1,
        projectId: 'proj-1',
        name: 'Test Project',
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          {
            id: 'dir-workbench-1',
            type: 'group',
            name: '导演台',
            position: { x: 200, y: 100 },
            size: { width: 540, height: 700 },
            data: { childIds: [], nodeKind: 'director', url: '' },
          },
        ],
        edges: [],
      },
      selectedNodeIds: ['dir-workbench-1'],
    })
  })

  it('renders pure chat console structure with top drag handle and bottom toolbar matching Image 2', () => {
    const { container } = render(
      <ReactFlowProvider>
        <ProviderCatalogProvider gateway={mockGateway()}>
          <DirectorNode
            {...({
              id: 'dir-workbench-1',
              selected: false,
              isConnectable: true,
              data: {
                name: '导演台',
                mediaType: 'group',
                url: '',
              },
            } as never)}
          />
        </ProviderCatalogProvider>
      </ReactFlowProvider>,
    )

    // Outer article is workbench
    const article = container.querySelector('article')
    expect(article).not.toBeNull()
    expect(article).toHaveClass('director-workbench')
    expect(article).toHaveClass('canvas-media-node')
    expect(article).not.toHaveClass('nodrag')

    // Header has drag handle, title and status indicator
    expect(screen.getByText('导演台')).toBeVisible()
    expect(screen.getByText('AI 导演就绪')).toBeVisible()

    // Chat pane has default welcome message
    expect(screen.getByText(/我是您的 AI 导演智能体/)).toBeVisible()

    // Bottom options bar strictly matches Image 2 design:
    // 1. Provider dropdown button
    expect(screen.getByRole('button', { name: /选择导演智能体平台/ })).toBeVisible()
    // 2. Model dropdown button
    expect(screen.getByRole('button', { name: /选择模型/ })).toBeVisible()
    // 3. Combined parameter pill [ 16:9 · 720p · 5s ▾ ]
    const paramsPill = screen.getByRole('button', { name: /成片生成参数设置/ })
    expect(paramsPill).toBeVisible()
    expect(paramsPill).toHaveTextContent('16:9 · 720p · 5s')

    // Clicking parameter pill opens settings popover
    fireEvent.click(paramsPill)
    expect(screen.getByText('画幅比例')).toBeVisible()
    expect(screen.getByText('成片时长')).toBeVisible()
    expect(screen.getByText('画质规格')).toBeVisible()

    // Textarea input and circular send button ( ↑ )
    const textarea = screen.getByPlaceholderText(/输入创意需求与交付指令/)
    expect(textarea).toBeVisible()
    const submitBtn = screen.getByRole('button', { name: /开始交付/ })
    expect(submitBtn).toBeDisabled()
  })

  it('handles creative requirement submission and expands agent thinking chain', () => {
    const onPromptChange = vi.fn()
    const onGenerate = vi.fn()

    render(
      <ReactFlowProvider>
        <ProviderCatalogProvider gateway={mockGateway()}>
          <DirectorNode
            {...({
              id: 'dir-workbench-1',
              selected: true,
              isConnectable: true,
              data: {
                name: '导演台',
                mediaType: 'group',
                url: '',
                onPromptChange,
                onGenerate,
                messages: [
                  {
                    id: 'msg-1',
                    role: 'user',
                    content: '制作一段国风香水商业宣传短片',
                    timestamp: Date.now() - 10000,
                  },
                  {
                    id: 'msg-2',
                    role: 'assistant',
                    content: '收到导演需求，已为您统筹视觉基调并生成成片。',
                    thinking: '【创意需求深度拆解】1. 核心意象：烟雨江南与白玉兰香氛质感。',
                    timestamp: Date.now() - 5000,
                  },
                ],
              },
            } as never)}
          />
        </ProviderCatalogProvider>
      </ReactFlowProvider>,
    )

    // Both user and assistant messages rendered with dark charcoal bubbles
    expect(screen.getByText('制作一段国风香水商业宣传短片')).toBeVisible()
    expect(screen.getByText('收到导演需求，已为您统筹视觉基调并生成成片。')).toBeVisible()

    // Thinking chain toggle
    const thinkingBtn = screen.getByRole('button', { name: /小云雀执行详情/ })
    expect(thinkingBtn).toBeVisible()

    // Click to expand thinking
    fireEvent.click(thinkingBtn)
    expect(screen.getByText(/【创意需求深度拆解】/)).toBeVisible()

    // Typing prompt enables circular send button
    const textarea = screen.getByPlaceholderText(/输入创意需求与交付指令/)
    fireEvent.change(textarea, { target: { value: '追加制作一段竖屏预告短片' } })
    const submitBtn = screen.getByRole('button', { name: /开始交付/ })
    expect(submitBtn).not.toBeDisabled()
  })

  it('delivers product onto canvas as VideoNode and automatically creates group frame for video requests', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reply: '已为您统筹机位与光影，生成赛博朋克饮料广告成片。',
        videoUrl: 'https://example.com/cyberpunk.mp4',
        threadId: 'th-video-1',
      }),
    }) as never

    try {
      render(
        <ReactFlowProvider>
          <ProviderCatalogProvider gateway={mockGateway()}>
            <DirectorNode
              {...({
                id: 'dir-workbench-1',
                selected: true,
                isConnectable: true,
                data: {
                  name: '导演台',
                  mediaType: 'group',
                  url: '',
                },
              } as never)}
            />
          </ProviderCatalogProvider>
        </ReactFlowProvider>,
      )

      const textarea = screen.getByPlaceholderText(/输入创意需求与交付指令/)
      fireEvent.change(textarea, { target: { value: '制作一段赛博朋克饮料广告短片' } })

      const submitBtn = screen.getByRole('button', { name: /开始交付/ })
      fireEvent.click(submitBtn)

      // Wait for delivery to materialize on canvas
      await waitFor(() => {
        const updatedNodes = canvasStore.getState().snapshot.nodes
        const deliverableNode = updatedNodes.find(
          (n) => n.type === 'video' && n.name.includes('交付成片'),
        )
        expect(deliverableNode).toBeDefined()
      })

      const updatedNodes = canvasStore.getState().snapshot.nodes
      const updatedEdges = canvasStore.getState().snapshot.edges

      const deliverableNode = updatedNodes.find(
        (n) => n.type === 'video' && n.name.includes('交付成片'),
      )
      expect(deliverableNode).toBeDefined()
      expect(deliverableNode?.data.url).toBe('https://example.com/cyberpunk.mp4')

      const groupNode = updatedNodes.find(
        (n) => n.type === 'group' && n.data.nodeKind === 'group',
      )
      expect(groupNode).toBeDefined()
      expect(groupNode?.name).toBe('导演台交付组')

      const connectingEdge = updatedEdges.find(
        (e) => e.source === 'dir-workbench-1' && e.target === deliverableNode?.id,
      )
      expect(connectingEdge).toBeDefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('delivers every returned video and renders task execution steps', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reply: '两个视频单元均已交付。',
        videoUrls: [
          'https://example.com/unit-1.mp4',
          'https://example.com/unit-2.mp4',
        ],
        executionSteps: [
          { id: 'step-1', title: '分析创作要求与参考素材', status: 'completed' },
          { id: 'step-2', title: '完成视频产物 1', status: 'completed' },
          { id: 'step-3', title: '完成视频产物 2', status: 'completed' },
        ],
        threadId: 'th-video-multi',
      }),
    }) as never

    try {
      render(
        <ReactFlowProvider>
          <ProviderCatalogProvider gateway={mockGateway()}>
            <DirectorNode
              {...({
                id: 'dir-workbench-1',
                selected: true,
                isConnectable: true,
                data: { name: '导演台', mediaType: 'group', url: '' },
              } as never)}
            />
          </ProviderCatalogProvider>
        </ReactFlowProvider>,
      )

      fireEvent.change(screen.getByPlaceholderText(/输入创意需求与交付指令/), {
        target: { value: '并行制作两个视频单元' },
      })
      fireEvent.click(screen.getByRole('button', { name: /开始交付/ }))

      await waitFor(() => {
        expect(canvasStore.getState().snapshot.nodes.filter((node) => node.type === 'video')).toHaveLength(2)
      })
      expect(screen.getByLabelText('任务执行步骤')).toBeVisible()
      expect(screen.getByText('完成视频产物 2')).toBeVisible()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('delivers product onto canvas as ImageNode and creates group frame when XiaoYunque returns imageUrl', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reply: '已为您设计生成红色国潮包装视觉图。',
        imageUrl: 'https://example.com/red-package.png',
        threadId: 'th-image-1',
      }),
    }) as never

    try {
      render(
        <ReactFlowProvider>
          <ProviderCatalogProvider gateway={mockGateway()}>
            <DirectorNode
              {...({
                id: 'dir-workbench-1',
                selected: true,
                isConnectable: true,
                data: {
                  name: '导演台',
                  mediaType: 'group',
                  url: '',
                },
              } as never)}
            />
          </ProviderCatalogProvider>
        </ReactFlowProvider>,
      )

      const textarea = screen.getByPlaceholderText(/输入创意需求与交付指令/)
      fireEvent.change(textarea, { target: { value: '参考这个图生成一个红色的包装' } })

      const submitBtn = screen.getByRole('button', { name: /开始交付/ })
      fireEvent.click(submitBtn)

      // Wait for delivery to materialize on canvas
      await waitFor(() => {
        const updatedNodes = canvasStore.getState().snapshot.nodes
        const deliverableNode = updatedNodes.find(
          (n) => n.type === 'image' && n.name.includes('交付图片'),
        )
        expect(deliverableNode).toBeDefined()
      })

      const updatedNodes = canvasStore.getState().snapshot.nodes
      const updatedEdges = canvasStore.getState().snapshot.edges

      const deliverableNode = updatedNodes.find(
        (n) => n.type === 'image' && n.name.includes('交付图片'),
      )
      expect(deliverableNode).toBeDefined()
      expect(deliverableNode?.data.url).toBe('https://example.com/red-package.png')

      const groupNode = updatedNodes.find(
        (n) => n.type === 'group' && n.data.nodeKind === 'group',
      )
      expect(groupNode).toBeDefined()
      expect(groupNode?.name).toBe('导演台交付组')

      const connectingEdge = updatedEdges.find(
        (e) => e.source === 'dir-workbench-1' && e.target === deliverableNode?.id,
      )
      expect(connectingEdge).toBeDefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps conversational greetings in the chat stream without creating video nodes on canvas', async () => {
    // Mock fetch for pure text reply like "你好！有什么想做的，随时说。"
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reply: '你好！有什么想做的，随时说。',
        threadId: 'th-test-greeting',
      }),
    }) as never

    try {
      render(
        <ReactFlowProvider>
          <ProviderCatalogProvider gateway={mockGateway()}>
            <DirectorNode
              {...({
                id: 'dir-workbench-1',
                selected: true,
                isConnectable: true,
                data: {
                  name: '导演台',
                  mediaType: 'group',
                  url: '',
                },
              } as never)}
            />
          </ProviderCatalogProvider>
        </ReactFlowProvider>,
      )

      const textarea = screen.getByPlaceholderText(/输入创意需求与交付指令/)
      fireEvent.change(textarea, { target: { value: '你好' } })

      const submitBtn = screen.getByRole('button', { name: /开始交付/ })
      fireEvent.click(submitBtn)

      // Wait for reply to appear in the chat pane
      await waitFor(() => {
        expect(screen.getByText('你好！有什么想做的，随时说。')).toBeVisible()
      })

      // Ensure NO VideoNode is created on the canvas for casual greeting!
      const currentNodes = canvasStore.getState().snapshot.nodes
      const videoNodes = currentNodes.filter((n) => n.type === 'video')
      expect(videoNodes).toHaveLength(0)

      // Ensure no group node was created
      const groupNodes = currentNodes.filter((n) => n.type === 'group' && n.data.nodeKind === 'group')
      expect(groupNodes).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps questions/consultations (e.g. output specifications) in chat stream without generating empty video nodes on canvas', async () => {
    const originalFetch = globalThis.fetch
    const specReply = '关于视频输出规格，以下是当前支持的能力范围：\n\n**分辨率**：支持 16:9、9:16、1:1 等主流比例\n**时长**：单次生成 4~15 秒'
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reply: specReply,
        threadId: 'th-test-spec-inquiry',
      }),
    }) as never

    try {
      render(
        <ReactFlowProvider>
          <ProviderCatalogProvider gateway={mockGateway()}>
            <DirectorNode
              {...({
                id: 'dir-workbench-1',
                selected: true,
                isConnectable: true,
                data: {
                  name: '导演台',
                  mediaType: 'group',
                  url: '',
                },
              } as never)}
            />
          </ProviderCatalogProvider>
        </ReactFlowProvider>,
      )

      const textarea = screen.getByPlaceholderText(/输入创意需求与交付指令/)
      fireEvent.change(textarea, { target: { value: '你都能输出什么规格的视频' } })

      const submitBtn = screen.getByRole('button', { name: /开始交付/ })
      fireEvent.click(submitBtn)

      // Wait for assistant reply to appear in chat
      await waitFor(() => {
        expect(screen.getByText(/关于视频输出规格/)).toBeVisible()
      })

      // Ensure NO VideoNode is created on the canvas for questions!
      const currentNodes = canvasStore.getState().snapshot.nodes
      const videoNodes = currentNodes.filter((n) => n.type === 'video')
      expect(videoNodes).toHaveLength(0)

      // Ensure no deliverable group was created
      const groupNodes = currentNodes.filter((n) => n.type === 'group' && n.data.nodeKind === 'group')
      expect(groupNodes).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('renders reference strip above input, inserts alias on click, and calls onRemoveReference on unlink', () => {
    const onRemoveReference = vi.fn()

    render(
      <ReactFlowProvider>
        <ProviderCatalogProvider gateway={mockGateway()}>
          <DirectorNode
            {...({
              id: 'dir-workbench-1',
              selected: true,
              isConnectable: true,
              data: {
                name: '导演台',
                mediaType: 'group',
                url: '',
                onRemoveReference,
                references: [
                  {
                    id: 'img-node-1',
                    referenceAlias: 1,
                    name: '古风人物面部.png',
                    kind: 'image',
                    url: 'https://example.com/face.png',
                  },
                  {
                    id: 'img-node-2',
                    referenceAlias: 2,
                    name: '江南雨巷场景.png',
                    kind: 'image',
                    url: 'https://example.com/street.png',
                  },
                ],
              },
            } as never)}
          />
        </ProviderCatalogProvider>
      </ReactFlowProvider>,
    )

    // Reference strip shows count and chips
    expect(screen.getByText('参考素材 (2)')).toBeVisible()
    expect(screen.getByText('古风人物面部.png')).toBeVisible()
    expect(screen.getByText('江南雨巷场景.png')).toBeVisible()

    // Chip tag button @1
    const tag1Btn = screen.getByRole('button', { name: '@1' })
    expect(tag1Btn).toBeVisible()

    const textarea = screen.getByPlaceholderText(/输入创意需求与交付指令/) as HTMLTextAreaElement
    expect(textarea.value).toBe('')

    // Clicking @1 inserts into prompt textarea
    fireEvent.click(tag1Btn)
    expect(textarea.value).toContain('@1')

    // Clicking remove button calls onRemoveReference
    const removeBtn = screen.getByRole('button', { name: '移除参考素材 古风人物面部.png' })
    fireEvent.click(removeBtn)
    expect(onRemoveReference).toHaveBeenCalledWith('dir-workbench-1', 'img-node-1')
  })

  it('renders three-tab preferences modal matching Image 1 and allows switching tabs and models', () => {
    const onSettingsChange = vi.fn()

    render(
      <ReactFlowProvider>
        <ProviderCatalogProvider gateway={mockGateway()}>
          <DirectorNode
            {...({
              id: 'dir-workbench-1',
              selected: true,
              isConnectable: true,
              data: {
                name: '导演台',
                mediaType: 'group',
                url: '',
                onSettingsChange,
              },
            } as never)}
          />
        </ProviderCatalogProvider>
      </ReactFlowProvider>,
    )

    // Click model button to open preferences modal
    const modelBtn = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(modelBtn)

    // Two tabs exist for official Xiaoyunque preferences
    expect(screen.getByRole('button', { name: /视频偏好/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /图片偏好/ })).toBeVisible()

    // Video preference tab shows official Xiaoyunque models
    expect(screen.getByText('Seedance 2.5')).toBeVisible()
    expect(screen.getAllByText('Seedance 2.0 Fast VIP')[0]).toBeVisible()
    expect(screen.getByText('Seedance 2.0 VIP')).toBeVisible()

    // Click Seedance 2.5
    fireEvent.click(screen.getByText('Seedance 2.5'))
    expect(onSettingsChange).toHaveBeenCalledWith(
      'dir-workbench-1',
      expect.objectContaining({
        model: 'Seedance_2.5',
      }),
    )

    // Switch to 图片偏好 tab (official Seedream models)
    fireEvent.click(screen.getByRole('button', { name: /图片偏好/ }))
    expect(screen.getAllByText('Seedream 5.0 Pro')[0]).toBeVisible()
    expect(screen.getByText('Seedream 5.0')).toBeVisible()
  })

  it('renders injected skills strip and removes skills via onRemoveSkill', () => {
    const onRemoveSkill = vi.fn()
    render(
      <ReactFlowProvider>
        <ProviderCatalogProvider gateway={mockGateway()}>
          <DirectorNode
            {...({
              id: 'dir-workbench-1',
              selected: true,
              isConnectable: true,
              data: {
                name: '导演台',
                mediaType: 'group',
                url: '',
                skills: [
                  { id: 'skill-1', name: '分镜拆解-skill', text: '# 分镜规范\n1. 特写镜头' },
                  { id: 'skill-2', name: '运镜节奏-skill', text: '# 运镜要求\n- 慢动作' },
                ],
                onRemoveSkill,
              },
            } as never)}
          />
        </ProviderCatalogProvider>
      </ReactFlowProvider>,
    )

    // Check skill strip rendered
    expect(screen.getByText(/注入技能 \(2\)/)).toBeInTheDocument()
    expect(screen.getByText('分镜拆解-skill')).toBeInTheDocument()
    expect(screen.getByText('运镜节奏-skill')).toBeInTheDocument()

    // Check pillSummary shows skill count
    expect(screen.getByText(/技能\(2\)/)).toBeInTheDocument()

    // Click remove button on first skill
    const removeButtons = screen.getAllByTitle('解除技能注入')
    expect(removeButtons).toHaveLength(2)
    fireEvent.click(removeButtons[0])
    expect(onRemoveSkill).toHaveBeenCalledWith('dir-workbench-1', 'skill-1')
  })
})
