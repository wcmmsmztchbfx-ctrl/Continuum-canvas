import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from '../atomic-json.ts'
import type { StoredRun } from './types.ts'

export class AgentRunStore {
  readonly records = new Map<string, StoredRun>()
  private readonly directory: string
  constructor(dataDir: string) { this.directory = join(dataDir, 'agent-runs') }
  async open() {
    await mkdir(this.directory, { recursive: true })
    for (const name of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue
      const record = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as StoredRun
      if (record.version !== 1 || `${record.run.id}.json` !== name || !Array.isArray(record.operations)) throw new Error('Invalid Agent run record; recovery required')
      this.records.set(record.run.id, record)
    }
  }
  async save(record: StoredRun) {
    // Serialize now: asynchronous writes must not observe later in-memory mutation.
    await atomicWriteJson(join(this.directory, `${record.run.id}.json`), structuredClone(record))
  }
}
