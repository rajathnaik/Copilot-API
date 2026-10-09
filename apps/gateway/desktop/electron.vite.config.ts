import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '~': resolve(__dirname, '../src'),
      },
    },
    plugins: [externalizeDepsPlugin({ exclude: ['@copilot-api/shared'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
        },
      },
    },
  },
  preload: {
    resolve: {
      alias: {
        '~': resolve(__dirname, '../src'),
      },
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts'),
        },
      },
    },
  },
  renderer: {
    root: '.',
    server: {
      // The renderer imports the dependency-free shared hostname module
      // from the Gateway API and workspace UI; allow the dev server to serve them.
      fs: {
        allow: [resolve(__dirname, '../../..')],
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
        },
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
