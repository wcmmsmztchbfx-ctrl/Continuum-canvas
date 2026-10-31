import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { startGateway } from '../../server/http-gateway.ts'

const root = resolve(import.meta.dirname, '../..')
const distDir = join(root, '.runtime/performance/build')
const sourceRoot = process.env.PERF_SOURCE_ROOT ? resolve(process.env.PERF_SOURCE_ROOT) : root
await build({ root: sourceRoot, define: { 'import.meta.env.VITE_CANVAS_DIAGNOSTICS': JSON.stringify('1') }, build: { outDir: distDir, emptyOutDir: true } })
const dataDir = await mkdtemp(join(tmpdir(), 'continuum-performance-'))
const gateway = await startGateway({
  dataDir, distDir, env: {}, processEnv: { CONTINUUM_E2E: '1' },
  envFile: join(dataDir, '.env.local'), host: '127.0.0.1', port: 4373,
})
let stopping
const stop = () => stopping ??= gateway.close()
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop())
console.log('Isolated production benchmark: ' + gateway.origin)
