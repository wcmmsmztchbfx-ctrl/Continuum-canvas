import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { get as httpGet, type RequestOptions } from 'node:http'
import { get as httpsGet } from 'node:https'
import { arch, platform } from 'node:os'
import { join } from 'node:path'

export interface DownloadProgress {
  percent: number
  downloadedBytes: number
  totalBytes: number
}

export interface PlatformAssetInfo {
  filename: string
  assetName: string
  isArchive: boolean
}

export function getPlatformAssetInfo(
  targetPlatform: string = platform(),
  targetArch: string = arch(),
): PlatformAssetInfo {
  if (targetPlatform === 'win32') {
    if (targetArch === 'arm64') {
      return {
        filename: 'cloudflared.exe',
        assetName: 'cloudflared-windows-amd64.exe',
        isArchive: false,
      }
    }
    if (targetArch === 'ia32') {
      return {
        filename: 'cloudflared.exe',
        assetName: 'cloudflared-windows-386.exe',
        isArchive: false,
      }
    }
    return {
      filename: 'cloudflared.exe',
      assetName: 'cloudflared-windows-amd64.exe',
      isArchive: false,
    }
  }

  if (targetPlatform === 'darwin') {
    return {
      filename: 'cloudflared',
      assetName: targetArch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz',
      isArchive: true,
    }
  }

  // Linux default
  return {
    filename: 'cloudflared',
    assetName: targetArch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64',
    isArchive: false,
  }
}

export function getCandidateDownloadUrls(assetName: string): string[] {
  return [
    `https://github.com/cloudflare/cloudflared/releases/latest/download/${assetName}`,
    `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/${assetName}`,
    `https://mirror.ghproxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${assetName}`,
    `https://github.moeyy.xyz/https://github.com/cloudflare/cloudflared/releases/latest/download/${assetName}`,
  ]
}

function fetchStreamWithRedirects(
  targetUrl: string,
  maxRedirects = 8,
): Promise<{ stream: NodeJS.ReadableStream; totalBytes: number }> {
  return new Promise((resolve, reject) => {
    let redirectsRemaining = maxRedirects

    const attempt = (currentUrl: string) => {
      let parsed: URL
      try {
        parsed = new URL(currentUrl)
      } catch (err) {
        reject(new Error(`Invalid URL: ${currentUrl}`))
        return
      }

      const getter = parsed.protocol === 'https:' ? httpsGet : httpGet
      const options: RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          'User-Agent': 'Continuum-Canvas/1.0 (cloudflared-downloader)',
          Accept: '*/*',
        },
        timeout: 15_000,
      }

      const req = getter(options, (res) => {
        const statusCode = res.statusCode ?? 200

        // Handle redirects (301, 302, 303, 307, 308)
        if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
          if (redirectsRemaining <= 0) {
            res.resume()
            reject(new Error('Too many redirects while downloading cloudflared'))
            return
          }
          redirectsRemaining--
          res.resume()
          const redirectUrl = new URL(res.headers.location, currentUrl).toString()
          attempt(redirectUrl)
          return
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume()
          reject(new Error(`HTTP status ${statusCode} when downloading from ${currentUrl}`))
          return
        }

        const contentLength = Number.parseInt(res.headers['content-length'] ?? '0', 10)
        resolve({
          stream: res,
          totalBytes: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0,
        })
      })

      req.on('error', (err) => {
        reject(err)
      })

      req.on('timeout', () => {
        req.destroy()
        reject(new Error(`Timeout connecting to ${currentUrl}`))
      })
    }

    attempt(targetUrl)
  })
}

export class TunnelDownloader {
  private isDownloading = false
  private currentProgress = 0

  getProgress(): number {
    return this.currentProgress
  }

  getIsDownloading(): boolean {
    return this.isDownloading
  }

  async downloadBinary(options: {
    targetDir: string
    onProgress?: (progress: DownloadProgress) => void
    platformOverride?: string
    archOverride?: string
  }): Promise<string> {
    if (this.isDownloading) {
      throw new Error('A binary download is already in progress')
    }

    const { filename, assetName } = getPlatformAssetInfo(
      options.platformOverride,
      options.archOverride,
    )
    const destinationPath = join(options.targetDir, filename)
    const tempPath = join(options.targetDir, `${filename}.download.tmp`)

    if (existsSync(destinationPath)) {
      return destinationPath
    }

    await mkdir(options.targetDir, { recursive: true })

    const candidateUrls = getCandidateDownloadUrls(assetName)
    let lastError: Error | null = null

    this.isDownloading = true
    this.currentProgress = 0

    try {
      for (const url of candidateUrls) {
        try {
          const success = await this.tryDownloadFromUrl(url, tempPath, destinationPath, options.onProgress)
          if (success) {
            this.currentProgress = 100
            options.onProgress?.({
              percent: 100,
              downloadedBytes: 0,
              totalBytes: 0,
            })
            return destinationPath
          }
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err))
          await rm(tempPath, { force: true }).catch(() => {})
          // Continue to next candidate URL
        }
      }

      throw new Error(
        `Failed to download cloudflared binary from all mirrors. Last error: ${lastError?.message ?? 'Unknown error'}`,
      )
    } finally {
      this.isDownloading = false
      await rm(tempPath, { force: true }).catch(() => {})
    }
  }

  private async tryDownloadFromUrl(
    url: string,
    tempPath: string,
    finalPath: string,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<boolean> {
    const { stream, totalBytes } = await fetchStreamWithRedirects(url)
    const fileStream = createWriteStream(tempPath, { mode: 0o755 })

    let downloadedBytes = 0

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length
        if (totalBytes > 0) {
          const percent = Math.min(99, Math.round((downloadedBytes / totalBytes) * 100))
          this.currentProgress = percent
          onProgress?.({
            percent,
            downloadedBytes,
            totalBytes,
          })
        }
      })

      stream.on('error', (err) => {
        fileStream.destroy()
        reject(err)
      })

      fileStream.on('error', (err) => {
        reject(err)
      })

      fileStream.on('finish', async () => {
        try {
          // Minimal sanity check: cloudflared binary is at least 1MB
          if (downloadedBytes < 1024 * 1024) {
            reject(new Error(`Downloaded file too small (${downloadedBytes} bytes), likely error response`))
            return
          }

          if (process.platform !== 'win32') {
            await chmod(tempPath, 0o755)
          }

          await rename(tempPath, finalPath)
          resolve(true)
        } catch (err) {
          reject(err)
        }
      })

      stream.pipe(fileStream)
    })
  }
}
