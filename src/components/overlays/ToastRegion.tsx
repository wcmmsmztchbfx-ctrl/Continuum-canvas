/* eslint-disable react-refresh/only-export-components */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, Info, TriangleAlert, X } from 'lucide-react'

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

export interface OverlayToast {
  id: string
  message: string
  tone?: ToastTone
}

export interface ToastRegionProps {
  onDismiss?: (id: string) => void
  toasts: ReadonlyArray<OverlayToast>
}

const toastDurations: Record<Exclude<ToastTone, 'error'>, number> = {
  info: 2_500,
  success: 2_500,
  warning: 4_000,
}

function limitToastQueue(toasts: OverlayToast[]): OverlayToast[] {
  if (toasts.length <= 3) return toasts
  const oldestTransient = toasts.findIndex((toast) => (toast.tone ?? 'info') !== 'error')
  if (oldestTransient >= 0) {
    return toasts.filter((_, index) => index !== oldestTransient)
  }
  // Three persistent errors already occupy the queue. A transient is less
  // important and is dropped; a newer error replaces the oldest error.
  return (toasts.at(-1)?.tone ?? 'info') === 'error' ? toasts.slice(1) : toasts.slice(0, 3)
}

export interface ToastQueue {
  dismiss: (id: string) => void
  notify: (message: string, tone?: ToastTone) => void
  toasts: OverlayToast[]
}

export function useToastQueue(): ToastQueue {
  const [toasts, setToasts] = useState<OverlayToast[]>([])
  const toastsRef = useRef<OverlayToast[]>([])
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const commit = useCallback((next: OverlayToast[]) => {
    toastsRef.current = next
    setToasts(next)
  }, [])

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer) clearTimeout(timer)
    timersRef.current.delete(id)
    commit(toastsRef.current.filter((toast) => toast.id !== id))
  }, [commit])

  const schedule = useCallback((toast: OverlayToast) => {
    const existing = timersRef.current.get(toast.id)
    if (existing) clearTimeout(existing)
    const tone = toast.tone ?? 'info'
    if (tone === 'error') {
      timersRef.current.delete(toast.id)
      return
    }
    timersRef.current.set(toast.id, setTimeout(() => {
      timersRef.current.delete(toast.id)
      commit(toastsRef.current.filter((candidate) => candidate.id !== toast.id))
    }, toastDurations[tone]))
  }, [commit])

  const notify = useCallback((message: string, tone: ToastTone = 'success') => {
    const normalized = message.trim()
    if (!normalized) return
    const duplicate = toastsRef.current.find(
      (toast) => toast.message === normalized && (toast.tone ?? 'info') === tone,
    )
    if (duplicate) {
      const next = [
        ...toastsRef.current.filter((toast) => toast.id !== duplicate.id),
        duplicate,
      ]
      commit(next)
      schedule(duplicate)
      return
    }

    const toast: OverlayToast = {
      id: globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      message: normalized,
      tone,
    }
    const overflow = limitToastQueue([...toastsRef.current, toast])
    const retained = new Set(overflow.map((candidate) => candidate.id))
    for (const candidate of toastsRef.current) {
      if (retained.has(candidate.id)) continue
      const timer = timersRef.current.get(candidate.id)
      if (timer) clearTimeout(timer)
      timersRef.current.delete(candidate.id)
    }
    commit(overflow)
    if (retained.has(toast.id)) schedule(toast)
  }, [commit, schedule])

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer)
    timersRef.current.clear()
  }, [])

  return { dismiss, notify, toasts }
}

const toneIcons = {
  error: CircleAlert,
  info: Info,
  success: Check,
  warning: TriangleAlert,
} as const

export function ToastRegion({ onDismiss, toasts }: ToastRegionProps) {
  return (
    <section aria-label="通知" className="toast-region" role="region">
      {toasts.map((toast) => {
        const tone = toast.tone ?? 'info'
        const Icon = toneIcons[tone]

        return (
          <div
            className={`overlay-surface overlay-toast overlay-toast--${tone}`}
            key={toast.id}
            role={tone === 'error' ? 'alert' : 'status'}
          >
            <Icon aria-hidden="true" focusable="false" />
            <span>{toast.message}</span>
            <button
              aria-label={`关闭：${toast.message}`}
              onClick={() => onDismiss?.(toast.id)}
              title="关闭通知"
              type="button"
            >
              <X aria-hidden="true" focusable="false" />
            </button>
          </div>
        )
      })}
    </section>
  )
}
