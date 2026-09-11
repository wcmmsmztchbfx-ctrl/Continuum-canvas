import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import type { CatalogModel } from '../../contracts/generation'
import type {
  ImageGenerationSettings,
  MediaGenerationSettings,
  VideoGenerationSettings,
} from '../../model/project'
import { placeFloatingRect } from './floatingGeometry'
import { modelCanGenerateAudio, supportedVideoModes } from './generationUi'

interface GenerationSettingsPopoverProps {
  anchor?: HTMLElement | null
  kind: 'image' | 'video' | 'director'
  model?: CatalogModel
  portalRoot?: Element | DocumentFragment | null
  settings: MediaGenerationSettings
  onChange: (settings: MediaGenerationSettings) => void
}

function OptionButton({
  children,
  selected,
  ariaLabel,
  onClick,
}: {
  children: ReactNode
  selected: boolean
  ariaLabel?: string
  onClick: () => void
}) {
  return (
    <button
      aria-label={ariaLabel}
      aria-pressed={selected}
      className="canvas-generation-settings__option"
      data-selected={selected}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}

function formatRatioLabel(ratio: string): string {
  if (ratio.toLowerCase() === 'adaptive' || ratio.toLowerCase() === 'auto') return '自适应'
  return ratio
}

function ratioShape(ratio: string) {
  const norm = ratio.toLowerCase()
  if (norm === 'auto' || norm === 'adaptive' || norm === '自适应') return { width: 12, height: 12 }
  const values = ratio.split(':').map(Number)
  const width = values[0]
  const height = values[1]
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) {
    return { width: 12, height: 12 }
  }
  const maximum = Math.max(width, height)
  return {
    width: Math.max(6, Math.round((width / maximum) * 16)),
    height: Math.max(6, Math.round((height / maximum) * 16)),
  }
}

function RatioButton({
  ratio,
  selected,
  onClick,
}: {
  ratio: string
  selected: boolean
  onClick: () => void
}) {
  const shape = ratioShape(ratio)
  return (
    <button
      aria-pressed={selected}
      className="canvas-generation-settings__ratio"
      data-ratio={ratio}
      data-selected={selected}
      onClick={onClick}
      type="button"
    >
      <span
        aria-hidden="true"
        className="canvas-generation-settings__ratio-shape"
        style={
          {
            '--ratio-height': `${shape.height}px`,
            '--ratio-width': `${shape.width}px`,
          } as CSSProperties
        }
      />
      <span>{formatRatioLabel(ratio)}</span>
    </button>
  )
}

function SettingGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="canvas-generation-settings__group">
      <h3>{label}</h3>
      {children}
    </div>
  )
}

function QualityOptions({
  model,
  selected,
  onSelect,
}: {
  model: CatalogModel
  selected: string
  onSelect: (value: string) => void
}) {
  return (
    <SettingGroup label="清晰度">
      <div className="canvas-generation-settings__segmented">
        {model.qualityOptions.map((option) => (
          <button
            key={option.value}
            aria-pressed={selected === option.value}
            className="canvas-generation-settings__segmented-btn"
            data-selected={selected === option.value}
            onClick={() => onSelect(option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </SettingGroup>
  )
}

function ImageSettings({
  model,
  settings,
  onChange,
}: {
  model: CatalogModel
  settings: ImageGenerationSettings
  onChange: (settings: ImageGenerationSettings) => void
}) {
  return (
    <>
      {model.aspectRatios.length > 0 ? (
        <SettingGroup label="比例">
          <div className="canvas-generation-settings__ratio-grid">
            {model.aspectRatios.map((ratio) => (
              <RatioButton
                key={ratio}
                onClick={() => onChange({ ...settings, aspectRatio: ratio })}
                ratio={ratio}
                selected={settings.aspectRatio === ratio}
              />
            ))}
          </div>
        </SettingGroup>
      ) : null}
      {model.qualityOptions.length > 0 ? (
        <QualityOptions
          model={model}
          onSelect={(quality) => onChange({ ...settings, quality, resolution: quality })}
          selected={settings.quality}
        />
      ) : null}
      {model.countOptions.length > 0 ? (
        <SettingGroup label="生成数量">
          <div className="canvas-generation-settings__pills">
            {model.countOptions.map((count) => (
              <OptionButton
                key={count}
                onClick={() => onChange({ ...settings, count })}
                selected={settings.count === count}
              >
                {count}张
              </OptionButton>
            ))}
          </div>
        </SettingGroup>
      ) : null}
    </>
  )
}

function VideoSettings({
  model,
  settings,
  onChange,
}: {
  model: CatalogModel
  settings: VideoGenerationSettings
  onChange: (settings: VideoGenerationSettings) => void
}) {
  const supportsAudio = modelCanGenerateAudio(model)
  const videoModes = supportedVideoModes(model)
  const selectedMode = videoModes.find((m) => m.value === settings.mode) ?? videoModes[0]

  return (
    <>
      {videoModes.length > 0 ? (
        <SettingGroup label="生成方式">
          <div className="canvas-generation-settings__segmented">
            {videoModes.map((mode) => (
              <button
                key={mode.value}
                aria-pressed={selectedMode?.value === mode.value}
                className="canvas-generation-settings__segmented-btn"
                data-selected={selectedMode?.value === mode.value}
                onClick={() => onChange({ ...settings, mode: mode.value })}
                type="button"
              >
                {mode.label}
              </button>
            ))}
          </div>
        </SettingGroup>
      ) : null}

      {model.aspectRatios.length > 0 ? (
        <SettingGroup label="比例">
          <div className="canvas-generation-settings__ratio-grid">
            {model.aspectRatios.map((ratio) => (
              <RatioButton
                key={ratio}
                onClick={() => onChange({ ...settings, aspectRatio: ratio })}
                ratio={ratio}
                selected={settings.aspectRatio === ratio}
              />
            ))}
          </div>
        </SettingGroup>
      ) : null}

      {model.qualityOptions.length > 0 ? (
        <QualityOptions
          model={model}
          onSelect={(resolution) => onChange({ ...settings, resolution })}
          selected={settings.resolution}
        />
      ) : null}

      {model.durationOptions.length > 0 ? (
        <SettingGroup label="时长">
          <div className="canvas-generation-settings__pills">
            {model.durationOptions.map((durationSec) => (
              <OptionButton
                ariaLabel={`${durationSec}秒`}
                key={durationSec}
                onClick={() => onChange({ ...settings, durationSec })}
                selected={settings.durationSec === durationSec}
              >
                {durationSec}s
              </OptionButton>
            ))}
          </div>
        </SettingGroup>
      ) : null}

      {supportsAudio ? (
        <SettingGroup label="有声视频">
          <div className="canvas-generation-settings__segmented">
            <button
              aria-pressed={settings.generateAudio}
              className="canvas-generation-settings__segmented-btn"
              data-selected={settings.generateAudio}
              onClick={() => onChange({ ...settings, generateAudio: true })}
              type="button"
            >
              有声
            </button>
            <button
              aria-pressed={!settings.generateAudio}
              className="canvas-generation-settings__segmented-btn"
              data-selected={!settings.generateAudio}
              onClick={() => onChange({ ...settings, generateAudio: false })}
              type="button"
            >
              无声
            </button>
          </div>
        </SettingGroup>
      ) : null}
    </>
  )
}

export function GenerationSettingsPopover({
  anchor,
  kind,
  model,
  portalRoot,
  settings,
  onChange,
}: GenerationSettingsPopoverProps) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const [position, setPosition] = useState<CSSProperties>({
    bottom: 'auto',
    left: 8,
    position: 'fixed',
    top: 70,
  })
  const isImage = kind === 'image' && settings.kind === 'image'
  const isVideo = (kind === 'video' || kind === 'director') && settings.kind === 'video'

  useEffect(() => {
    const update = () => {
      const anchorBounds = anchor?.getBoundingClientRect() ?? {
        left: 8,
        right: 8,
        top: 70,
        bottom: 70,
      }
      const dialogBounds = dialogRef.current?.getBoundingClientRect()
      const placement = placeFloatingRect({
        anchor: anchorBounds,
        floating: {
          width: dialogBounds?.width || 342,
          height: dialogBounds?.height || (kind === 'image' ? 463 : 448),
        },
        preferred: 'above',
        viewport: { width: window.innerWidth, height: window.innerHeight },
      })
      setPosition((prev) => (prev.left === placement.left && prev.top === placement.top ? prev : {
        bottom: 'auto',
        left: placement.left,
        position: 'fixed',
        top: placement.top,
      }))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const flowViewport = anchor
      ?.closest('.react-flow')
      ?.querySelector('.react-flow__viewport')
    const viewportObserver = flowViewport && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(update)
      : undefined
    if (flowViewport) viewportObserver?.observe(flowViewport, {
      attributeFilter: ['style'],
      attributes: true,
    })
    return () => {
      viewportObserver?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor, kind, model])

  const dialog = (
    <section
      aria-label={isImage ? '图片生成设置' : kind === 'director' ? '导演成片设置' : '视频生成设置'}
      className="canvas-generation-settings"
      data-kind={kind}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      ref={dialogRef}
      role="dialog"
      style={position}
    >
      {!model ? <p className="canvas-generation-settings__empty">等待同步模型目录</p> : null}
      {model && isImage ? (
        <ImageSettings model={model} onChange={onChange} settings={settings} />
      ) : null}
      {model && isVideo ? (
        <VideoSettings model={model} onChange={onChange} settings={settings} />
      ) : null}
    </section>
  )

  return typeof document === 'undefined'
    ? dialog
    : createPortal(dialog, portalRoot ?? document.body)
}
