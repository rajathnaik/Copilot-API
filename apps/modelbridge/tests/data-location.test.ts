import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  copyProfile,
  pointerFile,
  readDataLocation,
  validateDataTarget,
  writeDataLocation,
  writeDataRegistry,
} from '../electron/data-location'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})
function temporary() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modelbridge-data-'))
  directories.push(directory)
  return directory
}

test('reads the pointer the installer writes and the one the app writes', () => {
  const install = temporary()
  expect(readDataLocation(install)).toBeNull()
  const data = path.join(install, '..', 'Data Folder ü')
  writeDataLocation(install, data)
  expect(readDataLocation(install)).toBe(path.resolve(data))
  fs.writeFileSync(path.join(install, pointerFile), `\uFEFF${data}\r\n`)
  expect(readDataLocation(install)).toBe(path.resolve(data))
  fs.writeFileSync(path.join(install, pointerFile), 'relative\\folder')
  expect(readDataLocation(install)).toBeNull()
})

test('rejects data targets that would lose or overwrite data', () => {
  const root = temporary()
  const current = path.join(root, 'current')
  const install = path.join(root, 'install')
  fs.mkdirSync(current)
  fs.mkdirSync(install)
  expect(() => validateDataTarget('relative', current, install)).toThrow(
    'full folder path',
  )
  expect(() =>
    validateDataTarget(path.parse(root).root, current, install),
  ).toThrow('root of a drive')
  expect(() =>
    validateDataTarget(path.join(current, 'inner'), current, install),
  ).toThrow('current data folder')
  expect(() => validateDataTarget(root, current, install)).toThrow(
    'current data folder',
  )
  expect(() =>
    validateDataTarget(path.join(install, 'data'), current, install),
  ).toThrow('outside the install folder')
  const used = path.join(root, 'used')
  fs.mkdirSync(used)
  fs.writeFileSync(path.join(used, 'file.txt'), 'x')
  expect(() => validateDataTarget(used, current, install)).toThrow(
    'empty folder',
  )
  expect(
    validateDataTarget(` ${path.join(root, 'new')} `, current, install),
  ).toBe(path.join(root, 'new'))
})

test('copies the profile, skips the lock and optional failures, and fails on essential files', () => {
  const root = temporary()
  const from = path.join(root, 'from')
  fs.mkdirSync(path.join(from, 'usage'), { recursive: true })
  fs.writeFileSync(path.join(from, 'state.json'), '{"role":"host"}')
  fs.writeFileSync(path.join(from, 'credentials.json'), '{"key":"secret"}')
  fs.writeFileSync(path.join(from, 'usage', '2026-11.jsonl'), 'row\n')
  fs.writeFileSync(path.join(from, 'lockfile'), '')
  fs.writeFileSync(path.join(from, 'Cache'), 'cache')

  const to = path.join(root, 'to')
  fs.mkdirSync(to)
  // An existing optional entry cannot be overwritten, so it is reported.
  fs.writeFileSync(path.join(to, 'Cache'), 'other')
  expect(copyProfile(from, to)).toEqual(['Cache'])
  expect(fs.readFileSync(path.join(to, 'credentials.json'), 'utf8')).toBe(
    '{"key":"secret"}',
  )
  expect(fs.readFileSync(path.join(to, 'usage', '2026-11.jsonl'), 'utf8')).toBe(
    'row\n',
  )
  expect(fs.existsSync(path.join(to, 'lockfile'))).toBe(false)

  const blocked = path.join(root, 'blocked')
  fs.mkdirSync(blocked)
  fs.writeFileSync(path.join(blocked, 'state.json'), 'other')
  expect(() => copyProfile(from, blocked)).toThrow()
})

test('records the data folder in the per-user registry key', async () => {
  const calls: unknown[][] = []
  await writeDataRegistry('D:\\Model Data', async (...args) => {
    calls.push(args)
  })
  expect(calls).toEqual([
    [
      'reg.exe',
      [
        'add',
        'HKCU\\Software\\ModelBridge',
        '/v',
        'DataDir',
        '/t',
        'REG_SZ',
        '/d',
        'D:\\Model Data',
        '/f',
      ],
      { timeout: 15_000, windowsHide: true },
    ],
  ])
})
