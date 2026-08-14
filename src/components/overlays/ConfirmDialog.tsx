import { AlertTriangle } from 'lucide-react'

import { DialogFrame } from './primitives'
import type { ControlledOverlayProps } from './primitives'

export interface ConfirmDialogProps extends ControlledOverlayProps {
  confirmLabel: string
  message: string
  onConfirm: () => void
  title: string
}

export function ConfirmDialog({
  confirmLabel,
  message,
  onClose,
  onConfirm,
  open,
  title,
}: ConfirmDialogProps) {
  return (
    <DialogFrame
      className="confirm-dialog"
      closeLabel="关闭确认"
      onClose={onClose}
      open={open}
      title={title}
    >
      <div className="overlay-dialog__body confirm-dialog__body">
        <AlertTriangle aria-hidden="true" focusable="false" />
        <p>{message}</p>
      </div>
      <footer className="overlay-dialog__footer">
        <button className="overlay-text-button" onClick={onClose} type="button">
          取消
        </button>
        <button
          aria-label={`确认${confirmLabel}`}
          className="overlay-danger-button"
          onClick={onConfirm}
          type="button"
        >
          {confirmLabel}
        </button>
      </footer>
    </DialogFrame>
  )
}
