import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  configureHarness,
  detectHarness,
  harnessCandidates,
  harnessConfigPath,
  harnessFingerprint,
  hasHarnessProvider,
  helperShellCommand,
  OPENCLAW_SECRET_ID,
  profileDirectory,
  PROVIDER_ID,
  restoreHarness,
  type AdditionalHarness,
} from '../electron/connector/harness'
import {
  HarnessService,
  openClawSecretRequest,
  resolveSharedInput,
} from '../electron/connector/harness-service'
import { StructuredConfig } from '../electron/connector/structured-config'
import {
  ConnectorStore,
  type CredentialCodec,
} from '../electron/connector/store'
import type { CommandRunner } from '../electron/connector/codex'
import type { ConnectorFetch } from '../electron/connector/gateway'

const harnesses: AdditionalHarness[] = [
  'claude-code',
  'opencode',
  'hermes',
  'openclaw',
]
const key = 'synthetic-independent-key'
const url = 'https://example.devtunnels.ms'
const models = [
  {
    id: 'gpt-test',
    name: 'Test',
    description: '',
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    vision: true,
    reasoning: false,
  },
]
const options = {
  baseUrl: url,
  model: 'gpt-test',
  models,
  apiKey: key,
  helperCommand: 'C:\\Fixture With Spaces\\Connector.exe',
  helperArgs: [
    '--connector-token',
    '--user-data-dir=C:\\Fixture With Spaces\\Data',
  ],
  platform: 'win32' as const,
}
const codec: CredentialCodec = {
  available: () => true,
  encrypt: (value) => Buffer.from(value).reverse().toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').reverse().toString(),
}
let directory: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-harness-unit-'))
})
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

function doc(harness: AdditionalHarness, text: string) {
  return new StructuredConfig(
    text,
    harness === 'hermes' ? 'yaml'
    : harness === 'openclaw' ? 'json5'
    : harness === 'opencode' ? 'jsonc'
    : 'json',
  )
}
const original: Record<AdditionalHarness, string> = {
  'claude-code':
    '{"model":"old","apiKeyHelper":"original-helper","permissions":{"deny":["Bash"]},"env":{"CUSTOM":"keep","ANTHROPIC_AUTH_TOKEN":"old-token"}}\n',
  opencode:
    '{ // keep this comment\n "model":"other/old","provider":{"other":{"name":"Keep"}},"enabled_providers":["other"],"disabled_providers":["copilot_api_connector","unrelated"]}\n',
  hermes:
    '# keep this comment\nmodel:\n  default: old\n  provider: openrouter\nterminal:\n  backend: docker\nproviders:\n  other:\n    api: https://other.example/v1\n',
  openclaw:
    "{ // keep this comment\n channels: { custom: 'keep' }, models: {providers: {other: {baseUrl:'https://other.example/v1',models:[]}}}, agents: {defaults:{model:{primary:'other/old',fallbacks:['other/fallback']},models:{'other/old':{}}}}}\n",
}

describe('native harness configuration adapters', () => {
  for (const harness of harnesses) {
    test(`${harness} repairs only owned settings with a durable backup and preserves the original Undo baseline`, async () => {
      const { service, storage, dependencies } = fixture(harness)
      const input = { url, apiKey: key, allowPlaintext: harness === 'opencode' }
      await service.connect(input)
      const changed = doc(
        harness,
        configureHarness(harness, storage.read('config') ?? '', {
          ...options,
          baseUrl: 'https://externally-edited.example',
          helperCommand: dependencies.helperCommand,
          helperArgs: dependencies.helperArgs,
        }),
      )
      changed.set(['later'], 9)
      const edited = changed.toString()
      fs.writeFileSync(storage.files.config, edited)
      await expect(service.connect(input)).rejects.toThrow('Repair connection')
      await service.connect(input, true)
      const backupDirectory = path.join(storage.directory, 'config-backups')
      const backups = fs.readdirSync(backupDirectory)
      expect(backups).toHaveLength(1)
      expect(
        fs.readFileSync(path.join(backupDirectory, backups[0]), 'utf8'),
      ).toBe(edited)
      expect(storage.state()?.originalConfig).toBe(original[harness])
      expect(doc(harness, storage.read('config') ?? '').get(['later'])).toBe(9)
      await service.undo()
      expect(doc(harness, storage.read('config') ?? '').get(['later'])).toBe(9)
      expect(storage.state()).toBeNull()
      expect(fs.existsSync(path.join(backupDirectory, backups[0]))).toBe(true)
    })

    test(`${harness} preserves unrelated settings and safely restores ownership`, () => {
      const configured = configureHarness(harness, original[harness], options)
      const current = doc(harness, configured)
      expect(hasHarnessProvider(harness, configured)).toBe(true)
      expect(configured.includes(key)).toBe(harness === 'opencode')
      if (harness !== 'claude-code')
        expect(configured).toContain('keep this comment')
      current.set(['addedLater'], 'keep too')
      expect(harnessFingerprint(harness, current.toString())).toBe(
        harnessFingerprint(harness, configured),
      )
      const restored = restoreHarness(
        harness,
        current.toString(),
        original[harness],
      )
      const baseline = doc(harness, original[harness])
      const result = doc(harness, restored.text)
      expect(result.get(['addedLater'])).toBe('keep too')
      expect(
        result.get(
          harness === 'openclaw' ? ['agents', 'defaults', 'model'] : ['model'],
        ),
      ).toEqual(
        baseline.get(
          harness === 'openclaw' ? ['agents', 'defaults', 'model'] : ['model'],
        ),
      )
      expect(hasHarnessProvider(harness, restored.text)).toBe(false)
    })
    test(`${harness} creates an undoable configuration without a previous file`, () => {
      const configured = configureHarness(harness, '', options)
      const restored = restoreHarness(harness, configured, '')
      expect(restored.empty).toBe(true)
    })
  }

  test('Claude uses the gateway root and a helper, and neutralizes competing credential routes', () => {
    const result = doc(
      'claude-code',
      configureHarness('claude-code', original['claude-code'], options),
    )
    expect(result.get(['env', 'ANTHROPIC_BASE_URL'])).toBe(url)
    expect(result.get(['env', 'ANTHROPIC_AUTH_TOKEN'])).toBe('')
    expect(result.get(['env', 'ANTHROPIC_API_KEY'])).toBe('')
    expect(result.get(['env', 'CLAUDE_CODE_USE_BEDROCK'])).toBe('0')
    expect(result.get(['env', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'])).toBe(
      'gpt-test',
    )
    expect(result.get(['permissions'])).toEqual({ deny: ['Bash'] })
    expect(result.get(['apiKeyHelper'])).toContain(
      '"C:\\Fixture With Spaces\\Connector.exe"',
    )
  })

  test('OpenCode uses Anthropic /v1, correct model IDs and only known limits', () => {
    const result = doc(
      'opencode',
      configureHarness('opencode', original.opencode, options),
    )
    expect(result.get(['provider', PROVIDER_ID, 'npm'])).toBe(
      '@ai-sdk/anthropic',
    )
    expect(result.get(['provider', PROVIDER_ID, 'options'])).toEqual({
      baseURL: `${url}/v1`,
      apiKey: key,
    })
    expect(
      result.get(['provider', PROVIDER_ID, 'models', 'gpt-test', 'limit']),
    ).toEqual({ context: 128_000, output: 8192 })
    expect(result.get(['small_model'])).toBe(`${PROVIDER_ID}/gpt-test`)
    expect(result.get(['enabled_providers'])).toEqual(['other', PROVIDER_ID])
    expect(result.get(['disabled_providers'])).toEqual(['unrelated'])
    expect(() =>
      configureHarness('opencode', '', { ...options, apiKey: '{env:SECRET}' }),
    ).toThrow('substitution')
  })

  test('Claude model picker exposes every gateway ID and preserves unrelated picker rows and restrictions', () => {
    const source = JSON.stringify({
      availableModels: ['gpt-test', 'user-model'],
      modelPicker: {
        replaceBuiltInOptions: true,
        options: [{ model: 'user-model', label: 'Existing' }],
      },
    })
    const configured = configureHarness('claude-code', source, options)
    const current = doc('claude-code', configured)
    expect(current.get(['availableModels'])).toEqual(['gpt-test', 'user-model'])
    expect(current.get(['modelPicker', 'replaceBuiltInOptions'])).toBe(true)
    const rows = current.get(['modelPicker', 'options'])
    if (!Array.isArray(rows)) throw new Error('Missing model picker rows.')
    const pickerOptions: unknown[] = rows
    expect(rows).toHaveLength(2)
    current.set(
      ['modelPicker', 'options'],
      [...pickerOptions, { model: 'later-user-model', label: 'Later' }],
    )
    expect(harnessFingerprint('claude-code', current.toString())).toBe(
      harnessFingerprint('claude-code', configured),
    )
    const refreshed = configureHarness('claude-code', current.toString(), {
      ...options,
      model: 'replacement',
      models: [{ ...models[0], id: 'replacement' }],
    })
    expect(
      doc('claude-code', refreshed).get(['modelPicker', 'options']),
    ).toEqual([
      { model: 'user-model', label: 'Existing' },
      { model: 'later-user-model', label: 'Later' },
      expect.objectContaining({ model: 'replacement' }),
    ])
    const restored = doc(
      'claude-code',
      restoreHarness('claude-code', refreshed, source).text,
    )
    expect(restored.get(['modelPicker', 'options'])).toEqual([
      { model: 'user-model', label: 'Existing' },
      { model: 'later-user-model', label: 'Later' },
    ])
  })

  test('Claude adds opaque IDs without duplicating existing user model rows', () => {
    const source =
      '{"modelPicker":{"options":[{"model":"gpt-test","label":"My label"}]}}'
    const configured = configureHarness('claude-code', source, {
      ...options,
      models: [
        ...models,
        { ...models[0], id: 'opaque-gateway-id', name: 'Opaque' },
      ],
    })
    expect(
      doc('claude-code', configured).get(['modelPicker', 'options']),
    ).toEqual([
      { model: 'gpt-test', label: 'My label' },
      expect.objectContaining({ model: 'opaque-gateway-id', label: 'Opaque' }),
    ])
    const changed = doc('claude-code', configured)
    changed.set(
      ['modelPicker', 'options'],
      [{ model: 'gpt-test', description: '[Copilot API Connector] Edited' }],
    )
    expect(harnessFingerprint('claude-code', changed.toString())).not.toBe(
      harnessFingerprint('claude-code', configured),
    )
  })

  test('Claude rejects malformed native picker options', () => {
    for (const value of ['invalid', {}, [null], [{ model: 4 }]]) {
      expect(() =>
        configureHarness(
          'claude-code',
          JSON.stringify({ modelPicker: { options: value } }),
          options,
        ),
      ).toThrow('modelPicker.options')
    }
  })

  test('OpenCode provider allowlists preserve later unrelated edits through Sync and Undo', () => {
    const configured = configureHarness('opencode', original.opencode, options)
    const current = doc('opencode', configured)
    current.set(['enabled_providers'], ['other', PROVIDER_ID, 'later'])
    current.set(['disabled_providers'], ['unrelated', 'later-disabled'])
    expect(harnessFingerprint('opencode', current.toString())).toBe(
      harnessFingerprint('opencode', configured),
    )
    const restored = doc(
      'opencode',
      restoreHarness('opencode', current.toString(), original.opencode).text,
    )
    expect(restored.get(['enabled_providers'])).toEqual(['other', 'later'])
    expect(restored.get(['disabled_providers'])).toEqual([
      'unrelated',
      'later-disabled',
      PROVIDER_ID,
    ])
    current.set(['enabled_providers'], ['other'])
    expect(harnessFingerprint('opencode', current.toString())).not.toBe(
      harnessFingerprint('opencode', configured),
    )
    expect(() =>
      configureHarness('opencode', '{"enabled_providers":2}', options),
    ).toThrow('array')
  })

  test('Hermes uses a named custom provider and its native key_cmd surface', () => {
    const result = doc(
      'hermes',
      configureHarness('hermes', original.hermes, options),
    )
    expect(result.get(['model'])).toEqual({
      provider: `custom:${PROVIDER_ID}`,
      default: 'gpt-test',
    })
    expect(result.get(['providers', PROVIDER_ID, 'api'])).toBe(`${url}/v1`)
    expect(result.get(['providers', PROVIDER_ID, 'transport'])).toBe(
      'chat_completions',
    )
    expect(result.get(['providers', PROVIDER_ID, 'key_cmd'])).toContain(
      '--connector-token',
    )
    expect(result.get(['providers', PROVIDER_ID, 'discover_models'])).toBe(
      false,
    )
    expect(result.get(['terminal', 'backend'])).toBe('docker')
  })

  test('OpenClaw registers runtime models, an exec SecretRef and all selected-model aliases', () => {
    const result = doc(
      'openclaw',
      configureHarness('openclaw', original.openclaw, options),
    )
    expect(result.get(['models', 'providers', PROVIDER_ID, 'api'])).toBe(
      'openai-completions',
    )
    expect(result.get(['models', 'providers', PROVIDER_ID, 'baseUrl'])).toBe(
      `${url}/v1`,
    )
    expect(result.get(['models', 'providers', PROVIDER_ID, 'apiKey'])).toEqual({
      source: 'exec',
      provider: PROVIDER_ID,
      id: OPENCLAW_SECRET_ID,
    })
    expect(result.get(['secrets', 'providers', PROVIDER_ID, 'jsonOnly'])).toBe(
      false,
    )
    expect(
      result.has(['agents', 'defaults', 'models', `${PROVIDER_ID}/gpt-test`]),
    ).toBe(true)
    expect(result.has(['agents', 'defaults', 'models', 'other/old'])).toBe(true)
    expect(() =>
      configureHarness('openclaw', "{$include:'other.json'}", options),
    ).toThrow('includes')
  })

  test('helper commands quote spaces safely and reject Windows expansion characters', () => {
    expect(
      helperShellCommand('/opt/user tools/connector', ["user's data"], 'linux'),
    ).toBe("'/opt/user tools/connector' 'user'\"'\"'s data'")
    for (const command of [
      'C:\\%PATH%\\app.exe',
      'C:\\bad!\\app.exe',
      'bad\npath',
    ])
      expect(() => helperShellCommand(command, [], 'win32')).toThrow(
        'unsupported',
      )
  })
})

describe('structured source editing', () => {
  test('preserves JSON5 syntax, comments and nested unknown settings', () => {
    const source =
      "{ // header\n keep: 'value', nested: {before:1, /* comma , */ target:2, after:3,}, tail:0x10, }"
    const current = new StructuredConfig(source, 'json5')
    current.set(['nested', 'new', 'deep'], 'new')
    current.remove(['nested', 'target'])
    current.remove(['nested', 'before'])
    current.remove(['nested', 'after'])
    expect(current.get(['nested', 'new', 'deep'])).toBe('new')
    expect(current.toString()).toContain("keep: 'value'")
    expect(current.toString()).toContain('/* comma , */')
    expect(current.get(['tail'])).toBe(16)
  })
  test('restores source literals, handles scalar parents and rejects ambiguous documents', () => {
    const originalDoc = new StructuredConfig("{a:NaN,b:'old'}", 'json5')
    const current = new StructuredConfig('{"a":1,"b":"new"}', 'json5')
    current.restore(['a'], originalDoc)
    current.restore(['b'], originalDoc)
    expect(current.toString()).toContain('NaN')
    expect(current.toString()).toContain("'old'")
    expect(() => current.set(['b', 'nested'], 1)).toThrow('object')
    for (const text of ['[]', '{"duplicate":1,"duplicate":2}', '{broken'])
      expect(() => new StructuredConfig(text, 'jsonc')).toThrow()
    expect(() => new StructuredConfig('model: [', 'yaml')).toThrow('YAML')
    expect(() => new StructuredConfig('- scalar', 'yaml')).toThrow('object')
    const alias = new StructuredConfig(
      'other: &shared {x: 1}\nproviders: *shared\n',
      'yaml',
    )
    expect(() => alias.set(['providers', 'gateway'], {})).toThrow('alias')
  })
})

function transport(harness: AdditionalHarness, gateway = url): ConnectorFetch {
  return async (request) => {
    if (request === `${gateway}/v1/models`)
      return Response.json({
        data: models.map((model) => ({
          ...model,
          capabilities: { supports: { tool_calls: true } },
        })),
      })
    const expected =
      harness === 'claude-code' || harness === 'opencode' ?
        'messages'
      : 'chat/completions'
    if (request !== `${gateway}/v1/${expected}`)
      throw new Error('Unexpected native protocol endpoint.')
    const events =
      harness === 'claude-code' || harness === 'opencode' ?
        [
          {
            type: 'message_start',
            message: {
              id: 'message-probe',
              type: 'message',
              role: 'assistant',
              content: [],
              model: 'gpt-test',
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'probe-1',
              name: 'connector_probe',
              input: { ok: true },
            },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ]
      : [
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'probe-1',
                      type: 'function',
                      function: {
                        name: 'connector_probe',
                        arguments: '{"ok":true}',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
          '[DONE]',
        ]
    return new Response(
      events
        .map(
          (event) =>
            `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`,
        )
        .join(''),
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    )
  }
}

function fixture(harness: AdditionalHarness, gateway = url) {
  const storage = new ConnectorStore(
    profileDirectory(directory, harness),
    path.join(
      directory,
      'native',
      `${harness}.${harness === 'hermes' ? 'yaml' : 'json'}`,
    ),
    codec,
    harness,
  )
  fs.mkdirSync(path.dirname(storage.files.config), { recursive: true })
  fs.writeFileSync(storage.files.config, original[harness])
  const runner = mock<CommandRunner>(async (_command, args, commandOptions) => {
    if (args.includes('--connector-openclaw-secret')) {
      expect(commandOptions.stdin).toBe(openClawSecretRequest())
      return {
        stdout: JSON.stringify(storage.key()),
        stderr: '',
      }
    }
    return {
      stdout: args.includes('--connector-token') ? storage.key() : '',
      stderr: '',
    }
  })
  const dependencies = {
    installation: async () => ({
      executable: 'fixture-native',
      version: '2026.9.9',
      configPath: storage.files.config,
    }),
    helperCommand: 'fixture-helper',
    helperArgs: [
      harness === 'openclaw' ?
        '--connector-openclaw-secret'
      : '--connector-token',
    ],
    runner,
    fetcher: transport(harness, gateway),
  }
  return {
    storage,
    runner,
    dependencies,
    service: new HarnessService(harness, storage, dependencies),
  }
}

describe('independent persistent harness lifecycles', () => {
  for (const harness of harnesses) {
    test(`${harness} connects, rotates its key, refreshes and undoes without losing unrelated edits`, async () => {
      const { service, storage } = fixture(harness)
      const input = { url, apiKey: key, allowPlaintext: harness === 'opencode' }
      const discovery = await service.discover(input)
      expect(discovery.catalogMode).toBe('configured')
      const connected = await service.connect(input)
      expect(connected.harness).toBe(harness)
      expect(storage.state()?.connection).toEqual(connected)
      expect(storage.read('credential')).not.toContain(key)
      const configured = doc(harness, storage.read('config') ?? '')
      configured.set(['later'], 9)
      fs.writeFileSync(storage.files.config, configured.toString())
      await service.connect({ ...input, apiKey: 'synthetic-rotated-key' })
      expect(storage.key()).toBe('synthetic-rotated-key')
      expect(storage.state()?.originalConfig).toBe(original[harness])
      await service.refresh()
      await service.undo()
      expect(storage.state()).toBeNull()
      expect(storage.read('credential')).toBeNull()
      expect(doc(harness, storage.read('config') ?? '').get(['later'])).toBe(9)
    })
  }

  test('each harness keeps independent credentials and undo state', async () => {
    const a = fixture('claude-code')
    const otherGateway = 'https://different.example'
    const b = fixture('opencode', otherGateway)
    await a.service.connect({ url, apiKey: key })
    await b.service.connect({
      url: otherGateway,
      apiKey: 'synthetic-other-key',
      allowPlaintext: true,
    })
    await b.service.undo()
    expect(a.storage.state()?.connection.baseUrl).toBe(url)
    expect(a.storage.key()).toBe(key)
    expect(a.storage.state()?.connection.harness).toBe('claude-code')
    expect(b.storage.state()).toBeNull()
  })

  test('OpenCode requires explicit readable-key consent', async () => {
    const { service, storage } = fixture('opencode')
    await expect(service.connect({ url, apiKey: key })).rejects.toThrow(
      'permission',
    )
    expect(storage.read('credential')).toBeNull()
    expect(storage.read('config')).toBe(original.opencode)
  })

  test('repair does not bypass ownership, missing files, consent or invalid configuration', async () => {
    const { service, storage } = fixture('opencode')
    const input = { url, apiKey: key, allowPlaintext: true }
    await expect(service.connect(input, true)).rejects.toThrow(
      'saved connection',
    )
    await service.connect(input)
    await expect(
      service.connect({ ...input, allowPlaintext: false }, true),
    ).rejects.toThrow('permission')
    fs.unlinkSync(storage.files.config)
    await expect(service.connect(input, true)).rejects.toThrow(
      'existing harness configuration',
    )
    fs.writeFileSync(storage.files.config, '{invalid')
    await expect(service.connect(input, true)).rejects.toThrow()
    expect(storage.key()).toBe(key)
    expect(fs.existsSync(path.join(storage.directory, 'config-backups'))).toBe(
      false,
    )
  })

  test('repair rolls back native validation failure and refuses concurrent edits during backup', async () => {
    const { service, storage, dependencies } = fixture('hermes')
    const input = { url, apiKey: key }
    await service.connect(input)
    const current = storage.read('config')
    const state = storage.read('state')
    const failing = new HarnessService('hermes', storage, {
      ...dependencies,
      runner: async (_command, args) => {
        if (args.includes('config'))
          throw new Error('Synthetic validation failure')
        return { stdout: storage.key(), stderr: '' }
      },
    })
    await expect(
      failing.connect({ ...input, apiKey: 'synthetic-rotated-key' }, true),
    ).rejects.toThrow('rolled back')
    expect(storage.read('config')).toBe(current)
    expect(storage.read('state')).toBe(state)
    expect(storage.key()).toBe(key)
    const backup = storage.backupConfig.bind(storage)
    storage.backupConfig = (content) => {
      backup(content)
      fs.appendFileSync(
        storage.files.config,
        '\n# concurrent external change\n',
      )
    }
    await expect(service.connect(input, true)).rejects.toThrow(
      'no external edits were overwritten',
    )
    expect(storage.read('config')).toBe(
      `${current}\n# concurrent external change\n`,
    )
    expect(storage.key()).toBe(key)
    expect(
      fs.readdirSync(path.join(storage.directory, 'config-backups')),
    ).toHaveLength(2)
  })

  test('unsupported clients, invalid models, lost ownership and edited fields fail explicitly', async () => {
    const { service, storage, dependencies } = fixture('claude-code')
    await expect(
      new HarnessService('claude-code', storage, {
        ...dependencies,
        installation: async () => null,
      }).connect({ url, apiKey: key }),
    ).rejects.toThrow('not detected')
    await expect(
      service.connect({ url, apiKey: key, model: 'missing' }),
    ).rejects.toThrow('no longer')
    await expect(service.refresh()).rejects.toThrow('saved connection')
    await expect(service.undo()).rejects.toThrow('saved connection')
    await service.connect({ url, apiKey: key })
    const configured = doc('claude-code', storage.read('config') ?? '')
    configured.set(['model'], 'external')
    fs.writeFileSync(storage.files.config, configured.toString())
    await expect(service.refresh()).rejects.toThrow('edited')
    await expect(service.undo()).rejects.toThrow('edited')
    fs.unlinkSync(storage.files.state)
    await expect(service.connect({ url, apiKey: key })).rejects.toThrow(
      'without ownership',
    )
  })

  test('helper and native validation failures roll back and never reveal credentials', async () => {
    for (const harness of ['claude-code', 'hermes', 'openclaw'] as const) {
      const { storage, dependencies } = fixture(harness)
      const runner: CommandRunner = async (_command, args) => {
        if (args.includes('config')) throw new Error(key)
        if (harness === 'claude-code') return { stdout: 'wrong', stderr: key }
        return {
          stdout: harness === 'openclaw' ? JSON.stringify(key) : key,
          stderr: '',
        }
      }
      await expect(
        new HarnessService(harness, storage, {
          ...dependencies,
          runner,
        }).connect({ url, apiKey: key }),
      ).rejects.not.toThrow(key)
      expect(storage.read('config')).toBe(original[harness])
      expect(storage.read('credential')).toBeNull()
      expect(storage.state()).toBeNull()
    }
  })
})

describe('credential references, migration and discovery', () => {
  test('OpenClaw preflight uses its single-ID request shape', () => {
    expect(JSON.parse(openClawSecretRequest())).toEqual({
      protocolVersion: 1,
      provider: PROVIDER_ID,
      ids: [OPENCLAW_SECRET_ID],
    })
  })

  test('keeps legacy Codex files in place and copies a saved key only to the same URL', async () => {
    expect(profileDirectory(directory, 'codex')).toBe(directory)
    const source = fixture('claude-code')
    await source.service.connect({ url, apiKey: key })
    const copied = await resolveSharedInput(
      {
        harness: 'opencode',
        url: `${url}/v1`,
        apiKey: '',
        copyFrom: 'claude-code',
      },
      () => source.storage,
    )
    expect(copied.apiKey).toBe(key)
    expect(source.storage.key()).toBe(key)
    await expect(
      resolveSharedInput(
        { url: 'https://other.example', apiKey: '', copyFrom: 'claude-code' },
        () => source.storage,
      ),
    ).rejects.toThrow('different URL')
    await expect(
      resolveSharedInput(
        { url, apiKey: key, copyFrom: 'claude-code' },
        () => source.storage,
      ),
    ).rejects.toThrow('not both')
    const normal = { url, apiKey: key }
    expect(await resolveSharedInput(normal, () => source.storage)).toBe(normal)
    await source.service.undo()
    await expect(
      resolveSharedInput(
        { url, apiKey: '', copyFrom: 'claude-code' },
        () => source.storage,
      ),
    ).rejects.toThrow('no saved')
  })

  test('respects native config-home overrides and OpenCode file precedence', () => {
    expect(
      harnessConfigPath('claude-code', { CLAUDE_CONFIG_DIR: directory }),
    ).toBe(path.join(directory, 'settings.json'))
    expect(harnessConfigPath('hermes', { HERMES_HOME: directory })).toBe(
      path.join(directory, 'config.yaml'),
    )
    expect(
      harnessConfigPath(
        'hermes',
        { LOCALAPPDATA: directory },
        directory,
        'win32',
      ),
    ).toBe(path.join(directory, 'hermes', 'config.yaml'))
    expect(harnessConfigPath('hermes', {}, directory, 'linux')).toBe(
      path.join(directory, '.hermes', 'config.yaml'),
    )
    expect(
      harnessConfigPath('openclaw', { OPENCLAW_STATE_DIR: directory }),
    ).toBe(path.join(directory, 'openclaw.json'))
    expect(harnessConfigPath('openclaw', { OPENCLAW_HOME: directory })).toBe(
      path.join(directory, '.openclaw', 'openclaw.json'),
    )
    expect(() =>
      harnessConfigPath('hermes', { HERMES_HOME: 'relative' }),
    ).toThrow('absolute')
    fs.mkdirSync(path.join(directory, 'opencode'))
    fs.writeFileSync(path.join(directory, 'opencode', 'opencode.json'), '{}')
    expect(
      harnessConfigPath('opencode', { XDG_CONFIG_HOME: directory }),
    ).toEndWith('opencode.json')
    fs.writeFileSync(path.join(directory, 'opencode', 'opencode.jsonc'), '{}')
    expect(
      harnessConfigPath('opencode', { XDG_CONFIG_HOME: directory }),
    ).toEndWith('opencode.jsonc')
  })

  test('finds native, Python-venv and npm installations without executing command shims', () => {
    const env = { PATH: directory, APPDATA: directory }
    const node = path.join(directory, 'node.exe')
    fs.writeFileSync(node, '')
    expect(
      harnessCandidates('claude-code', env, directory, 'win32').some(
        (candidate) =>
          candidate.args[0]?.endsWith(
            path.join('@anthropic-ai', 'claude-code', 'cli.js'),
          ),
      ),
    ).toBe(true)
    expect(
      harnessCandidates('openclaw', env, directory, 'win32').some((candidate) =>
        candidate.args[0]?.endsWith('openclaw.mjs'),
      ),
    ).toBe(true)
    expect(
      harnessCandidates(
        'hermes',
        { HERMES_HOME: directory },
        directory,
        'win32',
      ).some((candidate) =>
        candidate.executable.endsWith(
          path.join('venv', 'Scripts', 'hermes.exe'),
        ),
      ),
    ).toBe(true)
    expect(
      harnessCandidates('opencode', env, directory, 'win32').some((candidate) =>
        candidate.executable.includes('opencode-windows-x64'),
      ),
    ).toBe(true)
  })

  test('continues past broken automatic candidates and makes manual overrides authoritative', async () => {
    const good = path.join(directory, 'good')
    const bad = path.join(directory, 'bad')
    fs.writeFileSync(good, '')
    fs.writeFileSync(bad, '')
    const runner: CommandRunner = async (executable, args) => {
      if (executable === bad) throw new Error('broken')
      return {
        stdout: args.includes('--help') ? 'OpenClaw CLI' : '2026.9.9',
        stderr: '',
      }
    }
    expect(
      (
        await detectHarness('openclaw', null, runner, [
          { executable: bad, args: [] },
          { executable: good, args: [] },
        ])
      )?.executable,
    ).toBe(good)
    await expect(detectHarness('openclaw', bad, runner)).rejects.toThrow(
      'broken',
    )
    await expect(
      detectHarness('openclaw', path.join(directory, 'missing'), runner),
    ).rejects.toThrow('no longer')
    expect(await detectHarness('openclaw', null, runner, [])).toBeNull()
  })

  test('requires the actual Claude model-picker support version', async () => {
    const executable = path.join(directory, 'claude.exe')
    fs.writeFileSync(executable, '')
    await expect(
      detectHarness('claude-code', executable, async () => ({
        stdout: '2.1.241 (Claude Code)',
        stderr: '',
      })),
    ).rejects.toThrow('2.1.242')
    expect(
      (
        await detectHarness('claude-code', executable, async () => ({
          stdout: '2.1.242 (Claude Code)',
          stderr: '',
        }))
      )?.version,
    ).toBe('2.1.242')
  })
})
