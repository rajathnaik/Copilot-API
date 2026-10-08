import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['toml-eslint-parser'] })],
    build: {
      outDir: 'out-connector/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/connector-main.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out-connector/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/connector-preload.ts') },
      },
    },
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out-connector/renderer',
      rollupOptions: {
        input: { connector: resolve(__dirname, 'connector.html') },
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
