import { afterEach, describe, expect, mock, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser'
import {
  configureCodex,
  hasConnectorProvider,
  managedConfigFingerprint,
  restoreCodex,
} from '../electron/connector/config'
import {
  codexCandidates,
  codexConfigPath,
  detectCodex,
  parseCodexVersion,
  runCommand,
  verifyCredentialHelper,
  verifyNativeCodex,
  windowsDesktopCandidates,
  type CommandRunner,
} from '../electron/connector/codex'
import {
  discoverGateway,
  normalizeGatewayUrl,
  validateApiKey,
  verifyStreamingTools,
  type ConnectorFetch,
} from '../electron/connector/gateway'
import { ConnectorService } from '../electron/connector/service'
import {
  ConnectorStore,
  type CredentialCodec,
} from '../electron/connector/store'
import type { ConnectorInput } from '../src/types/connector'

const directories: string[] = []
function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-unit-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

const input: ConnectorInput = {
  url: 'https://example.devtunnels.ms/v1/',
  apiKey: 'test-gateway-key',
}
const options = {
  baseUrl: 'https://example.devtunnels.ms',
  model: 'gpt-test',
  catalogPath: null,
  helperCommand: 'C:\\Program Files\\Copilot API Connector\\connector.exe',
  helperArgs: ['--connector-token'],
}
function catalogModel(slug = 'gpt-test') {
  return {
    slug,
    display_name: slug,
    description: 'Gateway model',
    context_window: 128_000,
    model_messages: { instructions_template: 'You are a coding assistant.' },
    supported_reasoning_levels: [{ effort: 'medium', description: 'Medium' }],
    default_reasoning_level: 'medium',
    supported_in_api: true,
  }
}
function streamResponse(type = 'response.completed', ok = true): Response {
  return new Response(
    `data: ${JSON.stringify({
      type,
      response: {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            name: 'connector_probe',
            arguments: JSON.stringify({ ok }),
          },
        ],
      },
    })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
function gateway(
  remoteModels = [catalogModel()],
  data: unknown[] = [{ id: 'gpt-test' }],
) {
  return mock<ConnectorFetch>((url, init) => {
    if (url.endsWith('/responses')) return Promise.resolve(streamResponse())
    if (url.endsWith('/v1/models'))
      return Promise.resolve(Response.json({ data }))
    const headers = new Headers(init?.headers)
    return Promise.resolve(
      Response.json({
        models:
          headers.get('x-full-model-catalog') === 'true' ?
            [catalogModel()]
          : remoteModels,
      }),
    )
  })
}
const testCodec: CredentialCodec = {
  available: () => true,
  encrypt: (value) => Buffer.from(value).reverse().toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').reverse().toString(),
}
function store(codec = testCodec) {
  const directory = temporaryDirectory()
  return new ConnectorStore(
    path.join(directory, 'connector'),
    path.join(directory, 'codex', 'config.toml'),
    codec,
  )
}
function successfulRunner(): CommandRunner {
  return mock<CommandRunner>((_command, args) => {
    const output = args[args.indexOf('--output-last-message') + 1]
    fs.writeFileSync(output, 'COPILOT_CONNECTOR_OK\n')
    return Promise.resolve({ stdout: '', stderr: '' })
  })
}
function service(
  storage = store(),
  runner = successfulRunner(),
  fetcher: ConnectorFetch = gateway(),
  detected = true,
) {
  const installation = {
    executable: 'fake-codex',
    version: '0.160.0',
    configPath: storage.files.config,
  }
  return new ConnectorService(storage, {
    installation: () => Promise.resolve(detected ? installation : null),
    helperCommand: options.helperCommand,
    helperArgs: options.helperArgs,
    runner: (command, args, opts) =>
      args.includes('--connector-token') ?
        Promise.resolve({ stdout: storage.key(), stderr: '' })
      : runner(command, args, opts),
    fetcher,
  })
}

describe('connector TOML edits', () => {
  test('preserves unrelated comments, tables, multiline strings and safety policy', () => {
    const original = [
      '# keep this comment',
      'model = "previous" # model comment',
      'model_context_window = 999999',
      'model_reasoning_effort = "max"',
      'sandbox_mode = "workspace-write"',
      'approval_policy = "on-request"',
      'note = """first',
      '[not.a.table]',
      'last"""',
      '[model_providers.existing]',
      'base_url = "http://localhost:1234"',
      '',
    ].join('\r\n')
    const configured = configureCodex(original, options)
    expect(configured).toContain('# keep this comment')
    expect(configured).toContain('# model comment')
    expect(configured).toContain('[not.a.table]')
    expect(configured).toContain('sandbox_mode = "workspace-write"')
    expect(configured).toContain('[model_providers.existing]')
    expect(configured).not.toContain('model_context_window = 999999')
    expect(configured).not.toContain('model_reasoning_effort = "max"')
    expect(getStaticTOMLValue(parseTOML(configured))).toMatchObject({
      model: 'gpt-test',
      model_provider: 'copilot_api_connector',
      sandbox_mode: 'workspace-write',
      model_providers: {
        existing: { base_url: 'http://localhost:1234' },
        copilot_api_connector: {
          wire_api: 'responses',
          auth: { command: options.helperCommand, args: ['--connector-token'] },
        },
      },
    })
    expect(configured).toContain('\r\n')
  })

  test('uses a complete local catalog without remote discovery when necessary', () => {
    const configured = configureCodex('', {
      ...options,
      catalogPath: 'C:\\Models\\catalog.json',
    })
    expect(configured).toContain(
      'model_catalog_json = "C:\\\\Models\\\\catalog.json"',
    )
    expect(configured).not.toContain('model_catalog_url')
    expect(configureCodex(configured, options)).not.toContain(
      'model_catalog_json',
    )
  })

  test('reconnects without duplicate tables and ignores unrelated edits in ownership checks', () => {
    const once = configureCodex('', options)
    const twice = configureCodex(once, { ...options, model: 'claude-test' })
    expect(
      (twice.match(/\[model_providers\.copilot_api_connector\]/g) ?? []).length,
    ).toBe(1)
    expect(
      managedConfigFingerprint(`${once}\n[features]\nexample = true`),
    ).toBe(managedConfigFingerprint(once))
    expect(managedConfigFingerprint(twice)).not.toBe(
      managedConfigFingerprint(once),
    )
    expect(hasConnectorProvider(twice)).toBe(true)
    expect(
      hasConnectorProvider('[model_providers.other]\nname = "Other"'),
    ).toBe(false)
  })

  test('restores original owned keys while preserving later unrelated edits', () => {
    const original =
      '"model" = "old"\nmodel_catalog_json = "old.json"\nmodel_context_window = 12345\n'
    const current =
      configureCodex(original, options) + '\n[features]\nnew_setting = true\n'
    const restored = restoreCodex(current, original)
    expect(getStaticTOMLValue(parseTOML(restored))).toMatchObject({
      model: 'old',
      model_catalog_json: 'old.json',
      model_context_window: 12345,
      features: { new_setting: true },
    })
    expect(hasConnectorProvider(restored)).toBe(false)
  })

  test('rejects invalid TOML and incompatible inline provider declarations', () => {
    expect(() => configureCodex('model = "unfinished', options)).toThrow(
      'valid TOML',
    )
    expect(() => configureCodex('model_providers = {}', options)).toThrow(
      'valid TOML',
    )
  })
})

describe('gateway discovery and streaming verification', () => {
  test('normalizes root and v1 URLs, allows loopback and rejects unsafe URL shapes', () => {
    expect(normalizeGatewayUrl(input.url)).toBe('https://example.devtunnels.ms')
    expect(normalizeGatewayUrl(' http://127.0.0.1:4141/// ')).toBe(
      'http://127.0.0.1:4141',
    )
    expect(normalizeGatewayUrl('http://[::1]:4141/v1')).toBe(
      'http://[::1]:4141',
    )
    for (const url of [
      'broken',
      'http://remote.example',
      'https://u:p@example.com',
      'https://example.com?key=secret',
      'https://example.com/#x',
      'https://example.com/messages',
    ]) {
      expect(() => normalizeGatewayUrl(url)).toThrow()
    }
    expect(validateApiKey(' test ')).toBe('test')
    for (const key of ['', 'two words', 'test\nkey', 'test\u0001key'])
      expect(() => validateApiKey(key)).toThrow()
  })

  test('authenticates known endpoints and chooses remote discovery only for a complete catalog', async () => {
    const fetcher = gateway()
    const result = await discoverGateway(input, '0.160.0', fetcher)
    expect(result.catalogMode).toBe('remote')
    expect(result.models).toEqual([
      {
        id: 'gpt-test',
        name: 'gpt-test',
        contextWindow: 128_000,
        description: 'Gateway model',
      },
    ])
    expect(result.defaultModel).toBe('gpt-test')
    expect(result.catalog).not.toContain(input.apiKey)
    const requests = fetcher.mock.calls
    expect(requests).toHaveLength(3)
    for (const [, init] of requests) {
      expect(init?.redirect).toBe('error')
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${input.apiKey}`,
      )
    }
  })

  test('uses the full local catalog if remote discovery omits or adds models', async () => {
    for (const remote of [
      [],
      [catalogModel(), catalogModel('fallback-only')],
    ]) {
      expect(
        (await discoverGateway(input, '0.160.0', gateway(remote))).catalogMode,
      ).toBe('local')
    }
    const hugeModel = {
      ...catalogModel(),
      description: 'x'.repeat(1024 * 1024),
    }
    expect(
      (await discoverGateway(input, '0.160.0', gateway([hugeModel])))
        .catalogMode,
    ).toBe('local')
  })

  test('measures the exact 1 MiB remote catalog boundary and rejects duplicate remote entries', async () => {
    const base = { ...catalogModel(), description: '' }
    const bytes = Buffer.byteLength(JSON.stringify({ models: [base] }), 'utf8')
    const exact = { ...base, description: 'x'.repeat(1024 * 1024 - bytes) }
    expect(Buffer.byteLength(JSON.stringify({ models: [exact] }), 'utf8')).toBe(
      1024 * 1024,
    )
    expect(
      (await discoverGateway(input, '0.160.0', gateway([exact]))).catalogMode,
    ).toBe('remote')
    expect(
      (
        await discoverGateway(
          input,
          '0.160.0',
          gateway([{ ...exact, description: `${exact.description}x` }]),
        )
      ).catalogMode,
    ).toBe('local')
    expect(
      (
        await discoverGateway(
          input,
          '0.160.0',
          gateway([catalogModel(), catalogModel()]),
        )
      ).catalogMode,
    ).toBe('local')
  })

  test('excludes models requiring a newer Codex and rejects invalid minimum versions', async () => {
    for (const minimum of ['0.160.1', '0.161.0', '1.0.0', 'invalid', 160]) {
      const newer: ConnectorFetch = (url) =>
        Promise.resolve(
          Response.json(
            url.endsWith('/v1/models') ?
              { data: [{ id: 'gpt-test' }] }
            : {
                models: [
                  { ...catalogModel(), minimal_client_version: minimum },
                ],
              },
          ),
        )
      await expect(discoverGateway(input, '0.160.0', newer)).rejects.toThrow()
    }
    const supported: ConnectorFetch = (url) =>
      Promise.resolve(
        Response.json(
          url.endsWith('/v1/models') ?
            { data: [{ id: 'gpt-test' }] }
          : {
              models: [
                { ...catalogModel(), minimal_client_version: '0.160.0' },
              ],
            },
        ),
      )
    expect(
      (await discoverGateway(input, '0.160.0', supported)).models,
    ).toHaveLength(1)
  })

  test('reports excluded embeddings and models without compatible catalog metadata', async () => {
    const result = await discoverGateway(
      input,
      '0.160.0',
      gateway(
        [catalogModel()],
        [
          { id: 'gpt-test' },
          { id: 'embedding', capabilities: { type: 'embeddings' } },
          { id: 'no-tools', capabilities: { supports: { tool_calls: false } } },
          { id: 'missing-metadata' },
        ],
      ),
    )
    expect(result.excludedModels).toEqual([
      'embedding',
      'no-tools',
      'missing-metadata',
    ])
  })

  test('rejects authentication errors, network failures and HTML responses explicitly', async () => {
    for (const status of [401, 403, 500]) {
      await expect(
        discoverGateway(input, '0.160.0', () =>
          Promise.resolve(new Response('error', { status })),
        ),
      ).rejects.toThrow(status === 500 ? 'HTTP 500' : 'authentication')
    }
    await expect(
      discoverGateway(input, '0.160.0', () =>
        Promise.reject(new Error('offline')),
      ),
    ).rejects.toThrow('connection failed')
    await expect(
      discoverGateway(input, '0.160.0', () =>
        Promise.resolve(new Response('<html>sign in</html>')),
      ),
    ).rejects.toThrow('valid JSON')
    await expect(
      discoverGateway(input, '0.160.0', () =>
        Promise.resolve(Response.json({ data: [null] })),
      ),
    ).rejects.toThrow('identifiers')
    await expect(
      discoverGateway(input, '0.160.0', () =>
        Promise.resolve(Response.json({ wrong: [] })),
      ),
    ).rejects.toThrow('discovery response')
  })

  test('rejects malformed catalogs and empty model intersections', async () => {
    const malformed: ConnectorFetch = (url) =>
      Promise.resolve(
        Response.json(
          url.endsWith('/v1/models') ?
            { data: [{ id: 'gpt-test' }] }
          : { models: [{ slug: 'gpt-test' }] },
        ),
      )
    await expect(discoverGateway(input, '0.160.0', malformed)).rejects.toThrow(
      'invalid Codex',
    )
    await expect(
      discoverGateway(input, '0.160.0', gateway([], [{ id: 'different' }])),
    ).rejects.toThrow('No discovered models')
  })

  test('requires a completed Responses stream containing the expected function call', async () => {
    const discovery = await discoverGateway(input, '0.160.0', gateway())
    await verifyStreamingTools(discovery, 'gpt-test', input.apiKey, gateway())
    for (const type of [
      'error',
      'response.failed',
      'response.incomplete',
      'response.created',
    ]) {
      await expect(
        verifyStreamingTools(discovery, 'gpt-test', input.apiKey, () =>
          Promise.resolve(streamResponse(type)),
        ),
      ).rejects.toThrow()
    }
    await expect(
      verifyStreamingTools(discovery, 'gpt-test', input.apiKey, () =>
        Promise.resolve(streamResponse('response.completed', false)),
      ),
    ).rejects.toThrow('expected streaming tool')
    await expect(
      verifyStreamingTools(discovery, 'gpt-test', input.apiKey, () =>
        Promise.resolve(Response.json({ output: [] })),
      ),
    ).rejects.toThrow('event stream')
    await expect(
      verifyStreamingTools(discovery, 'gpt-test', input.apiKey, () =>
        Promise.resolve(
          new Response('data: invalid\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
      ),
    ).rejects.toThrow('valid JSON')
  })

  test('decodes fragmented UTF-8 SSE frames and bounds response sizes', async () => {
    const discovery = await discoverGateway(input, '0.160.0', gateway())
    const bytes = new TextEncoder().encode(
      `: café\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","name":"connector_probe","arguments":"{\\"ok\\":true}"}]}}\r\n\r\n`,
    )
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })
    await verifyStreamingTools(discovery, 'gpt-test', input.apiKey, () =>
      Promise.resolve(
        new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    )
    await expect(
      discoverGateway(input, '0.160.0', () =>
        Promise.resolve(new Response(null)),
      ),
    ).rejects.toThrow('empty response')
    const oversized = () =>
      Promise.resolve(new Response(new Uint8Array(32 * 1024 * 1024 + 1)))
    await expect(discoverGateway(input, '0.160.0', oversized)).rejects.toThrow(
      'size limit',
    )
  })
})

describe('Codex detection and native smoke test', () => {
  test('preflights the installed credential helper without exposing its output', async () => {
    const runner: CommandRunner = () =>
      Promise.resolve({ stdout: 'expected-key\n', stderr: '' })
    await verifyCredentialHelper('helper', [], 'expected-key', runner)
    await expect(
      verifyCredentialHelper('helper', [], 'different', runner),
    ).rejects.toThrow('expected gateway key')
  })
  test('closes piped stdin so native commands cannot wait indefinitely for input', async () => {
    const result = await runCommand(
      process.execPath,
      [
        '-e',
        'process.stdin.resume(); process.stdin.on("end", () => console.log("stdin-closed"))',
      ],
      { timeout: 10_000 },
    )
    expect(result.stdout.trim()).toBe('stdin-closed')
    await expect(
      runCommand(process.execPath, ['-e', 'process.exit(2)'], {
        timeout: 10_000,
      }),
    ).rejects.toThrow()
  })
  test('requires a supported, recognizable CLI version', () => {
    expect(parseCodexVersion('codex-cli 0.160.0\n')).toBe('0.160.0')
    expect(parseCodexVersion('codex 1.2.3-beta')).toBe('1.2.3')
    expect(() => parseCodexVersion('codex-cli 0.159.0')).toThrow('Update Codex')
    expect(() => parseCodexVersion('some other program')).toThrow('valid Codex')
  })

  test('respects CODEX_HOME and includes native npm and desktop executable locations', () => {
    expect(codexConfigPath({ CODEX_HOME: temporaryDirectory() })).toContain(
      'config.toml',
    )
    expect(codexConfigPath({}, temporaryDirectory())).toContain(
      `${path.sep}.codex${path.sep}config.toml`,
    )
    const windows = codexCandidates(
      'win32',
      {
        PATH: 'C:\\Tools',
        APPDATA: 'C:\\User\\Roaming',
        LOCALAPPDATA: 'C:\\User\\Local',
      },
      'C:\\User',
    )
    expect(windows).toContain('C:\\Tools\\codex.exe')
    expect(windows).toContain(
      'C:\\User\\Roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe',
    )
    expect(codexCandidates('darwin', {}, '/Users/me')).toContain(
      '/Applications/Codex.app/Contents/Resources/codex',
    )
    expect(codexCandidates('linux', {}, '/home/me')).toContain(
      '/home/me/.local/bin/codex',
    )
  })

  test('verifies an explicitly selected executable and reports stale selections', async () => {
    const executable = path.join(temporaryDirectory(), 'codex')
    fs.writeFileSync(executable, 'fixture')
    const runner: CommandRunner = mock(() =>
      Promise.resolve({ stdout: 'codex-cli 0.160.0', stderr: '' }),
    )
    expect(await detectCodex(executable, runner, 'config.toml')).toEqual({
      executable,
      version: '0.160.0',
      configPath: 'config.toml',
    })
    await expect(detectCodex(`${executable}-missing`, runner)).rejects.toThrow(
      'no longer exists',
    )
  })

  test('uses Windows installed-package metadata without hardcoding versioned WindowsApps paths', async () => {
    const runner = mock<CommandRunner>(() =>
      Promise.resolve({
        stdout: JSON.stringify([
          'C:\\WindowsApps\\OpenAI.Codex_fixture',
          'C:\\Apps\\Codex',
        ]),
        stderr: '',
      }),
    )
    const candidates = await windowsDesktopCandidates(runner, {
      SystemRoot: 'D:\\Windows',
    })
    expect(candidates).toContain(
      'C:\\WindowsApps\\OpenAI.Codex_fixture\\app\\resources\\codex.exe',
    )
    expect(candidates).toContain('C:\\Apps\\Codex\\resources\\codex.exe')
    expect(runner.mock.calls[0][0]).toBe(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(runner.mock.calls[0][1]).toContain('-NoProfile')
    expect(runner.mock.calls[0][1]).not.toContain('-ExecutionPolicy')
    await expect(
      windowsDesktopCandidates(() =>
        Promise.resolve({
          stdout: JSON.stringify(['relative-folder']),
          stderr: '',
        }),
      ),
    ).rejects.toThrow('invalid locations')
  })

  test('continues automatic detection past an outdated or broken executable', async () => {
    const directory = temporaryDirectory()
    const outdated = path.join(directory, 'outdated')
    const broken = path.join(directory, 'broken')
    const supported = path.join(directory, 'supported')
    for (const executable of [outdated, broken, supported])
      fs.writeFileSync(executable, 'fixture')
    const runner: CommandRunner = (executable) => {
      if (executable === broken)
        return Promise.reject(new Error('Fixture executable failed'))
      return Promise.resolve({
        stdout:
          executable === outdated ? 'codex-cli 0.159.0' : (
            'codex-cli 0.162.0-alpha.2'
          ),
        stderr: '',
      })
    }
    expect(
      await detectCodex(null, runner, 'config.toml', [
        outdated,
        broken,
        supported,
      ]),
    ).toEqual({
      executable: supported,
      version: '0.162.0',
      configPath: 'config.toml',
    })
    await expect(
      detectCodex(null, runner, 'config.toml', [outdated, broken]),
    ).rejects.toThrow('Install or update')
    expect(
      await detectCodex(null, runner, 'config.toml', [
        path.join(directory, 'missing'),
      ]),
    ).toBeNull()
    await expect(detectCodex(outdated, runner)).rejects.toThrow('Update Codex')
  })
  test('runs in an isolated home with read-only sandbox and cleans up after success and failure', async () => {
    const runner = mock(successfulRunner())
    const installation = {
      executable: 'fake-codex',
      version: '0.160.0',
      configPath: 'unused',
    }
    await verifyNativeCodex(installation, configureCodex('', options), runner)
    const [, args, commandOptions] = runner.mock.calls[0]
    expect(args).toContain('--ephemeral')
    expect(args).toContain('read-only')
    expect(commandOptions.env?.CODEX_HOME).toBe(commandOptions.cwd)
    expect(fs.existsSync(commandOptions.cwd ?? '')).toBe(false)
    const failing: CommandRunner = (_executable, _args, opts) => {
      expect(opts.cwd).toBeDefined()
      return Promise.reject(new Error('native failure'))
    }
    await expect(verifyNativeCodex(installation, '', failing)).rejects.toThrow(
      'native failure',
    )
    const wrong: CommandRunner = () =>
      Promise.resolve({ stdout: 'wrong', stderr: '' })
    await expect(verifyNativeCodex(installation, '', wrong)).rejects.toThrow(
      'expected connection-test reply',
    )
  })
})

describe('persistent configuration transactions', () => {
  test('rolls back configuration, catalog, encrypted credential and state together', async () => {
    const storage = store()
    fs.mkdirSync(path.dirname(storage.files.config), { recursive: true })
    fs.writeFileSync(storage.files.config, 'model = "original"')
    await expect(
      storage.exclusive(() =>
        storage.transaction(
          {
            config: 'model = "new"',
            catalog: '{}',
            credential: 'encrypted',
            state: '{}',
          },
          () => Promise.reject(new Error('verification failed')),
        ),
      ),
    ).rejects.toThrow('verification failed')
    expect(storage.read('config')).toBe('model = "original"')
    for (const id of ['catalog', 'credential', 'state'] as const)
      expect(storage.read(id)).toBeNull()
    expect(
      fs.existsSync(path.join(storage.directory, 'transaction.json')),
    ).toBe(false)
  })

  test('recovers a crash journal before accepting another operation', async () => {
    const storage = store()
    fs.mkdirSync(storage.directory, { recursive: true })
    fs.writeFileSync(storage.files.catalog, 'partial')
    fs.writeFileSync(
      path.join(storage.directory, 'transaction.json'),
      JSON.stringify({
        version: 1,
        configPath: storage.files.config,
        snapshots: [{ id: 'catalog', before: null, after: 'partial' }],
      }),
    )
    await storage.exclusive(() => Promise.resolve())
    expect(storage.read('catalog')).toBeNull()
  })

  test('never overwrites external changes during rollback and retains the journal', async () => {
    const storage = store()
    await expect(
      storage.exclusive(() =>
        storage.transaction({ config: 'installed' }, () => {
          fs.writeFileSync(storage.files.config, 'external edit')
          return Promise.reject(new Error('failed'))
        }),
      ),
    ).rejects.toThrow('automatic rollback could not finish')
    expect(storage.read('config')).toBe('external edit')
    expect(
      fs.existsSync(path.join(storage.directory, 'transaction.json')),
    ).toBe(true)
    await expect(storage.exclusive(() => Promise.resolve())).rejects.toThrow(
      'edited externally',
    )
  })

  test('rejects active locks, invalid state and journal path injection', async () => {
    const storage = store()
    fs.mkdirSync(storage.directory, { recursive: true })
    const lock = path.join(storage.directory, 'setup.lock')
    fs.writeFileSync(lock, String(process.pid))
    await expect(storage.exclusive(() => Promise.resolve())).rejects.toThrow(
      'operation is active',
    )
    fs.unlinkSync(lock)
    fs.writeFileSync(storage.files.state, '{}')
    expect(() => storage.state()).toThrow('invalid')
    fs.writeFileSync(
      path.join(storage.directory, 'transaction.json'),
      JSON.stringify({
        version: 1,
        configPath: storage.files.config,
        snapshots: [{ id: '../outside', before: null, after: 'bad' }],
      }),
    )
    await expect(storage.exclusive(() => Promise.resolve())).rejects.toThrow(
      'invalid file snapshots',
    )
  })

  test('refuses plaintext credential storage and reports missing credentials', () => {
    const storage = store({ ...testCodec, available: () => false })
    expect(() => storage.encryptKey('key')).toThrow('plaintext')
    expect(() => storage.key()).toThrow('plaintext')
    expect(() => store().key()).toThrow('No saved')
  })

  test('reports unreadable encrypted credentials with recovery guidance without modifying them', () => {
    const storage = store({
      ...testCodec,
      decrypt: () => {
        throw new Error('Synthetic OS decryption failure')
      },
    })
    fs.mkdirSync(storage.directory, { recursive: true })
    fs.writeFileSync(storage.files.credential, 'unreadable-fixture-ciphertext')
    expect(() => storage.key()).toThrow(
      'Open Copilot API Connector and reconnect',
    )
    expect(storage.read('credential')).toBe('unreadable-fixture-ciphertext')
  })
})

describe('complete connector lifecycle', () => {
  test('connects, persists credentials, refreshes after restart and safely undoes', async () => {
    const storage = store()
    fs.mkdirSync(path.dirname(storage.files.config), { recursive: true })
    const original =
      'model = "old"\nmodel_context_window = 55555\nsandbox_mode = "workspace-write"\n'
    fs.writeFileSync(storage.files.config, original)
    const connector = service(storage)
    const discovery = await connector.discover(input)
    expect(discovery).not.toHaveProperty('catalog')
    const connected = await connector.connect(input)
    expect(connected.catalogMode).toBe('remote')
    expect(storage.state()?.connection).toEqual(connected)
    expect(storage.read('config')).not.toContain(input.apiKey)
    expect(storage.read('credential')).not.toContain(input.apiKey)
    expect(storage.read('state')).not.toContain(input.apiKey)
    expect(storage.key()).toBe(input.apiKey)
    fs.appendFileSync(storage.files.config, '\n[features]\nuser_added = true\n')
    const restarted = service(storage)
    expect((await restarted.refresh()).model).toBe('gpt-test')
    await restarted.undo()
    expect(
      getStaticTOMLValue(parseTOML(storage.read('config') ?? '')),
    ).toMatchObject({
      model: 'old',
      model_context_window: 55555,
      sandbox_mode: 'workspace-write',
      features: { user_added: true },
    })
    expect(storage.state()).toBeNull()
    expect(storage.read('credential')).toBeNull()
    expect(storage.read('catalog')).toBeNull()
  })

  test('removes a newly created configuration on undo and saves full catalogs when needed', async () => {
    const storage = store()
    const connector = service(storage, successfulRunner(), gateway([]))
    expect((await connector.connect(input)).catalogMode).toBe('local')
    expect(storage.read('catalog')).toContain('gpt-test')
    await connector.undo()
    expect(storage.read('config')).toBeNull()
  })

  test('rotates keys idempotently and retains the first original configuration', async () => {
    const storage = store()
    const connector = service(storage)
    await connector.connect(input)
    await connector.connect({ ...input, apiKey: 'rotated-key' })
    expect(storage.key()).toBe('rotated-key')
    expect(storage.state()?.originalConfig).toBeNull()
    await connector.undo()
    expect(storage.read('config')).toBeNull()
  })

  test('rolls back on native failures and redacts credentials from errors', async () => {
    const storage = store()
    const failing: CommandRunner = () =>
      Promise.reject(new Error(`native error ${input.apiKey}`))
    await expect(service(storage, failing).connect(input)).rejects.toThrow(
      'native error [redacted]',
    )
    expect(storage.read('config')).toBeNull()
    expect(storage.read('credential')).toBeNull()
    expect(storage.state()).toBeNull()
  })

  test('rejects missing Codex, unavailable models, unknown ownership and external managed edits', async () => {
    await expect(
      service(store(), successfulRunner(), gateway(), false).connect(input),
    ).rejects.toThrow('not detected')
    const storage = store()
    await expect(
      service(storage).connect({ ...input, model: 'not-available' }),
    ).rejects.toThrow('selected model')
    fs.mkdirSync(path.dirname(storage.files.config), { recursive: true })
    fs.writeFileSync(
      storage.files.config,
      '[model_providers.copilot_api_connector]\nname = "manual"',
    )
    await expect(service(storage).connect(input)).rejects.toThrow(
      'without connector ownership',
    )
    fs.unlinkSync(storage.files.config)
    const connector = service(storage)
    await connector.connect(input)
    fs.writeFileSync(
      storage.files.config,
      (storage.read('config') ?? '').replace(
        'model = "gpt-test"',
        'model = "external"',
      ),
    )
    await expect(connector.connect(input)).rejects.toThrow('edited outside')
    await expect(connector.undo()).rejects.toThrow('edited externally')
  })

  test('requires saved state for refresh and undo', async () => {
    const connector = service()
    await expect(connector.refresh()).rejects.toThrow('no saved')
    await expect(connector.undo()).rejects.toThrow('no saved')
  })

  test('does not write anything if the gateway tool-call probe fails', async () => {
    const storage = store()
    const base = gateway()
    const failing: ConnectorFetch = (url, init) =>
      url.endsWith('/responses') ?
        Promise.resolve(streamResponse('response.failed'))
      : base(url, init)
    await expect(
      service(storage, successfulRunner(), failing).connect(input),
    ).rejects.toThrow('tool-call test failed')
    expect(storage.read('config')).toBeNull()
    expect(storage.read('credential')).toBeNull()
  })
})
