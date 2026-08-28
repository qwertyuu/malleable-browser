import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Main and preload run in Node; externalize node_modules so the ACP library and
// the claude-code-acp adapter stay resolvable on disk at runtime (require.resolve).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@renderer': resolve(__dirname, 'src/renderer/src') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    server: {
      // Default 5173 (and neighboring ports through ~5202) falls inside a Windows
      // dynamic port exclusion range reserved by Hyper-V/WSL's winnat service on
      // some machines, which makes bind() fail with EACCES. 5000 is outside it.
      host: '127.0.0.1',
      port: 5000
    },
    plugins: [react()]
  }
})
