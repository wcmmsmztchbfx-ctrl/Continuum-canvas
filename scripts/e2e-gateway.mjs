import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startGateway } from '../server/http-gateway.ts'

const dataDir = await mkdtemp(join(tmpdir(), 'libtv-collaboration-e2e-'))
const gateway = await startGateway({
  dataDir,
  envFile: join(dataDir, '.env.local'),
  processEnv: { CONTINUUM_E2E: '1' },
  env: {},
  host: '127.0.0.1',
  port: 4274,
})

let stopping
function stop() {
  stopping ??= gateway.close()
    .finally(() => rm(dataDir, { recursive: true, force: true }))
  return stopping
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void stop().finally(() => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143
  }))
}

console.log(`Isolated E2E gateway listening at ${gateway.origin}`)
