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
  { action: '撤销', keys: 'Ctrl Z' },
  { action: '重做', keys: 'Ctrl Shift Z' },
  { action: '复制', keys: 'Ctrl C' },
  { action: '粘贴', keys: 'Ctrl V' },
  { action: '全选', keys: 'Ctrl A' },
  { action: '删除所选', keys: 'Delete' },
  { action: '适应画布', keys: 'Shift 1' },
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

