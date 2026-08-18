import { describe, expect, it } from 'vitest'
import {
  getCandidateDownloadUrls,
  getPlatformAssetInfo,
  TunnelDownloader,
} from './tunnel-downloader.ts'

describe('TunnelDownloader', () => {
  describe('getPlatformAssetInfo', () => {
    it('resolves correct binary and asset name on Windows x64', () => {
      const info = getPlatformAssetInfo('win32', 'x64')
      expect(info.filename).toBe('cloudflared.exe')
      expect(info.assetName).toBe('cloudflared-windows-amd64.exe')
      expect(info.isArchive).toBe(false)
    })

    it('resolves correct binary and asset name on Windows 32-bit', () => {
      const info = getPlatformAssetInfo('win32', 'ia32')
      expect(info.filename).toBe('cloudflared.exe')
      expect(info.assetName).toBe('cloudflared-windows-386.exe')
    })

    it('resolves correct binary and asset name on macOS Apple Silicon', () => {
      const info = getPlatformAssetInfo('darwin', 'arm64')
      expect(info.filename).toBe('cloudflared')
      expect(info.assetName).toBe('cloudflared-darwin-arm64.tgz')
      expect(info.isArchive).toBe(true)
    })

    it('resolves correct binary and asset name on Linux x64', () => {
      const info = getPlatformAssetInfo('linux', 'x64')
      expect(info.filename).toBe('cloudflared')
      expect(info.assetName).toBe('cloudflared-linux-amd64')
      expect(info.isArchive).toBe(false)
    })
  })

  describe('getCandidateDownloadUrls', () => {
    it('produces candidate mirror URLs starting with official GitHub release', () => {
      const urls = getCandidateDownloadUrls('cloudflared-windows-amd64.exe')
      expect(urls.length).toBeGreaterThanOrEqual(3)
      expect(urls[0]).toBe(
        'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
      )
      expect(urls.some((url) => url.includes('ghproxy'))).toBe(true)
    })
  })

  describe('Downloader instance state', () => {
    it('initializes with idle progress and not downloading', () => {
      const downloader = new TunnelDownloader()
      expect(downloader.getProgress()).toBe(0)
      expect(downloader.getIsDownloading()).toBe(false)
    })
  })
})
