import type { CanvasNode } from '../model/project'
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

const ASSET_REGISTRY_STORAGE_KEY = 'libtv.asset-registry.v1'

function generateId(): string {
  return 'asset-' + Math.random().toString(36).substring(2, 11) + '-' + Date.now().toString(36)
}

function loadStoredAssets(): CanvasAssetEntry[] {
  if (typeof window === 'undefined' || !window.localStorage) return []
  try {
    const raw = localStorage.getItem(ASSET_REGISTRY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persistStoredAssets(assets: CanvasAssetEntry[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    localStorage.setItem(ASSET_REGISTRY_STORAGE_KEY, JSON.stringify(assets))
  } catch (err) {
    console.warn('Failed to persist asset registry to localStorage:', err)
  }
}

class AssetRegistryService {
  private cache: CanvasAssetEntry[] = []
  private loaded = false

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.cache = loadStoredAssets()
      this.loaded = true
    }
  }

  public listAssets(filter?: { type?: 'image' | 'video' | 'audio'; projectId?: string; query?: string }): CanvasAssetEntry[] {
    this.ensureLoaded()
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
        item.tags?.some((t) => t.toLowerCase().includes(q))
      )
    }

    // Default sort: newest first
    return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }

  public getAsset(id: string): CanvasAssetEntry | undefined {
    this.ensureLoaded()
    return this.cache.find((item) => item.id === id)
  }

  public addAsset(input: Omit<CanvasAssetEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): CanvasAssetEntry {
    this.ensureLoaded()
    const entry: CanvasAssetEntry = {
      ...input,
      id: input.id || generateId(),
      createdAt: input.createdAt || new Date().toISOString(),
    }
    // Prepend new asset
    this.cache = [entry, ...this.cache.filter((item) => item.id !== entry.id)]
    persistStoredAssets(this.cache)
    return entry
  }

  public async uploadAndRegisterAsset(file: File, projectId?: string): Promise<CanvasAssetEntry> {
    const prepared = await uploadAndPrepareMediaAsset(file)
    return this.addAsset({
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
  }

  public registerNodeAsAsset(node: CanvasNode, projectId?: string): CanvasAssetEntry | null {
    if (node.type !== 'image' && node.type !== 'video') return null
    const data = node.data as { url?: string; poster?: string; activeVersionId?: string; versions?: Array<{ id: string; url: string }> }
    const url = data.url
    if (!url) return null

    return this.addAsset({
      name: node.name || (node.type === 'video' ? '视频资产' : '图片资产'),
      type: node.type,
      url,
      posterUrl: data.poster,
      thumbnailUrl: data.poster || url,
      width: node.size.width,
      height: node.size.height,
      projectId,
      tags: ['画布导出'],
    })
  }

  public deleteAssets(ids: string[]): void {
    this.ensureLoaded()
    const idSet = new Set(ids)
    this.cache = this.cache.filter((item) => !idSet.has(item.id))
    persistStoredAssets(this.cache)
  }

  public updateAsset(id: string, updates: Partial<CanvasAssetEntry>): CanvasAssetEntry | null {
    this.ensureLoaded()
    const index = this.cache.findIndex((item) => item.id === id)
    if (index === -1) return null

    const updated = { ...this.cache[index]!, ...updates }
    this.cache[index] = updated
    persistStoredAssets(this.cache)
    return updated
  }

  public clearAll(): void {
    this.cache = []
    this.loaded = true
    persistStoredAssets(this.cache)
  }
}

export const assetRegistry = new AssetRegistryService()
