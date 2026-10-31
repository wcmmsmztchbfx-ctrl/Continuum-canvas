import { execFile } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { EnvHttpProxyAgent, fetch } from 'undici'

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
  const architectures: Record<string, string> = { x64: 'amd64', ia32: '386', arm: 'arm', arm64: 'arm64' }
  let suffix = architectures[targetArch]
  if (!suffix || !['win32', 'darwin', 'linux'].includes(targetPlatform) ||
    (targetPlatform === 'darwin' && !['x64', 'arm64'].includes(targetArch)) ||
    (targetPlatform === 'win32' && targetArch === 'arm')) {
    throw new Error('此平台暂不支持自动安装远程组件，请手动配置 cloudflared。')
  }
  // Cloudflare provides Windows x86/x64 binaries; Windows ARM64 uses x64 emulation.
  if (targetPlatform === 'win32' && targetArch === 'arm64') suffix = 'amd64'
  const isWindows = targetPlatform === 'win32'
  const isArchive = targetPlatform === 'darwin'
  return {
    filename: isWindows ? 'cloudflared.exe' : 'cloudflared',
    assetName: `cloudflared-${isWindows ? 'windows' : targetPlatform}-${suffix}${isWindows ? '.exe' : isArchive ? '.tgz' : ''}`,
    isArchive,
  }
}

export function getCandidateDownloadUrls(assetName: string): string[] {
  return [`https://github.com/cloudflare/cloudflared/releases/latest/download/${assetName}`]
}

export async function validateBinary(path: string, targetPlatform: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    const signature = Buffer.alloc(4)
    await file.read(signature, 0, 4, 0)
    const magic = signature.toString('hex')
    const valid = targetPlatform === 'win32' ? magic.startsWith('4d5a')
      : targetPlatform === 'linux' ? magic === '7f454c46'
        : ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(magic)
    if (!valid || (await file.stat()).size < 1024 * 1024) {
      throw new Error('下载文件不完整或不是有效的远程组件，请重试。')
    }
  } finally {
    await file.close()
  }
}

export class TunnelDownloader {
  private isDownloading = false
  private currentProgress = 0

  getProgress(): number { return this.currentProgress }
  getIsDownloading(): boolean { return this.isDownloading }

  async downloadBinary(options: {
    targetDir: string
    onProgress?: (progress: DownloadProgress) => void
    platformOverride?: string
    archOverride?: string
    signal?: AbortSignal
  }): Promise<string> {
    if (this.isDownloading) throw new Error('远程组件正在下载，请稍候。')
    const targetPlatform = options.platformOverride ?? platform()
    const { filename, assetName, isArchive } = getPlatformAssetInfo(targetPlatform, options.archOverride)
    const destination = join(options.targetDir, filename)
    this.isDownloading = true
    this.currentProgress = 0
    let staging: string | undefined
    let dispatcher: EnvHttpProxyAgent | undefined
    try {
      if (existsSync(destination)) {
        try {
          await validateBinary(destination, targetPlatform)
          this.currentProgress = 100
          return destination
        } catch {
          await rm(destination, { force: true })
        }
      }
      await mkdir(options.targetDir, { recursive: true })
      staging = await mkdtemp(join(options.targetDir, '.cloudflared-'))
      const tempPath = join(staging, isArchive ? 'download.tgz' : filename)
      const deadline = AbortSignal.timeout(5 * 60_000)
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
      signal.throwIfAborted()
      // Scope proxy support to this download; do not change other backend requests.
      dispatcher = new EnvHttpProxyAgent({ connect: { timeout: 15_000 }, headersTimeout: 30_000, bodyTimeout: 30_000 })
      options.onProgress?.({ percent: 0, downloadedBytes: 0, totalBytes: 0 })
      const response = await fetch(getCandidateDownloadUrls(assetName)[0], {
        dispatcher,
        signal,
        headers: { 'User-Agent': 'Continuum-Canvas/cloudflared-downloader' },
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error(`官方下载服务暂时不可用（HTTP ${response.status}），请稍后重试。`)
      }
      const body = response.body
      const totalBytes = Number(response.headers.get('content-length')) || 0
      let downloadedBytes = 0
      const report = (percent: number) => {
        this.currentProgress = percent
        options.onProgress?.({ percent, downloadedBytes, totalBytes })
      }
      await pipeline(async function* () {
        for await (const chunk of body) {
          downloadedBytes += chunk.byteLength
          report(totalBytes > 0 ? Math.min(99, Math.floor(downloadedBytes / totalBytes * 100)) : 0)
          yield chunk
        }
      }, createWriteStream(tempPath, { mode: 0o755 }), { signal })
      if (totalBytes && downloadedBytes !== totalBytes) throw new Error('下载文件不完整，请重试。')
      if (isArchive) {
        // Extract only the expected member, into a private staging directory.
        await promisify(execFile)('tar', ['-xzf', tempPath, '-C', staging, filename], { signal, windowsHide: true })
      }
      const executable = join(staging, filename)
      await validateBinary(executable, targetPlatform)
      if (targetPlatform !== 'win32') await chmod(executable, 0o755)
      signal.throwIfAborted()
      await rename(executable, destination)
      report(100)
      return destination
    } finally {
      try {
        await dispatcher?.destroy()
      } finally {
        try { if (staging) await rm(staging, { recursive: true, force: true }) }
        finally { this.isDownloading = false }
      }
    }
  }
}
