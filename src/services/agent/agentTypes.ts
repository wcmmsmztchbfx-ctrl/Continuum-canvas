import type { Point } from '../../model/project'

export interface AgentPlanStep {
  id: string
  title: string
  toolName?: string
  status: 'pending' | 'running' | 'healing' | 'completed' | 'failed'
  detail?: string
  error?: string
}

export interface AgentPlan {
  id: string
  intent: string
  thoughts?: string
  steps: AgentPlanStep[]
  status: 'planning' | 'executing' | 'verifying' | 'healing' | 'completed' | 'failed'
  createdAt: number
}

export interface VerificationIssue {
  type: 'spatial_collision' | 'dangling_edge' | 'cycle' | 'empty_prompt' | 'missing_node'
  severity: 'error' | 'warning'
  message: string
  nodeIds?: string[]
  edgeIds?: string[]
  suggestedFix?: string
}

export interface VerificationResult {
  passed: boolean
  issues: VerificationIssue[]
  summary?: string
}

export interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  thoughts?: string
  plan?: AgentPlan
  actions?: CanvasAgentAction[]
  status?: 'streaming' | 'complete' | 'error'
  error?: string
  canRollback?: boolean
  rollbackSnapshot?: string
}

export type CanvasAgentActionType =
  | 'create_nodes'
  | 'connect_nodes'
  | 'update_node_prompts'
  | 'update_node_settings'
  | 'delete_nodes'
  | 'auto_layout'
  | 'trigger_generation'
  | 'apply_template'
  | 'inspect_canvas'

export interface CanvasAgentAction {
  id: string
  type: CanvasAgentActionType
  title: string
  summary: string
  details?: Record<string, unknown>
  status: 'pending' | 'success' | 'failed' | 'requires_confirmation'
  requiresConfirmation?: boolean
  payload?: Record<string, unknown>
}

export interface AgentCreateNodeInput {
  id?: string
  type: 'image' | 'video' | 'text' | 'group'
  name: string
  prompt?: string
  text?: string
  position?: Point
  relativeToNodeId?: string
  direction?: 'right' | 'bottom' | 'top' | 'left'
  size?: { width: number; height: number }
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9'
  resolution?: string
  quality?: string
  durationSec?: number
  referenceNodeIds?: string[]
}

export interface AgentConnectNodesInput {
  sourceNodeId: string
  targetNodeId: string
  relation: 'output' | 'flow' | 'reference'
  referenceAlias?: number
}

export interface AgentUpdatePromptInput {
  nodeId: string
  prompt?: string
  text?: string
  name?: string
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9'
  resolution?: string
  quality?: string
  durationSec?: number
  referenceNodeIds?: string[]
}

export interface AgentDeleteNodesInput {
  nodeIds: string[]
}

export interface AgentAutoLayoutInput {
  strategy: 'storyboard_horizontal' | 'grid' | 'tree'
  nodeIds?: string[]
}

export interface AgentTriggerGenerationInput {
  nodeIds: string[]
  prompt?: string
}

export interface AgentApplyTemplateInput {
  templateId: string
  theme?: string
  params?: Record<string, string | number | boolean>
}

export const CANVAS_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_nodes',
      description: '在画布上批量创建新节点（图片、视频、文本、画框），支持配置画幅比例、分辨率、视频时长以及挂载参考已有节点。',
      parameters: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['image', 'video', 'text', 'group'],
                  description: '节点类型：image(图片节点), video(视频节点), text(文本节点), group(画框/分组)',
                },
                name: { type: 'string', description: '节点显示名称，例如"分镜 1：雨夜街道"' },
                prompt: { type: 'string', description: '生图或生视频提示词 (Prompt)，若引用了参考节点可在提示词中自然包含 @1, @2' },
                text: { type: 'string', description: '文本节点的正文内容' },
                aspectRatio: {
                  type: 'string',
                  enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
                  description: '画幅宽高比：9:16(竖屏手机短视频/海报), 16:9(横屏电影), 1:1(方形头像), 4:3, 3:4, 21:9',
                },
                resolution: {
                  type: 'string',
                  description: '分辨率，如 "1K", "2K", "4K", "720p", "1080p"',
                },
                durationSec: {
                  type: 'number',
                  description: '视频时长秒数，如 5 或 10（仅针对视频节点）',
                },
                referenceNodeIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '需要参考的已有节点 ID 列表。系统将自动建立真实的参考挂载并在下方显示缩略图，在提示词中对应 @1, @2 等代号。',
                },
                relativeToNodeId: { type: 'string', description: '参考已有节点的 ID 进行相对定位' },
                direction: {
                  type: 'string',
                  enum: ['right', 'bottom', 'top', 'left'],
                  description: '相对于参考节点的方向，默认 right (右侧排列)',
                },
                position: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                  },
                  description: '绝对坐标（可选，若不指定会自动排版在合适空白区域）',
                },
              },
              required: ['type', 'name'],
            },
          },
        },
        required: ['nodes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'connect_nodes',
      description: '在画布上的两个节点之间建立连线（故事流连线 flow、生成衍生连线 output、或真实参考图连线 reference）。',
      parameters: {
        type: 'object',
        properties: {
          connections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sourceNodeId: { type: 'string', description: '起点节点 ID (参考源)' },
                targetNodeId: { type: 'string', description: '目标节点 ID (引用方)' },
                relation: {
                  type: 'string',
                  enum: ['flow', 'output', 'reference'],
                  description: '连线关系：flow(分镜故事流), output(生成衍生), reference(真实参考引用)',
                },
              },
              required: ['sourceNodeId', 'targetNodeId', 'relation'],
            },
          },
        },
        required: ['connections'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_node_settings',
      description: '修改已有节点的具体参数（画幅比例 aspectRatio、分辨率 resolution、视频时长 durationSec、提示词 prompt、名称或参考节点 referenceNodeIds）。',
      parameters: {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: '待修改的节点 ID' },
                name: { type: 'string', description: '修改节点标题/名称' },
                prompt: { type: 'string', description: '修改生图/生视频提示词' },
                text: { type: 'string', description: '修改文本节点正文' },
                aspectRatio: {
                  type: 'string',
                  enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
                  description: '修改画幅比例 (9:16, 16:9, 1:1 等)，节点物理尺寸将自适应联动调整',
                },
                resolution: { type: 'string', description: '修改分辨率 (1K, 2K, 4K, 720p, 1080p)' },
                durationSec: { type: 'number', description: '修改视频时长 (5, 10)' },
                referenceNodeIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '重新绑定或挂载参考的已有节点 ID 列表',
                },
              },
              required: ['nodeId'],
            },
          },
        },
        required: ['updates'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_node_prompts',
      description: '【别名】更新或润色已有节点的生图提示词 (Prompt)、文本内容或节点名称（推荐使用 update_node_settings）。',
      parameters: {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: '待修改的节点 ID' },
                prompt: { type: 'string', description: '新的生图提示词' },
                text: { type: 'string', description: '新的文本节点正文' },
                name: { type: 'string', description: '新的节点标题/名称' },
                aspectRatio: {
                  type: 'string',
                  enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
                },
              },
              required: ['nodeId'],
            },
          },
        },
        required: ['updates'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_nodes',
      description: '从画布上删除指定的节点。',
      parameters: {
        type: 'object',
        properties: {
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            description: '待删除的节点 ID 列表',
          },
        },
        required: ['nodeIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'auto_layout',
      description: '自动对齐和整理画布上的节点排版布局。',
      parameters: {
        type: 'object',
        properties: {
          strategy: {
            type: 'string',
            enum: ['storyboard_horizontal', 'grid', 'tree'],
            description: '排版策略：storyboard_horizontal(水平分镜流), grid(网格整齐对齐), tree(上下/演化树)',
          },
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            description: '指定要排版的节点 ID（可选，默认排版全部节点）',
          },
        },
        required: ['strategy'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trigger_generation',
      description: '为画布上的图片或视频草稿节点触发生成任务（将弹出确认卡片由用户点击确认）。',
      parameters: {
        type: 'object',
        properties: {
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            description: '要触发生成的节点 ID 列表',
          },
          prompt: { type: 'string', description: '可选的临时覆盖提示词' },
        },
        required: ['nodeIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_canvas',
      description: '主动检查和探测画布当前的局部或全局状态（节点坐标、连线关系、提示词等），用于校验和自愈纠错。',
      parameters: {
        type: 'object',
        properties: {
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            description: '待检查的节点 ID 列表（可选，为空则检查整个画布）',
          },
          checkCollisions: {
            type: 'boolean',
            description: '是否检测节点之间的空间碰撞与重叠，默认为 true',
          },
        },
      },
    },
  },
] as const
