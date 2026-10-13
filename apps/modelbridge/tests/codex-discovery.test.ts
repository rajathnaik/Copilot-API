import { expect, test } from 'bun:test'
import path from 'node:path'
import {
  codexCandidates,
  codexConfigPath,
  parseCodexVersion,
} from '../electron/codex-discovery'

test('Codex uses its explicit home and accepts installed alpha versions without confusing GUI launchers', () => {
  expect(
    codexConfigPath({ CODEX_HOME: 'C:\\test-codex' }, 'C:\\native-home'),
  ).toBe(path.join('C:\\test-codex', 'config.toml'))
  expect(codexConfigPath({}, 'C:\\native-home')).toBe(
    path.join('C:\\native-home', '.codex', 'config.toml'),
  )
  expect(parseCodexVersion('codex-cli 0.162.0-alpha.2\n')).toBe(
    '0.162.0-alpha.2',
  )
  expect(() => parseCodexVersion('Codex Desktop 26.1002')).toThrow(
    'valid Codex',
  )
  expect(() => parseCodexVersion('codex-cli 0.159.0')).toThrow('Update')
  expect(codexCandidates({ PATH: 'C:\\bin;C:\\tools' })).toContain(
    path.join('C:\\bin', 'codex.exe'),
  )
})
