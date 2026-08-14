import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const pendingWrites = new Map<string, Promise<unknown>>()
const TRANSIENT_REPLACE_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM'])

interface ReplaceFileOptions {
  renameFile?: typeof rename
  wait?: (delayMs: number) => Promise<void>
  attempts?: number
}

export async function replaceFileWithRetry(
  source: string,
  target: string,
  options: ReplaceFileOptions = {},
): Promise<void> {
  const renameFile = options.renameFile ?? rename
  const wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
  const attempts = options.attempts ?? 8
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await renameFile(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !TRANSIENT_REPLACE_ERRORS.has(code) || attempt === attempts - 1) throw error
      await wait(Math.min(10 * (2 ** attempt), 100))
    }
  }
}

async function withFileLock<T>(filePath: string, operation: (target: string) => Promise<T>): Promise<T> {
  const target = resolve(filePath)
  const previous = pendingWrites.get(target) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => operation(target))
  pendingWrites.set(target, current)
  try {
    return await current
  } finally {
    if (pendingWrites.get(target) === current) pendingWrites.delete(target)
  }
}

async function writeAtomicUnlocked(target: string, serialized: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await replaceFileWithRetry(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function atomicWriteText(filePath: string, value: string): Promise<void> {
  await withFileLock(filePath, (target) => writeAtomicUnlocked(target, value))
}

export async function atomicUpdateText(
  filePath: string,
  update: (current: string) => string | Promise<string>,
): Promise<void> {
  await withFileLock(filePath, async (target) => {
    let current = ''
    try {
      current = await readFile(target, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writeAtomicUnlocked(target, await update(current))
  })
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}
