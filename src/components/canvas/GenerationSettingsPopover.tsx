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
import { modelCanGenerateAudio } from './generationUi'

interface GenerationSettingsPopoverProps {
  anchor?: HTMLElement | null
  kind: 'image' | 'video'
  model?: CatalogModel
  portalRoot?: Element | DocumentFragment | null
  settings: MediaGenerationSettings
  onChange: (settings: MediaGenerationSettings) => void
}

function OptionButton({
  children,
  selected,
  onClick,
}: {
  children: ReactNode
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
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

function ratioShape(ratio: string) {
  if (ratio.toLowerCase() === 'auto') return { width: 13, height: 9 }
  const values = ratio.split(':').map(Number)
  const width = values[0]
  const height = values[1]
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) {
    return { width: 12, height: 12 }
  }
  const maximum = Math.max(width, height)
  return {
    width: Math.max(5, (width / maximum) * 15),
    height: Math.max(5, (height / maximum) * 15),
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
      <span>{ratio}</span>
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
      <div className="canvas-generation-settings__row">
        {model.qualityOptions.map((option) => (
          <OptionButton
            key={option.value}
            onClick={() => onSelect(option.value)}
            selected={selected === option.value}
          >
            {option.label}
          </OptionButton>
        ))}
      </div>
    </SettingGroup>
  )
}

function CommonSettings({
  model,
  settings,
  onRatio,
  onCount,
}: {
  model: CatalogModel
  settings: MediaGenerationSettings
  onRatio: (ratio: string) => void
  onCount: (count: number) => void
}) {
  return (
    <>
      {model.aspectRatios.length > 0 ? (
        <SettingGroup label="比例">
          <div className="canvas-generation-settings__ratio-grid">
            {model.aspectRatios.map((ratio) => (
              <RatioButton
                key={ratio}
                onClick={() => onRatio(ratio)}
                ratio={ratio}
                selected={settings.aspectRatio === ratio}
              />
            ))}
          </div>
        </SettingGroup>
      ) : null}
      {model.countOptions.length > 0 ? (
        <SettingGroup label="生成数量">
          <div className="canvas-generation-settings__row">
            {model.countOptions.map((count) => (
              <OptionButton
                key={count}
                onClick={() => onCount(count)}
                selected={settings.count === count}
              >
                {count}{settings.kind === 'image' ? '张' : '个'}
              </OptionButton>
            ))}
          </div>
        </SettingGroup>
      ) : null}
    </>
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
      <QualityOptions
        model={model}
        onSelect={(quality) => onChange({ ...settings, quality, resolution: quality })}
        selected={settings.quality}
      />
      <CommonSettings
        model={model}
        onCount={(count) => onChange({ ...settings, count })}
        onRatio={(aspectRatio) => onChange({ ...settings, aspectRatio })}
        settings={settings}
      />
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
  return (
    <>
      <QualityOptions
        model={model}
        onSelect={(resolution) => onChange({ ...settings, resolution })}
        selected={settings.resolution}
      />
      <CommonSettings
        model={model}
        onCount={(count) => onChange({ ...settings, count })}
        onRatio={(aspectRatio) => onChange({ ...settings, aspectRatio })}
        settings={settings}
      />
      {model.durationOptions.length > 0 ? (
        <SettingGroup label="视频时长">
          <div className="canvas-generation-settings__row">
            {model.durationOptions.map((durationSec) => (
              <OptionButton
                key={durationSec}
                onClick={() => onChange({ ...settings, durationSec })}
                selected={settings.durationSec === durationSec}
              >
                {durationSec}秒
              </OptionButton>
            ))}
          </div>
        </SettingGroup>
      ) : null}
      {supportsAudio ? (
        <SettingGroup label="生成音频">
          <div className="canvas-generation-settings__row">
            <OptionButton
              onClick={() => onChange({ ...settings, generateAudio: true })}
              selected={settings.generateAudio}
            >
              开启
            </OptionButton>
            <OptionButton
              onClick={() => onChange({ ...settings, generateAudio: false })}
              selected={!settings.generateAudio}
            >
              关闭
            </OptionButton>
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
  const isVideo = kind === 'video' && settings.kind === 'video'

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
      aria-label={isImage ? '图片生成设置' : '视频生成设置'}
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
