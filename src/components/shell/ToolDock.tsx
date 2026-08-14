import {
  Frame, ImagePlus, MousePointer2, MoreHorizontal,
  PenTool, Pencil, Redo2, Shapes, Type, Undo2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { IconButton } from './IconButton'

export type ToolDockTool =
  | 'select' | 'frame' | 'shape' | 'pen' | 'text' | 'brush'
  | 'upload' | 'undo' | 'redo' | 'more'

export interface ToolDockProps {
  activeTool?: ToolDockTool
  onToolSelect?: (tool: ToolDockTool) => void
}

const tools: Array<{ icon: LucideIcon; id: ToolDockTool; label: string }> = [
  { icon: MousePointer2, id: 'select', label: '选择 V' },
  { icon: Frame, id: 'frame', label: '画框 F' },
  { icon: Shapes, id: 'shape', label: '图形 R' },
  { icon: PenTool, id: 'pen', label: '钢笔 P' },
  { icon: Type, id: 'text', label: '文字 T' },
  { icon: Pencil, id: 'brush', label: '画笔 B' },
  { icon: ImagePlus, id: 'upload', label: '上传媒体 U' },
  { icon: Undo2, id: 'undo', label: '撤销 Ctrl+Z' },
  { icon: Redo2, id: 'redo', label: '重做 Ctrl+Shift+Z' },
  { icon: MoreHorizontal, id: 'more', label: '更多画布选项' },
]

export function ToolDock({ activeTool = 'select', onToolSelect }: ToolDockProps) {
  return <nav aria-label="创作工具" className="tool-dock" data-testid="tool-dock" role="toolbar">
    {tools.map(({ icon, id, label }, index) => <span className="tool-dock__item" key={id}>
      {(index === 6 || index === 7 || index === 9) ? <span aria-hidden="true" className="tool-dock__divider" /> : null}
      <IconButton
        className="tool-dock__button"
        icon={icon}
        label={label}
        onClick={() => onToolSelect?.(id)}
        pressed={['select', 'frame', 'shape', 'pen', 'text', 'brush'].includes(id) && activeTool === id}
      />
    </span>)}
  </nav>
}
