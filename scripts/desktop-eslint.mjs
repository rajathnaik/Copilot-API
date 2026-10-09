import eslint from '@eslint/js'
import gitignore from 'eslint-config-flat-gitignore'
import prettier from 'eslint-plugin-prettier/recommended'
import unusedImports from 'eslint-plugin-unused-imports'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export function desktopESLintConfig(configDir, extraIgnores = []) {
  return defineConfig(
    {
      ignores: [
        'node_modules/**',
        'out/**',
        'out-connector/**',
        'release/**',
        'release-connector/**',
        'dist/**',
        '*.tsbuildinfo',
        'electron.vite.config.*.mjs',
        ...extraIgnores,
      ],
    },
    { linterOptions: { reportUnusedDisableDirectives: 'off' } },
    gitignore(),
    eslint.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    prettier,
    {
      languageOptions: {
        globals: { ...globals.browser, ...globals.node },
        parserOptions: {
          projectService: true,
          tsconfigRootDir: configDir,
        },
      },
      plugins: {
        'unused-imports': unusedImports,
      },
      rules: {
        '@typescript-eslint/no-misused-promises': [
          'error',
          { checksVoidReturn: false },
        ],
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
            destructuredArrayIgnorePattern: '^_',
            ignoreRestSiblings: true,
            varsIgnorePattern: '^_',
          },
        ],
        'prettier/prettier': [
          'error',
          {
            experimentalOperatorPosition: 'start',
            experimentalTernaries: true,
            semi: false,
            singleQuote: true,
          },
        ],
        'unused-imports/no-unused-imports': 'error',
      },
    },
    {
      files: ['**/*.js', '**/*.mjs'],
      ...tseslint.configs.disableTypeChecked,
    },
    {
      files: ['**/tests/**/*'],
      rules: {
        '@typescript-eslint/await-thenable': 'off',
        '@typescript-eslint/require-await': 'off',
      },
    },
  )
}
