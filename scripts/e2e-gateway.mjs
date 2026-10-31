import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startGateway } from '../server/http-gateway.ts'
import { createAgentFixtureOptions } from './e2e-agent-fixtures.mjs'

const dataDir = await mkdtemp(join(tmpdir(), 'libtv-collaboration-e2e-'))
const gateway = await startGateway({
  ...await createAgentFixtureOptions(),
  dataDir,
  envFile: join(dataDir, '.env.local'),
  processEnv: { CONTINUUM_E2E: '1' },
  env: { API_PROVIDER_AISTARTLAB_KEY: 'e2e-fixture-only' },
  host: '127.0.0.1',
  port: 4274,
  // Exercise the development gateway's LAN authorization while keeping this
  // isolated test server bound to loopback.
  ...(process.env.CONTINUUM_E2E_LAN_AUTH === '1' ? {
    localHostOnly: false,
    publicOrigin: 'http://192.168.1.4:4273',
    allowedOrigins: ['http://192.168.1.4:4273', 'http://127.0.0.1:4273'],
    allowInsecureLan: true,
  } : {}),
})
await gateway.runtime.agentConfig.upsert({ id: 'e2e-agent', name: 'E2E Agent',
  baseUrl: 'https://agent-fixture.example/v1', model: 'e2e-vision', enabled: true,
  preferred: true, secret: 'e2e-fixture-only' })
await gateway.runtime.syncProvider('aistartlab')

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
