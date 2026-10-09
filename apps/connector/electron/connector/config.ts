import { createHash } from 'node:crypto'
import { getStaticTOMLValue, parseTOML, type AST } from 'toml-eslint-parser'

export const CONNECTOR_PROVIDER = 'copilot_api_connector'
const OWNED_KEYS = new Set([
  'model',
  'model_provider',
  'model_catalog_json',
  'model_reasoning_effort',
  'model_context_window',
  'model_auto_compact_token_limit',
])

export interface ConnectorConfigOptions {
  baseUrl: string
  model: string
  catalogPath: string | null
  helperCommand: string
  helperArgs: string[]
}

interface Edit {
  start: number
  end: number
  text: string
}

function parseConfig(text: string): AST.TOMLProgram {
  try {
    return parseTOML(text, { tomlVersion: '1.0.0' })
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Invalid TOML'
    throw new Error(`Codex configuration is not valid TOML: ${detail}`)
  }
}

function keyParts(key: AST.TOMLKey): string[] {
  return key.keys.map((part) =>
    part.type === 'TOMLBare' ? part.name : part.value,
  )
}

function isOwnedTable(table: AST.TOMLTable): boolean {
  const parts = keyParts(table.key)
  return parts[0] === 'model_providers' && parts[1] === CONNECTOR_PROVIDER
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function managedConfigFingerprint(text: string): string {
  const value: unknown = getStaticTOMLValue(parseConfig(text))
  if (!isRecord(value)) throw new Error('Codex configuration is not a table.')
  const owned: Record<string, unknown> = {}
  for (const key of OWNED_KEYS) {
    if (key in value) owned[key] = value[key]
  }
  const providers = value.model_providers
  if (isRecord(providers) && CONNECTOR_PROVIDER in providers) {
    owned.provider = providers[CONNECTOR_PROVIDER]
  }
  return createHash('sha256').update(JSON.stringify(owned)).digest('hex')
}

export function hasConnectorProvider(text: string): boolean {
  const value: unknown = getStaticTOMLValue(parseConfig(text))
  return (
    isRecord(value)
    && isRecord(value.model_providers)
    && CONNECTOR_PROVIDER in value.model_providers
  )
}

function withoutManagedConfig(text: string): string {
  const edits: Edit[] = []
  for (const node of parseConfig(text).body[0].body) {
    if (node.type === 'TOMLTable') {
      if (isOwnedTable(node)) {
        edits.push({ start: node.range[0], end: node.range[1], text: '' })
      }
    } else {
      const parts = keyParts(node.key)
      if (
        (parts.length === 1 && OWNED_KEYS.has(parts[0]))
        || (parts[0] === 'model_providers' && parts[1] === CONNECTOR_PROVIDER)
      ) {
        edits.push({ start: node.range[0], end: node.range[1], text: '' })
      }
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  }
  return text
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function configureCodex(
  original: string,
  options: ConnectorConfigOptions,
): string {
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const globals = [
    `model = ${tomlString(options.model)}`,
    `model_provider = "${CONNECTOR_PROVIDER}"`,
  ]
  if (options.catalogPath !== null) {
    globals.push(`model_catalog_json = ${tomlString(options.catalogPath)}`)
  }
  const provider = [
    `[model_providers.${CONNECTOR_PROVIDER}]`,
    'name = "OpenAI"',
    `base_url = ${tomlString(options.baseUrl)}`,
    'wire_api = "responses"',
    'supports_websockets = false',
    ...(options.catalogPath === null ?
      [`model_catalog_url = ${tomlString(`${options.baseUrl}/models`)}`]
    : []),
    '',
    `[model_providers.${CONNECTOR_PROVIDER}.auth]`,
    `command = ${tomlString(options.helperCommand)}`,
    `args = [${options.helperArgs.map(tomlString).join(', ')}]`,
    'timeout_ms = 30000',
    'refresh_interval_ms = 300000',
  ]
  const result = [
    globals.join(newline),
    withoutManagedConfig(original),
    provider.join(newline),
    '',
  ].join(newline)
  parseConfig(result)
  return result
}

export function restoreCodex(current: string, original: string): string {
  const newline = current.includes('\r\n') ? '\r\n' : '\n'
  const globals: string[] = []
  for (const node of parseConfig(original).body[0].body) {
    if (node.type !== 'TOMLKeyValue') continue
    const parts = keyParts(node.key)
    if (parts.length === 1 && OWNED_KEYS.has(parts[0])) {
      globals.push(original.slice(node.range[0], node.range[1]))
    }
  }
  const result = [...globals, withoutManagedConfig(current)].join(newline)
  parseConfig(result)
  return result
}
