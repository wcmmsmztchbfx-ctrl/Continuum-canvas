import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from './atomic-json.ts'
import { TunnelDownloader } from './tunnel-downloader.ts'

export interface TunnelStatus {
  enabled: boolean
  mode: 'auto' | 'custom'
  status: 'stopped' | 'downloading' | 'starting' | 'running' | 'error'
  downloadProgress?: number
  publicUrl?: string
  customUrl?: string
  error?: string
}

interface PersistedTunnelState {
  customUrl?: string
}

export class TunnelService {
  private readonly dataDir: string
  private readonly stateFile: string
  private readonly binDir: string
  private readonly localBinPath: string
  private readonly downloader = new TunnelDownloader()
  private process: ChildProcess | null = null
  private status: TunnelStatus = {
    enabled: false,
    mode: 'auto',
    status: 'stopped',
  }
  private originChangeListeners = new Set<(origin: string | undefined) => void>()

  constructor(options: { dataDir: string }) {
    this.dataDir = options.dataDir
    this.stateFile = join(this.dataDir, 'tunnel-state.json')
    this.binDir = join(this.dataDir, 'bin')
    this.localBinPath = join(
      this.binDir,
      process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared',
    )
  }

  static async open(options: { dataDir: string }): Promise<TunnelService> {
    const service = new TunnelService(options)
    await service.init()
    return service
  }

  private async init(): Promise<void> {
    try {
      const raw = await readFile(this.stateFile, 'utf8')
      const persisted = JSON.parse(raw) as PersistedTunnelState
      if (persisted?.customUrl) {
        this.status.customUrl = persisted.customUrl
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Ignore unparseable persisted state
      }
    }
  }

  onOriginChange(listener: (origin: string | undefined) => void): () => void {
    this.originChangeListeners.add(listener)
    return () => this.originChangeListeners.delete(listener)
  }

  private notifyOriginChange(origin: string | undefined): void {
    for (const listener of this.originChangeListeners) {
      try {
        listener(origin)
      } catch {}
    }
  }

  getStatus(): TunnelStatus {
    return { ...this.status }
  }

  async setCustomUrl(url: string | undefined): Promise<TunnelStatus> {
    const clean = url?.trim() || undefined
    if (clean) {
      try {
        const parsed = new URL(clean)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('URL 必须以 http:// 或 https:// 开头')
        }
      } catch (err: unknown) {
        throw new Error(err instanceof Error ? err.message : '无效的公网 URL')
      }
    }

    try {
      await atomicWriteJson(this.stateFile, { customUrl: clean })
    } catch {}

    this.status.customUrl = clean
    if (this.status.mode === 'custom' && this.status.enabled) {
      this.status.publicUrl = clean
      this.status.status = clean ? 'running' : 'stopped'
      this.notifyOriginChange(clean ? new URL(clean).origin : undefined)
    }
    return this.getStatus()
  }

  async startCustomMode(): Promise<TunnelStatus> {
    this.stopProcess()
    this.status.mode = 'custom'
    this.status.enabled = true
    if (this.status.customUrl) {
      this.status.publicUrl = this.status.customUrl
      this.status.status = 'running'
      this.status.error = undefined
      this.notifyOriginChange(new URL(this.status.customUrl).origin)
    } else {
      this.status.publicUrl = undefined
      this.status.status = 'stopped'
      this.status.error = '请先配置有效的公网/自定义域名'
      this.notifyOriginChange(undefined)
    }
    return this.getStatus()
  }

  async startAutoTunnel(localPort: number): Promise<TunnelStatus> {
    this.stopProcess()
    this.status.mode = 'auto'
    this.status.enabled = true
    this.status.error = undefined
    this.status.publicUrl = undefined
    this.notifyOriginChange(undefined)

    let binPath = await this.resolveBinary()
    if (!binPath) {
      this.status.status = 'downloading'
      this.status.downloadProgress = 0

      try {
        binPath = await this.downloader.downloadBinary({
          targetDir: this.binDir,
          onProgress: (p) => {
            this.status.downloadProgress = p.percent
          },
        })
      } catch (err: unknown) {
        this.status.status = 'error'
        this.status.error =
          err instanceof Error
            ? `下载穿透组件失败: ${err.message}`
            : '下载穿透组件失败，请检查网络或切换为【自定义域名】模式'
        return this.getStatus()
      }
    }

    this.status.status = 'starting'
    this.status.downloadProgress = undefined
    this.status.error = undefined

    try {
      const child = spawn(
        binPath,
        ['tunnel', '--url', `http://127.0.0.1:${localPort}`, '--no-autoupdate'],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            NO_PROXY: process.env.NO_PROXY
              ? `${process.env.NO_PROXY},localhost,127.0.0.1,::1`
              : 'localhost,127.0.0.1,::1',
          },
        },
      )
      this.process = child

      const handleOutput = (data: Buffer | string) => {
        const text = data.toString()
        const match = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/.exec(text)
        if (match && this.status.status !== 'running') {
          this.status.status = 'running'
          this.status.publicUrl = match[0]
          this.status.error = undefined
          this.notifyOriginChange(new URL(match[0]).origin)
        }
      }

      child.stdout?.on('data', handleOutput)
      child.stderr?.on('data', handleOutput)

      child.on('error', (err) => {
        if (this.process === child) {
          this.status.status = 'error'
          this.status.error = `穿透进程异常: ${err.message}`
          this.notifyOriginChange(undefined)
        }
      })

      child.on('exit', () => {
        if (this.process === child) {
          this.process = null
          if (this.status.enabled && this.status.status !== 'error') {
            this.status.status = 'stopped'
            this.status.publicUrl = undefined
            this.notifyOriginChange(undefined)
          }
        }
      })

      setTimeout(() => {
        if (this.status.status === 'starting') {
          this.status.status = 'error'
          this.status.error = '连接 Cloudflare 边缘节点超时，请检查网络或切换为自定义域名模式'
          this.notifyOriginChange(undefined)
        }
      }, 25_000)

      return this.getStatus()
    } catch (err: unknown) {
      this.status.status = 'error'
      this.status.error = err instanceof Error ? err.message : '启动穿透失败'
      return this.getStatus()
    }
  }

  async stopTunnel(): Promise<TunnelStatus> {
    this.stopProcess()
    this.status.enabled = false
    this.status.status = 'stopped'
    this.status.publicUrl = undefined
    this.status.error = undefined
    this.notifyOriginChange(undefined)
    return this.getStatus()
  }

  private stopProcess(): void {
    if (this.process) {
      try {
        this.process.kill('SIGTERM')
      } catch {}
      this.process = null
    }
  }

  private async resolveBinary(): Promise<string | null> {
    if (process.env.CLOUDFLARED_PATH && existsSync(process.env.CLOUDFLARED_PATH)) {
      return process.env.CLOUDFLARED_PATH
    }
    if (existsSync(this.localBinPath)) {
      return this.localBinPath
    }
    try {
      const isWin = process.platform === 'win32'
      const checkCmd = isWin ? 'where.exe' : 'which'
      const { spawnSync } = await import('node:child_process')
      const res = spawnSync(checkCmd, ['cloudflared'], { windowsHide: true })
      if (res.status === 0) {
        const foundPath = res.stdout.toString().split(/\r?\n/)[0]?.trim()
        if (foundPath && existsSync(foundPath)) return foundPath
      }
    } catch {}

    return null
  }
}
