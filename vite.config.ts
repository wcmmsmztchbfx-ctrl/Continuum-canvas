import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

type ViteEnvironment = Record<string, string | undefined>

export function resolveViteHost(env: ViteEnvironment): string {
  return env.CANVAS_VITE_HOST?.trim() || '127.0.0.1'
}

export function resolveCanvasPublicOrigin(env: ViteEnvironment): string {
  return env.CANVAS_PUBLIC_ORIGIN?.trim() || ''
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const gatewayTarget = env.CANVAS_GATEWAY_ORIGIN ?? 'http://127.0.0.1:4174'
  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_CANVAS_PUBLIC_ORIGIN': JSON.stringify(resolveCanvasPublicOrigin(env)),
    },
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'react-vendor',
                test: /node_modules[\\/](react|react-dom)[\\/]/,
                priority: 2,
              },
              {
                name: 'canvas-vendor',
                test: /node_modules[\\/]@xyflow[\\/]/,
                priority: 2,
              },
              {
                name: 'collab-vendor',
                test: /node_modules[\\/](yjs|y-protocols|y-indexeddb|lib0)[\\/]/,
                priority: 2,
              },
              {
                name: 'icons-vendor',
                test: /node_modules[\\/]lucide-react[\\/]/,
                priority: 2,
              },
            ],
          },
        },
      },
    },
    server: {
      host: resolveViteHost(env),
      port: 4173,
      strictPort: true,
      watch: {
        ignored: ['**/data/**', '**/.env.local', '**/.env'],
      },
      proxy: {
        '/api': { target: gatewayTarget, ws: true },
      },
    },
  }
})
