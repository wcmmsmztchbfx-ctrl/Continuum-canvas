import { DialogFrame } from './primitives'
import type { ControlledOverlayProps } from './primitives'

export interface KeyboardShortcut {
  action: string
  keys: string
}

export interface KeyboardShortcutsDialogProps extends ControlledOverlayProps {
  shortcuts?: ReadonlyArray<KeyboardShortcut>
}

const defaultShortcuts: ReadonlyArray<KeyboardShortcut> = [
  { action: '选择工具', keys: 'V' },
  { action: '画框工具', keys: 'F' },
  { action: '图形工具', keys: 'R' },
  { action: '钢笔工具', keys: 'P' },
  { action: '文本工具', keys: 'T' },
  { action: '画笔工具', keys: 'B' },
  { action: '上传媒体', keys: 'U' },
  { action: '撤销', keys: 'Ctrl Z' },
  { action: '重做', keys: 'Ctrl Shift Z' },
  { action: '复制', keys: 'Ctrl C' },
  { action: '粘贴', keys: 'Ctrl V' },
  { action: '全选', keys: 'Ctrl A' },
  { action: '编组 / 解组', keys: 'Ctrl G / Ctrl Shift G' },
  { action: '删除所选', keys: 'Delete' },
  { action: '适应画布', keys: 'Shift 1' },
  { action: '矢量编辑模式', keys: '双击路径 / Esc' },
  { action: '关闭面板', keys: 'Esc' },
]

export function KeyboardShortcutsDialog({
  onClose,
  open,
  shortcuts = defaultShortcuts,
}: KeyboardShortcutsDialogProps) {
  return (
    <DialogFrame
      className="keyboard-shortcuts-dialog"
      closeLabel="关闭键盘快捷键"
      onClose={onClose}
      open={open}
      title="键盘快捷键"
    >
      <div className="keyboard-shortcuts-dialog__list">
        {shortcuts.map((shortcut) => (
          <div className="keyboard-shortcuts-dialog__row" key={shortcut.action}>
            <span>{shortcut.action}</span>
            <kbd>{shortcut.keys}</kbd>
          </div>
        ))}
      </div>
    </DialogFrame>
  )
}

