import { memo, useEffect, useRef, useState } from 'react'
import { NodeResizer, Position, useViewport, type NodeProps } from '@xyflow/react'

import { EmptyMediaPlaceholder } from './EmptyMediaPlaceholder'
import { EditableNodeLabel } from './EditableNodeLabel'
import { GenerationOverlay } from './GenerationOverlay'
import { MediaDownloadButton } from './MediaDownloadButton'
import type { CanvasFlowNode } from './mapping'
import { NodeGeneratorPanel } from './NodeGeneratorPanel'
import { NodeHandle } from './NodeHandle'
import {
  getFastThumbnailUrl,
  getResponsiveImageUrl,
  subscribeThumbnailReady,
} from '../../services/imageThumbnailCache'
import {
  calculateLoadPriority,
  isMediaLoaded,
  requestMediaLoad,
} from '../../services/mediaLoadQueue'
import './canvas.css'

function ImageNodeContent({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<CanvasFlowNode>) {
  const [failed, setFailed] = useState(false)
  const [highResLoaded, setHighResLoaded] = useState(false)
  const [thumbnailAllowed, setThumbnailAllowed] = useState(false)
  const [highResAllowed, setHighResAllowed] = useState(
    () => typeof window === 'undefined' || typeof Image === 'undefined',
  )
  const [generatedThumbnail, setGeneratedThumbnail] = useState<string | undefined>(undefined)
  const resizeGranted = useRef(false)

  let viewport = { x: 0, y: 0, zoom: 1 }
  try {
    const vp = useViewport()
    viewport = { x: vp.x, y: vp.y, zoom: vp.zoom }
  } catch {
    viewport = { x: 0, y: 0, zoom: 1 }
  }

  const zoom = viewport.zoom
  const priority = calculateLoadPriority(
    data.node?.position,
    data.node?.size,
    viewport,
  )

  useEffect(() => {
    setFailed(false)
    setHighResLoaded(false)
    setHighResAllowed(false)
  }, [data.url])

  useEffect(() => {
    if (!data.url) return
    const initialThumb = getFastThumbnailUrl(data.url, data.thumbnailUrl)
    setGeneratedThumbnail(initialThumb)
    return subscribeThumbnailReady((url, thumb) => {
      if (url === data.url) {
        setGeneratedThumbnail(thumb)
      }
    })
  }, [data.url, data.thumbnailUrl])

  const hasImage = Boolean(data.url) && !failed
  const isLayerMode = data.node?.type === 'image' && data.node.data.displayMode === 'layer'
  const showResizer = isLayerMode && selected && data.isSoleSelection !== false
  const showDetails = selected && data.isSoleSelection !== false && !isLayerMode
  const modelData = data.node?.type === 'image' ? data.node.data : undefined

  const explicitThumbnail =
    data.thumbnailUrl ||
    (data.url && data.versions?.[0]?.url && data.versions[0].url !== data.url
      ? data.versions[0].url
      : undefined)
  const effectiveThumbnailUrl =
    explicitThumbnail || generatedThumbnail || getFastThumbnailUrl(data.url)
  const hasThumbnail = Boolean(effectiveThumbnailUrl)
  const isLowResMode = zoom <= 0.35

  // Purely zoom-based: zoom > 1.5 -> original, zoom <= 1.5 -> WebP
  const responsiveHighResUrl = getResponsiveImageUrl(data.url, zoom) || data.url

  // Prevent unmounting loaded images when zooming out: once loaded, keep mounted
  const isHighResAlreadyLoaded =
    isMediaLoaded(responsiveHighResUrl) || isMediaLoaded(data.url)
  const shouldRenderHighRes =
    !isLowResMode || !hasThumbnail || isHighResAlreadyLoaded || highResLoaded

  useEffect(() => {
    if (!effectiveThumbnailUrl) {
      setThumbnailAllowed(true)
      return
    }
    if (isMediaLoaded(effectiveThumbnailUrl)) {
      setThumbnailAllowed(true)
      return
    }
    const { promise, cancel } = requestMediaLoad(effectiveThumbnailUrl, priority)
    let active = true
    promise.then((success) => {
      if (active && success) setThumbnailAllowed(true)
    })
    return () => {
      active = false
      cancel()
    }
  }, [effectiveThumbnailUrl, priority])

  useEffect(() => {
    if (!responsiveHighResUrl) {
      return
    }
    if (isMediaLoaded(responsiveHighResUrl)) {
      setHighResAllowed(true)
      return
    }
    if (!shouldRenderHighRes) {
      return
    }
    const { promise, cancel } = requestMediaLoad(responsiveHighResUrl, priority)
    let active = true
    promise.then((success) => {
      if (active && success) setHighResAllowed(true)
    })
    return () => {
      active = false
      cancel()
    }
  }, [responsiveHighResUrl, shouldRenderHighRes, priority])

  return (
    <article
      className={`canvas-media-node${isLayerMode ? ' canvas-media-node--layer-mode' : ''}`}
      data-node-kind="image"
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
        minWidth={40}
        minHeight={40}
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
        style={{
          borderRadius: modelData?.radius ? `${modelData.radius}px` : undefined,
          border: modelData?.stroke
            ? `${modelData.strokeWidth ?? 1}px solid ${modelData.stroke}`
            : undefined,
          overflow: 'hidden',
        }}
      >
        {hasThumbnail ? (
          <img
            alt={data.alt ?? data.name}
            className="canvas-media-node__content canvas-image-thumbnail"
            decoding="async"
            draggable={false}
            loading="lazy"
            src={thumbnailAllowed ? effectiveThumbnailUrl : undefined}
            style={{
              objectFit: modelData?.objectFit ?? 'cover',
              borderRadius: modelData?.radius ? `${modelData.radius}px` : undefined,
            }}
          />
        ) : null}
        {hasImage && shouldRenderHighRes ? (
          <img
            className={`canvas-media-node__content ${hasThumbnail ? 'canvas-image-highres' : ''} ${highResLoaded ? 'is-loaded' : ''}`}
            decoding="async"
            draggable={false}
            loading="lazy"
            src={highResAllowed ? responsiveHighResUrl : undefined}
            alt={data.alt ?? data.name}
            style={{
              objectFit: modelData?.objectFit ?? 'cover',
              borderRadius: modelData?.radius ? `${modelData.radius}px` : undefined,
            }}
            onLoad={(event) => {
              setHighResLoaded(true)
              data.onImageNaturalSize?.(
                id,
                event.currentTarget.naturalWidth,
                event.currentTarget.naturalHeight,
              )
            }}
            onError={() => {
              if (!hasThumbnail) {
                setFailed(true)
              }
            }}
          />
        ) : !hasThumbnail && !hasImage ? (
          <EmptyMediaPlaceholder kind="image" />
        ) : null}
        {data.generation?.status === 'generating' ? (
          <GenerationOverlay />
        ) : null}
        {hasImage ? (
          <MediaDownloadButton kind="image" name={data.name} url={data.url!} />
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
          kind="image"
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
          mode={data.imagePanelMode}
          onModeChange={(mode) => data.onImagePanelModeChange?.(id, mode)}
          editContent={data.imageEditorContent}
          versionControl={data.versions && data.versions.length > 1 ? <select aria-label="图片版本" value={data.activeVersionId} onChange={(event) => data.onSetImageVersion?.(id, event.target.value)}>{data.versions.map((version) => <option value={version.id} key={version.id}>{version.label ?? version.createdAt}</option>)}</select> : null}
        />
      ) : null}
    </article>
  )
}

const StableImageNode = memo(
  ImageNodeContent,
  (previous, next) =>
    previous.id === next.id &&
    previous.data === next.data &&
    previous.selected === next.selected &&
    previous.isConnectable === next.isConnectable,
)

export function ImageNode(props: NodeProps<CanvasFlowNode>) {
  return <StableImageNode {...props} />
}
