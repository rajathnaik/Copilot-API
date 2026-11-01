import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDiagnosticsLog, describeError } from '../electron/diagnostics'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})
function directory() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'modelbridge-log-'))
  directories.push(value)
  return value
}

test('diagnostics append ordered single-line events with elapsed time', async () => {
  const root = directory()
  let elapsed = 10
  const log = createDiagnosticsLog(root, () => elapsed)
  void log.write('app ready')
  elapsed = 2500.4
  await log.write(
    'startup failed',
    describeError(new Error('line one\nline two')),
  )
  const lines = fs.readFileSync(log.file, 'utf8').trim().split('\n')
  expect(log.file).toBe(path.join(root, 'logs', 'modelbridge.log'))
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT.+Z \+10ms app ready$/u)
  expect(lines[1]).toEndWith('+2500ms startup failed Error: line one line two')
  expect(describeError('not an error')).toBe('Unknown error')
  await log.write('long', 'x'.repeat(2000))
  expect(fs.readFileSync(log.file, 'utf8')).toEndWith(
    ` long ${'x'.repeat(500)}\n`,
  )
})

test('diagnostics rotate an oversized log instead of growing without bound', async () => {
  const root = directory()
  fs.mkdirSync(path.join(root, 'logs'))
  const file = path.join(root, 'logs', 'modelbridge.log')
  fs.writeFileSync(file, 'old\n'.repeat(100))
  const log = createDiagnosticsLog(root, () => 0, 64)
  await log.write('fresh session')
  expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('old\n'.repeat(100))
  expect(fs.readFileSync(file, 'utf8')).toEndWith('+0ms fresh session\n')
})
