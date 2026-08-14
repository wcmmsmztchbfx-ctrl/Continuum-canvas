import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

import { placeFloatingRect } from './floatingGeometry'

interface FloatingChoiceMenuProps {
  anchor: HTMLElement | null
  ariaLabel: string
  children: ReactNode
  className: string
  menuRef: RefObject<HTMLDivElement | null>
  onKeyDown: KeyboardEventHandler<HTMLDivElement>
  portalRoot?: Element | DocumentFragment | null
}

export function FloatingChoiceMenu({
  anchor,
  ariaLabel,
  children,
  className,
  menuRef,
  onKeyDown,
  portalRoot,
}: FloatingChoiceMenuProps) {
  const [position, setPosition] = useState<CSSProperties>({
    bottom: 'auto',
    left: 8,
    position: 'fixed',
    top: 70,
  })

  useEffect(() => {
    let frame = 0
    const update = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const anchorBounds = anchor?.getBoundingClientRect()
        if (!anchorBounds) return
        const menuBounds = menuRef.current?.getBoundingClientRect()
        const placement = placeFloatingRect({
          anchor: anchorBounds,
          floating: {
            width: menuBounds?.width || 224,
            height: menuBounds?.height || 180,
          },
          preferred: 'above',
          viewport: { width: window.innerWidth, height: window.innerHeight },
        })
        setPosition((prev) => (prev.left === placement.left && prev.top === placement.top ? prev : {
          bottom: 'auto',
          left: placement.left,
          position: 'fixed',
          top: placement.top,
        }))
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const flowViewport = anchor
      ?.closest('.react-flow')
      ?.querySelector('.react-flow__viewport')
    const observer = flowViewport && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(update)
      : undefined
    if (flowViewport) observer?.observe(flowViewport, {
      attributeFilter: ['style'],
      attributes: true,
    })
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor, menuRef])

  const menu = (
    <div
      aria-label={ariaLabel}
      className={className}
      onKeyDown={onKeyDown}
      ref={menuRef}
      role="menu"
      style={position}
    >
      {children}
    </div>
  )

  return typeof document === 'undefined'
    ? menu
    : createPortal(menu, portalRoot ?? document.body)
}
