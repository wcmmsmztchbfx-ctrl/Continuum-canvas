import { Globe2, Link2, LockKeyhole, Rocket } from 'lucide-react'

import { DialogFrame } from './primitives'
import type { ControlledOverlayProps } from './primitives'

export type PublishVisibility = 'public' | 'unlisted' | 'private'

export interface PublishDialogProps extends ControlledOverlayProps {
  description?: string
  onDescriptionChange?: (description: string) => void
  onPublish?: () => void
  onVisibilityChange?: (visibility: PublishVisibility) => void
  projectTitle?: string
  visibility?: PublishVisibility
}

const visibilityOptions = [
  { icon: Globe2, label: '公开', value: 'public' },
  { icon: Link2, label: '不公开列出', value: 'unlisted' },
  { icon: LockKeyhole, label: '私密', value: 'private' },
] as const

export function PublishDialog({
  description = '',
  onClose,
  onDescriptionChange,
  onPublish,
  onVisibilityChange,
  open,
  projectTitle = '未命名项目',
  visibility = 'public',
}: PublishDialogProps) {
  return (
    <DialogFrame
      className="publish-dialog"
      closeLabel="关闭发布"
      onClose={onClose}
      open={open}
      title="发布项目"
    >
      <div className="overlay-dialog__body">
        <label className="overlay-field" htmlFor="publish-project-title">
          <span>项目名称</span>
          <input
            className="overlay-input"
            id="publish-project-title"
            readOnly
            value={projectTitle}
          />
        </label>

        <label className="overlay-field" htmlFor="publish-description">
          <span>项目简介</span>
          <textarea
            className="overlay-input publish-dialog__description"
            id="publish-description"
            onChange={(event) => onDescriptionChange?.(event.target.value)}
            placeholder="添加一段简短介绍"
            readOnly={!onDescriptionChange}
            rows={3}
            value={description}
          />
        </label>

        <div className="overlay-field">
          <span>可见范围</span>
          <div
            aria-label="发布可见范围"
            className="publish-dialog__visibility"
            role="radiogroup"
          >
            {visibilityOptions.map((option) => {
              const Icon = option.icon
              return (
                <button
                  aria-checked={visibility === option.value}
                  key={option.value}
                  onClick={() => onVisibilityChange?.(option.value)}
                  role="radio"
                  type="button"
                >
                  <Icon aria-hidden="true" focusable="false" />
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <footer className="overlay-dialog__footer">
        <button className="overlay-text-button" onClick={onClose} type="button">
          取消
        </button>
        <button
          className="overlay-primary-button"
          onClick={onPublish}
          type="button"
        >
          <Rocket aria-hidden="true" focusable="false" />
          确认发布
        </button>
      </footer>
    </DialogFrame>
  )
}

