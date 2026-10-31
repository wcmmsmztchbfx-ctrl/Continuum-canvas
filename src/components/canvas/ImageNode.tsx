import { memo, useEffect, useRef, useState } from 'react'
import { NodeResizer, Position, type NodeProps } from '@xyflow/react'

import { EmptyMediaPlaceholder } from './EmptyMediaPlaceholder'
import { EditableNodeLabel } from './EditableNodeLabel'
import { GenerationOverlay } from './GenerationOverlay'
import { MediaDownloadButton } from './MediaDownloadButton'
import type { CanvasFlowNode } from './mapping'
import { LazyNodeGeneratorPanel as NodeGeneratorPanel } from './lazyPanels'
import { NodeHandle } from './NodeHandle'
import { cacheThumbnailFromElement } from '../../services/imageThumbnailCache'
import { useCanvasMediaDemand } from './canvasMediaDemand'
import { useMediaResource } from './useMediaResource'
import {
  computeAppearanceStyles,
  NOISE_SVG_DATA_URI,
  TEXTURE_DOTS_DATA_URI,
} from './effectStyleUtils'
import './canvas.css'


function ImageNodeContent({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<CanvasFlowNode>) {
  const [highResLoaded, setHighResLoaded] = useState(false)
  const resizeGranted = useRef(false)
  const media = useCanvasMediaDemand(id, Boolean(selected))
  const assetId = data.node?.type === 'image' ? data.node.data.assetId : undefined
  const sourceUrl = (media.variant === 128 || media.variant === 360) && data.thumbnailUrl ? data.thumbnailUrl : data.url
  const resource = useMediaResource({ url: sourceUrl ?? '', assetId, version: data.activeVersionId }, media.variant, media.demand)
  const hasImage = Boolean(data.url)
  const isLayerMode = data.node?.type === 'image' && data.node.data.displayMode === 'layer'
  const showResizer = isLayerMode && selected && data.isSoleSelection !== false
  const showDetails = selected && data.isSoleSelection !== false && !isLayerMode && (data.generatorOpen ?? true)
  const modelData = data.node?.type === 'image' ? data.node.data : undefined
  const appearance = computeAppearanceStyles((modelData || {}) as Parameters<typeof computeAppearanceStyles>[0])
  // The resizer already uses React Flow's autoScale; no global zoom subscription.
  const zoom = 1
  useEffect(() => { setHighResLoaded(false) }, [data.url])

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
        '--resizer-scale': Math.min(1.35, Math.max(1, 1 / (zoom || 1))),
      } as React.CSSProperties}
    >
      <NodeResizer
        isVisible={showResizer}
        keepAspectRatio={true}
        minWidth={40}
        minHeight={40}
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
        {resource.displayUrl ? (
          <img
            key={resource.bindingKey}
            className={`canvas-media-node__content canvas-image-highres ${highResLoaded ? 'is-loaded' : ''}`}
            decoding="async"
            draggable={false}
            src={resource.displayUrl}
            data-source-url={data.url}
            alt={data.alt ?? data.name}
            style={{ objectFit: modelData?.objectFit ?? 'cover', borderRadius: modelData?.radius ? `${modelData.radius}px` : undefined }}
            onLoad={(event) => {
              resource.onLoad()
              setHighResLoaded(true)
              if (resource.displayedSource === data.url) {
                if (resource.originalWidth && resource.originalHeight) {
                  data.onImageNaturalSize?.(id, resource.originalWidth, resource.originalHeight)
                } else if (media.variant === 'original') {
                  data.onImageNaturalSize?.(id, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
                }
              }
              if (data.url && !resource.preview && !resource.preserveAnimation && resource.displayedSource === data.url) cacheThumbnailFromElement({ url: data.url, assetId, version: data.activeVersionId }, event.currentTarget)
            }}
            onError={resource.onError}
          />
        ) : !hasImage ? <EmptyMediaPlaceholder kind="image" /> : null}
        {resource.failed ? <button className="nodrag" onClick={resource.retry} type="button">加载失败，重试</button> : null}
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
          editAvailable={hasImage}
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
