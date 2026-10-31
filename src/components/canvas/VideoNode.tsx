import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { NodeResizer, Position, type NodeProps } from '@xyflow/react'

import { EmptyMediaPlaceholder } from './EmptyMediaPlaceholder'
import { EditableNodeLabel } from './EditableNodeLabel'
import { GenerationOverlay } from './GenerationOverlay'
import { MediaDownloadButton } from './MediaDownloadButton'
import type { CanvasFlowNode } from './mapping'
import { LazyNodeGeneratorPanel as NodeGeneratorPanel } from './lazyPanels'
import { NodeHandle } from './NodeHandle'
import {
  cacheThumbnailFromElement,
  getVideoPosterUrl,
  subscribeThumbnailReady,
  acquirePreview,
  requestVideoPoster,
  type PreviewLease,
} from '../../services/imageThumbnailCache'
import { mediaPreviewKey } from '../../services/mediaPreviewIdentity'
import { useCanvasMediaDemand } from './canvasMediaDemand'
import { useMediaResource } from './useMediaResource'
import {
  computeAppearanceStyles,
  NOISE_SVG_DATA_URI,
  TEXTURE_DOTS_DATA_URI,
} from './effectStyleUtils'
import './canvas.css'


function formatVideoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

const videoPlaybackPositions = new Map<string, number>()

function VideoNodeContent({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<CanvasFlowNode>) {
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [hasActivated, setHasActivated] = useState(false)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sliderRef = useRef<HTMLInputElement | null>(null)
  const timeDisplayRef = useRef<HTMLSpanElement | null>(null)
  const isSeeking = useRef(false)
  const resizeGranted = useRef(false)
  const playbackKey = data.url ? `${id}:${data.url}` : ''
  const currentTimeRef = useRef(playbackKey ? (videoPlaybackPositions.get(playbackKey) ?? 0) : 0)
  const restoringPlayback = useRef(true)

  const updateScrubberDom = (time: number, dur: number) => {
    const vDur = Number.isFinite(dur) && dur > 0 ? dur : 0
    const max = vDur > 0 ? vDur : (time > 0 ? time : 1)
    const val = vDur > 0 ? Math.min(time, vDur) : 0
    const pct = vDur > 0 ? Math.min(100, Math.max(0, (val / vDur) * 100)) : 0
    if (sliderRef.current) {
      sliderRef.current.max = String(max)
      sliderRef.current.value = String(val)
      sliderRef.current.style.background = `linear-gradient(to right, #0d99ff 0%, #0d99ff ${pct}%, rgba(255, 255, 255, 0.24) ${pct}%, rgba(255, 255, 255, 0.24) 100%)`
    }
    if (timeDisplayRef.current) {
      timeDisplayRef.current.textContent = `${formatVideoTime(time)} / ${formatVideoTime(vDur)}`
    }
  }

  const syncDuration = () => {
    const video = videoRef.current
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      const newDur = video.duration
      setDuration((prev) => (Math.abs(prev - newDur) > 0.01 ? newDur : prev))
      const savedTime = currentTimeRef.current
      if (savedTime > 0 && (restoringPlayback.current || Math.abs(video.currentTime - savedTime) > 0.3)) {
        try {
          video.currentTime = Math.min(savedTime, newDur)
        } catch {
          // Ignore seek errors on unready elements
        }
      }
      restoringPlayback.current = false
      updateScrubberDom(currentTimeRef.current, newDur)
    }
  }

  useEffect(() => {
    setFailed(false)
    setPlaying(false)
    setVideoReady(false)
    const savedTime = playbackKey ? (videoPlaybackPositions.get(playbackKey) ?? 0) : 0
    currentTimeRef.current = savedTime
    const video = videoRef.current
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      setDuration(video.duration)
      updateScrubberDom(savedTime, video.duration)
    } else {
      setDuration(0)
      updateScrubberDom(savedTime, 0)
    }
  }, [data.url, playbackKey])

  useEffect(() => {
    updateScrubberDom(currentTimeRef.current, duration)
  }, [duration])

  const media = useCanvasMediaDemand(id, Boolean(selected || playing))
  const zoom = media.variant === 'original' ? 2 : media.variant <= 360 ? .3 : 1
  const [generatedPoster, setGeneratedPoster] = useState<string>()
  useEffect(() => {
    setGeneratedPoster(undefined)
    if (!data.url || getVideoPosterUrl(data.url, data.poster) || media.demand === 'none') return
    const key = mediaPreviewKey(data.url)
    let preview: PreviewLease | undefined
    const refresh = () => {
      if (preview) return
      preview = acquirePreview(key)
      if (preview) setGeneratedPoster(preview.url)
    }
    refresh()
    const unsubscribe = subscribeThumbnailReady(readyKey => { if (readyKey === key) refresh() })
    const request = preview ? undefined : requestVideoPoster(data.url)
    return () => { unsubscribe(); request?.cancel(); preview?.release() }
  }, [data.url, data.poster, media.demand === 'none'])
  const posterSource = getVideoPosterUrl(data.url, data.poster, zoom) || generatedPoster
  const posterResource = useMediaResource({ url: posterSource ?? '' }, media.variant, media.demand)
  const effectivePoster = posterResource.displayUrl
  const hasVideo = Boolean(data.url) && !failed
  const hasPoster = Boolean(effectivePoster)
  const isLayerMode = data.node?.type === 'video' && data.node.data.displayMode === 'layer'
  const showResizer = selected && data.isSoleSelection !== false
  const showDetails = showResizer && !isLayerMode && (data.generatorOpen ?? true)
  const modelData = data.node?.type === 'video' ? data.node.data : undefined
  const appearance = computeAppearanceStyles((modelData || {}) as Parameters<typeof computeAppearanceStyles>[0])

  const shouldMountVideo = hasVideo && (selected || playing || (hasActivated && media.demand !== 'none'))
  const playbackState = useRef({ volume: 1, muted: false, playbackRate: 1 })
  const setVideoRef = useCallback((element: HTMLVideoElement | null) => {
    const previous = videoRef.current
    if (previous && !element) {
      // A new media element can detach before metadata restores its saved position
      // (including StrictMode's ref replay). Its default zero must not replace it.
      if (!restoringPlayback.current) currentTimeRef.current = previous.currentTime
      playbackState.current = { volume: previous.volume, muted: previous.muted, playbackRate: previous.playbackRate }
      if (playbackKey) {
        videoPlaybackPositions.set(playbackKey, currentTimeRef.current)
        while (videoPlaybackPositions.size > 200) videoPlaybackPositions.delete(videoPlaybackPositions.keys().next().value!)
      }
    }
    videoRef.current = element
    if (element) {
      restoringPlayback.current = true
      element.volume = playbackState.current.volume
      element.muted = playbackState.current.muted
      element.playbackRate = playbackState.current.playbackRate
    }
  }, [playbackKey])


  const togglePlayback = () => {
    if (!hasVideo) return
    setHasActivated(true)
    if (!playing) {
      const video = videoRef.current
      if (video) {
        if (video.ended || (video.duration > 0 && Math.abs(video.currentTime - video.duration) < 0.15)) {
          video.currentTime = 0
          currentTimeRef.current = 0
          if (playbackKey) videoPlaybackPositions.set(playbackKey, 0)
          updateScrubberDom(0, duration)
        }
      }
      setPlaying(true)
    } else {
      const video = videoRef.current
      if (video) {
        video.pause()
        if (playbackKey) videoPlaybackPositions.set(playbackKey, video.currentTime)
      }
      setPlaying(false)
    }
  }

  useEffect(() => {
    if (playing && videoRef.current) {
      const video = videoRef.current
      if (video.ended || (video.duration > 0 && Math.abs(video.currentTime - video.duration) < 0.15)) {
        video.currentTime = 0
        currentTimeRef.current = 0
      }
      if (video.paused) {
        try {
          const res = video.play()
          if (res && typeof res.catch === 'function') {
            res.catch(() => setPlaying(false))
          }
        } catch {
          setPlaying(false)
        }
      }
    }
  }, [playing, shouldMountVideo])

  const toggleMute = () => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    setMuted(video.muted)
  }

  const validDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  const sliderMax = validDuration > 0 ? validDuration : 1

  const handleSeek = (event: React.SyntheticEvent<HTMLInputElement>) => {
    setHasActivated(true)
    const target = event.currentTarget as HTMLInputElement
    const targetTime = Number(target.value)
    if (!Number.isFinite(targetTime)) return
    const validDur = Number.isFinite(duration) && duration > 0 ? duration : (videoRef.current?.duration || 0)
    const clampedTime = validDur > 0 ? Math.min(Math.max(0, targetTime), validDur) : Math.max(0, targetTime)
    currentTimeRef.current = clampedTime
    if (playbackKey) videoPlaybackPositions.set(playbackKey, clampedTime)
    updateScrubberDom(clampedTime, validDur)
    if (videoRef.current && Number.isFinite(clampedTime)) {
      videoRef.current.currentTime = clampedTime
    }
  }

  const isEnded = Boolean(
    videoRef.current?.ended ||
    (validDuration > 0 && currentTimeRef.current >= validDuration - 0.15)
  )

  return (
    <article
      className={`canvas-media-node${isLayerMode ? ' canvas-media-node--layer-mode' : ''}`}
      data-node-kind="video"
      data-generation-status={data.generation?.status}
      data-reference-candidate={data.referencePickCandidate || undefined}
      data-reference-target={data.referencePickTarget || undefined}
      data-selected={selected || undefined}
      aria-label={data.name}
      style={{
        opacity: modelData?.opacity !== undefined ? modelData.opacity : undefined,
        transform: modelData?.rotation ? `rotate(${modelData.rotation}deg)` : undefined,
        '--resizer-scale': Math.min(1.35, Math.max(1, 1 / (zoom || 1))),
      } as React.CSSProperties}
    >
      <NodeResizer
        isVisible={showResizer}
        keepAspectRatio={true}
        minWidth={80}
        minHeight={80}
        lineClassName="canvas-node-resizer__line"
        handleClassName="canvas-node-resizer__handle"
        onResizeStart={() => {
          resizeGranted.current = data.onResizeStart?.(id) ?? true
        }}
        shouldResize={() => resizeGranted.current}
        onResize={(_event, { width, height, x, y }) => {
          if (resizeGranted.current) data.onResizePreview?.(id, { width, height }, { x, y })
        }}
        onResizeEnd={(_event, { width, height, x, y }) =>
          resizeGranted.current ? data.onResize?.(id, { width, height }, { x, y }) : undefined
        }
      />
      <EditableNodeLabel
        name={data.name}
        nodeId={id}
        onRename={data.onRename}
      />
      <NodeHandle
        id="target"
        type="target"
        position={Position.Left}
        isConnectable={isConnectable}
        onPointerDown={data.onConnectionPointerDown}
      />
      <div
        className="canvas-media-node__frame"
        style={{
          borderRadius: modelData?.radius ? `${modelData.radius}px` : undefined,
          borderColor: appearance.style.borderColor,
          borderWidth: appearance.style.borderWidth,
          borderStyle: appearance.style.borderStyle,
          boxShadow: appearance.style.boxShadow,
          filter: appearance.style.filter,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {appearance.hasNoise && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage: `url("${NOISE_SVG_DATA_URI}")`,
              pointerEvents: 'none',
              opacity: 0.5,
              zIndex: 2,
            }}
          />
        )}
        {appearance.hasTexture && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage: `url("${TEXTURE_DOTS_DATA_URI}")`,
              pointerEvents: 'none',
              opacity: 0.4,
              zIndex: 2,
            }}
          />
        )}
        {appearance.hasShader && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'linear-gradient(135deg, rgba(99,102,241,0.2) 0%, rgba(168,85,247,0.2) 50%, rgba(236,72,153,0.2) 100%)',
              pointerEvents: 'none',
              mixBlendMode: 'overlay',
              zIndex: 2,
            }}
          />
        )}
        {hasPoster ? (
          <img
            key={posterResource.bindingKey}
            alt={`${data.name} 视频封面`}
            className="canvas-media-node__content canvas-media-node__poster"
            decoding="async"
            draggable={false}
            src={effectivePoster}
            onLoad={posterResource.onLoad}
            onError={posterResource.onError}
          />
        ) : null}
        {shouldMountVideo ? (
          <video
            autoPlay={playing}
            className={`canvas-media-node__content canvas-video-element ${videoReady ? 'is-ready' : ''}`}
            crossOrigin="anonymous"
            draggable={false}
            onCanPlay={() => {
              setVideoReady(true)
              syncDuration()
            }}
            onDurationChange={syncDuration}
            onEnded={() => {
              setPlaying(false)
              const endTime = duration > 0 ? duration : (videoRef.current?.duration || 0)
              currentTimeRef.current = endTime
              if (playbackKey) videoPlaybackPositions.set(playbackKey, endTime)
              updateScrubberDom(endTime, endTime)
            }}
            onLoadedData={(event) => {
              setVideoReady(true)
              syncDuration()
              if (data.url) {
                cacheThumbnailFromElement(data.url, event.currentTarget)
              }
            }}
            onLoadedMetadata={syncDuration}
            onPause={() => setPlaying(false)}
            onPlay={() => {
              setPlaying(true)
              syncDuration()
            }}
            onTimeUpdate={() => {
              const video = videoRef.current
              if (!video) return
              if (!duration || duration <= 0) syncDuration()
              if (!isSeeking.current && !restoringPlayback.current) {
                currentTimeRef.current = video.currentTime
                if (playbackKey) videoPlaybackPositions.set(playbackKey, video.currentTime)
                updateScrubberDom(video.currentTime, video.duration || duration)
              }
            }}
            src={data.url}
            ref={setVideoRef}
            preload={playing ? 'auto' : 'metadata'}
            onError={() => setFailed(true)}
          />
        ) : !hasPoster ? (
          <EmptyMediaPlaceholder kind="video" />
        ) : null}
        {hasVideo ? (
          <button
            aria-label={playing ? '暂停视频' : isEnded ? '重播视频' : '播放视频'}
            className="canvas-video-preview__toggle nodrag nopan"
            onClick={togglePlayback}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          >
            {playing ? (
              <Pause size={34} />
            ) : isEnded ? (
              <RotateCcw size={34} />
            ) : (
              <Play size={38} fill="currentColor" />
            )}
          </button>
        ) : null}
        {hasVideo ? (
          <div
            aria-label="视频播放进度控制"
            className="canvas-video-scrubber nodrag nopan"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              aria-label={playing ? '暂停' : isEnded ? '重播' : '播放'}
              className="canvas-video-scrubber__play-btn"
              onClick={togglePlayback}
              type="button"
            >
              {playing ? (
                <Pause size={13} />
              ) : isEnded ? (
                <RotateCcw size={13} />
              ) : (
                <Play size={13} fill="currentColor" />
              )}
            </button>
            <div className="canvas-video-scrubber__track-wrap">
              <input
                aria-label="播放进度"
                className="canvas-video-scrubber__slider"
                defaultValue={0}
                disabled={!hasVideo || validDuration === 0}
                max={sliderMax}
                min={0}
                onChange={handleSeek}
                onInput={handleSeek}
                onPointerDown={() => {
                  setHasActivated(true)
                  isSeeking.current = true
                }}
                onPointerUp={(event) => {
                  isSeeking.current = false
                  const time = Number((event.target as HTMLInputElement).value)
                  if (Number.isFinite(time)) {
                    const validDur = Number.isFinite(duration) && duration > 0 ? duration : (videoRef.current?.duration || 0)
                    const clamped = validDur > 0 ? Math.min(time, validDur) : time
                    currentTimeRef.current = clamped
                    updateScrubberDom(clamped, validDur)
                    if (videoRef.current) videoRef.current.currentTime = clamped
                  }
                }}
                ref={sliderRef}
                step={validDuration > 0 ? Math.min(0.05, Math.max(0.001, validDuration / 1000)) : 0.05}
                type="range"
              />
            </div>
            <span className="canvas-video-scrubber__time" ref={timeDisplayRef}>
              {formatVideoTime(0)} / {formatVideoTime(validDuration)}
            </span>
            <button
              aria-label={muted ? '取消静音' : '静音'}
              className="canvas-video-scrubber__mute-btn"
              onClick={toggleMute}
              type="button"
            >
              {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>
          </div>
        ) : null}
        {data.generation?.status === 'generating' ? (
          <GenerationOverlay />
        ) : null}
        {hasVideo ? (
          <MediaDownloadButton kind="video" name={data.name} url={data.url!} />
        ) : null}
      </div>
      <NodeHandle
        id="source"
        type="source"
        position={Position.Right}
        isConnectable={isConnectable}
        onPointerDown={data.onConnectionPointerDown}
      />
      {showDetails ? (
        <NodeGeneratorPanel
          canvasId={data.canvasId}
          generation={data.generation}
          kind="video"
          nodeId={id}
          projectId={data.projectId}
          onAttachReference={data.onAttachReference}
          onGenerate={data.onGenerate}
          onPromptChange={data.onPromptChange}
          onReferencePickerChange={data.onReferencePickerChange}
          onRemoveReference={data.onRemoveReference}
          onRetry={data.onRetry}
          pending={data.generationPending}
          promptDraft={data.promptDraft}
          error={data.generationError}
          onSettingsChange={data.onSettingsChange}
          interactionLeaseLost={data.interactionLeaseLost}
          lockedBy={data.lockedBy}
          onInteractionEnd={data.onInteractionEnd}
          onInteractionStart={data.onInteractionStart}
          references={data.references}
          referenceCandidates={data.referenceCandidates}
          referencePickerActive={data.referencePickerActive}
          settings={data.generationSettings}
          unresolvedReferences={data.unresolvedReferences}
          captureFrameAvailable={hasVideo}
          onCaptureFrame={(capture) => {
            if (videoRef.current) data.onCaptureFrame?.(id, videoRef.current, capture)
          }}
        />
      ) : null}
    </article>
  )
}

const StableVideoNode = memo(
  VideoNodeContent,
  (previous, next) =>
    previous.id === next.id &&
    previous.data === next.data &&
    previous.selected === next.selected &&
    previous.isConnectable === next.isConnectable,
)

export function VideoNode(props: NodeProps<CanvasFlowNode>) {
  return <StableVideoNode {...props} />
}
