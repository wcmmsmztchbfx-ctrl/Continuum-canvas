import type { NodeSize, Point } from '../../model/project'

const TARGET_AREA = 360 * 360
const MIN_SIDE = 120
const MAX_SIDE = 640

export function parseAspectRatio(value: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(value)
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined
  }
  return width / height
}

export function sizeForAspectRatio(value: string): NodeSize {
  const ratio = parseAspectRatio(value) ?? 1
  return {
    width: Math.round(Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.sqrt(TARGET_AREA * ratio)))),
    height: Math.round(Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.sqrt(TARGET_AREA / ratio)))),
  }
}

export function resizeAroundCenter(
  position: Point,
  currentSize: NodeSize,
  nextSize: NodeSize,
): { position: Point; size: NodeSize } {
  return {
    position: {
      x: position.x + (currentSize.width - nextSize.width) / 2,
      y: position.y + (currentSize.height - nextSize.height) / 2,
    },
    size: nextSize,
  }
}

export function materiallyDifferentRatio(
  requested: string,
  naturalWidth: number,
  naturalHeight: number,
): boolean {
  if (naturalWidth <= 0 || naturalHeight <= 0) return false
  if (requested === 'adaptive') return true
  const expected = parseAspectRatio(requested)
  if (!expected) return false
  const actual = naturalWidth / naturalHeight
  return Math.abs(actual - expected) / expected > 0.02
}

export function ratioStringFromDimensions(width: number, height: number): string {
  if (width <= 0 || height <= 0) return '1:1'
  const actual = width / height
  const standardRatios: Array<[string, number]> = [
    ['1:1', 1.0],
    ['3:4', 3 / 4],
    ['4:3', 4 / 3],
    ['9:16', 9 / 16],
    ['16:9', 16 / 9],
    ['21:9', 21 / 9],
  ]
  for (const [name, target] of standardRatios) {
    if (Math.abs(actual - target) / target < 0.03) {
      return name
    }
  }
  const divisor = greatestCommonDivisor(Math.round(width), Math.round(height))
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.max(1, Math.abs(left))
  let b = Math.max(1, Math.abs(right))
  while (b !== 0) [a, b] = [b, a % b]
  return a
}
