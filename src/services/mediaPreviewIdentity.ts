export interface MediaPreviewSource { url: string; assetId?: string; version?: string }
/** Disposable pixels have the same version identity as the source artwork. */
export function mediaPreviewKey(source: MediaPreviewSource | string, maxDimension = 320): string {
  const value = typeof source === 'string' ? { url: source } : source
  return JSON.stringify(['preview-v2', value.url, value.assetId ?? '', value.version ?? '', maxDimension, 'webp'])
}
