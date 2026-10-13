import { createHash } from 'node:crypto'
import { getStaticTOMLValue, parseTOML, type AST } from 'toml-eslint-parser'

export const CODEX_PROVIDER = 'modelbridge'
const ownedKeys = new Set([
  'model',
  'model_provider',
  'model_catalog_json',
  'model_reasoning_effort',
  'model_context_window',
  'model_auto_compact_token_limit',
])

function parse(text: string): AST.TOMLProgram {
  try {
    return parseTOML(text, { tomlVersion: '1.0.0' })
  } catch (error) {
    throw new Error(
      `Codex configuration is not valid TOML: ${error instanceof Error ? error.message : 'Invalid TOML'}`,
      { cause: error },
    )
  }
}
function parts(key: AST.TOMLKey) {
  return key.keys.map((part) =>
    part.type === 'TOMLBare' ? part.name : part.value,
  )
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function configValue(text: string): Record<string, unknown> {
  const value: unknown = getStaticTOMLValue(parse(text))
  if (!record(value)) throw new Error('Codex configuration is not a table.')
  return value
}
function managed(parts: string[]) {
  return parts[0] === 'model_providers' && parts[1] === CODEX_PROVIDER
}
function removeManaged(text: string) {
  const edits: Array<{ start: number; end: number }> = []
  for (const node of parse(text).body[0].body) {
    const key = parts(node.key)
    if (node.type === 'TOMLTable') {
      if (managed(key)) edits.push({ start: node.range[0], end: node.range[1] })
      else {
        for (const entry of node.body) {
          if (managed([...key, ...parts(entry.key)]))
            throw new Error(
              'Codex uses an unsupported nested representation of the ModelBridge provider. Normalize it before applying changes.',
            )
        }
      }
    } else if ((key.length === 1 && ownedKeys.has(key[0])) || managed(key)) {
      edits.push({ start: node.range[0], end: node.range[1] })
    } else if (key[0] === 'model_providers' && key.length === 1) {
      const value = configValue(text).model_providers
      if (record(value) && CODEX_PROVIDER in value)
        throw new Error(
          'An inline model_providers table contains the ModelBridge provider. Normalize it before applying changes.',
        )
    }
  }
  for (const edit of edits.sort((left, right) => right.start - left.start))
    text = text.slice(0, edit.start) + text.slice(edit.end)
  return text
}
export function managedFingerprint(text: string) {
  const value = configValue(text)
  const providers = value.model_providers
  return hash(
    JSON.stringify({
      ...Object.fromEntries([...ownedKeys].map((key) => [key, value[key]])),
      provider: record(providers) ? providers[CODEX_PROVIDER] : undefined,
    }),
  )
}
export function hash(text: string | null) {
  return createHash('sha256')
    .update(text === null ? 'missing:' : `present:${text}`)
    .digest('hex')
}
export function hasManagedProvider(text: string) {
  const providers = configValue(text).model_providers
  return record(providers) && CODEX_PROVIDER in providers
}
export function configureCodex(
  original: string,
  options: {
    model: string
    url: string
    catalogPath: string
    helperCommand: string
    helperArgs: string[]
    reasoningEffort?: string
  },
) {
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const result = [
    `model = ${JSON.stringify(options.model)}`,
    `model_provider = "${CODEX_PROVIDER}"`,
    `model_catalog_json = ${JSON.stringify(options.catalogPath)}`,
    `model_reasoning_effort = ${JSON.stringify(options.reasoningEffort ?? 'none')}`,
    removeManaged(original),
    `[model_providers.${CODEX_PROVIDER}]`,
    'name = "ModelBridge - remote Copilot"',
    `base_url = ${JSON.stringify(options.url)}`,
    `model_catalog_url = ${JSON.stringify(`${options.url}/codex/models`)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    `[model_providers.${CODEX_PROVIDER}.auth]`,
    `command = ${JSON.stringify(options.helperCommand)}`,
    `args = [${options.helperArgs.map((value) => JSON.stringify(value)).join(', ')}]`,
    'timeout_ms = 30000',
    'refresh_interval_ms = 300000',
    '',
  ].join(newline)
  parse(result)
  return result
}
export function restoreCodex(current: string, original: string) {
  const globals: string[] = []
  for (const node of parse(original).body[0].body) {
    if (node.type === 'TOMLKeyValue') {
      const key = parts(node.key)
      if (key.length === 1 && ownedKeys.has(key[0]))
        globals.push(original.slice(node.range[0], node.range[1]))
    }
  }
  const result = [...globals, removeManaged(current)].join(
    current.includes('\r\n') ? '\r\n' : '\n',
  )
  parse(result)
  return result
}
export function redactConfig(text: string) {
  const edits: Array<{ start: number; end: number }> = []
  const visit = (nodes: Array<AST.TOMLKeyValue | AST.TOMLTable>) => {
    for (const node of nodes) {
      if (node.type === 'TOMLTable') visit(node.body)
      else if (
        parts(node.key).some((key) =>
          /token|secret|password|api.?key|authorization|env_http_headers|http_headers/iu.test(
            key,
          ),
        )
      ) {
        edits.push({ start: node.value.range[0], end: node.value.range[1] })
      }
    }
  }
  visit(parse(text).body[0].body)
  for (const edit of edits.sort((left, right) => right.start - left.start))
    text = text.slice(0, edit.start) + '"[redacted]"' + text.slice(edit.end)
  return text
}
