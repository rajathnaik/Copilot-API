import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppState } from '../electron/state'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})
function directory() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'modelbridge-state-'))
  directories.push(value)
  return value
}
const codec = {
  encrypt: (value: string) => Buffer.from(value).reverse().toString('base64'),
  decrypt: (value: string) => Buffer.from(value, 'base64').reverse().toString(),
}

test('fresh state creates distinct stable access keys and a persistent installation-owned tunnel ID', async () => {
  const root = directory()
  fs.writeFileSync(path.join(root, 'legacy-config.json'), '{"untouched":true}')
  const state = await AppState.open(path.join(root, 'ModelBridge'), codec)
  expect(state.value.sources).toEqual([])
  expect(state.value.tunnelId).toMatch(/^modelbridge-[a-f0-9]{32}$/u)
  const local = state.vault.get('local-access')
  const remote = state.vault.get('remote-access')
  expect(local).not.toBe(remote)
  const restarted = await AppState.open(path.join(root, 'ModelBridge'), codec)
  expect(restarted.value.tunnelId).toBe(state.value.tunnelId)
  expect(restarted.vault.get('local-access')).toBe(local)
  expect(restarted.vault.get('remote-access')).toBe(remote)
  expect(
    fs.readFileSync(
      path.join(root, 'ModelBridge', 'credentials.encrypted.json'),
      'utf8',
    ),
  ).not.toContain(local)
  expect(fs.readFileSync(path.join(root, 'legacy-config.json'), 'utf8')).toBe(
    '{"untouched":true}',
  )
})

test('corrupt, missing or undecryptable state is not replaced by success-shaped defaults', async () => {
  const root = directory()
  const state = await AppState.open(root, codec)
  await expect(
    AppState.open(root, {
      ...codec,
      decrypt: () => {
        throw new Error('different profile')
      },
    }),
  ).rejects.toThrow('OS profile')
  fs.writeFileSync(path.join(root, 'state.json'), '{broken')
  await expect(AppState.open(root, codec)).rejects.toThrow()
  fs.unlinkSync(path.join(root, 'state.json'))
  await expect(AppState.open(root, codec)).rejects.toThrow(
    'metadata is missing',
  )
  expect(state.vault.get('local-access')).toHaveLength(64)
})

test('a failed first-run key write leaves no partial profile behind', async () => {
  const root = directory()
  await expect(
    AppState.open(root, {
      ...codec,
      encrypt: () => Promise.reject(new Error('provider unavailable')),
    }),
  ).rejects.toThrow('provider unavailable')
  expect(fs.readdirSync(root)).toEqual([])
  expect((await AppState.open(root, codec)).value.sources).toEqual([])
})

test('validates state before persisting changes', async () => {
  const root = directory()
  const state = await AppState.open(root, codec)
  const previous = fs.readFileSync(path.join(root, 'state.json'), 'utf8')
  expect(() =>
    state.save({ ...state.value, tunnelId: 'copilot-api' }),
  ).toThrow()
  expect(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).toBe(previous)
})
