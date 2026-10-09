import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopESLintConfig } from '../../scripts/desktop-eslint.mjs'

export default [
  ...desktopESLintConfig(dirname(fileURLToPath(import.meta.url))),
  {
    files: ['**/atomic-file.ts', '**/atomic-file.test.ts'],
    rules: {
      'prettier/prettier': [
        'error',
        {
          experimentalOperatorPosition: 'start',
          experimentalTernaries: true,
          semi: false,
        },
      ],
    },
  },
]
