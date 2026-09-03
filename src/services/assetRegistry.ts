import type { CanvasNode } from '../model/project'
import { gatewayClient } from './gatewayClient'
import type { AssetRecord } from './gatewayClient'
import { uploadAndPrepareMediaAsset } from './localMedia'

export interface CanvasAssetEntry {
  id: string
  name: string
  type: 'image' | 'video' | 'audio'
  url: string
  thumbnailUrl?: string
  posterUrl?: string
  size?: number
  width?: number
  height?: number
  durationSec?: number
  mimeType?: string
  projectId?: string
  createdAt: string
  tags?: string[]
}

function recordToAssetEntry(record: AssetRecord): CanvasAssetEntry {
  let type: 'image' | 'video' | 'audio' = 'image'
  if (record.contentType.startsWith('video/')) {
    type = 'video'
  } else if (record.contentType.startsWith('audio/')) {
    type = 'audio'
  }

  return {
    id: record.id,
    name: record.filename,
    type,
    url: record.url,
    thumbnailUrl: record.url,
    posterUrl: type === 'video' ? record.url : undefined,
    size: record.size,
    mimeType: record.contentType,
    createdAt: record.createdAt,
  }
}

class AssetRegistryService {
  private cache: CanvasAssetEntry[] = []
  private syncPromise: Promise<void> | null = null
  private initialized = false

  public async syncWithServer(): Promise<CanvasAssetEntry[]> {
    if (this.syncPromise) return this.syncPromise.then(() => this.cache)
    this.syncPromise = (async () => {
      try {
        const records = await gatewayClient.listAssets()
        const existingById = new Map(this.cache.map((item) => [item.id, item]))
        const entries = records.map((record) => {
          const existing = existingById.get(record.id)
          const converted = recordToAssetEntry(record)
          if (existing) {
            return {
              ...converted,
              name: existing.name || converted.name,
              width: existing.width,
              height: existing.height,
              durationSec: existing.durationSec,
              posterUrl: existing.posterUrl || converted.posterUrl,
              thumbnailUrl: existing.thumbnailUrl || converted.thumbnailUrl,
              tags: existing.tags,
              projectId: existing.projectId,
            }
          }
          return converted
        })
        this.cache = entries
        this.initialized = true
      } catch (err) {
        console.warn('Failed to sync assets with gateway server:', err)
      } finally {
        this.syncPromise = null
      }
    })()
    await this.syncPromise
    return this.cache
  }

  public listAssets(filter?: {
    type?: 'image' | 'video' | 'audio'
    projectId?: string
    query?: string
  }): CanvasAssetEntry[] {
    if (!this.initialized && !this.syncPromise) {
      void this.syncWithServer()
    }

    let result = [...this.cache]

    if (filter?.type) {
      result = result.filter((item) => item.type === filter.type)
    }

    if (filter?.projectId) {
      result = result.filter((item) => !item.projectId || item.projectId === filter.projectId)
    }

    if (filter?.query) {
      const q = filter.query.trim().toLowerCase()
      result = result.filter((item) =>
        item.name.toLowerCase().includes(q) ||
        item.tags?.some((t) => t.toLowerCase().includes(q)),
      )
    }

    return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }

  public getAsset(id: string): CanvasAssetEntry | undefined {
    return this.cache.find((item) => item.id === id)
  }

  public addAsset(
    input: Omit<CanvasAssetEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
  ): CanvasAssetEntry {
    const entry: CanvasAssetEntry = {
      ...input,
      id: input.id || crypto.randomUUID(),
      createdAt: input.createdAt || new Date().toISOString(),
    }
    this.cache = [entry, ...this.cache.filter((item) => item.id !== entry.id)]
    return entry
  }

  public async uploadAndRegisterAsset(file: File, projectId?: string): Promise<CanvasAssetEntry> {
    const prepared = await uploadAndPrepareMediaAsset(file)
    const match = /\/api\/assets\/([0-9a-f-]{36})/i.exec(prepared.url)
    const id = match ? match[1] : crypto.randomUUID()
    const entry = this.addAsset({
      id,
      name: file.name,
      type: prepared.kind,
      url: prepared.url,
      posterUrl: prepared.posterUrl,
      thumbnailUrl: prepared.posterUrl || prepared.url,
      size: file.size,
      width: prepared.width,
      height: prepared.height,
      durationSec: prepared.durationSec,
      mimeType: file.type,
      projectId,
    })
    return entry
  }

  public async registerNodeAsAsset(node: CanvasNode, projectId?: string): Promise<CanvasAssetEntry | null> {
    if (node.type !== 'image' && node.type !== 'video') return null
    const data = node.data as {
      url?: string
      poster?: string
      assetId?: string
      activeVersionId?: string
      versions?: Array<{ id: string; url: string }>
    }
    let url = data.url
    if (!url) return null

    let assetId = data.assetId
    if (!assetId) {
      const match = /\/api\/assets\/([0-9a-f-]{36})/i.exec(url)
      if (match) {
        assetId = match[1]
      }
    }

    // If it's a data url or blob, import or upload to gateway
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      try {
        const response = await fetch(url)
        const blob = await response.blob()
        const filename = `${node.name || 'canvas-asset'}.${node.type === 'video' ? 'mp4' : 'png'}`
        const file = new File([blob], filename, { type: blob.type || (node.type === 'video' ? 'video/mp4' : 'image/png') })
        return await this.uploadAndRegisterAsset(file, projectId)
      } catch (err) {
        console.warn('Failed to upload blob/data asset to server:', err)
      }
    }

    const entry = this.addAsset({
      id: assetId || crypto.randomUUID(),
      name: node.name || (node.type === 'video' ? '视频资产' : '图片资产'),
      type: node.type,
      url,
      posterUrl: data.poster,
      thumbnailUrl: data.poster || url,
      width: node.size.width,
      height: node.size.height,
      projectId,
      tags: ['画布素材'],
    })
    return entry
  }

  public async deleteAsset(id: string): Promise<void> {
    try {
      await gatewayClient.deleteAsset(id)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('引用') || message.includes('无法删除') || message.includes('409') || message.includes('asset_in_use')) {
        throw new Error(message)
      }
    }
    this.cache = this.cache.filter((item) => item.id !== id)
  }

  public async deleteAssets(ids: string[]): Promise<string[]> {
    const deleted: string[] = []
    const errors: string[] = []
    for (const id of ids) {
      try {
        await this.deleteAsset(id)
        deleted.push(id)
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
    }
    if (errors.length > 0 && deleted.length === 0) {
      throw new Error(errors[0])
    }
    return deleted
  }

  public async cleanUnreferenced(): Promise<{ count: number; deletedIds: string[] }> {
    const result = await gatewayClient.cleanUnreferencedAssets()
    const deletedSet = new Set(result.deletedIds)
    this.cache = this.cache.filter((item) => !deletedSet.has(item.id))
    return { count: result.count, deletedIds: result.deletedIds }
  }

  public updateAsset(id: string, updates: Partial<CanvasAssetEntry>): CanvasAssetEntry | null {
    const index = this.cache.findIndex((item) => item.id === id)
    if (index === -1) return null

    const updated = { ...this.cache[index]!, ...updates }
    this.cache[index] = updated
    return updated
  }

  public clearAll(): void {
    this.cache = []
  }
}

export const assetRegistry = new AssetRegistryService()
