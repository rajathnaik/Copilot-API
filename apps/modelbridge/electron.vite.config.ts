import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@modelbridge/runtime'] })],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/main.ts'),
        output: { entryFileNames: 'index.js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/preload.ts'),
        output: { entryFileNames: 'index.js' },
      },
    },
  },
  renderer: {
    root: '.',
    plugins: [react()],
    build: { rollupOptions: { input: resolve(__dirname, 'index.html') } },
  },
})
