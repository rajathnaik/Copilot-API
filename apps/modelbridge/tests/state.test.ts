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

test('fresh state creates distinct stable access keys and a persistent installation-owned tunnel ID', () => {
  const root = directory()
  fs.writeFileSync(path.join(root, 'legacy-config.json'), '{"untouched":true}')
  const state = AppState.open(path.join(root, 'ModelBridge'))
  expect(state.value.sources).toEqual([])
  expect(state.value.tunnelId).toMatch(/^modelbridge-[a-f0-9]{32}$/u)
  expect(state.archivedLegacyProfile).toBeNull()
  const local = state.vault.get('local-access')
  const remote = state.vault.get('remote-access')
  expect(local).toHaveLength(64)
  expect(local).not.toBe(remote)
  const restarted = AppState.open(path.join(root, 'ModelBridge'))
  expect(restarted.value.tunnelId).toBe(state.value.tunnelId)
  expect(restarted.vault.get('local-access')).toBe(local)
  expect(restarted.vault.get('remote-access')).toBe(remote)
  expect(
    JSON.parse(
      fs.readFileSync(
        path.join(root, 'ModelBridge', 'credentials.json'),
        'utf8',
      ),
    ),
  ).toEqual({ 'local-access': local, 'remote-access': remote })
  expect(fs.readFileSync(path.join(root, 'legacy-config.json'), 'utf8')).toBe(
    '{"untouched":true}',
  )
})

test('corrupt or missing state is not replaced by success-shaped defaults', () => {
  const root = directory()
  AppState.open(root)
  fs.writeFileSync(path.join(root, 'state.json'), '{broken')
  expect(() => AppState.open(root)).toThrow()
  fs.unlinkSync(path.join(root, 'state.json'))
  expect(() => AppState.open(root)).toThrow('metadata is missing')
})

test('an encrypted profile from an earlier build is archived while the tunnel identity is kept', () => {
  const root = directory()
  const tunnelId = `modelbridge-${'a'.repeat(32)}`
  fs.writeFileSync(
    path.join(root, 'state.json'),
    JSON.stringify({
      version: 1,
      tunnelId,
      sources: [
        {
          id: '00000000-0000-4000-8000-000000000000',
          label: 'Copilot',
          kind: 'copilot',
          baseUrl: 'https://api.githubcopilot.com',
          shared: true,
          models: [{ id: 'gpt-5', name: 'GPT-5', protocol: 'responses' }],
        },
      ],
    }),
  )
  fs.writeFileSync(
    path.join(root, 'credentials.encrypted.json'),
    '{"local-access":"modelbridge-dpapi-v1:AAAA"}',
  )
  fs.mkdirSync(path.join(root, 'codex'))
  fs.writeFileSync(path.join(root, 'codex', 'config.managed'), 'managed')
  const state = AppState.open(root)
  expect(state.archivedLegacyProfile).not.toBeNull()
  const archive = state.archivedLegacyProfile ?? ''
  expect(fs.existsSync(path.join(archive, 'credentials.encrypted.json'))).toBe(
    true,
  )
  expect(fs.existsSync(path.join(archive, 'codex', 'config.managed'))).toBe(
    true,
  )
  expect(fs.existsSync(path.join(root, 'credentials.encrypted.json'))).toBe(
    false,
  )
  expect(fs.existsSync(path.join(root, 'codex'))).toBe(false)
  expect(state.value.tunnelId).toBe(tunnelId)
  expect(state.value.sources).toEqual([])
  expect(state.vault.get('local-access')).toHaveLength(64)
  expect(AppState.open(root).archivedLegacyProfile).toBeNull()
})

test('validates state before persisting changes', () => {
  const root = directory()
  const state = AppState.open(root)
  const previous = fs.readFileSync(path.join(root, 'state.json'), 'utf8')
  expect(() =>
    state.save({ ...state.value, tunnelId: 'copilot-api' }),
  ).toThrow()
  expect(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).toBe(previous)
})
