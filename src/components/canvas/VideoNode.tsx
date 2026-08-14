import { memo, useEffect, useRef, useState } from 'react'
import {
  Pause,
  Play,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { NodeResizer, Position, useViewport, type NodeProps } from '@xyflow/react'

import { EmptyMediaPlaceholder } from './EmptyMediaPlaceholder'
import { EditableNodeLabel } from './EditableNodeLabel'
import { GenerationOverlay } from './GenerationOverlay'
import { MediaDownloadButton } from './MediaDownloadButton'
import type { CanvasFlowNode } from './mapping'
import { NodeGeneratorPanel } from './NodeGeneratorPanel'
import { NodeHandle } from './NodeHandle'
import './canvas.css'

function formatVideoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

function VideoNodeContent({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<CanvasFlowNode>) {
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sliderRef = useRef<HTMLInputElement | null>(null)
  const timeDisplayRef = useRef<HTMLSpanElement | null>(null)
  const isSeeking = useRef(false)
  const resizeGranted = useRef(false)
  const currentTimeRef = useRef(0)

  let zoom = 1
  try {
    const vp = useViewport()
    zoom = vp.zoom
  } catch {
    zoom = 1
  }

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
      updateScrubberDom(currentTimeRef.current, newDur)
    }
  }

  useEffect(() => {
    setFailed(false)
    setPlaying(false)
    setVideoReady(false)
    currentTimeRef.current = 0
    const video = videoRef.current
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      setDuration(video.duration)
      updateScrubberDom(0, video.duration)
    } else {
      setDuration(0)
      updateScrubberDom(0, 0)
    }
  }, [data.url])

  useEffect(() => {
    updateScrubberDom(currentTimeRef.current, duration)
  }, [duration])

  const hasVideo = Boolean(data.url) && !failed
  const hasPoster = Boolean(data.poster)
  const isLayerMode = data.node?.type === 'video' && data.node.data.displayMode === 'layer'
  const showResizer = selected && data.isSoleSelection !== false
  const showDetails = showResizer && !isLayerMode
  const modelData = data.node?.type === 'video' ? data.node.data : undefined
  const isLowResMode = zoom <= 0.35
  const shouldMountVideo = hasVideo && (!isLowResMode || playing || selected) && (selected || isHovered || playing || data.generation?.status === 'generating')

  const togglePlayback = () => {
    if (!hasVideo) return
    const video = videoRef.current
    if (!video) {
      setPlaying(true)
      return
    }
    if (video.paused) {
      void video.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    } else {
      video.pause()
      setPlaying(false)
    }
  }

  useEffect(() => {
    if (playing && videoRef.current && videoRef.current.paused) {
      void videoRef.current.play().catch(() => setPlaying(false))
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

  const handleSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const targetTime = Number(event.target.value)
    if (!Number.isFinite(targetTime)) return
    const validDur = Number.isFinite(duration) && duration > 0 ? duration : (videoRef.current?.duration || 0)
    const clampedTime = validDur > 0 ? Math.min(Math.max(0, targetTime), validDur) : Math.max(0, targetTime)
    currentTimeRef.current = clampedTime
    updateScrubberDom(clampedTime, validDur)
    if (videoRef.current && Number.isFinite(clampedTime)) {
      videoRef.current.currentTime = clampedTime
    }
  }

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
      }}
    >
      <NodeResizer
        isVisible={showResizer}
        minWidth={80}
        minHeight={80}
        lineClassName="canvas-node-resizer__line"
        handleClassName="canvas-node-resizer__handle"
        onResizeStart={() => {
          resizeGranted.current = data.onResizeStart?.(id) ?? true
        }}
        shouldResize={() => resizeGranted.current}
        onResize={(_event, { width, height }) => {
          if (resizeGranted.current) data.onResizePreview?.(id, { width, height })
        }}
        onResizeEnd={(_event, { width, height }) =>
          resizeGranted.current ? data.onResize?.(id, { width, height }) : undefined
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
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => setIsHovered(false)}
        style={{
          borderRadius: modelData?.radius ? `${modelData.radius}px` : undefined,
          border: modelData?.stroke
            ? `${modelData.strokeWidth ?? 1}px solid ${modelData.stroke}`
            : undefined,
          overflow: 'hidden',
        }}
      >
        {hasPoster ? (
          <img
            alt={`${data.name} 视频封面`}
            className="canvas-media-node__content canvas-media-node__poster"
            decoding="async"
            draggable={false}
            src={data.poster}
          />
        ) : null}
        {hasVideo ? (
          <video
            className={`canvas-media-node__content canvas-video-element ${videoReady ? 'is-ready' : ''}`}
            draggable={false}
            onCanPlay={() => {
              setVideoReady(true)
              syncDuration()
            }}
            onDurationChange={syncDuration}
            onEnded={() => {
              setPlaying(false)
              const video = videoRef.current
              if (video && Number.isFinite(video.duration) && video.duration > 0) {
                currentTimeRef.current = video.duration
                updateScrubberDom(video.duration, video.duration)
              }
            }}
            onLoadedData={() => {
              setVideoReady(true)
              syncDuration()
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
                updateScrubberDom(video.currentTime, video.duration || duration)
              }
            }}
            src={data.url}
            poster={data.poster}
            ref={videoRef}
            preload="metadata"
            onError={() => setFailed(true)}
          />
        ) : !hasPoster ? (
          <EmptyMediaPlaceholder kind="video" />
        ) : null}
        {hasVideo ? (
          <button
            aria-label={playing ? '暂停视频' : '播放视频'}
            className="canvas-video-preview__toggle nodrag nopan"
            onClick={togglePlayback}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          >
            {playing ? <Pause size={34} /> : <Play size={38} fill="currentColor" />}
          </button>
        ) : null}
        {hasVideo ? (
          <div
            aria-label="视频播放进度控制"
            className="canvas-video-scrubber nodrag nopan"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              aria-label={playing ? '暂停' : '播放'}
              className="canvas-video-scrubber__play-btn"
              onClick={togglePlayback}
              type="button"
            >
              {playing ? <Pause size={13} /> : <Play size={13} fill="currentColor" />}
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
                onPointerDown={() => {
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
