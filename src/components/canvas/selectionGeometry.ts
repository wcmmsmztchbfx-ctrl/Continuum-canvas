interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Bounds {
  left: number
  top: number
  width: number
  height: number
}

interface Viewport {
  x: number
  y: number
  zoom: number
}

interface ScreenSize {
  width: number
  height: number
}

export function selectionUnionBounds(
  nodes: Rect[],
  viewport: Viewport,
): Bounds | null {
  if (nodes.length === 0) return null
  const minimumX = Math.min(...nodes.map((node) => node.x))
  const minimumY = Math.min(...nodes.map((node) => node.y))
  const maximumX = Math.max(...nodes.map((node) => node.x + node.width))
  const maximumY = Math.max(...nodes.map((node) => node.y + node.height))
  return {
    left: viewport.x + minimumX * viewport.zoom,
    top: viewport.y + minimumY * viewport.zoom,
    width: (maximumX - minimumX) * viewport.zoom,
    height: (maximumY - minimumY) * viewport.zoom,
  }
}

export function placeSelectionToolbar(
  selection: Bounds,
  toolbar: ScreenSize,
  viewport: ScreenSize,
): { left: number; top: number; placement: 'above' | 'inside' } {
  const margin = 8
  const gap = 14
  const topSafeArea = 70
  const desiredAboveTop = selection.top - gap - toolbar.height
  const placement = desiredAboveTop >= topSafeArea ? 'above' : 'inside'
  const desiredLeft = selection.left + (selection.width - toolbar.width) / 2
  const maximumLeft = Math.max(margin, viewport.width - margin - toolbar.width)
  const desiredTop = placement === 'above'
    ? desiredAboveTop
    : selection.top + gap
  const maximumTop = Math.max(topSafeArea, viewport.height - 76 - toolbar.height)
  return {
    left: Math.max(margin, Math.min(desiredLeft, maximumLeft)),
    top: Math.max(topSafeArea, Math.min(desiredTop, maximumTop)),
    placement,
  }
}
