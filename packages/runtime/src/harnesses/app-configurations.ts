import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  type ParseError,
} from 'jsonc-parser'
import JSON5 from 'json5'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type { AvailableModel, Credentials, Protocol } from '../contracts'
import { atomicWrite, readOptional } from '../credentials/vault'
import { hash } from './codex-config'

export const configurableApps = ['claude-code', 'hermes', 'openclaw'] as const
export type ConfigurableApp = (typeof configurableApps)[number]
export const configurableAppSchema = z.enum(configurableApps)

export const appProtocols: Record<ConfigurableApp, Protocol> = {
  'claude-code': 'messages',
  hermes: 'chat-completions',
  openclaw: 'chat-completions',
}

const appNames: Record<ConfigurableApp, string> = {
  'claude-code': 'Claude Code',
  hermes: 'Hermes Agent',
  openclaw: 'OpenClaw',
}

const PROVIDER = 'modelbridge'
const APP_HEADER = 'x-modelbridge-app'

type KeyPath = string[]
type Entry = { path: KeyPath; value: unknown }
const originalSchema = z.object({
  path: z.array(z.string()).min(1),
  present: z.boolean(),
  value: z.unknown().optional(),
  // A parent object ModelBridge created; removed on restore only when empty.
  container: z.boolean().optional(),
})
type Original = z.infer<typeof originalSchema>
const savedSchema = z.object({
  created: z.boolean(),
  originals: z.array(originalSchema),
  applied: z
    .object({
      model: z.string(),
      at: z.string(),
      fingerprint: z.string(),
    })
    .nullable(),
})
type Saved = z.infer<typeof savedSchema>

export interface AppConfigurationStatus {
  app: ConfigurableApp
  configPath: string
  exists: boolean
  // ModelBridge's settings are in place and unchanged since they were applied.
  configured: boolean
  // ModelBridge's settings were changed outside the app after being applied.
  externalEdit: boolean
  // The applied default model is no longer available.
  missingModel: boolean
  canRestore: boolean
  model: string | null
  appliedAt: string | null
  error: string | null
}

export interface AppConfigurationPreview {
  id: string
  app: ConfigurableApp
  action: 'configure' | 'restore'
  configPath: string
  before: string
  after: string
  changes: string[]
  warnings: string[]
}

export interface AppConfigureOptions {
  modelId: string
  models: AvailableModel[]
  // Gateway origin without /v1, for example http://127.0.0.1:4321.
  origin: string
  key: string
}

interface Format {
  read(text: string): unknown
  set(text: string, path: KeyPath, value: unknown): string
  // Saving rewrites the whole file, dropping comments and formatting.
  lossy(text: string): boolean
}

interface Definition {
  configPath(env: NodeJS.ProcessEnv, home: string): string
  format: Format
  paths: KeyPath[]
  entries(model: AvailableModel, options: AppConfigureOptions): Entry[]
  model(value: unknown): string | null
  changes: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function get(value: unknown, keys: KeyPath): unknown {
  let current = value
  for (const key of keys) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

function setObject(
  target: Record<string, unknown>,
  keys: KeyPath,
  value: unknown,
) {
  let current = target
  for (const key of keys.slice(0, -1)) {
    const next = current[key]
    if (!isRecord(next)) current[key] = {}
    current = current[key] as Record<string, unknown>
  }
  const last = keys[keys.length - 1]
  if (value === undefined) delete current[last]
  else current[last] = value
}

const eol = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')

function strictJsonc(text: string): { value: unknown } | null {
  const errors: ParseError[] = []
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true })
  return errors.length ? null : { value }
}

function jsoncSet(text: string, keys: KeyPath, value: unknown) {
  const base = text.trim() ? text : `{}${eol(text)}`
  const edits = modify(base, keys, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: eol(text) },
  })
  return applyEdits(base, edits)
}

const jsonFormat: Format = {
  read(text) {
    if (!text.trim()) return {}
    const parsed = strictJsonc(text)
    if (!parsed) throw new Error('The file is not valid JSON.')
    return parsed.value
  },
  set: jsoncSet,
  lossy: () => false,
}

const json5Format: Format = {
  read(text) {
    if (!text.trim()) return {}
    const parsed = strictJsonc(text)
    if (parsed) return parsed.value
    try {
      return JSON5.parse(text)
    } catch {
      throw new Error('The file is not valid JSON5.')
    }
  },
  set(text, keys, value) {
    if (!text.trim() || strictJsonc(text)) return jsoncSet(text, keys, value)
    const data: unknown = JSON5.parse(text)
    if (!isRecord(data)) throw new Error('The file must contain an object.')
    setObject(data, keys, value)
    return `${JSON.stringify(data, null, 2)}${eol(text)}`
  },
  lossy: (text) => !!text.trim() && !strictJsonc(text),
}

const yamlFormat: Format = {
  read(text) {
    const document = parseDocument(text)
    const [error] = document.errors
    if (error) throw new Error(`The file is not valid YAML: ${error.message}`)
    return (document.toJS() as unknown) ?? {}
  },
  set(text, keys, value) {
    const document = parseDocument(text)
    if (value === undefined) document.deleteIn(keys)
    else document.setIn(keys, document.createNode(value))
    const output = document.toString()
    return eol(text) === '\r\n' ? output.replace(/\r?\n/gu, '\r\n') : output
  },
  lossy: () => false,
}

// Sets one key path, replacing any non-object parent so the edit cannot fail.
function setPath(format: Format, text: string, keys: KeyPath, value: unknown) {
  const current = format.read(text)
  if (value === undefined && get(current, keys) === undefined) return text
  let next = text
  for (let depth = 1; depth < keys.length; depth++) {
    const parent = get(current, keys.slice(0, depth))
    if (parent === undefined) break
    if (!isRecord(parent)) {
      next = format.set(next, keys.slice(0, depth), {})
      break
    }
  }
  return format.set(next, keys, value)
}

function originalsFor(value: unknown, entries: Entry[]): Original[] {
  const originals: Original[] = []
  const recorded = new Set<string>()
  const record = (original: Original) => {
    const key = JSON.stringify(original.path)
    if (recorded.has(key)) return
    recorded.add(key)
    originals.push(original)
  }
  for (const { path: keys } of entries) {
    for (let depth = 1; depth < keys.length; depth++) {
      const prefix = keys.slice(0, depth)
      const parent = get(value, prefix)
      if (parent === undefined) {
        record({ path: prefix, present: false, container: true })
        continue
      }
      if (!isRecord(parent)) {
        record({ path: prefix, present: true, value: parent })
        break
      }
    }
    const current = get(value, keys)
    record(
      current === undefined ?
        { path: keys, present: false }
      : { path: keys, present: true, value: current },
    )
  }
  return originals
}

const byVersion = (left: AvailableModel, right: AvailableModel) =>
  right.id.localeCompare(left.id, undefined, { numeric: true })

// Prefers a same-source model of the given family, newest first.
function family(
  model: AvailableModel,
  models: AvailableModel[],
  word: string,
): string {
  if (model.id.toLowerCase().includes(word)) return model.id
  const candidates = models
    .filter(
      (item) =>
        item.protocols.includes('messages')
        && item.id.toLowerCase().includes(word),
    )
    .sort(byVersion)
  return (
    candidates.find((item) => item.sourceId === model.sourceId)
    ?? candidates[0]
    ?? model
  ).id
}

const servable = (models: AvailableModel[], protocol: Protocol) =>
  models.filter((model) => model.protocols.includes(protocol))

const definitions: Record<ConfigurableApp, Definition> = {
  'claude-code': {
    configPath: (env, home) =>
      path.join(
        env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
        'settings.json',
      ),
    format: jsonFormat,
    paths: [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_CUSTOM_HEADERS',
    ].map((name) => ['env', name]),
    entries: (model, { models, origin, key }) => [
      { path: ['env', 'ANTHROPIC_BASE_URL'], value: origin },
      { path: ['env', 'ANTHROPIC_AUTH_TOKEN'], value: key },
      { path: ['env', 'ANTHROPIC_API_KEY'], value: undefined },
      { path: ['env', 'ANTHROPIC_MODEL'], value: model.id },
      {
        path: ['env', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
        value: family(model, models, 'opus'),
      },
      {
        path: ['env', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
        value: family(model, models, 'sonnet'),
      },
      {
        path: ['env', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
        value: family(model, models, 'haiku'),
      },
      {
        path: ['env', 'ANTHROPIC_CUSTOM_HEADERS'],
        value: `${APP_HEADER}: claude-code`,
      },
    ],
    model: (value) => {
      const model = get(value, ['env', 'ANTHROPIC_MODEL'])
      return typeof model === 'string' ? model : null
    },
    changes: [
      'env.ANTHROPIC_BASE_URL points Claude Code at the local ModelBridge gateway.',
      'env.ANTHROPIC_AUTH_TOKEN holds this machine’s local key, which only works on 127.0.0.1. Your remote host key is never written.',
      'env.ANTHROPIC_MODEL and the opus/sonnet/haiku aliases select ModelBridge models; haiku also runs background tasks.',
      'env.ANTHROPIC_API_KEY is removed while ModelBridge is active so it cannot override the token. Restore puts it back.',
      'Other settings stay untouched. Shell environment variables still win over settings.json; restart Claude Code to apply.',
    ],
  },
  hermes: {
    configPath: (env, home) => {
      const base =
        env.HERMES_HOME
        || (process.platform === 'win32' ?
          path.join(
            env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local'),
            'hermes',
          )
        : path.join(home, '.hermes'))
      return path.join(base, 'config.yaml')
    },
    format: yamlFormat,
    paths: [['providers', PROVIDER], ['model']],
    entries: (model, { models, origin, key }) => [
      {
        path: ['providers', PROVIDER],
        value: {
          name: 'ModelBridge',
          api: `${origin}/v1`,
          api_key: key,
          transport: 'chat_completions',
          default_model: model.id,
          discover_models: false,
          models: servable(models, 'chat-completions').map((item) => item.id),
          extra_headers: { [APP_HEADER]: 'hermes' },
        },
      },
      {
        path: ['model'],
        value: { default: model.id, provider: `custom:${PROVIDER}` },
      },
    ],
    model: (value) => {
      const model = get(value, ['model'])
      if (typeof model === 'string') return model
      const name = get(model, ['default'])
      return typeof name === 'string' ? name : null
    },
    changes: [
      'providers.modelbridge adds ModelBridge as a Chat Completions provider at the local gateway, listing every available model.',
      'Its api_key is this machine’s local key, which only works on 127.0.0.1. Your remote host key is never written.',
      'model is replaced so Hermes defaults to custom:modelbridge and the chosen model. Restore puts your previous model block back.',
      'Other settings and ~/.hermes/.env stay untouched. Start a new Hermes session to apply.',
    ],
  },
  openclaw: {
    configPath: (env, home) =>
      env.OPENCLAW_CONFIG_PATH
      || path.join(
        env.OPENCLAW_STATE_DIR
          || path.join(env.OPENCLAW_HOME || home, '.openclaw'),
        'openclaw.json',
      ),
    format: json5Format,
    paths: [
      ['models', 'providers', PROVIDER],
      ['agents', 'defaults', 'model', 'primary'],
    ],
    entries: (model, { models, origin, key }) => [
      {
        path: ['models', 'providers', PROVIDER],
        value: {
          baseUrl: `${origin}/v1`,
          apiKey: key,
          api: 'openai-completions',
          headers: { [APP_HEADER]: 'openclaw' },
          models: servable(models, 'chat-completions').map((item) => ({
            id: item.id,
            name: `${item.name} (${item.sourceLabel})`,
            reasoning: !!item.reasoningEfforts?.length,
            input: item.inputModalities ?? ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            ...(item.contextWindow ?
              { contextWindow: item.contextWindow }
            : {}),
            ...(item.maxOutputTokens ?
              { maxTokens: item.maxOutputTokens }
            : {}),
          })),
        },
      },
      {
        path: ['agents', 'defaults', 'model', 'primary'],
        value: `${PROVIDER}/${model.id}`,
      },
    ],
    model: (value) => {
      const model = get(value, ['agents', 'defaults', 'model'])
      if (typeof model === 'string') return model
      const primary = get(model, ['primary'])
      return typeof primary === 'string' ? primary : null
    },
    changes: [
      'models.providers.modelbridge adds ModelBridge as an OpenAI-compatible provider at the local gateway, listing every available model.',
      'Its apiKey is this machine’s local key, which only works on 127.0.0.1. Your remote host key is never written.',
      'agents.defaults.model.primary makes the chosen model the default for new agent sessions.',
      'Other providers and settings stay untouched. Restart the OpenClaw gateway to apply.',
    ],
  },
}

const LOCAL_KEY = '<modelbridge-local-key>'
const SECRET =
  /((?:api_?key|auth_?token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/giu

export function redactSecrets(text: string, key?: string) {
  const masked = key ? text.split(key).join(LOCAL_KEY) : text
  return masked.replace(SECRET, (_, prefix: string, value: string) =>
    value === LOCAL_KEY ? `${prefix}${value}` : `${prefix}••••••••`,
  )
}

interface Prepared {
  preview: AppConfigurationPreview
  before: string | null
  content: string | null
  originals: Original[]
  model: string
  fingerprint: string
}

export class AppConfigurations {
  private readonly previews = new Map<string, Prepared>()
  private writing = false

  constructor(
    private readonly credentials: Credentials,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly home: string = os.homedir(),
  ) {}

  configPath(app: ConfigurableApp) {
    return definitions[app].configPath(this.env, this.home)
  }

  private vaultId(app: ConfigurableApp) {
    return `app-configuration-${app}-${hash(this.configPath(app))}`
  }

  private saved(app: ConfigurableApp): Saved | null {
    let raw: string
    try {
      raw = this.credentials.get(this.vaultId(app))
    } catch {
      return null
    }
    return savedSchema.parse(JSON.parse(raw))
  }

  private fingerprint(app: ConfigurableApp, value: unknown) {
    return hash(
      JSON.stringify(
        definitions[app].paths.map((keys) => get(value, keys) ?? null),
      ),
    )
  }

  status(
    app: ConfigurableApp,
    models?: AvailableModel[],
  ): AppConfigurationStatus {
    const configPath = this.configPath(app)
    const definition = definitions[app]
    const text = readOptional(configPath)
    const saved = this.saved(app)
    const base = {
      app,
      configPath,
      exists: text !== null,
      canRestore: !!saved,
      appliedAt: saved?.applied?.at ?? null,
    }
    let value: unknown
    try {
      value = definition.format.read(text ?? '')
    } catch (error) {
      return {
        ...base,
        configured: false,
        externalEdit: false,
        missingModel: false,
        model: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    const configured =
      !!saved?.applied
      && this.fingerprint(app, value) === saved.applied.fingerprint
    return {
      ...base,
      configured,
      externalEdit: !!saved?.applied && !configured,
      missingModel:
        !!saved?.applied
        && !!models
        && !models.some(
          (model) =>
            model.id === saved.applied?.model
            && model.protocols.includes(appProtocols[app]),
        ),
      model: definition.model(value),
      error: null,
    }
  }

  private read(app: ConfigurableApp) {
    const configPath = this.configPath(app)
    const before = readOptional(configPath)
    let value: unknown
    try {
      value = definitions[app].format.read(before ?? '')
    } catch (error) {
      throw new Error(
        `${appNames[app]} settings at ${configPath} could not be read. ${error instanceof Error ? error.message : String(error)} Fix the file and try again.`,
      )
    }
    if (!isRecord(value))
      throw new Error(
        `${appNames[app]} settings at ${configPath} must contain an object at the top level.`,
      )
    return { configPath, before, value }
  }

  private store(prepared: Prepared) {
    this.previews.clear()
    this.previews.set(prepared.preview.id, prepared)
    return prepared.preview
  }

  preview(
    app: ConfigurableApp,
    options: AppConfigureOptions,
  ): AppConfigurationPreview {
    const definition = definitions[app]
    const model = options.models.find((item) => item.id === options.modelId)
    if (!model?.protocols.includes(appProtocols[app]))
      throw new Error(
        `Choose an available model that ${appNames[app]} can use.`,
      )
    const { configPath, before, value } = this.read(app)
    const entries = definition.entries(model, options)
    let content = before ?? ''
    for (const entry of entries)
      content = setPath(definition.format, content, entry.path, entry.value)
    const warnings: string[] = []
    if (definition.format.lossy(before ?? ''))
      warnings.push(
        'This file uses JSON5-only syntax, so saving rewrites it as plain JSON. Comments and formatting are not kept; Restore brings back the values ModelBridge changed, not the comments.',
      )
    if (this.saved(app)?.applied && this.status(app).externalEdit)
      warnings.push(
        'ModelBridge settings in this file were edited outside the app. Applying replaces those edits.',
      )
    return this.store({
      preview: {
        id: randomUUID(),
        app,
        action: 'configure',
        configPath,
        before: redactSecrets(before ?? '', options.key),
        after: redactSecrets(content, options.key),
        changes: definition.changes,
        warnings,
      },
      before,
      content,
      originals: originalsFor(value, entries),
      model: model.id,
      fingerprint: this.fingerprint(app, definition.format.read(content)),
    })
  }

  restore(app: ConfigurableApp): AppConfigurationPreview {
    const saved = this.saved(app)
    if (!saved)
      throw new Error(
        `ModelBridge has not changed ${appNames[app]}’s settings on this machine.`,
      )
    const definition = definitions[app]
    const { configPath, before } = this.read(app)
    let content = before ?? ''
    const ordered = [...saved.originals].sort(
      (left, right) => right.path.length - left.path.length,
    )
    for (const original of ordered) {
      if (original.container) {
        const current = get(definition.format.read(content), original.path)
        if (isRecord(current) && Object.keys(current).length === 0)
          content = setPath(
            definition.format,
            content,
            original.path,
            undefined,
          )
      } else
        content = setPath(
          definition.format,
          content,
          original.path,
          original.present ? original.value : undefined,
        )
    }
    const value = definition.format.read(content)
    const remove =
      saved.created && isRecord(value) && Object.keys(value).length === 0
    return this.store({
      preview: {
        id: randomUUID(),
        app,
        action: 'restore',
        configPath,
        before: redactSecrets(before ?? ''),
        after: remove ? '' : redactSecrets(content),
        changes: [
          remove ?
            'ModelBridge created this file and nothing else is in it, so it is removed.'
          : 'Every setting ModelBridge changed goes back to its value before setup.',
          'Settings you changed elsewhere in the file stay as they are.',
        ],
        warnings: [],
      },
      before,
      content: remove ? null : content,
      originals: [],
      model: '',
      fingerprint: '',
    })
  }

  async apply(id: string): Promise<AppConfigurationStatus> {
    const prepared = this.previews.get(id)
    if (!prepared)
      throw new Error('The preview is stale. Generate a new preview first.')
    if (this.writing)
      throw new Error(
        'Another settings change is in progress. Wait for it to finish.',
      )
    this.writing = true
    try {
      const { app, action, configPath } = prepared.preview
      if (hash(readOptional(configPath)) !== hash(prepared.before))
        throw new Error(
          'The settings file changed after the preview. Nothing was overwritten; generate a fresh preview.',
        )
      const vaultId = this.vaultId(app)
      if (action === 'restore') {
        if (prepared.content === null) fs.rmSync(configPath, { force: true })
        else atomicWrite(configPath, prepared.content)
        await this.credentials.remove(vaultId)
      } else {
        const content = prepared.content ?? ''
        const saved = this.saved(app)
        const known = new Set(
          saved?.originals.map((original) => JSON.stringify(original.path)),
        )
        const next: Saved = {
          created: saved ? saved.created : prepared.before === null,
          originals: [
            ...(saved?.originals ?? []),
            ...prepared.originals.filter(
              (original) => !known.has(JSON.stringify(original.path)),
            ),
          ],
          applied: saved?.applied ?? null,
        }
        // Originals are saved before writing so a crash never loses them.
        await this.credentials.set(vaultId, JSON.stringify(next))
        atomicWrite(configPath, content)
        await this.credentials.set(
          vaultId,
          JSON.stringify({
            ...next,
            applied: {
              model: prepared.model,
              at: new Date().toISOString(),
              fingerprint: prepared.fingerprint,
            },
          }),
        )
      }
      this.previews.clear()
      return this.status(app)
    } finally {
      this.writing = false
    }
  }
}
