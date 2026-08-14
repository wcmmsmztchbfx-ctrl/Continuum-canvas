import { gatewayClient } from './gatewayClient'

interface LocalAssetUploader {
  uploadAsset(body: Blob, filename: string): Promise<{
    id: string
    url: string
  }>
}

const LOCAL_ASSET_URL = /^\/api\/assets\/([0-9a-f-]{36})$/i

export async function persistLocalMedia(
  file: File,
  uploader: LocalAssetUploader = gatewayClient,
): Promise<{ assetId: string; url: string }> {
  const asset = await uploader.uploadAsset(file, file.name)
  const match = LOCAL_ASSET_URL.exec(asset.url)
  if (!match || match[1].toLowerCase() !== asset.id.toLowerCase()) {
    throw new Error('Upload did not return a stable local asset')
  }
  return { assetId: asset.id, url: asset.url }
}
