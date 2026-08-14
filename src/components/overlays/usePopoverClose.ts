import { useEffect, type RefObject } from 'react'

import { useEscapeClose } from './useEscapeClose'

export function usePopoverClose(
  open: boolean,
  onClose: () => void,
  surfaceRef: RefObject<HTMLElement | null>,
) {
  useEscapeClose(open, onClose)

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (surfaceRef.current?.contains(target)) return
      if (target.closest('[data-popup-trigger="true"]')) return
      onClose()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [onClose, open, surfaceRef])
}
