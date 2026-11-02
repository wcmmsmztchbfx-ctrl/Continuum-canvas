import type { CanvasNode, MediaGeneration } from '../../model/project.ts'
import {
  materiallyDifferentRatio,
  parseAspectRatio,
  ratioStringFromDimensions,
  resizeAroundCenter,
  sizeForAspectRatio,
} from '../../components/canvas/mediaGeometry.ts'
import type { CanvasStoreState, StoreGet, StoreSet } from '../types.ts'
import type { HistoryContext } from './historySlice.ts'

export function createGenerationActions(
  set: StoreSet,
  get: StoreGet,
  history: HistoryContext,
): Pick<
  CanvasStoreState,
  | 'updateGenerationSettings'
  | 'reconcileImageNaturalSize'
  | 'updateGenerationPrompt'
  | 'createGenerationBatch'
  | 'setMediaGenerationGuarded'
  | 'setMediaAssetGuarded'
  | 'setMediaGeneration'
  | 'setMediaAsset'
> {
  return {
    updateGenerationSettings: (nodeId, settings) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (
        !node ||
        (node.type !== 'image' && node.type !== 'video') ||
        node.type !== settings.kind
      ) {
        return
      }

      const resized =
        parseAspectRatio(settings.aspectRatio) !== undefined
          ? resizeAroundCenter(
              node.position,
              node.size,
              sizeForAspectRatio(settings.aspectRatio),
            )
          : undefined
      history.commitDocument({
        ...current,
        nodes: current.nodes.map((candidate) => {
          if (candidate.id !== nodeId) return candidate
          if (candidate.type === 'image' && settings.kind === 'image') {
            return {
              ...candidate,
              ...(resized ?? {}),
              data: {
                ...candidate.data,
                generationSettings: { ...settings },
              },
            }
          }
          if (candidate.type === 'video' && settings.kind === 'video') {
            return {
              ...candidate,
              ...(resized ?? {}),
              data: {
                ...candidate.data,
                generationSettings: { ...settings },
              },
            }
          }
          return candidate
        }),
      })
    },

    reconcileImageNaturalSize: (nodeId, naturalWidth, naturalHeight) => {
      if (
        !Number.isFinite(naturalWidth) ||
        !Number.isFinite(naturalHeight) ||
        naturalWidth <= 0 ||
        naturalHeight <= 0
      ) {
        return
      }
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (node?.type !== 'image') return

      // Do NOT reset sizes for layer/pasted/uploaded nodes or nodes without generation
      if (node.data.displayMode === 'layer' || !node.data.generation) return
      // If outputAspectRatio is already recorded, do not reconcile again on reload
      if (node.data.generation.outputAspectRatio) return

      const requested = node.data.generation.actualSettings?.aspectRatio ??
        node.data.generationSettings?.aspectRatio
      if (!requested || !materiallyDifferentRatio(requested, naturalWidth, naturalHeight)) {
        return
      }
      const outputAspectRatio = ratioStringFromDimensions(naturalWidth, naturalHeight)
      if (node.data.generation.outputAspectRatio === outputAspectRatio) {
        return
      }
      const next = resizeAroundCenter(
        node.position,
        node.size,
        sizeForAspectRatio(outputAspectRatio),
      )
      if (
        next.size.width === node.size.width &&
        next.size.height === node.size.height &&
        node.data.generation.outputAspectRatio === outputAspectRatio
      ) {
        return
      }
      set({
        snapshot: {
          ...current,
          nodes: current.nodes.map((candidate) =>
            candidate.id === nodeId && candidate.type === 'image'
              ? {
                  ...candidate,
                  ...next,
                  data: {
                    ...candidate.data,
                    generation: {
                      ...candidate.data.generation!,
                      outputAspectRatio,
                    },
                  },
                }
              : candidate,
          ),
        },
      })
    },

    updateGenerationPrompt: (nodeId, prompt) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (
        !node ||
        (node.type !== 'image' && node.type !== 'video') ||
        node.data.promptDraft === prompt
      ) {
        return
      }

      history.commitDocument({
        ...current,
        nodes: current.nodes.map((candidate) => {
          if (candidate.id !== nodeId) return candidate
          if (candidate.type === 'image') {
            return {
              ...candidate,
              data: { ...candidate.data, promptDraft: prompt },
            }
          }
          if (candidate.type === 'video') {
            return {
              ...candidate,
              data: { ...candidate.data, promptDraft: prompt },
            }
          }
          return candidate
        }),
      })
    },

    createGenerationBatch: (input) => {
      const current = get().snapshot
      if (current.projectId !== input.projectId) return undefined
      const source = current.nodes.find((node) => node.id === input.sourceNodeId)
      if (!source || (source.type !== 'image' && source.type !== 'video')) {
        return undefined
      }
      if (
        current.nodes.some((node) => {
          if (node.type !== 'image' && node.type !== 'video') return false
          return (
            node.data.generation?.sourceNodeId === input.sourceNodeId &&
            (node.data.generation.status === 'generating' ||
              node.data.generation.pendingRequest !== undefined)
          )
        })
      ) {
        return undefined
      }

      const existingNodeIds = new Set(current.nodes.map((node) => node.id))
      const existingEdgeIds = new Set(current.edges.map((edge) => edge.id))
      const targetIds = [
        ...input.existingTargetNodeIds,
        ...input.targetNodes.map((node) => node.id),
      ]
      if (
        new Set(targetIds).size !== targetIds.length ||
        targetIds[0] !== source.id ||
        input.targetNodes.some(
          (node) => existingNodeIds.has(node.id) || node.type !== source.type,
        ) ||
        input.outputEdges.some(
          (edge) =>
            existingEdgeIds.has(edge.id) ||
            edge.source !== source.id ||
            edge.relation !== 'output' ||
            !targetIds.includes(edge.target),
        ) ||
        input.existingTargetNodeIds.some((id) => {
          const node = current.nodes.find((candidate) => candidate.id === id)
          return !node || node.type !== source.type
        })
      ) {
        return undefined
      }

      const generationFor = (outputIndex: number): MediaGeneration => ({
        prompt: input.prompt,
        status: 'generating',
        phase: 'queued',
        progress: 0,
        sourceNodeId: source.id,
        clientRequestId: input.clientRequestId,
        outputIndex,
        providerId: input.settings.providerId,
        createdAt: input.createdAt,
        actualSettings: { ...input.settings },
      })
      const outputIndexById = new Map(
        targetIds.map((id, outputIndex) => [id, outputIndex]),
      )
      const existingNodes = current.nodes.map((node) => {
        const outputIndex = outputIndexById.get(node.id)
        if (
          outputIndex === undefined ||
          (node.type !== 'image' && node.type !== 'video')
        ) {
          return node
        }
        return {
          ...node,
          data: { ...node.data, generation: generationFor(outputIndex) },
        } as CanvasNode
      })
      const targetNodes = input.targetNodes.map((node) => {
        const outputIndex = outputIndexById.get(node.id)!
        if (node.type === 'image' || node.type === 'video') {
          return {
            ...node,
            data: { ...node.data, generation: generationFor(outputIndex) },
          } as CanvasNode
        }
        return node
      })

      history.commitDocument({
        ...current,
        nodes: [...existingNodes, ...targetNodes],
        edges: [...current.edges, ...input.outputEdges],
      })
      set({ selectedNodeIds: [targetIds[0] ?? source.id] })
      return targetIds
    },

    setMediaGenerationGuarded: (input) => {
      const current = get().snapshot
      if (current.projectId !== input.projectId) return false
      const node = current.nodes.find((candidate) => candidate.id === input.nodeId)
      if (!node || (node.type !== 'image' && node.type !== 'video')) return false
      const existing = node.data.generation
      if (
        (input.clientRequestId === null
          ? existing?.clientRequestId !== undefined
          : existing?.clientRequestId !== input.clientRequestId) ||
        (input.expectedJobId === null
          ? existing?.jobId !== undefined
          : existing?.jobId !== input.expectedJobId)
      ) {
        return false
      }

      set({
        snapshot: {
          ...current,
          nodes: current.nodes.map((candidate) => {
            if (candidate.id !== input.nodeId) return candidate
            if (candidate.type === 'image') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  ...(input.asset
                    ? { url: input.asset.url, assetId: input.asset.assetId }
                    : {}),
                  generation: { ...input.generation },
                },
              }
            }
            if (candidate.type === 'video') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  ...(input.asset
                    ? { url: input.asset.url, assetId: input.asset.assetId }
                    : {}),
                  ...(input.asset?.poster ? { poster: input.asset.poster } : {}),
                  generation: { ...input.generation },
                },
              }
            }
            return candidate
          }),
        },
      })
      return true
    },

    setMediaAssetGuarded: (input) => {
      const current = get().snapshot
      if (current.projectId !== input.projectId) return false
      const node = current.nodes.find((candidate) => candidate.id === input.nodeId)
      if (
        !node ||
        (node.type !== 'image' && node.type !== 'video') ||
        node.data.url !== input.expectedUrl
      ) {
        return false
      }
      set({
        snapshot: {
          ...current,
          nodes: current.nodes.map((candidate) => {
            if (candidate.id !== input.nodeId) return candidate
            if (candidate.type === 'image') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  url: input.asset.url,
                  assetId: input.asset.assetId,
                },
              }
            }
            if (candidate.type === 'video') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  url: input.asset.url,
                  assetId: input.asset.assetId,
                  ...(input.asset.poster ? { poster: input.asset.poster } : {}),
                },
              }
            }
            return candidate
          }),
        },
      })
      return true
    },

    setMediaGeneration: (nodeId, generation, result = {}) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || (node.type !== 'image' && node.type !== 'video')) return

      set({
        snapshot: {
          ...current,
          nodes: current.nodes.map((candidate) => {
            if (candidate.id !== nodeId) return candidate
            if (candidate.type === 'image') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  ...(result.url ? { url: result.url } : {}),
                  generation: { ...generation },
                },
              }
            }
            if (candidate.type === 'video') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  ...(result.url ? { url: result.url } : {}),
                  ...(result.poster ? { poster: result.poster } : {}),
                  generation: { ...generation },
                },
              }
            }
            return candidate
          }),
        },
      })
    },

    setMediaAsset: (nodeId, asset) => {
      const current = get().snapshot
      const node = current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || (node.type !== 'image' && node.type !== 'video')) return
      if (
        node.data.url === asset.url &&
        (node.type !== 'video' ||
          asset.poster === undefined ||
          node.data.poster === asset.poster)
      ) {
        return
      }
      set({
        snapshot: {
          ...current,
          nodes: current.nodes.map((candidate) => {
            if (candidate.id !== nodeId) return candidate
            if (candidate.type === 'image') {
              return {
                ...candidate,
                data: { ...candidate.data, url: asset.url },
              }
            }
            if (candidate.type === 'video') {
              return {
                ...candidate,
                data: {
                  ...candidate.data,
                  url: asset.url,
                  ...(asset.poster ? { poster: asset.poster } : {}),
                },
              }
            }
            return candidate
          }),
        },
      })
    },
  }
}
