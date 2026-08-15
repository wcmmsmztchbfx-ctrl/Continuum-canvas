import {
  Bot,
  Compass,
  Layers,
  Palette,
  Send,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { useState } from 'react'

export interface AgentSidebarPanelProps {
  onNotify?: (message: string, tone?: 'info' | 'success' | 'error') => void
}

const SUGGESTED_TASKS = [
  {
    icon: Wand2,
    title: '自动排版画布',
    desc: '根据故事线或节点类型自动整理并对齐画布节点',
  },
  {
    icon: Palette,
    title: '统一场景色彩',
    desc: '分析并对齐当前分镜画面的光影与色调风格',
  },
  {
    icon: Layers,
    title: '提取角色资产',
    desc: '从现有生成图片中识别主要人物并建立角色资产卡',
  },
  {
    icon: Compass,
    title: '镜头语言推导',
    desc: '基于剧本文本自动推导全景、特写与运镜提示词',
  },
]

export function AgentSidebarPanel({ onNotify }: AgentSidebarPanelProps) {
  const [prompt, setPrompt] = useState('')

  const handleSend = () => {
    if (!prompt.trim()) return
    onNotify?.('Agent 助手正在研发中，敬请期待！', 'info')
    setPrompt('')
  }

  return (
    <div aria-label="Agent 智能助手" className="sidebar-agent-panel">
      {/* Top Title */}
      <div className="sidebar-agent-panel__top">
        <div className="sidebar-agent-panel__title-group">
          <Bot size={15} style={{ color: '#0d99ff' }} />
          <strong>Agent 智能助手</strong>
        </div>
        <span className="sidebar-agent-panel__badge">Beta 预览</span>
      </div>

      {/* Intro Banner */}
      <div className="sidebar-agent-panel__banner">
        <Sparkles size={16} style={{ color: '#0d99ff', flexShrink: 0 }} />
        <p>AI 协作 Agent，可理解全画布内容并协助进行创意发散与自动化编排。</p>
      </div>

      {/* Suggested Tasks */}
      <div className="sidebar-agent-panel__section">
        <span className="sidebar-agent-panel__section-title">推荐协作指令</span>
        <div className="sidebar-agent-panel__tasks">
          {SUGGESTED_TASKS.map((task) => {
            const Icon = task.icon
            return (
              <button
                className="sidebar-agent-panel__task-card"
                key={task.title}
                onClick={() => {
                  setPrompt(task.title)
                  onNotify?.(`已选择指令：「${task.title}」（Agent 助手正在研发中）`, 'info')
                }}
                type="button"
              >
                <div className="sidebar-agent-panel__task-icon">
                  <Icon size={14} />
                </div>
                <div className="sidebar-agent-panel__task-info">
                  <strong>{task.title}</strong>
                  <p>{task.desc}</p>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Input Shell */}
      <div className="sidebar-agent-panel__input-container">
        <textarea
          className="sidebar-agent-panel__textarea"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder="向 Agent 发送指令或提问..."
          rows={2}
          value={prompt}
        />
        <div className="sidebar-agent-panel__input-footer">
          <small>Enter 发送，Shift+Enter 换行</small>
          <button
            aria-label="发送"
            className="sidebar-agent-panel__send-btn"
            disabled={!prompt.trim()}
            onClick={handleSend}
            type="button"
          >
            <Send size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}
