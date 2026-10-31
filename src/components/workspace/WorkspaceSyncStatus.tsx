import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceSyncService } from '../../persistence/workspaceSyncState'
import './workspace-sync-status.css'

export interface WorkspaceSyncStatusProps {
  service: WorkspaceSyncService
  host?: HTMLElement | null
  reloadPage?: () => void
}

const phaseLabels = {
  saving: '保存中',
  synced: '已同步',
  pending: '已保存到本地，等待同步',
  conflict: '存在冲突',
  error: '保存失败',
}

const compactLabels = { ...phaseLabels, pending: '待同步', conflict: '保存冲突' }

function downloadRecovery(serialized: string) {
  const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'continuum-workspace-recovery.json'
  document.body.append(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

export function WorkspaceSyncStatus({
  service,
  host,
  reloadPage = () => window.location.reload(),
}: WorkspaceSyncStatusProps) {
  const subscribe = useCallback((listener: () => void) => service.subscribe(listener), [service])
  const getState = useCallback(() => service.getState(), [service])
  const state = useSyncExternalStore(subscribe, getState)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const lifecycle = useRef(0)
  const running = useRef(false)

  const [revealed, setRevealed] = useState(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const detailsId = useId()
  const needsAttention = state.phase === 'pending' || state.phase === 'conflict' || state.phase === 'error'
  const urgent = state.phase === 'conflict' || state.phase === 'error'
  // The backend also uses saving with an empty queue during initial hydration.
  const active = state.phase !== 'synced' && (state.phase !== 'saving' || state.pendingCount > 0)
  const visible = active && (revealed || urgent)
  const detailsOpen = open && visible

  useEffect(() => {
    if (!active) { setRevealed(false); setOpen(false); return }
    if (urgent) { setRevealed(true); return }
    // Coalesce transient pending -> saving -> synced updates. Once visible,
    // keep the indicator present through retries until the server confirms it.
    const timer = window.setTimeout(() => setRevealed(true), 300)
    return () => window.clearTimeout(timer)
  }, [active, urgent, service])

  useLayoutEffect(() => {
    if (!detailsOpen) return
    const place = () => {
      const bounds = trigger.current?.getBoundingClientRect()
      if (!bounds) return
      const width = panel.current?.getBoundingClientRect().width ?? 300
      setPosition({ top: bounds.bottom + 8, left: Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)) })
    }
    place()
    panel.current?.focus()
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape, true)
    }
  }, [detailsOpen, host])

  useEffect(() => {
    lifecycle.current += 1
    running.current = false
    setOpen(false)
    setBusy(false)
    setActionError(undefined)
    const stop = service.start()
    return () => {
      lifecycle.current += 1
      stop()
    }
  }, [service])

  useEffect(() => {
    if (state.phase === 'synced') setActionError(undefined)
  }, [state.phase])

  const perform = async <T,>(action: () => Promise<T>, complete?: (result: T) => void) => {
    if (running.current) return
    const generation = lifecycle.current
    running.current = true
    setBusy(true)
    setActionError(undefined)
    try {
      const result = await action()
      if (generation === lifecycle.current) complete?.(result)
    } catch (error) {
      if (generation === lifecycle.current) {
        setActionError(error instanceof Error ? error.message : '操作未完成，请重试')
      }
    } finally {
      if (generation === lifecycle.current) {
        running.current = false
        setBusy(false)
      }
    }
  }

  const resolveConflict = (choice: 'copy' | 'reload') => {
    if (choice === 'reload' && !window.confirm('重新载入服务器版本将覆盖本地未同步修改。建议先导出本地恢复文件。确定继续？')) return
    void perform(() => service.resolveConflict(choice), reloadPage)
  }
  const label = <><span aria-hidden="true" className="workspace-sync-status__dot" /><span>{compactLabels[state.phase]}</span></>
  const content = (
    <aside aria-label="工作区保存状态" className="workspace-sync-status" data-phase={state.phase} data-testid="workspace-sync-status" hidden={!visible}>
      <div role="status" aria-live="polite" aria-atomic="true">
        {needsAttention || detailsOpen ? (
          <button aria-label="查看保存详情" aria-expanded={detailsOpen} aria-controls={detailsId} aria-haspopup="dialog"
            className="workspace-sync-status__indicator" ref={trigger} title={phaseLabels[state.phase]}
            onClick={() => setOpen((value) => !value)} type="button">{label}</button>
        ) : <span className="workspace-sync-status__indicator">{label}</span>}
      </div>
      {detailsOpen && createPortal(
        <div aria-label="保存详情" className="workspace-sync-details" id={detailsId} ref={panel} role="dialog" style={position} tabIndex={-1}>
          <div className="workspace-sync-details__heading">
            <strong>{phaseLabels[state.phase]}</strong>
            <button aria-label="关闭保存详情" onClick={() => { setOpen(false); trigger.current?.focus() }} type="button">×</button>
          </div>
          {state.pendingCount > 0 && <p className="workspace-sync-status__count">{state.pendingCount} 项待同步</p>}
          {state.message && <p className="workspace-sync-status__message">{state.message}</p>}
          <div className="workspace-sync-status__actions">
            {state.phase === 'conflict' ? (
              <>
                <button disabled={busy} onClick={() => { void perform(() => service.retry()) }} type="button">重新检查同步</button>
                <button disabled={busy} onClick={() => resolveConflict('copy')} type="button">保留为副本</button>
                <button disabled={busy} onClick={() => resolveConflict('reload')} type="button">重新载入服务器版本</button>
              </>
            ) : (
              <button disabled={busy} onClick={() => { void perform(() => service.retry()) }} type="button">重试同步</button>
            )}
            <button disabled={busy} onClick={() => { void perform(() => service.exportRecovery(), downloadRecovery) }} type="button">导出本地恢复文件</button>
          </div>
          {actionError && <p className="workspace-sync-status__message" role="alert">{actionError}</p>}
        </div>, document.body,
      )}
    </aside>
  )
  if (host === null) return <div className="workspace-sync-fallback">{content}</div>
  return host ? createPortal(content, host) : content
}
