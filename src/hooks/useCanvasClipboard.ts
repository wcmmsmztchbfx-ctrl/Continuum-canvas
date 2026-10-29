import { useCallback, useEffect, useRef } from 'react'
import type { StoreApi } from 'zustand/vanilla'

import type { CanvasNode } from '../model/project'
import {
  DEFAULT_IMAGE_GENERATION_SETTINGS,
  DEFAULT_VIDEO_GENERATION_SETTINGS,
} from '../model/project'
import type { CanvasStoreState } from '../store/canvas-store'
import {
  contentsFromDataTransfer,
  parseEnvelope,
  persistRemoteClipboardMedia,
  resolveClipboardContents,
  safeMediaUrl,
  type CanvasClipboardEnvelope,
  type ClipboardContents,
} from '../clipboard-import'
import { gatewayClient, persistLocalMedia, uploadAndPrepareMediaAsset } from '../services'

export interface UseCanvasClipboardOptions {
  store: StoreApi<CanvasStoreState>
  hydrated: boolean
  readOnly?: boolean
  notify: (message: string, type?: 'info' | 'error') => void
  lastCanvasPointerRef: React.RefObject<{ x: number; y: number } | null | undefined>
  copiedNodeIdsRef: React.MutableRefObject<string[]>
  internalClipboardRef: React.MutableRefObject<CanvasClipboardEnvelope | undefined>
}

export function useCanvasClipboard({
  store,
  hydrated,
  readOnly = false,
  notify,
  lastCanvasPointerRef,
  copiedNodeIdsRef,
  internalClipboardRef,
}: UseCanvasClipboardOptions) {
  const pasteCascadeRef = useRef<{ key: string; count: number } | undefined>(undefined)

  const importClipboardContents = useCallback(async (contents: ClipboardContents) => {
    const resolved = await resolveClipboardContents(contents)
    const pasteAnchor = (signature: string) => {
      const current = store.getState().snapshot
      const zoom = Math.max(current.viewport.zoom, 0.01)
      const pointer = lastCanvasPointerRef.current ?? {
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      }
      const key = `${signature}:${pointer.x}:${pointer.y}`
      const count = pasteCascadeRef.current?.key === key
        ? pasteCascadeRef.current.count + 1
        : 0
      pasteCascadeRef.current = { key, count }
      return {
        x: (pointer.x - current.viewport.x) / zoom + count * 32,
        y: (pointer.y - current.viewport.y) / zoom + count * 32,
      }
    }
    const pasteGraph = (
      nodes: CanvasNode[],
      edges: CanvasClipboardEnvelope['edges'],
      signature: string,
    ) => store.getState().pasteImportedGraph({
      nodes,
      edges,
      anchor: pasteAnchor(signature),
    })
    const importEnvelope = (envelope: CanvasClipboardEnvelope) => {
      internalClipboardRef.current = envelope
      pasteGraph(
        envelope.nodes,
        envelope.edges,
        `internal:${envelope.sourceCanvasId}:${envelope.nodes.map((node) => node.id).join(',')}`,
      )
    }

    if (resolved.kind === 'empty') {
      if (!internalClipboardRef.current) throw new Error('剪贴板中没有可粘贴的内容')
      importEnvelope(internalClipboardRef.current)
    } else if (resolved.kind === 'error') {
      throw new Error(resolved.message)
    } else if (resolved.kind === 'internal') {
      importEnvelope(resolved.envelope)
    } else if (resolved.kind === 'files') {
      copiedNodeIdsRef.current = []
      internalClipboardRef.current = undefined
      const nodes: CanvasNode[] = []
      for (const [index, file] of resolved.files.entries()) {
        const prepared = await uploadAndPrepareMediaAsset(file)
        const name = file.name || '粘贴素材'
        if (prepared.kind === 'image') {
          nodes.push({
            id: `clipboard-source-${index}`,
            type: 'image',
            name,
            position: { x: index * 32, y: index * 32 },
            size: { width: prepared.width, height: prepared.height },
            data: {
              url: prepared.url,
              assetId: prepared.assetId,
              displayMode: 'layer',
              generationSettings: DEFAULT_IMAGE_GENERATION_SETTINGS,
            },
          } as CanvasNode)
        } else if (prepared.kind === 'video') {
          nodes.push({
            id: `clipboard-source-${index}`,
            type: 'video',
            name,
            position: { x: index * 32, y: index * 32 },
            size: { width: prepared.width, height: prepared.height },
            data: {
              url: prepared.url,
              poster: prepared.posterUrl,
              assetId: prepared.assetId,
              displayMode: 'layer',
              durationSec: prepared.durationSec ?? 5,
              generationSettings: DEFAULT_VIDEO_GENERATION_SETTINGS,
            },
          } as CanvasNode)
        }
      }
      pasteGraph(nodes, [], `files:${resolved.files.map((file) => `${file.name}:${file.size}`).join('|')}`)
    } else if (resolved.kind === 'url') {
      let asset: { assetId?: string; url: string }
      const localMatch = /^\/api\/assets\/([0-9a-f-]{36})$/i.exec(
        new URL(resolved.url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost').pathname
      )
      if (localMatch) {
        asset = { assetId: localMatch[1], url: `/api/assets/${localMatch[1]}` }
      } else if (/^data:/i.test(resolved.url)) {
        const response = await fetch(resolved.url)
        const blob = await response.blob()
        asset = await persistLocalMedia(new File(
          [blob],
          `clipboard.${resolved.media === 'image' ? 'png' : 'mp4'}`,
          { type: blob.type },
        ))
      } else {
        asset = await persistRemoteClipboardMedia(resolved.url, resolved.media, gatewayClient)
      }

      let size = resolved.media === 'image' ? { width: 480, height: 320 } : { width: 480, height: 270 }
      if (resolved.media === 'image' && typeof Image !== 'undefined') {
        try {
          const probe = new Image()
          probe.src = asset.url
          await new Promise<void>((res) => {
            if (probe.complete && probe.naturalWidth) return res()
            probe.onload = () => res()
            probe.onerror = () => res()
            setTimeout(res, 350)
          })
          if (probe.naturalWidth && probe.naturalHeight) {
            const aspect = probe.naturalWidth / probe.naturalHeight
            const width = Math.min(640, Math.max(160, probe.naturalWidth))
            size = { width, height: Math.round(width / aspect) }
          }
        } catch {}
      }

      pasteGraph([{
        id: 'clipboard-remote-source',
        type: resolved.media,
        name: resolved.media === 'image' ? '剪贴板图片' : '剪贴板视频',
        position: { x: 0, y: 0 },
        size,
        data: {
          url: asset.url,
          assetId: asset.assetId,
          displayMode: 'layer',
          generationSettings: resolved.media === 'image'
            ? DEFAULT_IMAGE_GENERATION_SETTINGS
            : DEFAULT_VIDEO_GENERATION_SETTINGS,
        },
      } as CanvasNode], [], `url:${resolved.url}`)
    } else {
      const trimmed = resolved.text.trim()
      // Guard 1: Double-check if text is actually a serialized canvas envelope or node array
      const maybeEnvelope = parseEnvelope(trimmed)
      if (maybeEnvelope) {
        importEnvelope(maybeEnvelope)
        return
      }

      // Guard 2: Double-check if text is actually an image / media URL or asset path
      const maybeMedia = safeMediaUrl(trimmed)
      if (maybeMedia) {
        let asset: { assetId?: string; url: string }
        const localMatch = /^\/api\/assets\/([0-9a-f-]{36})$/i.exec(
          new URL(maybeMedia.url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost').pathname
        )
        if (localMatch) {
          asset = { assetId: localMatch[1], url: `/api/assets/${localMatch[1]}` }
        } else if (/^data:/i.test(maybeMedia.url)) {
          const response = await fetch(maybeMedia.url)
          const blob = await response.blob()
          asset = await persistLocalMedia(new File(
            [blob],
            `clipboard.${maybeMedia.media === 'image' ? 'png' : 'mp4'}`,
            { type: blob.type },
          ))
        } else {
          asset = await persistRemoteClipboardMedia(maybeMedia.url, maybeMedia.media, gatewayClient)
        }

        let size = maybeMedia.media === 'image' ? { width: 480, height: 320 } : { width: 480, height: 270 }
        if (maybeMedia.media === 'image' && typeof Image !== 'undefined') {
          try {
            const probe = new Image()
            probe.src = asset.url
            await new Promise<void>((res) => {
              if (probe.complete && probe.naturalWidth) return res()
              probe.onload = () => res()
              probe.onerror = () => res()
              setTimeout(res, 350)
            })
            if (probe.naturalWidth && probe.naturalHeight) {
              const aspect = probe.naturalWidth / probe.naturalHeight
              const width = Math.min(640, Math.max(160, probe.naturalWidth))
              size = { width, height: Math.round(width / aspect) }
            }
          } catch {}
        }

        pasteGraph([{
          id: 'clipboard-remote-source',
          type: maybeMedia.media,
          name: maybeMedia.media === 'image' ? '剪贴板图片' : '剪贴板视频',
          position: { x: 0, y: 0 },
          size,
          data: {
            url: asset.url,
            assetId: asset.assetId,
            displayMode: 'layer',
            generationSettings: maybeMedia.media === 'image'
              ? DEFAULT_IMAGE_GENERATION_SETTINGS
              : DEFAULT_VIDEO_GENERATION_SETTINGS,
          },
        } as CanvasNode], [], `url:${maybeMedia.url}`)
        return
      }

      pasteGraph([{
        id: 'clipboard-text-source',
        type: 'text',
        name: '文本',
        position: { x: 0, y: 0 },
        size: { width: 420, height: 220 },
        data: { text: resolved.text, nodeKind: 'text' },
      }], [], `text:${resolved.text}`)
    }
  }, [copiedNodeIdsRef, internalClipboardRef, lastCanvasPointerRef, store])

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (!hydrated || readOnly) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return
      }

      event.preventDefault()
      void importClipboardContents(contentsFromDataTransfer(event.clipboardData))
        .catch((error: unknown) => notify(
          error instanceof Error ? error.message : '无法读取剪贴板内容',
          'error',
        ))
    }

    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [hydrated, importClipboardContents, notify, readOnly])

  return {
    importClipboardContents,
  }
}
