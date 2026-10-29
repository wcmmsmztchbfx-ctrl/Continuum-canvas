import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { WorkspaceSyncService } from '../../persistence/workspaceSyncState'
import './workspace-sync-status.css'

export interface WorkspaceSyncStatusProps {
  service: WorkspaceSyncService
  reloadPage?: () => void
}

const phaseLabels = {
  saving: '保存中',
  synced: '已同步',
  pending: '已保存到本地，等待同步',
  conflict: '存在冲突',
  error: '保存失败',
}

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
  reloadPage = () => window.location.reload(),
}: WorkspaceSyncStatusProps) {
  const subscribe = useCallback((listener: () => void) => service.subscribe(listener), [service])
  const getState = useCallback(() => service.getState(), [service])
  const state = useSyncExternalStore(subscribe, getState)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const lifecycle = useRef(0)
  const running = useRef(false)

  useEffect(() => {
    lifecycle.current += 1
    running.current = false
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
  const needsAttention = state.phase === 'pending' || state.phase === 'conflict' || state.phase === 'error'

  return (
    <aside aria-label="工作区保存状态" className="workspace-sync-status" data-phase={state.phase}>
      <div role="status" aria-live="polite" aria-atomic="true">
        <span>{phaseLabels[state.phase]}</span>
        {state.pendingCount > 0 && <span className="workspace-sync-status__count">{state.pendingCount} 项待同步</span>}
        {state.message && <p className="workspace-sync-status__message">{state.message}</p>}
      </div>
      {needsAttention && (
        <div className="workspace-sync-status__actions">
          {state.phase === 'conflict' ? (
            <>
              <button disabled={busy} onClick={() => resolveConflict('copy')} type="button">保留为副本</button>
              <button disabled={busy} onClick={() => resolveConflict('reload')} type="button">重新载入服务器版本</button>
            </>
          ) : (
            <button disabled={busy} onClick={() => { void perform(() => service.retry()) }} type="button">重试同步</button>
          )}
          <button disabled={busy} onClick={() => { void perform(() => service.exportRecovery(), downloadRecovery) }} type="button">导出本地恢复文件</button>
        </div>
      )}
      {needsAttention && actionError && <p className="workspace-sync-status__message" role="alert">{actionError}</p>}
    </aside>
  )
}
