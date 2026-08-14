import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

interface LockMetadata {
  pid: number
  startedAt: string
  token: string
  processIdentity: string
}

type ProcessState = 'alive' | 'dead' | 'uncertain'
type ProcessStateCheck = (pid: number) => ProcessState | Promise<ProcessState>
type ProcessIdentityCheck = (pid: number) => string | undefined | Promise<string | undefined>

interface MetadataFile {
  exists: boolean
  metadata?: LockMetadata
}

export interface DataDirectoryLockHandle {
  assertHeld(): void
  release(): Promise<void>
}

export class DataDirectoryLockedError extends Error {
  readonly code = 'data_directory_locked'

  constructor() {
    super('The data directory is already owned by another backend instance')
  }
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function parseMetadata(value: unknown): LockMetadata | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) return undefined
  if (typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))) return undefined
  if (typeof record.token !== 'string' || record.token.length === 0 || record.token.length > 256) return undefined
  if (!validIdentity(record.processIdentity)) return undefined
  return {
    pid: record.pid as number,
    startedAt: record.startedAt,
    token: record.token,
    processIdentity: record.processIdentity,
  }
}

async function readMetadataFile(path: string): Promise<MetadataFile> {
  try {
    const source = await readFile(path, 'utf8')
    try {
      return { exists: true, metadata: parseMetadata(JSON.parse(source)) }
    } catch {
      return { exists: true }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    return { exists: true }
  }
}

async function readMetadata(path: string): Promise<LockMetadata | undefined> {
  return (await readMetadataFile(path)).metadata
}

async function pathExists(path: string): Promise<boolean> {
  return (await readMetadataFile(path)).exists
}

function defaultProcessState(pid: number): ProcessState {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'uncertain'
  }
}

const execFileAsync = promisify(execFile)

async function windowsProcessIdentity(pid: number): Promise<string | undefined> {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${pid}"`,
    'if ($null -eq $p) { exit 3 }',
    '$os=Get-CimInstance -ClassName Win32_OperatingSystem',
    '$boot=([DateTime]$os.LastBootUpTime).ToUniversalTime().Ticks',
    '$started=([DateTime]$p.CreationDate).ToUniversalTime().Ticks',
    '[Console]::Out.Write($boot.ToString() + ":" + $started.ToString())',
  ].join(';')
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 4_096 })
    const value = String(stdout).trim()
    return /^\d+:\d+$/.test(value) ? `windows:${value}` : undefined
  } catch {
    return undefined
  }
}

async function linuxProcessIdentity(pid: number): Promise<string | undefined> {
  try {
    const [bootId, stat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ])
    const commandEnd = stat.lastIndexOf(')')
    if (commandEnd < 0) return undefined
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/)
    const startTicks = fields[19]
    const boot = bootId.trim()
    if (!/^[0-9a-f-]{36}$/i.test(boot) || !/^\d+$/.test(startTicks ?? '')) return undefined
    return `linux:${boot}:${startTicks}`
  } catch {
    return undefined
  }
}

async function discoverProcessIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === 'win32') return windowsProcessIdentity(pid)
  if (process.platform === 'linux') return linuxProcessIdentity(pid)
  return undefined
}

let ownProcessIdentity: Promise<string | undefined> | undefined

function defaultProcessIdentity(pid: number): Promise<string | undefined> {
  if (pid !== process.pid) return discoverProcessIdentity(pid)
  ownProcessIdentity ??= discoverProcessIdentity(pid)
  return ownProcessIdentity
}

async function ownerCertainlyGone(
  metadata: LockMetadata,
  processState: ProcessStateCheck,
  processIdentity: ProcessIdentityCheck,
): Promise<boolean> {
  const state = await processState(metadata.pid)
  if (state === 'dead') return true
  if (state !== 'alive' || metadata.processIdentity.startsWith('unverifiable:')) return false
  const currentIdentity = await processIdentity(metadata.pid)
  return validIdentity(currentIdentity) && currentIdentity !== metadata.processIdentity
}

async function writeOwnedFile(path: string, metadata: LockMetadata): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, { encoding: 'utf8' })
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(path, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
}

async function restoreDisplacedGuard(quarantinePath: string, guardPath: string): Promise<void> {
  if (!await pathExists(guardPath)) await rename(quarantinePath, guardPath).catch(() => {})
}

async function reclaimAbandonedGuard(
  guardPath: string,
  lockPath: string,
  processState: ProcessStateCheck,
  processIdentity: ProcessIdentityCheck,
): Promise<void> {
  const observed = await readMetadataFile(guardPath)
  if (!observed.exists) return
  if (!observed.metadata || !await ownerCertainlyGone(observed.metadata, processState, processIdentity)) {
    throw new DataDirectoryLockedError()
  }

  const quarantinePath = `${guardPath}.stale.${randomUUID()}`
  try {
    await rename(guardPath, quarantinePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (!(await readMetadataFile(guardPath)).exists) return
    }
    throw new DataDirectoryLockedError()
  }

  const displaced = await readMetadataFile(quarantinePath)
  if (!displaced.metadata || displaced.metadata.token !== observed.metadata.token ||
    !await ownerCertainlyGone(displaced.metadata, processState, processIdentity)) {
    await restoreDisplacedGuard(quarantinePath, guardPath)
    throw new DataDirectoryLockedError()
  }

  const interruptedQuarantine = `${lockPath}.stale.${displaced.metadata.token}`
  if (await pathExists(interruptedQuarantine)) {
    if (!await pathExists(lockPath)) await rename(interruptedQuarantine, lockPath).catch(() => {})
    else await rm(interruptedQuarantine, { force: true }).catch(() => {})
  }
  await rm(quarantinePath, { force: true })
}

export class DataDirectoryLock implements DataDirectoryLockHandle {
  private held = true
  private readonly filePath: string
  private readonly ownerToken: string

  private constructor(filePath: string, ownerToken: string) {
    this.filePath = filePath
    this.ownerToken = ownerToken
  }

  static async acquire(options: {
    dataDir: string
    pid?: number
    now?: () => Date
    token?: () => string
    processState?: ProcessStateCheck
    processIdentity?: ProcessIdentityCheck
  }): Promise<DataDirectoryLock> {
    await mkdir(options.dataDir, { recursive: true })
    const filePath = join(options.dataDir, '.backend.lock')
    const reclaimPath = join(options.dataDir, '.backend.lock.reclaim')
    const processState = options.processState ?? defaultProcessState
    const processIdentity = options.processIdentity ?? defaultProcessIdentity
    const pid = options.pid ?? process.pid
    const discoveredIdentity = await processIdentity(pid)
    const metadata: LockMetadata = {
      pid,
      startedAt: (options.now ?? (() => new Date()))().toISOString(),
      token: (options.token ?? randomUUID)(),
      processIdentity: validIdentity(discoveredIdentity) ? discoveredIdentity : `unverifiable:${randomUUID()}`,
    }
    if (!parseMetadata(metadata)) throw new DataDirectoryLockedError()

    await reclaimAbandonedGuard(reclaimPath, filePath, processState, processIdentity)
    try {
      return await this.createOwnedLock(filePath, reclaimPath, metadata, false)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const existing = await readMetadata(filePath)
    if (!existing || !await ownerCertainlyGone(existing, processState, processIdentity)) {
      throw new DataDirectoryLockedError()
    }

    const guardToken = randomUUID()
    const guardMetadata: LockMetadata = { ...metadata, token: guardToken }
    try {
      await writeOwnedFile(reclaimPath, guardMetadata)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DataDirectoryLockedError()
      throw error
    }

    const quarantinePath = `${filePath}.stale.${guardToken}`
    let quarantined = false
    let replacement: DataDirectoryLock | undefined
    try {
      const confirmed = await readMetadata(filePath)
      if (!confirmed || confirmed.token !== existing.token ||
        !await ownerCertainlyGone(confirmed, processState, processIdentity)) {
        throw new DataDirectoryLockedError()
      }
      await rename(filePath, quarantinePath)
      quarantined = true
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          replacement = await this.createOwnedLock(filePath, reclaimPath, metadata, true)
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 9) throw error
          await delay(5)
        }
      }
      if (!replacement) throw new DataDirectoryLockedError()
      await rm(quarantinePath, { force: true })
      quarantined = false
      return replacement
    } catch (error) {
      if (!replacement && quarantined && !await pathExists(filePath)) {
        await rename(quarantinePath, filePath).catch(() => {})
        quarantined = false
      }
      throw error instanceof DataDirectoryLockedError ? error : new DataDirectoryLockedError()
    } finally {
      if (quarantined && replacement) await rm(quarantinePath, { force: true }).catch(() => {})
      const currentGuard = await readMetadata(reclaimPath)
      if (currentGuard?.token === guardToken) await rm(reclaimPath, { force: true }).catch(() => {})
    }
  }

  private static async createOwnedLock(
    filePath: string,
    reclaimPath: string,
    metadata: LockMetadata,
    ignoreReclaimGuard: boolean,
  ): Promise<DataDirectoryLock> {
    if (!ignoreReclaimGuard && await pathExists(reclaimPath)) throw new DataDirectoryLockedError()
    await writeOwnedFile(filePath, metadata)
    if (!ignoreReclaimGuard && await pathExists(reclaimPath)) {
      const current = await readMetadata(filePath)
      if (current?.token === metadata.token) await rm(filePath, { force: true }).catch(() => {})
      throw new DataDirectoryLockedError()
    }
    return new DataDirectoryLock(filePath, metadata.token)
  }

  assertHeld(): void {
    if (!this.held) throw new Error('GenerationRunner requires a held data-directory lock')
  }

  async release(): Promise<void> {
    if (!this.held) return
    const metadata = await readMetadata(this.filePath)
    if (!metadata || metadata.token !== this.ownerToken) {
      throw new Error('Cannot safely release a data-directory lock owned by another process')
    }
    await rm(this.filePath)
    this.held = false
  }
}
