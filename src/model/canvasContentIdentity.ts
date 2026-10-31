import type { CanvasSnapshotV2 } from './project.ts'

// Camera position belongs to the viewer. Everything else remains conflict-protected.
export function canvasContentIdentity(snapshot: CanvasSnapshotV2): string {
  const { viewport: _viewport, ...content } = snapshot
  return JSON.stringify(content, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  })
}
