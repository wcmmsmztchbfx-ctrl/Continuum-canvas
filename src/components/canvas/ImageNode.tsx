import { memo, useEffect, useState } from 'react'
import { Position, type NodeProps } from '@xyflow/react'

import { EmptyMediaPlaceholder } from './EmptyMediaPlaceholder'
import { EditableNodeLabel } from './EditableNodeLabel'
import { GenerationOverlay } from './GenerationOverlay'
import { MediaDownloadButton } from './MediaDownloadButton'
import type { CanvasFlowNode } from './mapping'
import { NodeGeneratorPanel } from './NodeGeneratorPanel'
import { NodeHandle } from './NodeHandle'
import './canvas.css'

function ImageNodeContent({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<CanvasFlowNode>) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [data.url])
  const hasImage = Boolean(data.url) && !failed
  const showDetails = selected && data.isSoleSelection !== false

  return (
    <article
      className="canvas-media-node"
      data-node-kind="image"
      data-generation-status={data.generation?.status}
      data-reference-candidate={data.referencePickCandidate || undefined}
      data-reference-target={data.referencePickTarget || undefined}
      aria-label={data.name}
    >
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
        {hasImage ? (
          <img
            className="canvas-media-node__content"
            src={data.url}
            alt={data.alt ?? data.name}
            draggable={false}
            onLoad={(event) => {
              data.onImageNaturalSize?.(
                id,
                event.currentTarget.naturalWidth,
                event.currentTarget.naturalHeight,
              )
            }}
            onError={() => setFailed(true)}
          />
        ) : (
          <EmptyMediaPlaceholder kind="image" />
        )}
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
