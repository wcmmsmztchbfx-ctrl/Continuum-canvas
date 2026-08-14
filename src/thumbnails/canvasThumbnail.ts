import type { CanvasNode, CanvasSnapshotV2, Point } from '../model/project'
import {
  deleteCanvasThumbnail,
  loadCanvasThumbnail,
  saveCanvasThumbnail,
  type CanvasThumbnailRecord,
} from '../persistence/projectRepository'

export const CANVAS_THUMBNAIL_WIDTH = 640
export const CANVAS_THUMBNAIL_HEIGHT = 360
const THUMBNAIL_DELAY_MS = 2_000
const THUMBNAIL_PADDING = 28

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const item = canonicalize((value as Record<string, unknown>)[key])
      if (item !== undefined) result[key] = item
      return result
    }, {})
}

export function computeCanvasThumbnailHash(snapshot: CanvasSnapshotV2): string {
  const visualNodes = snapshot.nodes.map((node) => {
    const base = {
      id: node.id,
      type: node.type,
      position: node.position,
      size: node.size,
      parentId: node.parentId,
      hidden: node.hidden,
    }
    if (node.type === 'image') return { ...base, data: { url: node.data.url } }
    if (node.type === 'video') {
      return { ...base, data: { poster: node.data.poster, url: node.data.poster ? undefined : node.data.url } }
    }
    if (node.type === 'text') {
      return {
        ...base,
        data: {
          text: node.data.text,
          fontSize: node.data.fontSize,
          color: node.data.color,
        },
      }
    }
    return { ...base, data: node.data }
  })
  const serialized = JSON.stringify(canonicalize({
    nodes: visualNodes,
    edges: snapshot.edges,
  }))
  let hash = 0x811c9dc5
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function absolutePosition(node: CanvasNode, byId: Map<string, CanvasNode>): Point {
  let x = node.position.x
  let y = node.position.y
  let parentId = node.parentId
  const visited = new Set<string>()
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentId
  }
  return { x, y }
}

function imageUrl(node: CanvasNode): string | undefined {
  if (node.type === 'image') return node.data.url || undefined
  if (node.type === 'video') return node.data.poster || undefined
  return undefined
}

function defaultLoadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Unable to load thumbnail media: ${url}`))
    image.src = url
  })
}

export interface CanvasThumbnailRenderOptions {
  createCanvas?: () => HTMLCanvasElement
  loadImage?: (url: string) => Promise<CanvasImageSource>
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Unable to encode canvas thumbnail')),
      'image/webp',
      0.82,
    )
  })
}

export async function renderCanvasThumbnail(
  snapshot: CanvasSnapshotV2,
  options: CanvasThumbnailRenderOptions = {},
): Promise<Blob> {
  const canvas = options.createCanvas?.() ?? document.createElement('canvas')
  canvas.width = CANVAS_THUMBNAIL_WIDTH
  canvas.height = CANVAS_THUMBNAIL_HEIGHT
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas2D is unavailable')

  context.fillStyle = '#141516'
  context.fillRect(0, 0, canvas.width, canvas.height)
  const visibleNodes = snapshot.nodes.filter((node) => !node.hidden)
  if (visibleNodes.length === 0) return canvasToBlob(canvas)

  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const positions = new Map(visibleNodes.map((node) => [node.id, absolutePosition(node, byId)]))
  const minX = Math.min(...visibleNodes.map((node) => positions.get(node.id)!.x))
  const minY = Math.min(...visibleNodes.map((node) => positions.get(node.id)!.y))
  const maxX = Math.max(...visibleNodes.map((node) => positions.get(node.id)!.x + node.size.width))
  const maxY = Math.max(...visibleNodes.map((node) => positions.get(node.id)!.y + node.size.height))
  const contentWidth = Math.max(1, maxX - minX)
  const contentHeight = Math.max(1, maxY - minY)
  const scale = Math.min(
    (canvas.width - THUMBNAIL_PADDING * 2) / contentWidth,
    (canvas.height - THUMBNAIL_PADDING * 2) / contentHeight,
  )
  const offsetX = (canvas.width - contentWidth * scale) / 2 - minX * scale
  const offsetY = (canvas.height - contentHeight * scale) / 2 - minY * scale
  const point = (value: Point) => ({
    x: value.x * scale + offsetX,
    y: value.y * scale + offsetY,
  })

  context.strokeStyle = '#555b64'
  context.lineWidth = Math.max(1, scale)
  for (const edge of snapshot.edges) {
    const sourceNode = byId.get(edge.source)
    const targetNode = byId.get(edge.target)
    const sourcePosition = positions.get(edge.source)
    const targetPosition = positions.get(edge.target)
    if (!sourceNode || !targetNode || !sourcePosition || !targetPosition) continue
    const source = point({
      x: sourcePosition.x + sourceNode.size.width,
      y: sourcePosition.y + sourceNode.size.height / 2,
    })
    const target = point({
      x: targetPosition.x,
      y: targetPosition.y + targetNode.size.height / 2,
    })
    context.beginPath()
    context.moveTo(source.x, source.y)
    context.lineTo(target.x, target.y)
    context.stroke()
  }

  const loadImage = options.loadImage ?? defaultLoadImage
  for (const node of visibleNodes) {
    const position = point(positions.get(node.id)!)
    const width = Math.max(2, node.size.width * scale)
    const height = Math.max(2, node.size.height * scale)
    context.fillStyle = node.type === 'frame' || node.type === 'group' ? '#202327' : '#292d33'
    context.fillRect(position.x, position.y, width, height)
    const mediaUrl = imageUrl(node)
    if (mediaUrl) {
      try {
        const image = await loadImage(mediaUrl)
        context.drawImage(image, position.x, position.y, width, height)
      } catch {
        context.strokeStyle = '#68707c'
        context.strokeRect(position.x, position.y, width, height)
      }
    } else if (node.type === 'text') {
      context.fillStyle = node.data.color || '#f4f5f7'
      context.font = `${Math.max(8, Math.min(22, (node.data.fontSize ?? 16) * scale))}px sans-serif`
      context.textBaseline = 'top'
      context.fillText(node.data.text.slice(0, 80), position.x + 6, position.y + 6, Math.max(1, width - 12))
    } else {
      context.strokeStyle = node.type === 'shape' ? node.data.stroke : '#68707c'
      context.strokeRect(position.x, position.y, width, height)
    }
  }
  return canvasToBlob(canvas)
}

export interface CanvasThumbnailDependencies {
  load: (canvasId: string) => Promise<CanvasThumbnailRecord | undefined>
  save: (record: CanvasThumbnailRecord) => Promise<void>
  delete: (canvasId: string) => Promise<void>
  render?: (snapshot: CanvasSnapshotV2) => Promise<Blob>
  now?: () => string
}

interface PendingThumbnail {
  snapshot: CanvasSnapshotV2
  timer: ReturnType<typeof setTimeout>
}

export class CanvasThumbnailService {
  private readonly pending = new Map<string, PendingThumbnail>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly dependencies: CanvasThumbnailDependencies

  constructor(dependencies: CanvasThumbnailDependencies) {
    this.dependencies = dependencies
  }

  schedule(snapshot: CanvasSnapshotV2): void {
    const existing = this.pending.get(snapshot.canvasId)
    if (existing) clearTimeout(existing.timer)
    const copy = structuredClone(snapshot)
    const timer = setTimeout(() => {
      this.pending.delete(copy.canvasId)
      void this.persist(copy)
    }, THUMBNAIL_DELAY_MS)
    this.pending.set(copy.canvasId, { snapshot: copy, timer })
  }

  async flush(canvasId: string): Promise<void> {
    const pending = this.pending.get(canvasId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pending.delete(canvasId)
      await this.persist(pending.snapshot)
      return
    }
    await this.running.get(canvasId)
  }

  async delete(canvasId: string): Promise<void> {
    const pending = this.pending.get(canvasId)
    if (pending) clearTimeout(pending.timer)
    this.pending.delete(canvasId)
    await this.dependencies.delete(canvasId)
  }

  private persist(snapshot: CanvasSnapshotV2): Promise<void> {
    const previous = this.running.get(snapshot.canvasId) ?? Promise.resolve()
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const contentHash = computeCanvasThumbnailHash(snapshot)
        const existing = await this.dependencies.load(snapshot.canvasId)
        if (existing?.contentHash === contentHash) return
        const blob = await (this.dependencies.render ?? renderCanvasThumbnail)(snapshot)
        await this.dependencies.save({
          canvasId: snapshot.canvasId,
          blob,
          width: CANVAS_THUMBNAIL_WIDTH,
          height: CANVAS_THUMBNAIL_HEIGHT,
          contentHash,
          updatedAt: (this.dependencies.now ?? (() => new Date().toISOString()))(),
        })
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.running.get(snapshot.canvasId) === operation) {
          this.running.delete(snapshot.canvasId)
        }
      })
    this.running.set(snapshot.canvasId, operation)
    return operation
  }
}

export const canvasThumbnailService = new CanvasThumbnailService({
  load: loadCanvasThumbnail,
  save: saveCanvasThumbnail,
  delete: deleteCanvasThumbnail,
})
