import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopESLintConfig } from './scripts/desktop-eslint.mjs'

export default desktopESLintConfig(dirname(fileURLToPath(import.meta.url)), [
  'apps/**',
  'packages/**',
  'plugin/**',
])
