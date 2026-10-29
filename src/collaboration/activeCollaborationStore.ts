import { useEffect, useState } from 'react'

export interface ActiveCollaboration {
  roomId: string
  projectId: string
  canvasId: string
  canvasName: string
  role: 'owner' | 'editor' | 'viewer'
  status: 'active' | 'closed'
  createdAt: string
  memberCount?: number
}

const STORAGE_KEY = 'libtv.active-collaboration.v1'

const listeners = new Set<(collab: ActiveCollaboration | null) => void>()

export function getActiveCollaboration(): ActiveCollaboration | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ActiveCollaboration
    if (parsed && typeof parsed === 'object' && parsed.roomId && parsed.canvasId && parsed.status === 'active') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export function setActiveCollaboration(collab: ActiveCollaboration | null): void {
  try {
    if (collab && collab.status === 'active') {
      globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(collab))
    } else {
      globalThis.sessionStorage?.removeItem(STORAGE_KEY)
    }
  } catch {
    // Ignore storage errors
  }
  const current = getActiveCollaboration()
  listeners.forEach((listener) => listener(current))
}

export function clearActiveCollaboration(): void {
  setActiveCollaboration(null)
}

export function subscribeActiveCollaboration(
  listener: (collab: ActiveCollaboration | null) => void,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useActiveCollaboration(): ActiveCollaboration | null {
  const [collab, setCollab] = useState<ActiveCollaboration | null>(getActiveCollaboration)

  useEffect(() => {
    setCollab(getActiveCollaboration())
    const unsubscribe = subscribeActiveCollaboration((next) => {
      setCollab(next)
    })
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setCollab(getActiveCollaboration())
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => {
      unsubscribe()
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  return collab
}
