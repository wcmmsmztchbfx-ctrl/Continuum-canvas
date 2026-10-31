import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { TunnelDownloader } from './tunnel-downloader.ts'
import { TunnelService } from './tunnel-service.ts'

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }))
const services: TunnelService[] = []
const directories: string[] = []
async function service(binary: string | null = null) {
  const dataDir = await mkdtemp(join(tmpdir(), 'continuum-tunnel-service-'))
  directories.push(dataDir)
  const result = await TunnelService.open({ dataDir })
  services.push(result)
  vi.spyOn(result as unknown as { resolveBinary(): Promise<string | null> }, 'resolveBinary').mockResolvedValue(binary)
  return result
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(item => item.stopTunnel()))
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it('returns a concise actionable download error without private network details', async () => {
  vi.spyOn(TunnelDownloader.prototype, 'downloadBinary').mockRejectedValue(new Error('https://private-proxy.example/secret'))
  const tunnel = await service()
  const result = await tunnel.startAutoTunnel(4173)
  expect(result.status).toBe('error')
  expect(result.error).toContain('重试')
  expect(result.error).not.toContain('https://')
  expect(result.downloadProgress).toBeUndefined()
})

it('stopping during installation cannot start a tunnel later', async () => {
  let finish!: (path: string) => void
  let signal: AbortSignal | undefined
  const download = vi.spyOn(TunnelDownloader.prototype, 'downloadBinary').mockImplementation(options => {
    signal = options.signal
    return new Promise(resolve => { finish = resolve })
  })
  const tunnel = await service()
  const pending = tunnel.startAutoTunnel(4173)
  await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
  await tunnel.stopTunnel()
  expect(signal?.aborted).toBe(true)
  finish('unused-binary')
  await pending
  expect(spawn).not.toHaveBeenCalled()
  expect(tunnel.getStatus()).toMatchObject({ enabled: false, status: 'stopped' })
})

it('ignores old process output after stopping or switching to a custom domain', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  const tunnel = await service('installed-binary')
  await tunnel.startAutoTunnel(4173)
  await tunnel.setCustomUrl('https://canvas.example.com')
  await tunnel.startCustomMode()
  child.stderr.emit('data', 'https://obsolete.trycloudflare.com')
  expect(tunnel.getStatus()).toMatchObject({ mode: 'custom', status: 'running', publicUrl: 'https://canvas.example.com' })
  expect(child.kill).toHaveBeenCalledOnce()
})
