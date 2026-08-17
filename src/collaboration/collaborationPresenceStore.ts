import { useEffect, useState } from 'react'
import type { PresenceState } from '../contracts/collaboration'

type PresenceListener = (presence: readonly PresenceState[]) => void

class CollaborationPresenceStore {
  private presence: readonly PresenceState[] = []
  private listeners = new Set<PresenceListener>()

  getPresence(): readonly PresenceState[] {
    return this.presence
  }

  setPresence(next: readonly PresenceState[]): void {
    this.presence = next
    for (const listener of this.listeners) {
      try {
        listener(next)
      } catch {
        // Prevent listener exception from breaking notifications
      }
    }
  }

  subscribe(listener: PresenceListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  clear(): void {
    this.setPresence([])
  }
}

export const collaborationPresenceStore = new CollaborationPresenceStore()

export function useCollaborationPresence(): readonly PresenceState[] {
  const [presence, setPresence] = useState<readonly PresenceState[]>(() =>
    collaborationPresenceStore.getPresence(),
  )

  useEffect(() => {
    setPresence(collaborationPresenceStore.getPresence())
    return collaborationPresenceStore.subscribe(setPresence)
  }, [])

  return presence
}
