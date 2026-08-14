import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { createServer } from 'vite'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
process.env.CANVAS_GATEWAY_ORIGIN = 'http://127.0.0.1:4274'
const vite = await createServer({
  root,
  server: { host: '127.0.0.1', port: 4273, strictPort: true },
})
await vite.listen()

let stopping
function stop() {
  stopping ??= vite.close()
  return stopping
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void stop().finally(() => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143
  }))
}

vite.printUrls()
