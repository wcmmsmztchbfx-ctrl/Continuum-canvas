import { memo, useEffect, useRef, useState } from 'react'
import {
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { NodeResizer, Position, useStore as useReactFlowStore, type NodeProps } from '@xyflow/react'

import { EmptyMediaPlaceholder } from './EmptyMediaPlaceholder'
import { EditableNodeLabel } from './EditableNodeLabel'
import { GenerationOverlay } from './GenerationOverlay'
import { MediaDownloadButton } from './MediaDownloadButton'
import type { CanvasFlowNode } from './mapping'
import { NodeGeneratorPanel } from './NodeGeneratorPanel'
import { NodeHandle } from './NodeHandle'
import {
  cacheThumbnailFromElement,
  getVideoPosterUrl,
  subscribeThumbnailReady,
} from '../../services/imageThumbnailCache'
import {
  isMediaLoaded,
  requestMediaLoad,
  type LoadPriority,
} from '../../services/mediaLoadQueue'
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
      if (savedTime > 0 && Math.abs(video.currentTime - savedTime) > 0.3) {
        try {
          video.currentTime = Math.min(savedTime, newDur)
        } catch {
          // Ignore seek errors on unready elements
        }
      }
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

  let zoomTier: 'low' | 'normal' | 'high' = 'normal'
  try {
    zoomTier = useReactFlowStore((s) =>
      s.transform[2] > 1.5 ? 'high' : s.transform[2] <= 0.35 ? 'low' : 'normal',
    )
  } catch {
    zoomTier = 'normal'
  }

  const zoom = zoomTier === 'high' ? 2 : zoomTier === 'low' ? 0.3 : 1
  const priority: LoadPriority = zoomTier

  const [generatedPoster, setGeneratedPoster] = useState<string | undefined>(
    () => getVideoPosterUrl(data.url, data.poster, zoom),
  )
  const [posterAllowed, setPosterAllowed] = useState(
    () => typeof window === 'undefined' || typeof Image === 'undefined',
  )

  useEffect(() => {
    const initial = getVideoPosterUrl(data.url, data.poster, zoom)
    setGeneratedPoster(initial)
    return subscribeThumbnailReady((url, thumb) => {
      if (url === data.url || url === data.poster) {
        setGeneratedPoster(thumb)
      }
    })
  }, [data.url, data.poster, zoom > 1.5])

  const effectivePoster =
    getVideoPosterUrl(data.url, data.poster, zoom) || data.poster || generatedPoster
  const hasVideo = Boolean(data.url) && !failed
  const hasPoster = Boolean(effectivePoster)
  const isLayerMode = data.node?.type === 'video' && data.node.data.displayMode === 'layer'
  const showResizer = selected && data.isSoleSelection !== false
  const showDetails = (data.isInspected !== undefined ? data.isInspected : showResizer) && !isLayerMode
  const modelData = data.node?.type === 'video' ? data.node.data : undefined
  const shouldMountVideo = hasVideo && (selected || hasActivated || playing || data.generation?.status === 'generating')

  useEffect(() => {
    if (!effectivePoster) {
      setPosterAllowed(true)
      return
    }
    if (isMediaLoaded(effectivePoster)) {
      setPosterAllowed(true)
      return
    }
    const { promise, cancel } = requestMediaLoad(effectivePoster, priority)
    let active = true
    promise.then((success) => {
      if (active && success) setPosterAllowed(true)
    })
    return () => {
      active = false
      cancel()
    }
  }, [effectivePoster, priority])

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
        filter: (() => {
          const filters: string[] = []
          if (modelData?.blur && modelData.blur > 0) filters.push(`blur(${modelData.blur}px)`)
          if (modelData?.shadow) filters.push(`drop-shadow(${modelData.shadow.x}px ${modelData.shadow.y}px ${modelData.shadow.blur}px ${modelData.shadow.color})`)
          return filters.length > 0 ? filters.join(' ') : undefined
        })(),
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
          border: modelData?.stroke
            ? `${modelData.strokeWidth ?? 1}px ${modelData.strokeStyle ?? 'solid'} ${modelData.stroke}`
            : undefined,
          overflow: 'hidden',
        }}
      >
        {hasPoster && posterAllowed && (!hasActivated || !videoReady) ? (
          <img
            alt={`${data.name} 视频封面`}
            className="canvas-media-node__content canvas-media-node__poster"
            decoding="async"
            draggable={false}
            loading="lazy"
            src={effectivePoster}
          />
        ) : null}
        {shouldMountVideo ? (
          <video
            autoPlay={playing}
            className={`canvas-media-node__content canvas-video-element ${videoReady ? 'is-ready' : ''}`}
            crossOrigin={data.url.startsWith('/api/assets/') ? 'anonymous' : undefined}
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
              if (!isSeeking.current) {
                currentTimeRef.current = video.currentTime
                if (playbackKey) videoPlaybackPositions.set(playbackKey, video.currentTime)
                updateScrubberDom(video.currentTime, video.duration || duration)
              }
            }}
            src={data.url}
            poster={effectivePoster}
            ref={videoRef}
            preload="auto"
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
