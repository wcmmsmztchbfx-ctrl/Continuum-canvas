export const LAYER_ROW_PITCH = 40
export function getLayerWindow(rowCount: number, scrollTop: number, height: number, pinnedIndices: readonly number[]) {
  const top = Math.max(0, Math.min(scrollTop, rowCount * LAYER_ROW_PITCH - height))
  const start = Math.max(0, Math.floor(top / LAYER_ROW_PITCH) - 8)
  const end = Math.min(rowCount, Math.ceil((top + Math.max(0, height)) / LAYER_ROW_PITCH) + 8)
  return { start, end, pinned: [...new Set(pinnedIndices)].filter(index => index >= 0 && index < rowCount && (index < start || index >= end)) }
}
