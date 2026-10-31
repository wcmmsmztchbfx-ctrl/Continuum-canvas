import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvHttpProxyAgent, fetch as downloadFetch } from 'undici'
import {
  getCandidateDownloadUrls,
  getPlatformAssetInfo,
  TunnelDownloader,
} from './tunnel-downloader.ts'

vi.mock('undici', async (original) => ({ ...await original<typeof import('undici')>(), fetch: vi.fn() }))
// A regression must never fall back to live, proxy-unaware network requests.
vi.mock('node:https', () => ({ get: () => { throw new Error('Legacy direct downloader used') } }))
const directories: string[] = []
const binary = Buffer.alloc(1024 * 1024 + 4, 1)
binary.write('MZ')
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'continuum-tunnel-test-'))
  directories.push(path)
  return path
}
function reply(body: Buffer, headers: Record<string, string> = {}) {
  return new Response(body, { headers: { 'content-length': String(body.length), ...headers } }) as unknown as Awaited<ReturnType<typeof downloadFetch>>
}
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('TunnelDownloader', () => {
  describe('getPlatformAssetInfo', () => {
    it.each([
      ['linux', 'ia32', 'cloudflared-linux-386'],
      ['linux', 'arm', 'cloudflared-linux-arm'],
      ['linux', 'arm64', 'cloudflared-linux-arm64'],
      ['darwin', 'x64', 'cloudflared-darwin-amd64.tgz'],
      ['win32', 'arm64', 'cloudflared-windows-amd64.exe'],
    ])('selects the published asset for %s / %s', (os, cpu, asset) => {
      expect(getPlatformAssetInfo(os, cpu).assetName).toBe(asset)
    })

    it('does not silently install an x64 executable on unsupported systems', () => {
      expect(() => getPlatformAssetInfo('freebsd', 'x64')).toThrow('不支持')
      expect(() => getPlatformAssetInfo('linux', 'riscv64')).toThrow('不支持')
    })
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
    it('uses only the official GitHub release', () => {
      const urls = getCandidateDownloadUrls('cloudflared-windows-amd64.exe')
      expect(urls).toEqual([
        'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
      ])
    })
  })

  describe('Downloader instance state', () => {
    it('initializes with idle progress and not downloading', () => {
      const downloader = new TunnelDownloader()
      expect(downloader.getProgress()).toBe(0)
      expect(downloader.getIsDownloading()).toBe(false)
    })
  })

  it('streams through the standard environment proxy agent and reuses the completed file', async () => {
    const targetDir = await directory()
    vi.mocked(downloadFetch).mockResolvedValueOnce(reply(binary))
    const downloader = new TunnelDownloader()
    const progress = vi.fn()
    const file = await downloader.downloadBinary({ targetDir, platformOverride: 'win32', onProgress: progress })
    expect(downloadFetch).toHaveBeenCalledWith(expect.stringContaining('https://github.com/cloudflare/'), expect.objectContaining({ dispatcher: expect.any(EnvHttpProxyAgent), signal: expect.any(AbortSignal) }))
    expect(await readFile(file)).toEqual(binary)
    expect(progress).toHaveBeenLastCalledWith({ percent: 100, downloadedBytes: binary.length, totalBytes: binary.length })
    expect(await downloader.downloadBinary({ targetDir, platformOverride: 'win32' })).toBe(file)
    expect(downloadFetch).toHaveBeenCalledTimes(1)
    expect(downloader.getIsDownloading()).toBe(false)
  })

  it('cleans an interrupted download and allows a fresh retry', async () => {
    const targetDir = await directory()
    const downloader = new TunnelDownloader()
    const body = new ReadableStream({ start(controller) { controller.enqueue(binary.subarray(0, 100)); controller.error(new Error('connection lost')) } })
    vi.mocked(downloadFetch).mockResolvedValueOnce(new Response(body) as unknown as Awaited<ReturnType<typeof downloadFetch>>)
    await expect(downloader.downloadBinary({ targetDir, platformOverride: 'win32' })).rejects.toThrow()
    expect(await readdir(targetDir)).toEqual([])
    expect(downloader.getIsDownloading()).toBe(false)
    vi.mocked(downloadFetch).mockResolvedValueOnce(reply(binary))
    await expect(downloader.downloadBinary({ targetDir, platformOverride: 'win32' })).resolves.toBe(join(targetDir, 'cloudflared.exe'))
  })

  it('installs a Linux executable and cleans up when an operation is cancelled', async () => {
    const targetDir = await directory()
    const linuxBinary = Buffer.from(binary)
    linuxBinary.writeUInt32BE(0x7f454c46)
    vi.mocked(downloadFetch).mockResolvedValueOnce(reply(linuxBinary))
    const path = await new TunnelDownloader().downloadBinary({ targetDir, platformOverride: 'linux', archOverride: 'x64' })
    expect(await readFile(path)).toEqual(linuxBinary)
    const cancelledDir = await directory()
    const controller = new AbortController()
    controller.abort()
    await expect(new TunnelDownloader().downloadBinary({ targetDir: cancelledDir, signal: controller.signal })).rejects.toThrow()
    expect(await readdir(cancelledDir)).toEqual([])
    expect(downloadFetch).toHaveBeenCalledOnce()
  })

  it('rejects truncated or HTML responses instead of caching them as executables', async () => {
    const targetDir = await directory()
    vi.mocked(downloadFetch).mockResolvedValueOnce(reply(binary, { 'content-length': String(binary.length * 2) }))
    await expect(new TunnelDownloader().downloadBinary({ targetDir, platformOverride: 'win32' })).rejects.toThrow()
    vi.mocked(downloadFetch).mockResolvedValueOnce(reply(Buffer.alloc(binary.length, 60)))
    await expect(new TunnelDownloader().downloadBinary({ targetDir, platformOverride: 'win32' })).rejects.toThrow()
    expect(await readdir(targetDir)).toEqual([])
  })

  it('replaces an invalid cache left by an interrupted or older installer', async () => {
    const targetDir = await directory()
    await writeFile(join(targetDir, 'cloudflared.exe'), 'incomplete')
    vi.mocked(downloadFetch).mockResolvedValueOnce(reply(binary))
    const file = await new TunnelDownloader().downloadBinary({ targetDir, platformOverride: 'win32' })
    expect(await readFile(file)).toEqual(binary)
    expect(downloadFetch).toHaveBeenCalledOnce()
  })

  it('extracts the macOS archive before installing the executable', async () => {
    const sourceDir = await directory()
    const targetDir = await directory()
    const macBinary = Buffer.from(binary)
    macBinary.writeUInt32BE(0xcffaedfe)
    await writeFile(join(sourceDir, 'cloudflared'), macBinary)
    const archive = join(sourceDir, 'asset.tgz')
    execFileSync('tar', ['-czf', archive, '-C', sourceDir, 'cloudflared'], { windowsHide: true })
    vi.mocked(downloadFetch).mockResolvedValueOnce(reply(await readFile(archive)))
    const file = await new TunnelDownloader().downloadBinary({ targetDir, platformOverride: 'darwin', archOverride: 'arm64' })
    expect(await readFile(file)).toEqual(macBinary)
    expect(await readdir(targetDir)).toEqual(['cloudflared'])
  })
})
