import { useEffect, useRef } from 'react'
import { X, Sliders } from 'lucide-react'
import type { CanvasEffectItem } from '../../model/project'
import { ScrubbableLabel } from './ScrubbableLabel'
import { ScrubbableNumberInput } from './ScrubbableNumberInput'

interface EffectSettingsPopoverProps {
  effect: CanvasEffectItem
  onUpdate: (updated: CanvasEffectItem, commit?: boolean) => void
  onClose: () => void
  readOnly?: boolean
  disabled?: boolean
  topPosition?: number
}

const EFFECT_NAMES: Record<CanvasEffectItem['type'], { title: string; subtitle: string }> = {
  'inner-shadow': { title: '内阴影', subtitle: 'Inner Shadow' },
  'drop-shadow': { title: '投影', subtitle: 'Drop Shadow' },
  'layer-blur': { title: '图层模糊', subtitle: 'Layer Blur' },
  'background-blur': { title: '背景模糊', subtitle: 'Background Blur' },
  'noise': { title: '噪点颗粒', subtitle: 'Noise' },
  'texture': { title: '材质纹理', subtitle: 'Texture' },
  'glass': { title: '拟态玻璃', subtitle: 'Glass' },
  'shader': { title: '动态着色器', subtitle: 'Shader' },
}

export function EffectSettingsPopover({
  effect,
  onUpdate,
  onClose,
  readOnly = false,
  disabled = false,
  topPosition = 120,
}: EffectSettingsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handlePointerDownOutside(e: MouseEvent) {
      if ((e.target as HTMLElement)?.closest?.('.inspector-layer-action-btn')) {
        return
      }
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    window.addEventListener('mousedown', handlePointerDownOutside)
    return () => window.removeEventListener('mousedown', handlePointerDownOutside)
  }, [onClose])

  const isLocked = readOnly || disabled

  const renderContent = () => {
    switch (effect.type) {
      case 'inner-shadow':
      case 'drop-shadow': {
        const x = effect.x ?? 0
        const y = effect.y ?? 4
        const blur = effect.blur ?? (effect.type === 'inner-shadow' ? 8 : 12)
        const spread = effect.spread ?? 0
        const color = effect.color || '#000000'
        const intensity = effect.intensity ?? (effect.type === 'inner-shadow' ? 40 : 45)

        return (
          <div className="effect-popover__body">
            <div className="inspector-row">
              <div className="inspector-field">
                <ScrubbableNumberInput
                  aria-label="X 偏移"
                  disabled={isLocked}
                  label="X 偏移"
                  min={-100}
                  max={100}
                  onValueChange={(val, commit) => onUpdate({ ...effect, x: val }, commit)}
                  scrubProps={{ min: -100, max: 100 }}
                  value={x}
                />
              </div>
              <div className="inspector-field">
                <ScrubbableNumberInput
                  aria-label="Y 偏移"
                  disabled={isLocked}
                  label="Y 偏移"
                  min={-100}
                  max={100}
                  onValueChange={(val, commit) => onUpdate({ ...effect, y: val }, commit)}
                  scrubProps={{ min: -100, max: 100 }}
                  value={y}
                />
              </div>
            </div>

            <div className="inspector-row">
              <div className="inspector-field">
                <ScrubbableNumberInput
                  aria-label="模糊半径"
                  disabled={isLocked}
                  label="模糊 (Blur)"
                  min={0}
                  max={100}
                  onValueChange={(val, commit) => onUpdate({ ...effect, blur: Math.max(0, val) }, commit)}
                  scrubProps={{ min: 0, max: 100 }}
                  value={blur}
                />
              </div>
              <div className="inspector-field">
                <ScrubbableNumberInput
                  aria-label="扩散半径"
                  disabled={isLocked}
                  label="扩散 (Spread)"
                  min={-100}
                  max={100}
                  onValueChange={(val, commit) => onUpdate({ ...effect, spread: val }, commit)}
                  scrubProps={{ min: -100, max: 100 }}
                  value={spread}
                />
              </div>
            </div>

            <div className="inspector-field" style={{ marginTop: '4px' }}>
              <span className="inspector-field__label" style={{ width: '42px' }}>颜色</span>
              <div className="inspector-color-chip" style={{ background: color }}>
                <input
                  aria-label="阴影颜色"
                  className="inspector-color-input-native"
                  disabled={isLocked}
                  onChange={(e) => onUpdate({ ...effect, color: e.target.value }, true)}
                  type="color"
                  value={color.startsWith('#') ? color : '#000000'}
                />
              </div>
              <input
                aria-label="阴影十六进制"
                className="inspector-color-hex"
                disabled={isLocked}
                onChange={(e) => onUpdate({ ...effect, color: e.target.value }, true)}
                value={color}
              />
            </div>

            <div className="inspector-row" style={{ marginTop: '6px' }}>
              <div className="inspector-field" style={{ width: '100%' }}>
                <ScrubbableLabel
                  label="不透明度"
                  max={100}
                  min={0}
                  onChange={(val) => onUpdate({ ...effect, intensity: Math.max(0, Math.min(100, val)) }, false)}
                  onChangeEnd={(val) => onUpdate({ ...effect, intensity: Math.max(0, Math.min(100, val)) }, true)}
                  value={intensity}
                />
                <input
                  aria-label="阴影不透明度"
                  className="inspector-slider"
                  disabled={isLocked}
                  max={100}
                  min={0}
                  onChange={(e) => onUpdate({ ...effect, intensity: Number(e.target.value) || 0 }, true)}
                  type="range"
                  value={intensity}
                />
                <span style={{ color: '#888', fontSize: '10px', minWidth: '28px', textAlign: 'right' }}>
                  {intensity}%
                </span>
              </div>
            </div>
          </div>
        )
      }

      case 'layer-blur':
      case 'background-blur': {
        const blur = effect.blur ?? (effect.type === 'layer-blur' ? 8 : 12)
        return (
          <div className="effect-popover__body">
            <div className="inspector-row">
              <div className="inspector-field" style={{ width: '100%' }}>
                <ScrubbableNumberInput
                  aria-label="模糊半径"
                  disabled={isLocked}
                  label="模糊半径"
                  min={0}
                  max={100}
                  onValueChange={(val, commit) => onUpdate({ ...effect, blur: Math.max(0, val) }, commit)}
                  scrubProps={{ min: 0, max: 100 }}
                  value={blur}
                />
                <span style={{ color: '#737373', fontSize: '10px' }}>px</span>
              </div>
            </div>
            <div className="inspector-row" style={{ marginTop: '6px' }}>
              <input
                aria-label="模糊滑动条"
                className="inspector-slider"
                disabled={isLocked}
                max={100}
                min={0}
                onChange={(e) => onUpdate({ ...effect, blur: Number(e.target.value) || 0 }, true)}
                type="range"
                value={blur}
              />
            </div>
          </div>
        )
      }

      case 'noise': {
        const intensity = effect.intensity ?? 30
        const preset = effect.preset ?? 'medium'
        return (
          <div className="effect-popover__body">
            <div className="inspector-row">
              <span className="inspector-field__label" style={{ width: '50px' }}>噪点颗粒</span>
              <div className="inspector-seg-group" style={{ flex: 1 }}>
                {(['fine', 'medium', 'coarse'] as const).map((p) => (
                  <button
                    key={p}
                    className={`inspector-seg-btn ${preset === p ? 'inspector-seg-btn--active' : ''}`}
                    disabled={isLocked}
                    onClick={() => onUpdate({ ...effect, preset: p }, true)}
                    type="button"
                  >
                    {p === 'fine' ? '细致' : p === 'medium' ? '中等' : '粗颗粒'}
                  </button>
                ))}
              </div>
            </div>
            <div className="inspector-row" style={{ marginTop: '8px' }}>
              <div className="inspector-field" style={{ width: '100%' }}>
                <ScrubbableLabel
                  label="噪点强度"
                  max={100}
                  min={0}
                  onChange={(val) => onUpdate({ ...effect, intensity: Math.max(0, Math.min(100, val)) }, false)}
                  onChangeEnd={(val) => onUpdate({ ...effect, intensity: Math.max(0, Math.min(100, val)) }, true)}
                  value={intensity}
                />
                <input
                  aria-label="噪点强度"
                  className="inspector-slider"
                  disabled={isLocked}
                  max={100}
                  min={0}
                  onChange={(e) => onUpdate({ ...effect, intensity: Number(e.target.value) || 0 }, true)}
                  type="range"
                  value={intensity}
                />
                <span style={{ color: '#888', fontSize: '10px', minWidth: '28px', textAlign: 'right' }}>
                  {intensity}%
                </span>
              </div>
            </div>
          </div>
        )
      }

      case 'texture': {
        const intensity = effect.intensity ?? 30
        const preset = effect.preset ?? 'dots'
        const tint = effect.tint || '#ffffff'
        return (
          <div className="effect-popover__body">
            <div className="inspector-row">
              <span className="inspector-field__label" style={{ width: '50px' }}>图案类型</span>
              <select
                aria-label="纹理图案类型"
                className="inspector-select"
                disabled={isLocked}
                onChange={(e) => onUpdate({ ...effect, preset: e.target.value }, true)}
                value={preset}
              >
                <option value="dots">Dots (点阵纹理)</option>
                <option value="grid">Grid (网格几何)</option>
                <option value="diagonal">Diagonal (斜纹编织)</option>
                <option value="waves">Waves (水波纹理)</option>
              </select>
            </div>
            <div className="inspector-field" style={{ marginTop: '6px' }}>
              <span className="inspector-field__label" style={{ width: '50px' }}>色彩 Tint</span>
              <div className="inspector-color-chip" style={{ background: tint }}>
                <input
                  aria-label="纹理色彩"
                  className="inspector-color-input-native"
                  disabled={isLocked}
                  onChange={(e) => onUpdate({ ...effect, tint: e.target.value }, true)}
                  type="color"
                  value={tint.startsWith('#') ? tint : '#ffffff'}
                />
              </div>
              <input
                aria-label="纹理色彩十六进制"
                className="inspector-color-hex"
                disabled={isLocked}
                onChange={(e) => onUpdate({ ...effect, tint: e.target.value }, true)}
                value={tint}
              />
            </div>
            <div className="inspector-row" style={{ marginTop: '8px' }}>
              <div className="inspector-field" style={{ width: '100%' }}>
                <ScrubbableLabel
                  label="纹理透明度"
                  max={100}
                  min={0}
                  onChange={(val) => onUpdate({ ...effect, intensity: Math.max(0, Math.min(100, val)) }, false)}
                  onChangeEnd={(val) => onUpdate({ ...effect, intensity: Math.max(0, Math.min(100, val)) }, true)}
                  value={intensity}
                />
                <input
                  aria-label="纹理不透明度"
                  className="inspector-slider"
                  disabled={isLocked}
                  max={100}
                  min={0}
                  onChange={(e) => onUpdate({ ...effect, intensity: Number(e.target.value) || 0 }, true)}
                  type="range"
                  value={intensity}
                />
                <span style={{ color: '#888', fontSize: '10px', minWidth: '28px', textAlign: 'right' }}>
                  {intensity}%
                </span>
              </div>
            </div>
          </div>
        )
      }

      case 'glass': {
        const blur = effect.blur ?? 16
        const specular = effect.specular ?? 40
        const tint = effect.tint || 'rgba(255, 255, 255, 0.12)'
        return (
          <div className="effect-popover__body">
            <div className="inspector-row">
              <div className="inspector-field" style={{ width: '100%' }}>
                <ScrubbableNumberInput
                  aria-label="玻璃模糊"
                  disabled={isLocked}
                  label="毛玻璃模糊"
                  min={0}
                  max={60}
                  onValueChange={(val, commit) => onUpdate({ ...effect, blur: Math.max(0, val) }, commit)}
                  scrubProps={{ min: 0, max: 60 }}
                  value={blur}
                />
                <span style={{ color: '#737373', fontSize: '10px' }}>px</span>
              </div>
            </div>
            <div className="inspector-row" style={{ marginTop: '6px' }}>
              <div className="inspector-field" style={{ width: '100%' }}>
                <ScrubbableLabel
                  label="边缘高光反射"
                  max={100}
                  min={0}
                  onChange={(val) => onUpdate({ ...effect, specular: Math.max(0, Math.min(100, val)) }, false)}
                  onChangeEnd={(val) => onUpdate({ ...effect, specular: Math.max(0, Math.min(100, val)) }, true)}
                  value={specular}
                />
                <input
                  aria-label="高光反射"
                  className="inspector-slider"
                  disabled={isLocked}
                  max={100}
                  min={0}
                  onChange={(e) => onUpdate({ ...effect, specular: Number(e.target.value) || 0 }, true)}
                  type="range"
                  value={specular}
                />
                <span style={{ color: '#888', fontSize: '10px', minWidth: '28px', textAlign: 'right' }}>
                  {specular}%
                </span>
              </div>
            </div>
            <div className="inspector-field" style={{ marginTop: '6px' }}>
              <span className="inspector-field__label" style={{ width: '50px' }}>底色 Tint</span>
              <input
                aria-label="玻璃色调"
                className="inspector-color-hex"
                disabled={isLocked}
                onChange={(e) => onUpdate({ ...effect, tint: e.target.value }, true)}
                value={tint}
              />
            </div>
          </div>
        )
      }

      case 'shader': {
        const preset = effect.preset ?? 'wave'
        const intensity = effect.intensity ?? 50
        return (
          <div className="effect-popover__body">
            <div className="inspector-row">
              <span className="inspector-field__label" style={{ width: '50px' }}>着色效果</span>
              <select
                aria-label="Shader 预设"
                className="inspector-select"
                disabled={isLocked}
                onChange={(e) => onUpdate({ ...effect, preset: e.target.value }, true)}
                value={preset}
              >
                <option value="wave">动态波浪 (Gradient Wave)</option>
                <option value="neon">霓虹辉光 (Neon Glow)</option>
                <option value="aurora">极光流转 (Aurora)</option>
                <option value="hologram">全息矩阵 (Hologram)</option>
              </select>
            </div>
            <div className="inspector-row" style={{ marginTop: '8px' }}>
              <div className="inspector-field" style={{ width: '100%' }}>
                <ScrubbableLabel
                  label="动态速度/强度"
                  max={100}
                  min={0}
                  onChange={(val) => onUpdate({ ...effect, intensity: Math.max(0, Math.min(100, val)) }, false)}
                  onChangeEnd={(val) => onUpdate({ ...effect, intensity: Math.max(0, Math.min(100, val)) }, true)}
                  value={intensity}
                />
                <input
                  aria-label="Shader 强度"
                  className="inspector-slider"
                  disabled={isLocked}
                  max={100}
                  min={0}
                  onChange={(e) => onUpdate({ ...effect, intensity: Number(e.target.value) || 0 }, true)}
                  type="range"
                  value={intensity}
                />
                <span style={{ color: '#888', fontSize: '10px', minWidth: '28px', textAlign: 'right' }}>
                  {intensity}%
                </span>
              </div>
            </div>
          </div>
        )
      }
    }
  }

  return (
    <div
      ref={popoverRef}
      className="figma-effect-popover"
      style={{
        top: `${Math.max(10, topPosition)}px`,
      }}
    >
      <div className="figma-effect-popover__header">
        <span className="figma-effect-popover__title">
          <Sliders size={12} style={{ marginRight: '6px' }} />
          <span>{EFFECT_NAMES[effect.type]?.title ?? effect.type}</span>
          <span style={{ fontSize: '10px', color: '#888', marginLeft: '6px', fontWeight: 'normal' }}>
            {EFFECT_NAMES[effect.type]?.subtitle}
          </span>
        </span>
        <button
          aria-label="关闭参数面板"
          className="figma-effect-popover__close"
          onClick={onClose}
          type="button"
        >
          <X size={13} />
        </button>
      </div>
      {renderContent()}
    </div>
  )
}
