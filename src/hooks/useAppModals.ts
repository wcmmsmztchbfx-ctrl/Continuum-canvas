import { useState, useCallback } from 'react'

export type AppPopup =
  | 'workspace'
  | 'add'
  | 'api-integration'
  | 'collaboration'
  | 'help'
  | null

export type AppDialog = 'publish' | 'shortcuts' | 'delete' | 'rename' | null
export type AppContextMenu = 'blank' | 'node' | null

export function useAppModals() {
  const [popup, setPopup] = useState<AppPopup>(null)
  const [dialog, setDialog] = useState<AppDialog>(null)
  const [contextMenu, setContextMenu] = useState<AppContextMenu>(null)

  const togglePopup = useCallback((target: AppPopup) => {
    setPopup((current) => (current === target ? null : target))
    setContextMenu(null)
  }, [])

  const closePopup = useCallback(() => {
    setPopup(null)
  }, [])

  const closeAllOverlays = useCallback(() => {
    setPopup(null)
    setContextMenu(null)
  }, [])

  return {
    popup,
    setPopup,
    togglePopup,
    closePopup,
    dialog,
    setDialog,
    contextMenu,
    setContextMenu,
    closeAllOverlays,
  }
}
