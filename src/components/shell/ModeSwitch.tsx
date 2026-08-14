import { PanelsTopLeft, Workflow } from 'lucide-react'

export type ShellMode = 'workflow' | 'storyboard'

export interface ModeSwitchProps {
  onChange?: (mode: ShellMode) => void
  value: ShellMode
}

export function ModeSwitch({ onChange, value }: ModeSwitchProps) {
  return (
    <div aria-label="视图模式" className="mode-switch" role="group">
      <button
        aria-label="工作流"
        aria-pressed={value === 'workflow'}
        className="mode-switch__option"
        data-tooltip="工作流"
        onClick={() => onChange?.('workflow')}
        title="工作流"
        type="button"
      >
        <Workflow aria-hidden="true" focusable="false" />
        <span>工作流</span>
      </button>
      <button
        aria-label="故事板"
        aria-pressed={value === 'storyboard'}
        className="mode-switch__option"
        data-tooltip="故事板"
        onClick={() => onChange?.('storyboard')}
        title="故事板"
        type="button"
      >
        <PanelsTopLeft aria-hidden="true" focusable="false" />
        <span>故事板</span>
      </button>
    </div>
  )
}
