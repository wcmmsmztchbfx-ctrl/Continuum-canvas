import type { LucideIcon } from 'lucide-react'

export interface TopBarFeatureButtonProps {
  className: string
  disabled?: boolean
  icon: LucideIcon
  id: string
  label: string
  onClick?: () => void
}

export function TopBarFeatureButton({
  className,
  disabled,
  icon: Icon,
  id,
  label,
  onClick,
}: TopBarFeatureButtonProps) {
  return (
    <button
      aria-label={`打开${/^[A-Za-z]/.test(label) ? ' ' : ''}${label}`}
      className={`shell-icon-button topbar-feature-button ${className}`}
      data-popup-trigger="true"
      data-tooltip={label}
      disabled={disabled}
      id={id}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon aria-hidden="true" focusable="false" />
      <span>{label}</span>
    </button>
  )
}
