import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexConfigurations } from '../src/harnesses/codex-configurations'
import {
  configValue,
  configureCodex,
  redactConfig,
} from '../src/harnesses/codex-config'
import { EncryptedVault } from '../src/credentials/vault'
import type { AvailableModel } from '../src/contracts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})
const models: AvailableModel[] = [
  {
    id: 'host/copilot/gpt',
    name: 'GPT',
    sourceId: 'host',
    sourceLabel: 'Remote Copilot',
    protocol: 'responses',
    supportsTools: true,
  },
  {
    id: 'host/copilot/claude',
    name: 'Claude',
    sourceId: 'host',
    sourceLabel: 'Remote Copilot',
    protocol: 'responses',
    upstreamProtocol: 'messages',
    supportsTools: true,
  },
]
const helper = {
  command: 'C:\\Programs\\ModelBridge.exe',
  args: ['--modelbridge-credential', '--user-data-dir=C:\\Profile'],
}
const url = 'http://127.0.0.1:4321/v1'
const original =
  '# Native account stays signed in\nmodel = "native-model"\nmodel_provider = "openai"\n\n[projects."C:\\\\work"]\ntrust_level = "trusted"\n\n[mcp_servers.local]\ncommand = "local-mcp"\n'
function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'modelbridge-codex-config-'),
  )
  directories.push(directory)
  const file = path.join(directory, 'config.toml')
  fs.writeFileSync(file, original)
  fs.writeFileSync(
    path.join(directory, 'auth.json'),
    'native-account-do-not-touch',
  )
  const vault = new EncryptedVault(path.join(directory, 'credentials.json'), {
    encrypt: (value) => Buffer.from(value).reverse().toString('base64'),
    decrypt: (value) => Buffer.from(value, 'base64').reverse().toString(),
  })
  const revisions = path.join(directory, 'revisions')
  return {
    directory,
    file,
    vault,
    revisions,
    service: new CodexConfigurations(file, revisions, vault, helper),
  }
}
test('preview explains exact Codex changes and writes nothing until approval', () => {
  const { file, service, revisions } = fixture()
  const preview = service.preview(
    'My remote Copilot',
    models[0].id,
    models,
    url,
  )
  expect(fs.readFileSync(file, 'utf8')).toBe(original)
  expect(fs.existsSync(revisions)).toBe(false)
  expect(preview.before).toBe(original)
  const value = configValue(preview.after)
  expect(value).toMatchObject({
    model: models[0].id,
    model_provider: 'modelbridge',
    model_reasoning_effort: 'none',
  })
  expect(preview.after).toContain('requires_openai_auth = false')
  expect(preview.after).toContain('auth]')
  expect(preview.after).not.toContain('experimental_bearer_token')
  expect(preview.changes.join('\n')).toContain('auth.json')
  expect(preview.changes.join('\n')).toContain('ChatGPT backend')
})
test('activation, revision switching, restart and native restoration preserve unrelated edits and auth', () => {
  const { directory, file, service, revisions, vault } = fixture()
  const first = service.preview('GPT configuration', models[0].id, models, url)
  expect(service.apply(first.id).active).toBe(first.id)
  const catalog: unknown = JSON.parse(
    fs.readFileSync(first.catalogPath, 'utf8'),
  )
  expect(catalog).toMatchObject({
    models: [{ slug: models[0].id }, { slug: models[1].id }],
  })
  fs.appendFileSync(file, '\n[tools]\nweb_search = false\n')
  const second = service.preview(
    'Claude configuration',
    models[1].id,
    models,
    url,
  )
  service.apply(second.id)
  const restarted = new CodexConfigurations(file, revisions, vault, helper)
  expect(restarted.status().revisions).toHaveLength(2)
  expect(restarted.status().effective.model).toBe(models[1].id)
  restarted.apply(restarted.previewRevision(first.id, models, url).id)
  const restore = restarted.restore()
  expect(restore.after).toContain('model_provider = "openai"')
  restarted.apply(restore.id)
  expect(restarted.status().active).toBeNull()
  expect(fs.readFileSync(file, 'utf8')).toContain('web_search = false')
  expect(fs.readFileSync(file, 'utf8')).toContain('command = "local-mcp"')
  expect(fs.readFileSync(path.join(directory, 'auth.json'), 'utf8')).toBe(
    'native-account-do-not-touch',
  )
  expect(
    fs.readFileSync(path.join(directory, 'credentials.json'), 'utf8'),
  ).not.toContain('Native account')
})
test('stale previews and external provider edits cannot overwrite newer settings without acknowledgement', () => {
  const { file, service } = fixture()
  const preview = service.preview('Test', models[0].id, models, url)
  fs.appendFileSync(file, '\n# changed after preview\n')
  expect(() => service.apply(preview.id)).toThrow('changed after')
  expect(service.status().revisions).toHaveLength(0)
  service.apply(service.preview('Test', models[0].id, models, url).id)
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8').replace(models[0].id, 'external-model'),
  )
  expect(service.status().externalManagedEdit).toBe(true)
  expect(() => service.preview('Test', models[0].id, models, url)).toThrow(
    'outside ModelBridge',
  )
  expect(() => service.restore()).toThrow('outside ModelBridge')
  service.reconcile()
  expect(service.status().externalManagedEdit).toBe(false)
  service.apply(
    service.preview('Reviewed external change', models[1].id, models, url).id,
  )
  expect(service.status().effective.model).toBe(models[1].id)
})
test('unsupported models, malformed config and unowned provider collisions fail before writes', () => {
  const { file, service } = fixture()
  expect(() => service.preview('Unknown', 'not-a-model', models, url)).toThrow(
    'available',
  )
  fs.writeFileSync(file, 'model = [broken')
  expect(() => service.status()).toThrow('valid TOML')
  fs.writeFileSync(
    file,
    '[model_providers.modelbridge]\nname="Some other owner"\n',
  )
  expect(() => service.preview('Collision', models[0].id, models, url)).toThrow(
    'not owned',
  )
})
test('preview redacts existing secrets and TOML editing preserves comments, quoted keys and CRLF', () => {
  const text =
    original.replaceAll('\n', '\r\n')
    + '\r\n[model_providers.private]\r\nexperimental_bearer_token = "dont-display-this"\r\nhttp_headers = { Authorization = "dont-display-that" }\r\n'
  const redacted = redactConfig(text)
  expect(redacted).not.toContain('dont-display')
  const changed = configureCodex(text, {
    model: models[0].id,
    url,
    catalogPath: 'C:\\models.json',
    helperCommand: helper.command,
    helperArgs: helper.args,
  })
  expect(changed).toContain('# Native account stays signed in')
  expect(changed).toContain('[projects."C:\\\\work"]')
  expect(changed).toContain('experimental_bearer_token = "dont-display-this"')
  expect(configValue(changed)).toHaveProperty('model_providers.private')
})
test('interrupted committed config is recovered from the encrypted journal, not reset', () => {
  const { file, service, revisions, vault } = fixture()
  const preview = service.preview('Recovery', models[0].id, models, url)
  service.apply(preview.id)
  const marker = fs
    .readdirSync(revisions)
    .find((entry) => entry.endsWith('.managed'))
  if (!marker) throw new Error('Missing revision ownership marker.')
  const id = `codex-configurations-${marker.replace('.managed', '')}`
  const saved = JSON.parse(vault.get(id)) as {
    pending: unknown
    active: string | null
    fingerprint: string
  }
  saved.pending = {
    before: original,
    after: fs.readFileSync(file, 'utf8'),
    revisionId: preview.id,
  }
  saved.active = null
  vault.set(id, JSON.stringify(saved))
  expect(
    new CodexConfigurations(file, revisions, vault, helper).status().active,
  ).toBe(preview.id)
})
