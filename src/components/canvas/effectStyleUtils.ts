import type { CSSProperties } from 'react'
import type {
  CanvasEffectItem,
  CanvasFillItem,
  CanvasStrokeItem,
  CanvasStrokePosition,
  CanvasNodeEffectShadow,
} from '../../model/project'

export interface ResolvedAppearance {
  fills: CanvasFillItem[]
  strokes: CanvasStrokeItem[]
  effects: CanvasEffectItem[]
  style: CSSProperties
  overlayStyle?: CSSProperties
  innerShadowStyle?: CSSProperties
  hasGlass: boolean
  hasNoise: boolean
  hasTexture: boolean
  hasShader: boolean
}

export function parseHexOrRgba(color: string, opacity = 1): string {
  if (!color) return 'transparent'
  const trimmed = color.trim()
  if (trimmed.startsWith('#')) {
    let hex = trimmed.slice(1)
    if (hex.length === 3) {
      hex = hex.split('').map((c) => c + c).join('')
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, opacity))})`
    }
  }
  if (trimmed.startsWith('rgb(')) {
    return trimmed.replace('rgb(', 'rgba(').replace(')', `, ${opacity})`)
  }
  if (trimmed.startsWith('rgba(')) {
    if (opacity < 1) {
      return trimmed.replace(/,\s*[\d.]+\)$/, `, ${opacity})`)
    }
    return trimmed
  }
  return trimmed
}

export function getResolvedFills(data: {
  fill?: string
  fills?: CanvasFillItem[]
}): CanvasFillItem[] {
  if (Array.isArray(data.fills)) {
    return data.fills
  }
  if (data.fill) {
    return [
      {
        id: 'fill-default',
        color: data.fill,
        opacity: 1,
        enabled: true,
      },
    ]
  }
  return []
}

export function getResolvedStrokes(data: {
  stroke?: string
  strokeWidth?: number
  strokeStyle?: 'solid' | 'dashed'
  strokePosition?: CanvasStrokePosition
  strokes?: CanvasStrokeItem[]
}): CanvasStrokeItem[] {
  if (Array.isArray(data.strokes)) {
    return data.strokes.map((s) => ({
      ...s,
      position: s.position ?? data.strokePosition ?? 'outside',
    }))
  }
  if (data.stroke) {
    return [
      {
        id: 'stroke-default',
        color: data.stroke,
        width: data.strokeWidth ?? 1,
        style: data.strokeStyle ?? 'solid',
        opacity: 1,
        enabled: true,
        position: data.strokePosition ?? 'outside',
      },
    ]
  }
  return []
}

export function getResolvedEffects(data: {
  blur?: number
  shadow?: CanvasNodeEffectShadow
  effects?: CanvasEffectItem[]
}): CanvasEffectItem[] {
  if (Array.isArray(data.effects)) {
    return data.effects
  }
  const synthesized: CanvasEffectItem[] = []
  if (data.shadow) {
    synthesized.push({
      id: 'effect-shadow-default',
      type: 'drop-shadow',
      enabled: true,
      x: data.shadow.x,
      y: data.shadow.y,
      blur: data.shadow.blur,
      spread: 0,
      color: data.shadow.color,
    })
  }
  if (typeof data.blur === 'number' && data.blur > 0) {
    synthesized.push({
      id: 'effect-blur-default',
      type: 'layer-blur',
      enabled: true,
      blur: data.blur,
    })
  }
  return synthesized
}

export const NOISE_SVG_DATA_URI =
  "data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.3'/%3E%3C/svg%3E"

export const TEXTURE_DOTS_DATA_URI =
  "data:image/svg+xml,%3Csvg width='20' height='20' viewBox='0 0 20 20' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%23ffffff' fill-opacity='0.15' fill-rule='evenodd'%3E%3Ccircle cx='3' cy='3' r='1.5'/%3E%3Ccircle cx='13' cy='13' r='1.5'/%3E%3C/g%3E%3C/svg%3E"

export const TEXTURE_GRID_DATA_URI =
  "data:image/svg+xml,%3Csvg width='24' height='24' viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0 0h24v24H0V0zm1 1v22h22V1H1z' fill='%23ffffff' fill-opacity='0.08'/%3E%3C/svg%3E"

export function computeAppearanceStyles(data: {
  fill?: string
  fills?: CanvasFillItem[]
  stroke?: string
  strokeWidth?: number
  strokeStyle?: 'solid' | 'dashed'
  strokePosition?: CanvasStrokePosition
  strokes?: CanvasStrokeItem[]
  blur?: number
  shadow?: CanvasNodeEffectShadow
  effects?: CanvasEffectItem[]
  opacity?: number
  radius?: number
  rotation?: number
}): ResolvedAppearance {
  const fills = getResolvedFills(data)
  const strokes = getResolvedStrokes(data)
  const effects = getResolvedEffects(data)

  const enabledFills = fills.filter((f) => f.enabled)
  const enabledStrokes = strokes.filter((s) => s.enabled)
  const enabledEffects = effects.filter((e) => e.enabled)

  // 1. Background (layered fills from top to bottom)
  const bgLayers: string[] = []
  for (const fill of enabledFills) {
    const col = parseHexOrRgba(fill.color, fill.opacity ?? 1)
    bgLayers.push(`linear-gradient(0deg, ${col}, ${col})`)
  }

  // 2. Strokes calculation
  let outlineVal: string | undefined
  let outlineOffsetVal: string | undefined
  const insetStrokeShadows: string[] = []
  const outerStrokeShadows: string[] = []
  let accumulatedOutsideWidth = 0
  let accumulatedInsideWidth = 0

  for (const s of enabledStrokes) {
    const col = parseHexOrRgba(s.color, s.opacity ?? 1)
    const pos = s.position ?? 'outside'
    const isDashed = s.style === 'dashed'

    if (pos === 'outside') {
      accumulatedOutsideWidth += s.width
      if (isDashed) {
        outlineVal = `${s.width}px dashed ${col}`
        outlineOffsetVal = `${accumulatedOutsideWidth - s.width}px`
      } else {
        outerStrokeShadows.push(`0 0 0 ${accumulatedOutsideWidth}px ${col}`)
      }
    } else if (pos === 'inside') {
      accumulatedInsideWidth += s.width
      if (isDashed) {
        outlineVal = `${s.width}px dashed ${col}`
        outlineOffsetVal = `-${s.width}px`
      } else {
        insetStrokeShadows.push(`inset 0 0 0 ${accumulatedInsideWidth}px ${col}`)
      }
    } else {
      // 'center'
      const half = s.width / 2
      accumulatedOutsideWidth += half
      accumulatedInsideWidth += half
      if (isDashed) {
        outlineVal = `${s.width}px dashed ${col}`
        outlineOffsetVal = `-${half}px`
      } else {
        outerStrokeShadows.push(`0 0 0 ${accumulatedOutsideWidth}px ${col}`)
        insetStrokeShadows.push(`inset 0 0 0 ${accumulatedInsideWidth}px ${col}`)
      }
    }
  }

  // 3. Effects calculation
  const innerShadowParts: string[] = []
  const dropShadowParts: string[] = []
  const glassShadowParts: string[] = []
  const filterParts: string[] = []
  const backdropFilterParts: string[] = []

  let hasGlass = false
  let hasNoise = false
  let hasTexture = false
  let hasShader = false

  for (const eff of enabledEffects) {
    switch (eff.type) {
      case 'inner-shadow': {
        const col = parseHexOrRgba(eff.color || '#000000', eff.intensity !== undefined ? eff.intensity / 100 : 0.4)
        innerShadowParts.push(
          `inset ${eff.x ?? 0}px ${eff.y ?? 4}px ${eff.blur ?? 8}px ${eff.spread ?? 0}px ${col}`
        )
        break
      }
      case 'drop-shadow': {
        const col = parseHexOrRgba(eff.color || '#000000', eff.intensity !== undefined ? eff.intensity / 100 : 0.45)
        dropShadowParts.push(
          `${eff.x ?? 0}px ${eff.y ?? 4}px ${eff.blur ?? 12}px ${(eff.spread ?? 0) + accumulatedOutsideWidth}px ${col}`
        )
        break
      }
      case 'layer-blur': {
        const blur = eff.blur ?? 8
        if (blur > 0) {
          filterParts.push(`blur(${blur}px)`)
        }
        break
      }
      case 'background-blur': {
        const blur = eff.blur ?? 12
        if (blur > 0) {
          backdropFilterParts.push(`blur(${blur}px)`)
        }
        break
      }
      case 'glass': {
        hasGlass = true
        const blur = eff.blur ?? 16
        backdropFilterParts.push(`blur(${blur}px)`)
        const tint = eff.tint || 'rgba(255, 255, 255, 0.12)'
        bgLayers.unshift(`linear-gradient(0deg, ${tint}, ${tint})`)
        glassShadowParts.push('inset 0 1px 1px 0 rgba(255, 255, 255, 0.35)')
        glassShadowParts.push('inset 0 -1px 1px 0 rgba(0, 0, 0, 0.25)')
        glassShadowParts.push('0 8px 32px 0 rgba(0, 0, 0, 0.36)')
        break
      }
      case 'noise': {
        hasNoise = true
        break
      }
      case 'texture': {
        hasTexture = true
        break
      }
      case 'shader': {
        hasShader = true
        break
      }
    }
  }

  const allBoxShadows = [
    ...insetStrokeShadows,
    ...innerShadowParts,
    ...glassShadowParts,
    ...outerStrokeShadows,
    ...dropShadowParts,
  ]

  const combinedBackground = bgLayers.length > 0 ? bgLayers.join(', ') : undefined
  const combinedBoxShadow = allBoxShadows.length > 0 ? allBoxShadows.join(', ') : undefined
  const combinedFilter = filterParts.length > 0 ? filterParts.join(' ') : undefined
  const combinedBackdropFilter = backdropFilterParts.length > 0 ? backdropFilterParts.join(' ') : undefined

  const style: CSSProperties = {
    background: combinedBackground,
    boxShadow: combinedBoxShadow,
    outline: outlineVal,
    outlineOffset: outlineOffsetVal,
    filter: combinedFilter,
    backdropFilter: combinedBackdropFilter,
    WebkitBackdropFilter: combinedBackdropFilter,
    opacity: data.opacity,
    borderRadius: data.radius !== undefined ? `${data.radius}px` : undefined,
    transform: data.rotation ? `rotate(${data.rotation}deg)` : undefined,
  }

  return {
    fills,
    strokes,
    effects,
    style,
    hasGlass,
    hasNoise,
    hasTexture,
    hasShader,
  }
}
