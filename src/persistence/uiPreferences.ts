export const UI_PREFERENCES_STORAGE_KEY = 'libtv.ui-preferences.v1'
export const DEFAULT_LAYERS_WIDTH = 240
export const MIN_LAYERS_WIDTH = 220
export const MAX_LAYERS_WIDTH = 4096

export const DEFAULT_INSPECTOR_WIDTH = 280
export const MIN_INSPECTOR_WIDTH = 220
export const MAX_INSPECTOR_WIDTH = 560

export interface UiPreferences {
  hideConnections: boolean
  snapToGrid: boolean
  smartSnap: boolean
  showMiniMap: boolean
  lastOpenPanel: string | null
  showZoom: boolean
  layersOpen: boolean
  layersWidth: number
  inspectorWidth?: number
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_UI_PREFERENCES: Readonly<UiPreferences> = Object.freeze({
  hideConnections: false,
  snapToGrid: false,
  smartSnap: true,
  showMiniMap: false,
  lastOpenPanel: null,
  showZoom: true,
  layersOpen: false,
  layersWidth: DEFAULT_LAYERS_WIDTH,
})

export function normalizeLayersWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_LAYERS_WIDTH
  }
  return Math.min(MAX_LAYERS_WIDTH, Math.max(MIN_LAYERS_WIDTH, Math.round(value)))
}

export function normalizeInspectorWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_INSPECTOR_WIDTH
  }
  return Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, Math.round(value)))
}

function defaults(): UiPreferences {
  return { ...DEFAULT_UI_PREFERENCES }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function normalizePreferences(value: unknown): UiPreferences {
  const result = defaults()
  if (!isRecord(value)) {
    return result
  }

  if (typeof value.hideConnections === 'boolean') {
    result.hideConnections = value.hideConnections
  }
  if (typeof value.snapToGrid === 'boolean') {
    result.snapToGrid = value.snapToGrid
  }
  if (typeof value.smartSnap === 'boolean') result.smartSnap = value.smartSnap
  if (typeof value.showMiniMap === 'boolean') {
    result.showMiniMap = value.showMiniMap
  }
  if (typeof value.lastOpenPanel === 'string' || value.lastOpenPanel === null) {
    result.lastOpenPanel = value.lastOpenPanel
  }
  if (typeof value.showZoom === 'boolean') {
    result.showZoom = value.showZoom
  }
  if (typeof value.layersOpen === 'boolean') result.layersOpen = value.layersOpen
  result.layersWidth = normalizeLayersWidth(value.layersWidth)
  if (typeof value.inspectorWidth === 'number') {
    result.inspectorWidth = normalizeInspectorWidth(value.inspectorWidth)
  }
  return result
}

function serializePreferences(preferences: UiPreferences): string {
  const normalized = normalizePreferences(preferences)
  const result: Record<string, unknown> = {
    hideConnections: normalized.hideConnections,
    lastOpenPanel: normalized.lastOpenPanel,
    showZoom: normalized.showZoom,
    showMiniMap: normalized.showMiniMap,
    snapToGrid: normalized.snapToGrid,
    smartSnap: normalized.smartSnap,
    layersOpen: normalized.layersOpen,
    layersWidth: normalized.layersWidth,
  }
  if (typeof normalized.inspectorWidth === 'number') {
    result.inspectorWidth = normalized.inspectorWidth
  }
  return JSON.stringify(result)
}

export function loadUiPreferences(storage?: StorageLike): UiPreferences {
  const target = storage ?? browserStorage()
  if (!target) {
    return defaults()
  }

  try {
    const serialized = target.getItem(UI_PREFERENCES_STORAGE_KEY)
    if (serialized === null) {
      return defaults()
    }
    return normalizePreferences(JSON.parse(serialized) as unknown)
  } catch {
    return defaults()
  }
}

export function saveUiPreferences(
  preferences: UiPreferences,
  storage?: StorageLike,
): void {
  const target = storage ?? browserStorage()
  if (!target) {
    throw new Error('保存界面偏好失败：浏览器存储不可用')
  }

  try {
    target.setItem(
      UI_PREFERENCES_STORAGE_KEY,
      serializePreferences(preferences),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`保存界面偏好失败：${message}`)
  }
}

export function updateUiPreferences(
  changes: Partial<UiPreferences>,
  storage?: StorageLike,
): UiPreferences {
  const updated = normalizePreferences({
    ...loadUiPreferences(storage),
    ...changes,
  })
  saveUiPreferences(updated, storage)
  return updated
}
