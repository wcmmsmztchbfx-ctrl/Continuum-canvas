import { Pencil } from 'lucide-react'

import { DialogFrame } from './primitives'
import type { ControlledOverlayProps } from './primitives'

export interface RenameProjectDialogProps extends ControlledOverlayProps {
  name: string
  onNameChange: (name: string) => void
  onRename: () => void
}

export function RenameProjectDialog({
  name,
  onClose,
  onNameChange,
  onRename,
  open,
}: RenameProjectDialogProps) {
  return (
    <DialogFrame
      className="rename-project-dialog"
      closeLabel="关闭重命名"
      onClose={onClose}
      open={open}
      title="重命名项目"
    >
      <div className="overlay-dialog__body">
        <label className="overlay-field" htmlFor="rename-project-name">
          <span>项目名称</span>
          <input
            className="overlay-input"
            id="rename-project-name"
            maxLength={60}
            onChange={(event) => onNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && name.trim()) onRename()
            }}
            placeholder="输入项目名称"
            value={name}
          />
        </label>
      </div>
      <footer className="overlay-dialog__footer">
        <button className="overlay-text-button" onClick={onClose} type="button">
          取消
        </button>
        <button
          className="overlay-primary-button"
          disabled={!name.trim()}
          onClick={onRename}
          type="button"
        >
          <Pencil aria-hidden="true" focusable="false" />
          保存名称
        </button>
      </footer>
    </DialogFrame>
  )
}
