import { useRef, useCallback, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'

interface ScrubbableLabelProps {
  label: ReactNode
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  sensitivity?: number
  className?: string
  title?: string
}

export function ScrubbableLabel({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  sensitivity = 2,
  className = '',
  title = '按住并左右拖拽快速调节数值 (Shift 加速)',
}: ScrubbableLabelProps) {
  const isDraggingRef = useRef(false)
  const startXRef = useRef(0)
  const startValRef = useRef(value)
  const activeValueRef = useRef(value)
  activeValueRef.current = value

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      if (event.button !== 0) return // Only primary click
      event.preventDefault()
      event.stopPropagation()

      isDraggingRef.current = true
      startXRef.current = event.clientX
      startValRef.current = activeValueRef.current

      const target = event.currentTarget
      target.setPointerCapture(event.pointerId)
      document.body.style.cursor = 'ew-resize'
      document.body.style.userSelect = 'none'

      const onPointerMove = (moveEvent: PointerEvent) => {
        if (!isDraggingRef.current) return
        const deltaX = moveEvent.clientX - startXRef.current
        const multiplier = moveEvent.shiftKey ? 10 : moveEvent.altKey ? 0.1 : 1
        const deltaValue = Math.round(deltaX / sensitivity) * step * multiplier
        let nextValue = startValRef.current + deltaValue

        if (min !== undefined) nextValue = Math.max(min, nextValue)
        if (max !== undefined) nextValue = Math.min(max, nextValue)

        // Handle step precision
        if (step < 1) {
          const precision = step.toString().split('.')[1]?.length || 1
          nextValue = Number(nextValue.toFixed(precision))
        } else {
          nextValue = Math.round(nextValue)
        }

        onChange(nextValue)
      }

      const onPointerUp = (upEvent: PointerEvent) => {
        isDraggingRef.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        try {
          target.releasePointerCapture(upEvent.pointerId)
        } catch {
          // Ignored if pointer was lost
        }
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerUp)
        window.removeEventListener('pointercancel', onPointerUp)
      }

      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerUp)
    },
    [max, min, onChange, sensitivity, step],
  )

  return (
    <span
      className={`inspector-field__label inspector-field__label--scrubbable ${className}`}
      onPointerDown={handlePointerDown}
      title={title}
    >
      {label}
    </span>
  )
}
