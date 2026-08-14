import { memo, useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import {
  NodeResizer,
  Position,
  type NodeProps,
} from '@xyflow/react'

import { EmptyMediaPlaceholder } from './EmptyMediaPlaceholder'
import { EditableNodeLabel } from './EditableNodeLabel'
import { GenerationOverlay } from './GenerationOverlay'
import { MediaDownloadButton } from './MediaDownloadButton'
import type { CanvasFlowNode } from './mapping'
import { NodeGeneratorPanel } from './NodeGeneratorPanel'
import { NodeHandle } from './NodeHandle'
import './canvas.css'

function VideoNodeContent({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<CanvasFlowNode>) {
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const resizeGranted = useRef(false)
  useEffect(() => {
    setFailed(false)
    setPlaying(false)
  }, [data.url])
  const hasVideo = Boolean(data.url) && !failed
  const hasPoster = !hasVideo && Boolean(data.poster)
  const showDetails = selected && data.isSoleSelection !== false

  const togglePlayback = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void video.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    } else {
      video.pause()
      setPlaying(false)
    }
  }

  return (
    <article
      className="canvas-media-node"
      data-node-kind="video"
      data-generation-status={data.generation?.status}
      data-reference-candidate={data.referencePickCandidate || undefined}
      data-reference-target={data.referencePickTarget || undefined}
      aria-label={data.name}
    >
      <NodeResizer
        isVisible={showDetails}
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
      <div className="canvas-media-node__frame">
        {hasVideo ? (
          <video
            className="canvas-media-node__content"
            draggable={false}
            onEnded={() => setPlaying(false)}
            src={data.url}
            poster={data.poster}
            ref={videoRef}
            preload="metadata"
            onError={() => setFailed(true)}
          />
        ) : hasPoster ? (
          <img
            alt={`${data.name} 视频封面`}
            className="canvas-media-node__content"
            draggable={false}
            src={data.poster}
          />
        ) : (
          <EmptyMediaPlaceholder kind="video" />
        )}
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
