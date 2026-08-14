import { clsx } from 'clsx'
import type { ButtonHTMLAttributes } from 'react'
import type { LucideIcon } from 'lucide-react'

interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  icon: LucideIcon
  label: string
  pressed?: boolean
}

export function IconButton({
  className,
  icon: Icon,
  label,
  pressed,
  type = 'button',
  ...buttonProps
}: IconButtonProps) {
  return (
    <button
      {...buttonProps}
      aria-label={label}
      aria-pressed={pressed}
      className={clsx('shell-icon-button', className)}
      data-tooltip={label}
      title={label}
      type={type}
    >
      <Icon aria-hidden="true" focusable="false" />
    </button>
  )
}
