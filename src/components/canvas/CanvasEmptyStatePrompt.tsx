import type { MouseEvent } from 'react'

export interface CanvasEmptyStatePromptProps {
  onOpenAddMenu?: (position: { x: number; y: number }) => void
}

export function CanvasEmptyStatePrompt({ onOpenAddMenu }: CanvasEmptyStatePromptProps) {
  const handleClick = (event: MouseEvent) => {
    event.stopPropagation()
    onOpenAddMenu?.({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })
  }

  return (
    <div
      className="canvas-empty-state-prompt"
      data-testid="canvas-empty-state-prompt"
      onClick={handleClick}
      role="region"
      aria-label="空白画布操作提示"
    >
      <div className="canvas-empty-state-prompt__graphic" aria-hidden="true">
        <svg
          className="canvas-empty-state-prompt__mouse-svg"
          width="44"
          height="44"
          viewBox="0 0 44 44"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect
            x="12"
            y="8"
            width="20"
            height="28"
            rx="10"
            stroke="currentColor"
            strokeWidth="1.75"
            className="canvas-empty-state-prompt__mouse-body"
          />
          <line
            x1="22"
            y1="8"
            x2="22"
            y2="20"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            className="canvas-empty-state-prompt__mouse-divider"
          />
          <path
            d="M13.5 14.5C13.5 11.2 16 8.5 19.5 8.5"
            stroke="#38bdf8"
            strokeWidth="2"
            strokeLinecap="round"
            className="canvas-empty-state-prompt__click-accent"
          />
          <circle
            cx="16"
            cy="12"
            r="6"
            stroke="#38bdf8"
            strokeWidth="1.2"
            strokeDasharray="2.5 2.5"
            className="canvas-empty-state-prompt__ripple-1"
          />
          <circle
            cx="16"
            cy="12"
            r="10"
            stroke="#38bdf8"
            strokeWidth="1"
            opacity="0.4"
            className="canvas-empty-state-prompt__ripple-2"
          />
        </svg>
      </div>

      <div className="canvas-empty-state-prompt__content">
        <h3 className="canvas-empty-state-prompt__title">
          双击空白处创建节点
        </h3>
        <p className="canvas-empty-state-prompt__subtitle">
          或从下方工具栏选择 · 拖入媒体文件
        </p>
      </div>
    </div>
  )
}
