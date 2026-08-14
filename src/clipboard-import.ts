import type { CanvasEdge, CanvasNode, CanvasSnapshotV2 } from './model/project'

export const CANVAS_CLIPBOARD_MIME = 'application/x-libtv-canvas-nodes+json'
const ENVELOPE_KIND = 'libtv-canvas-nodes'
const ENVELOPE_VERSION = 1

export interface CanvasClipboardEnvelope {
  kind: typeof ENVELOPE_KIND
  version: typeof ENVELOPE_VERSION
  sourceCanvasId: string
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export interface ClipboardContents {
  files: File[]
  html: string
  text: string
  internal?: string
}

export type ResolvedClipboardContents =
  | { kind: 'internal'; envelope: CanvasClipboardEnvelope }
  | { kind: 'files'; files: File[] }
  | { kind: 'url'; media: 'image' | 'video'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }

interface ClipboardReader {
  read?: () => Promise<ArrayLike<{ types: readonly string[]; getType(type: string): Promise<Blob> }>>
  readText?: () => Promise<string>
}

interface ClipboardWriter {
  write?: (items: ClipboardItems) => Promise<void>
  writeText?: (text: string) => Promise<void>
}

interface RemoteAssetImporter {
  importAsset(url: string): Promise<{
    id: string
    url: string
    contentType: string
  }>
}

const LOCAL_ASSET_URL = /^\/api\/assets\/([0-9a-f-]{36})$/i

export async function persistRemoteClipboardMedia(
  url: string,
  media: 'image' | 'video',
  importer: RemoteAssetImporter,
): Promise<{ assetId: string; url: string }> {
  const safe = safeMediaUrl(url)
  if (!safe || safe.url !== url || safe.media !== media || !/^https?:$/i.test(new URL(url).protocol)) {
    throw new Error('剪贴板图片地址不安全')
  }
  const asset = await importer.importAsset(url)
  const match = LOCAL_ASSET_URL.exec(asset.url)
  if (
    !match ||
    match[1].toLowerCase() !== asset.id.toLowerCase() ||
    !asset.contentType.startsWith(`${media}/`)
  ) {
    throw new Error('远程素材没有保存为稳定的本地资产')
  }
  return { assetId: asset.id, url: asset.url }
}

const imageExtensions = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
const videoExtensions = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm'])

function extensionOf(value: string): string {
  const clean = value.split(/[?#]/, 1)[0] ?? ''
  return clean.includes('.') ? clean.slice(clean.lastIndexOf('.') + 1).toLowerCase() : ''
}

export function mediaKindForFile(file: File): 'image' | 'video' | undefined {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  const extension = extensionOf(file.name)
  if (imageExtensions.has(extension)) return 'image'
  if (videoExtensions.has(extension)) return 'video'
  return undefined
}

async function sniffMediaKind(file: File): Promise<'image' | 'video' | undefined> {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const ascii = String.fromCharCode(...bytes)
  if (bytes[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'image'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image'
  if (ascii.startsWith('GIF8') || ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image'
  if (ascii.slice(4, 8) === 'ftyp' || ascii.startsWith('\u001aE\udfa3')) return 'video'
  return undefined
}

export async function detectMediaKind(file: File): Promise<'image' | 'video' | undefined> {
  return mediaKindForFile(file) ?? sniffMediaKind(file)
}

async function mediaFiles(files: File[]): Promise<File[]> {
  const resolved: File[] = []
  for (const file of files) {
    if (await detectMediaKind(file)) resolved.push(file)
  }
  return resolved
}

function safeMediaUrl(value: string): { media: 'image' | 'video'; url: string } | undefined {
  const trimmed = value.trim()
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return { media: 'image', url: trimmed }
  if (/^data:video\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return { media: 'video', url: trimmed }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const extension = extensionOf(url.pathname)
  if (imageExtensions.has(extension)) return { media: 'image', url: url.href }
  if (videoExtensions.has(extension)) return { media: 'video', url: url.href }
  return undefined
}

function parseEnvelope(value: string): CanvasClipboardEnvelope | undefined {
  if (!value.trim()) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<CanvasClipboardEnvelope>
    if (
      parsed.kind !== ENVELOPE_KIND ||
      parsed.version !== ENVELOPE_VERSION ||
      typeof parsed.sourceCanvasId !== 'string' ||
      !Array.isArray(parsed.nodes) ||
      !Array.isArray(parsed.edges)
    ) return undefined
    return parsed as CanvasClipboardEnvelope
  } catch {
    return undefined
  }
}

export function createCanvasClipboardEnvelope(
  snapshot: Pick<CanvasSnapshotV2, 'nodes' | 'edges'> & { canvasId?: string },
  selectedNodeIds: string[],
  sourceCanvasId = snapshot.canvasId,
): CanvasClipboardEnvelope {
  const selected = new Set(selectedNodeIds)
  return {
    kind: ENVELOPE_KIND,
    version: ENVELOPE_VERSION,
    sourceCanvasId: sourceCanvasId ?? '',
    nodes: structuredClone(snapshot.nodes.filter((node) => selected.has(node.id))),
    edges: structuredClone(snapshot.edges.filter((edge) => selected.has(edge.source) && selected.has(edge.target))),
  }
}

export async function resolveClipboardContents(contents: ClipboardContents): Promise<ResolvedClipboardContents> {
  const envelope = parseEnvelope(contents.internal || contents.text)
  if (envelope) return { kind: 'internal', envelope }

  const files = await mediaFiles(contents.files)
  if (files.length > 0) return { kind: 'files', files }

  if (contents.html.trim()) {
    const document = new DOMParser().parseFromString(contents.html, 'text/html')
    const source = document.querySelector('img, video, source')?.getAttribute('src')?.trim()
    if (source) {
      const media = safeMediaUrl(source)
      if (media) return { kind: 'url', ...media }
      return { kind: 'error', message: '剪贴板图片地址不安全' }
    }
  }

  const media = safeMediaUrl(contents.text)
  if (media) return { kind: 'url', ...media }
  const text = contents.text.trim()
  return text ? { kind: 'text', text } : { kind: 'empty' }
}

function fileNameForBlob(type: string, index: number): string {
  const extension = type.split('/')[1]?.replace('jpeg', 'jpg') || 'bin'
  return `clipboard-${index + 1}.${extension}`
}

export async function readClipboardContents(clipboard: ClipboardReader): Promise<ClipboardContents> {
  if (clipboard.read) {
    const files: File[] = []
    let html = ''
    let text = ''
    let internal = ''
    const items = Array.from(await clipboard.read())
    for (const [index, item] of items.entries()) {
      for (const type of item.types) {
        const blob = await item.getType(type)
        if (type === CANVAS_CLIPBOARD_MIME) internal = await blob.text()
        else if (type === 'text/html') html = await blob.text()
        else if (type === 'text/plain') text = await blob.text()
        else if (type.startsWith('image/') || type.startsWith('video/')) {
          files.push(new File([blob], fileNameForBlob(type, index), { type }))
        }
      }
    }
    return { files, html, text, internal }
  }
  if (clipboard.readText) return { files: [], html: '', text: await clipboard.readText() }
  throw new Error('当前浏览器不支持读取剪贴板')
}

export function contentsFromDataTransfer(data: DataTransfer | null): ClipboardContents {
  if (!data) return { files: [], html: '', text: '' }
  const directFiles = Array.from(data.files)
  const files = directFiles.length > 0
    ? directFiles
    : Array.from(data.items)
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
  return {
    files,
    html: data.getData('text/html'),
    text: data.getData('text/plain'),
    internal: data.getData(CANVAS_CLIPBOARD_MIME),
  }
}

export async function writeCanvasClipboardEnvelope(
  envelope: CanvasClipboardEnvelope,
  clipboard: ClipboardWriter,
): Promise<string> {
  const serialized = JSON.stringify(envelope)
  const ClipboardItemConstructor = globalThis.ClipboardItem
  if (clipboard.write && ClipboardItemConstructor) {
    try {
      await clipboard.write([new ClipboardItemConstructor({
        [CANVAS_CLIPBOARD_MIME]: new Blob([serialized], { type: CANVAS_CLIPBOARD_MIME }),
        'text/plain': new Blob([serialized], { type: 'text/plain' }),
      })])
      return serialized
    } catch {
      // Chromium may reject custom web clipboard MIME types; plain text remains portable.
    }
  }
  if (clipboard.writeText) {
    await clipboard.writeText(serialized)
    return serialized
  }
  throw new Error('浏览器未允许写入剪贴板')
}

export function materializeCanvasClipboardEnvelope(
  envelope: CanvasClipboardEnvelope,
  createId: (kind: 'node' | 'edge') => string,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const ids = new Map(envelope.nodes.map((node) => [node.id, createId('node')]))
  const nodes = envelope.nodes.map((source) => {
    const node = structuredClone(source)
    node.id = ids.get(source.id)!
    node.name = `${source.name} - 副本`
    node.position = { x: source.position.x + 40, y: source.position.y + 40 }
    if (node.parentId) node.parentId = ids.get(node.parentId)
    if (node.type === 'group' || node.type === 'frame') {
      node.data.childIds = node.data.childIds.flatMap((id) => ids.get(id) ?? [])
    }
    return node
  })
  const edges = envelope.edges.flatMap((source) => {
    const sourceId = ids.get(source.source)
    const targetId = ids.get(source.target)
    if (!sourceId || !targetId) return []
    return [{ ...structuredClone(source), id: createId('edge'), source: sourceId, target: targetId }]
  })
  return { nodes, edges }
}
