import { clsx } from 'clsx'
import { X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

import { useEscapeClose } from './useEscapeClose'

const focusableSelector =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => !element.hasAttribute('hidden'),
  )
}

export interface ControlledOverlayProps {
  onClose: () => void
  open: boolean
}

export interface OverlayPosition {
  x: number
  y: number
}

export interface MenuItemSpec<Action extends string> {
  action: Action
  danger?: boolean
  disabled?: boolean
  icon: LucideIcon
  label: string
  separatorBefore?: boolean
  shortcut?: string
}

interface ActionMenuProps<Action extends string>
  extends ControlledOverlayProps {
  className?: string
  items: ReadonlyArray<MenuItemSpec<Action>>
  label: string
  onAction: (action: Action) => void
  position?: OverlayPosition
}

export function ActionMenu<Action extends string>({
  className,
  items,
  label,
  onAction,
  onClose,
  open,
  position,
}: ActionMenuProps<Action>) {
  const menuRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [resolvedPosition, setResolvedPosition] = useState(position)
  useEscapeClose(open, onClose)

  useLayoutEffect(() => {
    if (!open || !position || !menuRef.current) return
    const margin = 8
    const bounds = menuRef.current.getBoundingClientRect()
    const next = {
      x: Math.max(margin, Math.min(position.x, window.innerWidth - bounds.width - margin)),
      y: Math.max(
        margin,
        Math.min(position.y, window.innerHeight - bounds.height - margin),
      ),
    }
    setResolvedPosition(next)
  }, [open, position])

  useEffect(() => {
    if (!open || !menuRef.current) return
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    focusableElements(menuRef.current)[0]?.focus()

    return () => {
      const previous = previousFocusRef.current
      if (previous?.isConnected) previous.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return
      }
      onClose()
    }
    document.addEventListener('click', closeOutside, true)
    return () => document.removeEventListener('click', closeOutside, true)
  }, [onClose, open])

  if (!open) return null

  const style: CSSProperties | undefined = resolvedPosition
    ? { left: resolvedPosition.x, top: resolvedPosition.y }
    : undefined

  return (
    <div
      aria-label={label}
      className={clsx('overlay-surface', 'overlay-menu', className)}
      role="menu"
      ref={menuRef}
      style={style}
      onKeyDown={(event) => {
        if (!menuRef.current) return
        const items = focusableElements(menuRef.current)
        const currentIndex = items.indexOf(document.activeElement as HTMLElement)
        let nextIndex: number | undefined
        if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length
        if (event.key === 'ArrowUp') {
          nextIndex = (currentIndex - 1 + items.length) % items.length
        }
        if (event.key === 'Home') nextIndex = 0
        if (event.key === 'End') nextIndex = items.length - 1
        if (nextIndex === undefined || items.length === 0) return
        event.preventDefault()
        items[nextIndex]?.focus()
      }}
    >
      {items.map((item) => {
        const Icon = item.icon

        return (
          <button
            aria-disabled={item.disabled || undefined}
            aria-label={item.label}
            className={clsx(
              'overlay-menu__item',
              item.danger && 'overlay-menu__item--danger',
              item.separatorBefore && 'overlay-menu__item--separated',
            )}
            disabled={item.disabled}
            key={item.action}
            onClick={() => {
              onAction(item.action)
              onClose()
            }}
            role="menuitem"
            type="button"
          >
            <Icon aria-hidden="true" focusable="false" />
            <span>{item.label}</span>
            {item.shortcut ? (
              <kbd className="overlay-menu__shortcut">{item.shortcut}</kbd>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

interface DialogFrameProps extends ControlledOverlayProps {
  children: ReactNode
  className?: string
  closeLabel: string
  title: string
}

export function DialogFrame({
  children,
  className,
  closeLabel,
  onClose,
  open,
  title,
}: DialogFrameProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  useEscapeClose(open, onClose)

  useEffect(() => {
    if (!open || !dialogRef.current) return
    const dialog = dialogRef.current
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const initialFocus =
      dialog.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)') ??
      focusableElements(dialog)[0]
    initialFocus?.focus()

    const keepFocusInside = (event: FocusEvent) => {
      if (event.target instanceof Node && dialog.contains(event.target)) return
      initialFocus?.focus()
    }
    document.addEventListener('focusin', keepFocusInside)

    return () => {
      document.removeEventListener('focusin', keepFocusInside)
      const previous = previousFocusRef.current
      if (previous?.isConnected) previous.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="overlay-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={clsx('overlay-surface', 'overlay-dialog', className)}
        onKeyDownCapture={(event) => {
          if (event.key !== 'Tab' || !dialogRef.current) return
          const items = focusableElements(dialogRef.current)
          if (items.length === 0) return
          const first = items[0]!
          const last = items.at(-1)!
          const active = document.activeElement
          if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && active === last) {
            event.preventDefault()
            first.focus()
          }
        }}
        ref={dialogRef}
        role="dialog"
      >
        <header className="overlay-dialog__header">
          <h2 id={titleId}>{title}</h2>
          <button
            aria-label={closeLabel}
            className="overlay-icon-button"
            onClick={onClose}
            title={closeLabel}
            type="button"
          >
            <X aria-hidden="true" focusable="false" />
          </button>
        </header>
        {children}
      </section>
    </div>
  )
}
