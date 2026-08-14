export interface ImageEditorGeometryInput {
  naturalWidth: number
  naturalHeight: number
  targetRatio?: number
  rotation: number
  maxDimension?: number
}

export interface ImageEditorGeometry {
  source: {
    width: number
    height: number
  }
  canvas: {
    width: number
    height: number
  }
  draw: {
    width: number
    height: number
  }
}

export function calculateImageEditorGeometry({
  naturalWidth,
  naturalHeight,
  targetRatio,
  rotation,
  maxDimension = 1400,
}: ImageEditorGeometryInput): ImageEditorGeometry {
  const sourceRatio = naturalWidth / naturalHeight
  const outputRatio = targetRatio ?? sourceRatio
  let sourceWidth = naturalWidth
  let sourceHeight = naturalHeight

  if (outputRatio > sourceRatio) sourceHeight = sourceWidth / outputRatio
  else sourceWidth = sourceHeight * outputRatio

  const swapped = Math.abs(rotation % 180) === 90
  const orientedWidth = swapped ? sourceHeight : sourceWidth
  const orientedHeight = swapped ? sourceWidth : sourceHeight
  const scale = Math.min(1, maxDimension / Math.max(orientedWidth, orientedHeight))
  const canvas = {
    width: Math.round(orientedWidth * scale),
    height: Math.round(orientedHeight * scale),
  }

  return {
    source: { width: sourceWidth, height: sourceHeight },
    canvas,
    draw: swapped
      ? { width: canvas.height, height: canvas.width }
      : { ...canvas },
  }
}
