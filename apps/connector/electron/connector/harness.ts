import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  ConnectorHarness,
  ConnectorModel,
  HarnessInstallation,
} from '../../src/types/connector'
import { HARNESS_NAMES, HARNESS_PROTOCOLS } from '../../src/types/connector'
import { codexConfigPath, runCommand, type CommandRunner } from './codex'
import { StructuredConfig, type ConfigKey } from './structured-config'

export const PROVIDER_ID = 'copilot_api_connector'
export const OPENCLAW_SECRET_ID = 'gateway-api-key'
export type AdditionalHarness = Exclude<ConnectorHarness, 'codex'>

export { HARNESS_NAMES, HARNESS_PROTOCOLS }
export const HARNESS_GUIDES: Record<ConnectorHarness, string> = {
  codex: 'https://developers.openai.com/codex/cli',
  'claude-code': 'https://code.claude.com/docs/en/setup',
  opencode: 'https://opencode.ai/docs/',
  hermes:
    'https://hermes-agent.nousresearch.com/docs/getting-started/installation/',
  openclaw: 'https://docs.openclaw.ai/start/getting-started',
}

export function profileDirectory(
  root: string,
  harness: ConnectorHarness,
): string {
  return harness === 'codex' ? root : path.join(root, 'connections', harness)
}

function expandedDirectory(
  value: string,
  home: string,
  env: NodeJS.ProcessEnv,
): string {
  const expanded = value
    .replace(/^~(?=$|[\\/])/u, home)
    .replace(
      /\$\{(\w+)\}|\$(\w+)|%(\w+)%/gu,
      (match: string, a: string, b: string, c: string) =>
        env[a || b || c] ?? match,
    )
  if (!path.isAbsolute(expanded))
    throw new Error(
      'Harness configuration directory overrides must be absolute paths.',
    )
  return expanded
}

export function harnessConfigPath(
  harness: ConnectorHarness,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (harness === 'codex') return codexConfigPath(env, home)
  if (harness === 'claude-code')
    return path.join(
      env.CLAUDE_CONFIG_DIR ?
        expandedDirectory(env.CLAUDE_CONFIG_DIR, home, env)
      : path.join(home, '.claude'),
      'settings.json',
    )
  if (harness === 'hermes')
    return path.join(
      env.HERMES_HOME ? expandedDirectory(env.HERMES_HOME, home, env)
      : platform === 'win32' ?
        path.join(
          env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'),
          'hermes',
        )
      : path.join(home, '.hermes'),
      'config.yaml',
    )
  if (harness === 'openclaw') {
    if (env.OPENCLAW_CONFIG_PATH)
      return expandedDirectory(env.OPENCLAW_CONFIG_PATH, home, env)
    const clawHome =
      env.OPENCLAW_HOME ? expandedDirectory(env.OPENCLAW_HOME, home, env) : home
    const state =
      env.OPENCLAW_STATE_DIR ?
        expandedDirectory(env.OPENCLAW_STATE_DIR, home, env)
      : path.join(clawHome, '.openclaw')
    return path.join(state, 'openclaw.json')
  }
  if (env.OPENCODE_CONFIG)
    return expandedDirectory(env.OPENCODE_CONFIG, home, env)
  const directory = path.join(
    env.XDG_CONFIG_HOME ?
      expandedDirectory(env.XDG_CONFIG_HOME, home, env)
    : path.join(home, '.config'),
    'opencode',
  )
  for (const file of ['opencode.jsonc', 'opencode.json', 'config.json']) {
    const candidate = path.join(directory, file)
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(directory, 'opencode.jsonc')
}

function document(harness: AdditionalHarness, text: string): StructuredConfig {
  return new StructuredConfig(
    text,
    harness === 'hermes' ? 'yaml'
    : harness === 'openclaw' ? 'json5'
    : harness === 'opencode' ? 'jsonc'
    : 'json',
  )
}

const CLAUDE_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]
const PICKER_MARKER = '[Copilot API Connector] '

function pickerRows(doc: StructuredConfig): Record<string, unknown>[] {
  const value = doc.get(['modelPicker', 'options'])
  if (value === undefined) return []
  if (
    !Array.isArray(value)
    || !value.every(
      (row: unknown): row is Record<string, unknown> =>
        row !== null
        && typeof row === 'object'
        && !Array.isArray(row)
        && 'model' in row
        && typeof row.model === 'string',
    )
  )
    throw new Error('Claude Code modelPicker.options must contain model rows.')
  return value
}

function managedPickerRow(row: Record<string, unknown>): boolean {
  return (
    typeof row.description === 'string'
    && row.description.startsWith(PICKER_MARKER)
  )
}

function ownedKeys(
  harness: AdditionalHarness,
  doc: StructuredConfig,
): ConfigKey[] {
  if (harness === 'claude-code')
    return [
      ['model'],
      ['modelOverrides'],
      ['apiKeyHelper'],
      ...CLAUDE_ENV.map((key) => ['env', key]),
    ]
  if (harness === 'opencode')
    return [['model'], ['small_model'], ['provider', PROVIDER_ID]]
  if (harness === 'hermes') return [['model'], ['providers', PROVIDER_ID]]
  const aliases = doc.get(['agents', 'defaults', 'models'])
  return [
    ['models', 'mode'],
    ['models', 'providers', PROVIDER_ID],
    ['secrets', 'providers', PROVIDER_ID],
    ['agents', 'defaults', 'model'],
    ...((
      aliases !== null && typeof aliases === 'object' && !Array.isArray(aliases)
    ) ?
      Object.keys(aliases)
        .filter((id) => id.startsWith(`${PROVIDER_ID}/`))
        .sort()
        .map((id) => ['agents', 'defaults', 'models', id])
    : []),
  ]
}

export function harnessFingerprint(
  harness: AdditionalHarness,
  text: string,
): string {
  const doc = document(harness, text)
  if (harness === 'claude-code')
    return doc.fingerprint(
      ownedKeys(harness, doc),
      pickerRows(doc).filter(managedPickerRow),
    )
  if (harness !== 'opencode') return doc.fingerprint(ownedKeys(harness, doc))
  const enabled = providerList(doc, 'enabled_providers')
  const disabled = providerList(doc, 'disabled_providers')
  return doc.fingerprint(ownedKeys(harness, doc), {
    enabled: enabled === undefined || enabled.includes(PROVIDER_ID),
    disabled: disabled?.includes(PROVIDER_ID) ?? false,
  })
}

function providerList(
  doc: StructuredConfig,
  key: string,
): string[] | undefined {
  const value = doc.get([key])
  if (value === undefined) return undefined
  if (
    !Array.isArray(value)
    || !value.every((item): item is string => typeof item === 'string')
  )
    throw new Error(`OpenCode ${key} must be an array of provider identifiers.`)
  return value
}

export function hasHarnessProvider(
  harness: AdditionalHarness,
  text: string,
): boolean {
  const doc = document(harness, text)
  if (harness === 'claude-code')
    return (
      (typeof doc.get(['apiKeyHelper']) === 'string'
        && String(doc.get(['apiKeyHelper'])).includes('--connector-token'))
      || pickerRows(doc).some(managedPickerRow)
    )
  return (
    doc.has([
      harness === 'opencode' ? 'provider'
      : harness === 'hermes' ? 'providers'
      : 'models',
      ...(harness === 'openclaw' ? ['providers'] : []),
      PROVIDER_ID,
    ])
    || (harness === 'openclaw'
      && doc.has(['secrets', 'providers', PROVIDER_ID]))
  )
}

export function helperShellCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return [command, ...args]
    .map((value) => {
      if (platform === 'win32') {
        if (/["%!\r\n]/u.test(value))
          throw new Error(
            'The connector path contains characters unsupported by Windows credential-helper command strings. Install it in a path without quotes, %, or !.',
          )
        return `"${value}"`
      }
      return `'${value.replace(/'/gu, `'"'"'`)}'`
    })
    .join(' ')
}

export interface HarnessConfigOptions {
  baseUrl: string
  model: string
  models: ConnectorModel[]
  apiKey: string
  helperCommand: string
  helperArgs: string[]
  platform?: NodeJS.Platform
}

export function configureHarness(
  harness: AdditionalHarness,
  text: string,
  options: HarnessConfigOptions,
): string {
  const doc = document(harness, text)
  if (harness === 'openclaw' && doc.has(['$include']))
    throw new Error(
      'OpenClaw includes must be consolidated before this connector can safely own and undo provider settings.',
    )
  const helper = () =>
    helperShellCommand(
      options.helperCommand,
      options.helperArgs,
      options.platform,
    )
  if (harness === 'claude-code') {
    const existing = pickerRows(doc).filter((row) => !managedPickerRow(row))
    const seen = new Set(existing.map((row) => row.model))
    doc.set(
      ['modelPicker', 'options'],
      [
        ...existing,
        ...options.models
          .filter((model) => !seen.has(model.id))
          .map((model) => ({
            model: model.id,
            label: model.name,
            description: `${PICKER_MARKER}${model.description || 'Discovered gateway model'}`,
          })),
      ],
    )
    doc.set(['model'], options.model)
    doc.set(['modelOverrides'], {})
    doc.set(['apiKeyHelper'], helper())
    doc.set(['env', 'ANTHROPIC_BASE_URL'], options.baseUrl)
    doc.set(['env', 'ANTHROPIC_MODEL'], options.model)
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_CUSTOM_HEADERS',
    ])
      doc.set(['env', key], '')
    for (const key of [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ])
      doc.set(['env', key], '0')
    for (const key of CLAUDE_ENV.filter(
      (key) =>
        key.startsWith('ANTHROPIC_DEFAULT_')
        || key === 'ANTHROPIC_SMALL_FAST_MODEL'
        || key === 'CLAUDE_CODE_SUBAGENT_MODEL',
    ))
      doc.set(['env', key], options.model)
  } else if (harness === 'opencode') {
    if (/\{(?:env|file):/u.test(options.apiKey))
      throw new Error(
        'This API key resembles an OpenCode configuration substitution. Use a gateway key without {env: or {file: sequences.',
      )
    doc.set(['model'], `${PROVIDER_ID}/${options.model}`)
    doc.set(['small_model'], `${PROVIDER_ID}/${options.model}`)
    const enabled = providerList(doc, 'enabled_providers')
    const disabled = providerList(doc, 'disabled_providers')
    if (enabled && !enabled.includes(PROVIDER_ID))
      doc.set(['enabled_providers'], [...enabled, PROVIDER_ID])
    if (disabled?.includes(PROVIDER_ID))
      doc.set(
        ['disabled_providers'],
        disabled.filter((id) => id !== PROVIDER_ID),
      )
    doc.set(['provider', PROVIDER_ID], {
      npm: '@ai-sdk/anthropic',
      name: 'Copilot API Connector',
      options: { baseURL: `${options.baseUrl}/v1`, apiKey: options.apiKey },
      models: Object.fromEntries(
        options.models.map((model) => [
          model.id,
          {
            id: model.id,
            name: model.name,
            ...(model.contextWindow > 0 && model.maxOutputTokens ?
              {
                limit: {
                  context: model.contextWindow,
                  output: model.maxOutputTokens,
                },
              }
            : {}),
            ...(model.vision === undefined ?
              {}
            : {
                modalities: {
                  input: model.vision ? ['text', 'image'] : ['text'],
                  output: ['text'],
                },
              }),
          },
        ]),
      ),
    })
  } else if (harness === 'hermes') {
    doc.set(['model'], {
      provider: `custom:${PROVIDER_ID}`,
      default: options.model,
    })
    doc.set(['providers', PROVIDER_ID], {
      api: `${options.baseUrl}/v1`,
      transport: 'chat_completions',
      key_cmd: helper(),
      default_model: options.model,
      discover_models: false,
      models: Object.fromEntries(
        options.models.map((model) => [
          model.id,
          {
            ...(model.contextWindow > 0 ?
              { context_length: model.contextWindow }
            : {}),
          },
        ]),
      ),
    })
  } else {
    doc.set(['models', 'mode'], 'merge')
    doc.set(['models', 'providers', PROVIDER_ID], {
      baseUrl: `${options.baseUrl}/v1`,
      api: 'openai-completions',
      apiKey: { source: 'exec', provider: PROVIDER_ID, id: OPENCLAW_SECRET_ID },
      models: options.models.map((model) => ({
        id: model.id,
        name: model.name,
        ...(model.contextWindow > 0 ?
          { contextWindow: model.contextWindow }
        : {}),
        ...(model.maxOutputTokens ? { maxTokens: model.maxOutputTokens } : {}),
        ...(model.vision === undefined ?
          {}
        : { input: model.vision ? ['text', 'image'] : ['text'] }),
        ...(model.reasoning === undefined ?
          {}
        : { reasoning: model.reasoning }),
      })),
    })
    doc.set(['secrets', 'providers', PROVIDER_ID], {
      source: 'exec',
      command: options.helperCommand,
      args: options.helperArgs,
      jsonOnly: false,
      timeoutMs: 30_000,
      passEnv: [
        'APPDATA',
        'LOCALAPPDATA',
        'USERPROFILE',
        'HOME',
        'XDG_RUNTIME_DIR',
        'DBUS_SESSION_BUS_ADDRESS',
        'DISPLAY',
        'WAYLAND_DISPLAY',
      ],
    })
    doc.set(['agents', 'defaults', 'model'], {
      primary: `${PROVIDER_ID}/${options.model}`,
    })
    for (const key of ownedKeys(harness, doc).filter(
      (key) => key[0] === 'agents' && key[2] === 'models',
    ))
      doc.remove(key)
    for (const model of options.models)
      doc.set(
        ['agents', 'defaults', 'models', `${PROVIDER_ID}/${model.id}`],
        {},
      )
  }
  return doc.toString()
}

export function restoreHarness(
  harness: AdditionalHarness,
  current: string,
  original: string,
): { text: string; empty: boolean } {
  const doc = document(harness, current)
  const baseline = document(harness, original)
  for (const key of ownedKeys(harness, doc)) doc.restore(key, baseline)
  if (harness === 'claude-code') {
    const rows = pickerRows(doc).filter((row) => !managedPickerRow(row))
    if (rows.length || baseline.has(['modelPicker', 'options']))
      doc.set(['modelPicker', 'options'], rows)
    else doc.restore(['modelPicker', 'options'], baseline)
  }
  if (harness === 'opencode') {
    for (const key of ['enabled_providers', 'disabled_providers']) {
      const currentList = providerList(doc, key)
      if (!currentList) continue
      const originalList = providerList(baseline, key)
      const restored = currentList.filter((id) => id !== PROVIDER_ID)
      if (originalList?.includes(PROVIDER_ID)) restored.push(PROVIDER_ID)
      if (restored.length || originalList !== undefined)
        doc.set([key], restored)
      else doc.remove([key])
    }
  }
  return { text: doc.toString(), empty: doc.empty() }
}

export function harnessCandidates(
  harness: AdditionalHarness,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): { executable: string; args: string[] }[] {
  const name = harness === 'claude-code' ? 'claude' : harness
  const entries = (env.PATH ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
  const candidates: { executable: string; args: string[] }[] = entries.map(
    (entry) => ({
      executable: path.join(
        entry.replace(/^"|"$/gu, ''),
        platform === 'win32' ? `${name}.exe` : name,
      ),
      args: [],
    }),
  )
  candidates.push({
    executable: path.join(
      home,
      '.local',
      'bin',
      platform === 'win32' ? `${name}.exe` : name,
    ),
    args: [],
  })
  if (harness === 'hermes')
    candidates.push({
      executable: path.join(
        path.dirname(harnessConfigPath(harness, env, home, platform)),
        'venv',
        platform === 'win32' ? 'Scripts' : 'bin',
        platform === 'win32' ? 'hermes.exe' : 'hermes',
      ),
      args: [],
    })
  if (harness === 'opencode') {
    if (env.OPENCODE_BIN_PATH)
      candidates.unshift({
        executable: path.resolve(env.OPENCODE_BIN_PATH),
        args: [],
      })
    candidates.push({
      executable: path.join(
        home,
        '.opencode',
        'bin',
        platform === 'win32' ? 'opencode.exe' : 'opencode',
      ),
      args: [],
    })
  }
  if (platform === 'win32') {
    const prefixes = [
      ...entries,
      ...(env.APPDATA ? [path.join(env.APPDATA, 'npm')] : []),
      ...[env.NPM_CONFIG_PREFIX, env.npm_config_prefix].filter(
        (value): value is string => !!value,
      ),
    ]
    const node = entries
      .map((entry) => path.join(entry, 'node.exe'))
      .find((file) => fs.existsSync(file))
    for (const prefix of new Set(prefixes)) {
      const modules =
        path.basename(prefix) === '.bin' ?
          path.dirname(prefix)
        : path.join(prefix, 'node_modules')
      if (harness === 'opencode') {
        for (const arch of ['x64', 'arm64']) {
          for (const variant of ['', '-baseline'])
            candidates.push({
              executable: path.join(
                modules,
                'opencode-ai',
                'node_modules',
                `opencode-windows-${arch}${variant}`,
                'bin',
                'opencode.exe',
              ),
              args: [],
            })
          candidates.push({
            executable: path.join(
              modules,
              `opencode-windows-${arch}`,
              'bin',
              'opencode.exe',
            ),
            args: [],
          })
        }
      } else if (
        node
        && (harness === 'openclaw' || harness === 'claude-code')
      ) {
        candidates.push({
          executable: node,
          args: [
            harness === 'openclaw' ?
              path.join(modules, 'openclaw', 'openclaw.mjs')
            : path.join(modules, '@anthropic-ai', 'claude-code', 'cli.js'),
          ],
        })
      }
    }
  }
  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (other) =>
          other.executable === candidate.executable
          && other.args.join('\0') === candidate.args.join('\0'),
      ) === index,
  )
}

export async function detectHarness(
  harness: AdditionalHarness,
  selected: string | null = null,
  runner: CommandRunner = runCommand,
  candidates = harnessCandidates(harness),
): Promise<HarnessInstallation | null> {
  for (const candidate of selected ?
    [{ executable: selected, args: [] }]
  : candidates) {
    if (
      !fs.existsSync(candidate.executable)
      || candidate.args.some((file) => !fs.existsSync(file))
    ) {
      if (selected)
        throw new Error('The selected harness executable no longer exists.')
      continue
    }
    try {
      const result = await runner(
        candidate.executable,
        [...candidate.args, '--version'],
        { timeout: 15_000 },
      )
      const version = result.stdout
        .trim()
        .match(/(?:^|\s|v)(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?=$|\s|\))/u)?.[1]
      if (harness === 'claude-code' && version) {
        const [major, minor, patch] = version.split(/[.-]/u).map(Number)
        if (
          major < 2
          || (major === 2 && (minor < 1 || (minor === 1 && patch < 242)))
        )
          throw new Error(
            'Update Claude Code to 2.1.242 or newer for gateway model picker support.',
          )
      }
      const identity = new RegExp(
        `\\b${harness === 'claude-code' ? 'claude' : harness}\\b`,
        'iu',
      )
      if (!version && !(harness === 'hermes' && identity.test(result.stdout)))
        throw new Error(
          'The executable did not report a recognizable harness version.',
        )
      if (!identity.test(result.stdout)) {
        const help = await runner(
          candidate.executable,
          [...candidate.args, '--help'],
          { timeout: 15_000 },
        )
        if (!identity.test(help.stdout))
          throw new Error(
            'The executable did not identify itself as the selected harness.',
          )
      }
      return {
        ...candidate,
        version: version ?? result.stdout.trim(),
        configPath: harnessConfigPath(harness),
      }
    } catch (error) {
      if (selected) throw error
      console.warn(
        `[connector] ${HARNESS_NAMES[harness]} detection failed for ${candidate.executable}; trying another installed candidate.`,
      )
    }
  }
  return null
}
