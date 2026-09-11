import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  CanvasCreateNodeOperation,
  CanvasOperation,
  CanvasOperationBatch,
  CanvasOperationReceipt,
} from '../src/contracts/agent-api.ts'
import { parseCanvasSnapshot, type CanvasEdge, type CanvasNode, type CanvasSnapshotV2 } from '../src/model/project.ts'
import { atomicWriteJson } from './atomic-json.ts'
import type { CanvasDocumentService } from './canvas-document-service.ts'

interface ReceiptState {
  version: 1
  receipts: Record<string, CanvasOperationReceipt>
}

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function dimensions(ratio: string | undefined, fallback: { width: number; height: number }) {
  if (!ratio) return fallback
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio)
  if (!match) return fallback
  const value = Number(match[1]) / Number(match[2])
  if (!Number.isFinite(value) || value <= 0) return fallback
  const area = fallback.width * fallback.height
  return { width: Math.round(Math.sqrt(area * value)), height: Math.round(Math.sqrt(area / value)) }
}

function nextPosition(snapshot: CanvasSnapshotV2, index: number) {
  const maxX = snapshot.nodes.reduce((value, node) => Math.max(value, node.position.x + node.size.width), 0)
  return { x: maxX + 100 + (index % 3) * 420, y: Math.floor(index / 3) * 320 }
}

function buildNode(operation: CanvasCreateNodeOperation, snapshot: CanvasSnapshotV2, index: number): CanvasNode {
  const input = operation.node
  const id = input.id ?? randomUUID()
  const position = input.position ?? nextPosition(snapshot, index)
  if (input.kind === 'image') {
    const size = input.size ?? dimensions(input.aspectRatio, { width: 384, height: 216 })
    return { id, type: 'image', name: input.name, position, size, data: {
      url: '', promptDraft: input.prompt ?? '', referenceNodeIds: input.referenceNodeIds ?? [],
      generationSettings: { kind: 'image', quality: input.resolution ?? '1K', resolution: input.resolution ?? '1K', aspectRatio: input.aspectRatio ?? '16:9', count: 1 },
    } }
  }
  if (input.kind === 'video') {
    const size = input.size ?? dimensions(input.aspectRatio, { width: 480, height: 270 })
    return { id, type: 'video', name: input.name, position, size, data: {
      url: '', promptDraft: input.prompt ?? '', referenceNodeIds: input.referenceNodeIds ?? [],
      generationSettings: { kind: 'video', resolution: input.resolution ?? '720P', aspectRatio: input.aspectRatio ?? '16:9', durationSec: input.durationSec ?? 5, generateAudio: false, count: 1 },
    } }
  }
  if (input.kind === 'director') {
    return { id, type: 'group', name: input.name, position, size: input.size ?? { width: 540, height: 700 }, data: {
      childIds: [], nodeKind: 'director', promptDraft: input.prompt ?? '', messages: [], assets: [],
    } }
  }
  if (input.kind === 'frame') {
    return { id, type: 'frame', name: input.name, position, size: input.size ?? { width: 1280, height: 720 }, data: {
      childIds: [], fill: '#111111', stroke: '#666666', strokeWidth: 1, strokeStyle: 'dashed', opacity: 0.2,
    } }
  }
  return { id, type: 'text', name: input.kind === 'skill' && !input.name.endsWith('-skill') ? `${input.name}-skill` : input.name,
    position, size: input.size ?? { width: input.kind === 'skill' ? 360 : 440, height: input.kind === 'skill' ? 240 : 520 },
    data: { text: input.text ?? '', nodeKind: input.kind === 'skill' ? 'skill' : 'script', presentation: input.kind === 'skill' ? 'workflow-card' : 'plain' },
  }
}

function resolve(value: string, aliases: Record<string, string>): string {
  return value.startsWith('$') ? aliases[value.slice(1)] ?? value : aliases[value] ?? value
}

function patchNode(node: CanvasNode, patch: Extract<CanvasOperation, { type: 'node.update' }>['patch']): CanvasNode {
  const next = structuredClone(node)
  if (patch.name !== undefined) next.name = patch.name
  if (patch.position !== undefined) next.position = patch.position
  if (patch.size !== undefined) next.size = patch.size
  if (next.type === 'text' && patch.text !== undefined) next.data.text = patch.text
  if ((next.type === 'image' || next.type === 'video') && patch.prompt !== undefined) next.data.promptDraft = patch.prompt
  if (next.type === 'group' && next.data.nodeKind === 'director' && patch.prompt !== undefined) next.data.promptDraft = patch.prompt
  if ((next.type === 'image' || next.type === 'video') && patch.referenceNodeIds !== undefined) next.data.referenceNodeIds = patch.referenceNodeIds
  if ((next.type === 'image' || next.type === 'video') && next.data.generationSettings) {
    if (patch.aspectRatio !== undefined) next.data.generationSettings.aspectRatio = patch.aspectRatio
    if (patch.resolution !== undefined) next.data.generationSettings.resolution = patch.resolution
    if (next.type === 'video' && patch.durationSec !== undefined) next.data.generationSettings.durationSec = patch.durationSec
  }
  return next
}

function applyLayout(snapshot: CanvasSnapshotV2, operation: Extract<CanvasOperation, { type: 'layout.apply' }>) {
  const ids = new Set(operation.nodeIds ?? snapshot.nodes.map((node) => node.id))
  const selected = snapshot.nodes.filter((node) => ids.has(node.id))
  selected.forEach((node, index) => {
    if (operation.strategy === 'storyboard_horizontal') node.position = { x: index * 520, y: 0 }
    else if (operation.strategy === 'grid') node.position = { x: (index % 3) * 520, y: Math.floor(index / 3) * 620 }
    else node.position = { x: Math.floor(Math.log2(index + 1)) * 560, y: (index - (2 ** Math.floor(Math.log2(index + 1)) - 1)) * 420 }
  })
}

export class CanvasOperationService {
  readonly #documents: CanvasDocumentService
  readonly #statePath: string
  readonly #auditPath: string
  #state: ReceiptState = { version: 1, receipts: {} }
  readonly #inFlight = new Map<string, Promise<CanvasOperationReceipt>>()

  private constructor(dataDir: string, documents: CanvasDocumentService) {
    this.#documents = documents
    this.#statePath = join(dataDir, 'agent-operation-receipts.json')
    this.#auditPath = join(dataDir, 'agent-audit.ndjson')
  }

  static async open(dataDir: string, documents: CanvasDocumentService): Promise<CanvasOperationService> {
    const service = new CanvasOperationService(dataDir, documents)
    try {
      const parsed = JSON.parse(await readFile(service.#statePath, 'utf8')) as ReceiptState
      if (parsed?.version === 1 && parsed.receipts) service.#state = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return service
  }

  async execute(canvasId: string, batch: CanvasOperationBatch, actorId: string): Promise<CanvasOperationReceipt> {
    const key = `${canvasId}:${batch.operationId}`
    const active = this.#inFlight.get(key)
    if (active) return { ...structuredClone(await active), replayed: true }
    const operation = this.#execute(canvasId, batch, actorId)
    this.#inFlight.set(key, operation)
    try {
      return await operation
    } finally {
      if (this.#inFlight.get(key) === operation) this.#inFlight.delete(key)
    }
  }

  async #execute(canvasId: string, batch: CanvasOperationBatch, actorId: string): Promise<CanvasOperationReceipt> {
    if (!OPERATION_ID.test(batch.operationId) || !Array.isArray(batch.operations) || batch.operations.length === 0 || batch.operations.length > 200) {
      throw new Error('Canvas operation batch is invalid')
    }
    const receiptKey = `${canvasId}:${batch.operationId}`
    const existing = this.#state.receipts[receiptKey]
    if (existing) return { ...structuredClone(existing), replayed: true }

    const committedAt = new Date().toISOString()
    const committed = await this.#documents.mutate({
      canvasId,
      baseRevision: batch.baseRevision,
      origin: `agent:${actorId}`,
      mutation: (snapshot) => {
        const aliases: Record<string, string> = {}
        const createdNodeIds: string[] = []
        const updatedNodeIds: string[] = []
        const deletedNodeIds: string[] = []
        const createdEdgeIds: string[] = []
        const deletedEdgeIds: string[] = []
        batch.operations.forEach((operation, index) => {
          if (operation.type === 'node.create') {
            const node = buildNode(operation, snapshot, index)
            if (snapshot.nodes.some((candidate) => candidate.id === node.id)) throw new Error(`Node already exists: ${node.id}`)
            snapshot.nodes.push(node)
            createdNodeIds.push(node.id)
            if (operation.alias) aliases[operation.alias] = node.id
          } else if (operation.type === 'node.update') {
            const nodeId = resolve(operation.nodeId, aliases)
            const nodeIndex = snapshot.nodes.findIndex((node) => node.id === nodeId)
            if (nodeIndex < 0) throw new Error(`Node not found: ${nodeId}`)
            snapshot.nodes[nodeIndex] = patchNode(snapshot.nodes[nodeIndex]!, operation.patch)
            updatedNodeIds.push(nodeId)
          } else if (operation.type === 'node.delete') {
            const nodeId = resolve(operation.nodeId, aliases)
            if (!snapshot.nodes.some((node) => node.id === nodeId)) throw new Error(`Node not found: ${nodeId}`)
            snapshot.nodes = snapshot.nodes.filter((node) => node.id !== nodeId)
            snapshot.edges = snapshot.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
            deletedNodeIds.push(nodeId)
          } else if (operation.type === 'edge.create') {
            const edge: CanvasEdge = {
              id: operation.edge.id ?? randomUUID(),
              source: resolve(operation.edge.source, aliases),
              target: resolve(operation.edge.target, aliases),
              sourceHandle: 'source', targetHandle: 'target', relation: operation.edge.relation,
              ...(operation.edge.referenceAlias !== undefined ? { referenceAlias: operation.edge.referenceAlias } : {}),
            }
            if (!snapshot.nodes.some((node) => node.id === edge.source) || !snapshot.nodes.some((node) => node.id === edge.target)) {
              throw new Error('Edge endpoints must exist')
            }
            if (snapshot.edges.some((candidate) => candidate.id === edge.id)) throw new Error(`Edge already exists: ${edge.id}`)
            snapshot.edges.push(edge)
            createdEdgeIds.push(edge.id)
            if (operation.alias) aliases[operation.alias] = edge.id
          } else if (operation.type === 'edge.delete') {
            const edgeId = resolve(operation.edgeId, aliases)
            if (!snapshot.edges.some((edge) => edge.id === edgeId)) throw new Error(`Edge not found: ${edgeId}`)
            snapshot.edges = snapshot.edges.filter((edge) => edge.id !== edgeId)
            deletedEdgeIds.push(edgeId)
          } else if (operation.type === 'layout.apply') applyLayout(snapshot, operation)
        })
        const normalized = parseCanvasSnapshot(JSON.stringify(snapshot))
        return { snapshot: normalized, result: { aliases, createdNodeIds, updatedNodeIds, deletedNodeIds, createdEdgeIds, deletedEdgeIds } }
      },
    })
    const receipt: CanvasOperationReceipt = {
      operationId: batch.operationId, canvasId, projectId: committed.snapshot.projectId,
      revision: committed.revision, ...committed.result, replayed: false, committedAt,
    }
    this.#state.receipts[receiptKey] = receipt
    const keys = Object.keys(this.#state.receipts)
    if (keys.length > 5_000) for (const key of keys.slice(0, keys.length - 5_000)) delete this.#state.receipts[key]
    await mkdir(join(this.#statePath, '..'), { recursive: true })
    await atomicWriteJson(this.#statePath, this.#state)
    await appendFile(this.#auditPath, `${JSON.stringify({ ...receipt, actorId, operations: batch.operations.map((item) => item.type) })}\n`, 'utf8')
    return receipt
  }
}
