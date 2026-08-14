import { Bot } from 'lucide-react'

export interface AgentButtonProps {
  label?: string
  onClick?: () => void
}

export function AgentButton({ label = 'Agent', onClick }: AgentButtonProps) {
  return (
    <button
      aria-label={`打开 ${label}`}
      className="shell-icon-button agent-button"
      data-tooltip={label}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Bot aria-hidden="true" focusable="false" />
      <span>{label}</span>
    </button>
  )
}
