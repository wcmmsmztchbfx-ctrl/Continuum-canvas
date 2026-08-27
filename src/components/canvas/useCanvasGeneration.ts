import { useCallback } from 'react'
import type { StoreApi } from 'zustand/vanilla'

import type { CanvasNode, MediaGenerationSettings, CanvasEdge as ProjectCanvasEdge } from '../../model/project'
import { getOrderedReferences } from '../../model/project'
import type { GenerationQuoteRequest } from '../../contracts/generation'
import type { NodeLeaseKind } from '../../contracts/collaboration'
import type { GenerationController } from '../../services/generationController'
import type { CanvasStoreState } from '../../store/canvas-store'
import { createCanvasId } from '../../utils/id'
import { parseAspectRatio, sizeForAspectRatio } from './mediaGeometry'
import { createConnectedNode } from './nodeCreationHelpers'

export interface UseCanvasGenerationOptions {
  store: StoreApi<CanvasStoreState>
  generationController: Pick<
    GenerationController,
    'start' | 'startSubmitted' | 'resumePersisted' | 'dispose'
  > &
    Partial<Pick<GenerationController, 'retry' | 'retrySubmitted'>>
  readOnly?: boolean
  onGenerationError?: (message: string) => void
  runWithNodeLease: <T,>(
    nodeIds: readonly string[],
    kind: NodeLeaseKind,
    action: () => T | Promise<T>,
  ) => Promise<Awaited<T> | undefined>
}

export function useCanvasGeneration({
  store,
  generationController,
  readOnly = false,
  onGenerationError,
  runWithNodeLease,
}: UseCanvasGenerationOptions) {
  const createConnectedAfterNode = useCallback(
    (anchorNodeId: string, kind: 'image' | 'video' | 'text') => {
      if (readOnly) return
      const current = store.getState().snapshot
      const anchor = current.nodes.find((node) => node.id === anchorNodeId)
      if (!anchor) return

      const prefix = kind === 'image' ? 'i' : kind === 'video' ? 'v' : 't'
      const nodeId = createCanvasId(prefix)
      const node = createConnectedNode(
        kind,
        nodeId,
        {
          x: anchor.position.x + anchor.size.width + 180,
          y: anchor.position.y + (anchor.size.height - (kind === 'text' ? 350 : kind === 'image' ? 320 : 270)) / 2,
        },
      )
      const isReference =
        (anchor.type === 'image' || anchor.type === 'video') &&
        (node.type === 'image' || node.type === 'video')
      const edge: ProjectCanvasEdge = {
        id: createCanvasId('e'),
        source: anchorNodeId,
        target: nodeId,
        sourceHandle: 'source',
        targetHandle: 'target',
        type: 'canvas',
        relation: isReference ? 'reference' : 'flow',
        ...(isReference ? { referenceAlias: 1 } : {}),
      }
      const relatedNodeIds = current.edges.flatMap((candidate) =>
        candidate.source === anchorNodeId || candidate.target === anchorNodeId
          ? [candidate.source, candidate.target]
          : [],
      )
      void runWithNodeLease(
        [anchorNodeId, ...relatedNodeIds],
        'bulk',
        () => store.getState().addConnectedNode(node, edge),
      )
    },
    [readOnly, runWithNodeLease, store],
  )

  const performGenerate = useCallback(
    (sourceNodeId: string, request: GenerationQuoteRequest) => {
      if (readOnly) return
      const current = store.getState().snapshot
      const source = current.nodes.find((node) => node.id === sourceNodeId)
      if (!source || (source.type !== 'image' && source.type !== 'video')) return

      if (request.mediaType !== source.type) return
      if (request.projectId !== current.projectId) {
        onGenerationError?.('项目已切换，请重新确认本次生成')
        return
      }
      const configuredCount = request.n ?? 1
      const resultCount = Number.isInteger(configuredCount)
        ? Math.max(1, Math.min(16, configuredCount))
        : 1
      const targetNodeIds: string[] = []
      const targetNodes: CanvasNode[] = []
      const outputEdges: ProjectCanvasEdge[] = []
      const frozenReferences = getOrderedReferences(current, source.id).flatMap(
        ({ edge, node }) =>
          node.type === 'image' || node.type === 'video'
            ? [{
                alias: edge.referenceAlias,
                mediaType: node.type,
                nodeId: node.id,
              }]
            : [],
      )
      const frozenSettings: MediaGenerationSettings = request.mediaType === 'image'
        ? {
            kind: 'image',
            providerId: request.providerId,
            catalogVersion: request.catalogVersion,
            channel: request.channel,
            model: request.model,
            mode: request.mode,
            quality: request.quality ?? '',
            resolution: request.quality ?? '',
            aspectRatio: request.aspectRatio ?? '',
            count: request.n ?? 1,
          }
        : {
            kind: 'video',
            providerId: request.providerId,
            catalogVersion: request.catalogVersion,
            channel: request.channel,
            model: request.model,
            mode: request.mode,
            resolution: request.quality ?? '',
            aspectRatio: request.aspectRatio ?? '',
            durationSec: request.duration ?? 1,
            generateAudio: request.generateAudio ?? false,
            count: request.n ?? 1,
          }
      const resultSize = parseAspectRatio(request.aspectRatio ?? '')
        ? sizeForAspectRatio(request.aspectRatio ?? '16:9')
        : { ...source.size }
      const createResult = (index: number) => {
        const prefix = source.type === 'image' ? 'i' : 'v'
        const resultNodeId = createCanvasId(prefix)
        const resultHeight = resultSize.height
        const resultWidth = resultSize.width
        const resultNode = createConnectedNode(
          source.type,
          resultNodeId,
          {
            x:
              source.position.x +
              source.size.width +
              180 +
              Math.floor(index / 2) * (resultWidth + 80),
            y: source.position.y + (index % 2) * (resultHeight + 60),
          },
        )
        resultNode.size = { ...resultSize }
        if (source.type === 'image' && resultNode.type === 'image') {
          resultNode.data.generationSettings = frozenSettings.kind === 'image'
            ? { ...frozenSettings }
            : undefined
        }
        if (source.type === 'video' && resultNode.type === 'video') {
          resultNode.data.generationSettings = frozenSettings.kind === 'video'
            ? { ...frozenSettings }
            : undefined
        }
        targetNodes.push(resultNode)
        outputEdges.push({
          id: createCanvasId('e'),
          source: source.id,
          target: resultNode.id,
          sourceHandle: 'source',
          targetHandle: 'target',
          type: 'canvas',
          relation: 'output',
        })
        targetNodeIds.push(resultNode.id)
      }

      targetNodeIds.push(source.id)
      for (let index = 1; index < resultCount; index += 1) {
        createResult(index - 1)
      }
      const input = {
        canvasId: request.canvasId,
        projectId: request.projectId,
        sourceNodeId: source.id,
        targetNodeIds,
        targetNodes,
        outputEdges,
        prompt: request.prompt,
        clientRequestId: request.clientRequestId,
        references: frozenReferences,
        settings: frozenSettings,
      }
      return generationController.startSubmitted(input)
        .catch((error: unknown) => {
          onGenerationError?.(
            error instanceof Error ? error.message : '生成任务创建失败',
          )
        })
    },
    [generationController, onGenerationError, readOnly, store],
  )

  const handleGenerate = useCallback(
    (sourceNodeId: string, request: GenerationQuoteRequest) => {
      if (readOnly) return
      const lockIds = [
        sourceNodeId,
        ...getOrderedReferences(store.getState().snapshot, sourceNodeId)
          .map(({ node }) => node.id),
      ]
      let submitted = false
      void runWithNodeLease(lockIds, 'bulk', async () => {
        submitted = true
        await performGenerate(sourceNodeId, request)
      })
        .then(() => {
          if (!submitted) {
            onGenerationError?.('生成所需节点正在被其他协作者操作，请稍后再试')
          }
        })
    },
    [onGenerationError, performGenerate, readOnly, runWithNodeLease, store],
  )

  const performRetry = useCallback(
    (sourceNodeId: string, prompt: string) => {
      if (readOnly) return
      const targetNodeIds = store
        .getState()
        .snapshot.nodes.filter((node) => {
          if (node.type !== 'image' && node.type !== 'video') return false
          return node.data.generation?.sourceNodeId === sourceNodeId
        })
        .sort(
          (left, right) =>
            (left.type === 'image' || left.type === 'video'
              ? left.data.generation?.outputIndex ?? 0
              : 0) -
            (right.type === 'image' || right.type === 'video'
              ? right.data.generation?.outputIndex ?? 0
              : 0),
        )
        .map((node) => node.id)
      if (!generationController.retry || targetNodeIds.length === 0) {
        onGenerationError?.('没有可恢复的生成请求')
        return
      }
      const input = { sourceNodeId, targetNodeIds, prompt }
      return (generationController.retrySubmitted
        ? generationController.retrySubmitted(input)
        : generationController.retry?.(input))
        ?.catch((error: unknown) => {
          onGenerationError?.(
            error instanceof Error ? error.message : '生成任务恢复失败',
          )
        })
    },
    [generationController, onGenerationError, readOnly, store],
  )

  const handleRetry = useCallback(
    (sourceNodeId: string, prompt: string) => {
      if (readOnly) return
      const current = store.getState().snapshot
      const targetNodeIds = current.nodes.flatMap((node) =>
        (node.type === 'image' || node.type === 'video') &&
        node.data.generation?.sourceNodeId === sourceNodeId
          ? [node.id]
          : [],
      )
      const referenceSourceIds = getOrderedReferences(current, sourceNodeId)
        .map(({ node }) => node.id)
      void runWithNodeLease(
        [sourceNodeId, ...targetNodeIds, ...referenceSourceIds],
        'bulk',
        () => performRetry(sourceNodeId, prompt),
      )
    },
    [performRetry, readOnly, runWithNodeLease, store],
  )

  return {
    createConnectedAfterNode,
    performGenerate,
    handleGenerate,
    performRetry,
    handleRetry,
  }
}
