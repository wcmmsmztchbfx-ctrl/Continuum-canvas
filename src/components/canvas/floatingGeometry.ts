export interface FloatingAnchorRect {
  left: number
  right: number
  top: number
  bottom: number
}

export interface FloatingSize {
  width: number
  height: number
}

export interface FloatingViewport {
  width: number
  height: number
}

export interface FloatingPlacement {
  left: number
  top: number
  placement: 'above' | 'below'
}

export function correctViewportOverflow(
  rect: FloatingAnchorRect,
  viewport: FloatingViewport,
  {
    margin = 8,
    topSafeArea = 70,
    bottomSafeArea = 76,
  }: { margin?: number; topSafeArea?: number; bottomSafeArea?: number } = {},
): { x: number; y: number } {
  const rightEdge = viewport.width - margin
  const bottomEdge = viewport.height - bottomSafeArea
  const x = rect.left < margin
    ? margin - rect.left
    : rect.right > rightEdge ? rightEdge - rect.right : 0
  const y = rect.top < topSafeArea
    ? topSafeArea - rect.top
    : rect.bottom > bottomEdge ? bottomEdge - rect.bottom : 0
  return { x, y }
}

interface PlaceFloatingRectOptions {
  anchor: FloatingAnchorRect
  floating: FloatingSize
  viewport: FloatingViewport
  preferred: 'above' | 'below'
  gap?: number
  margin?: number
  topSafeArea?: number
  bottomSafeArea?: number
}

export function placeFloatingRect({
  anchor,
  floating,
  viewport,
  preferred,
  gap = 8,
  margin = 8,
  topSafeArea = 70,
  bottomSafeArea = 76,
}: PlaceFloatingRectOptions): FloatingPlacement {
  const maximumBottom = Math.max(topSafeArea, viewport.height - bottomSafeArea)
  const maximumLeft = Math.max(margin, viewport.width - margin - floating.width)
  const aboveTop = anchor.top - gap - floating.height
  const belowTop = anchor.bottom + gap
  const fitsAbove = aboveTop >= topSafeArea
  const fitsBelow = belowTop + floating.height <= maximumBottom

  const placement = preferred === 'above'
    ? fitsAbove || !fitsBelow ? 'above' : 'below'
    : fitsBelow || !fitsAbove ? 'below' : 'above'
  const desiredTop = placement === 'above' ? aboveTop : belowTop
  const maximumTop = Math.max(topSafeArea, maximumBottom - floating.height)

  return {
    left: Math.max(margin, Math.min(anchor.left, maximumLeft)),
    top: Math.max(topSafeArea, Math.min(desiredTop, maximumTop)),
    placement,
  }
}
