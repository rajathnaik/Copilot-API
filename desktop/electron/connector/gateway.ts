import type {
  ConnectorDiscovery,
  ConnectorInput,
  ConnectorModel,
} from '../../src/types/connector'

const MAX_CATALOG_BYTES = 32 * 1024 * 1024
const REMOTE_CATALOG_BYTES = 1024 * 1024
const TIMEOUT_MS = 120_000
export type ConnectorFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>

interface CatalogModel extends Record<string, unknown> {
  slug: string
  display_name: string
  context_window: number
  model_messages: { instructions_template: string }
}

export interface GatewayDiscovery extends ConnectorDiscovery {
  catalog: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeGatewayUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Enter a valid HTTPS gateway URL.')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(
      'The gateway must use HTTPS. HTTP is allowed only on loopback.',
    )
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'The gateway URL must not contain credentials, a query, or a fragment.',
    )
  }
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  if (pathname !== '') {
    throw new Error('Enter the gateway root URL, optionally ending in /v1.')
  }
  return url.origin
}

export function validateApiKey(value: string): string {
  const key = value.trim()
  if (
    !key
    || /\s/u.test(key)
    || [...key].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  ) {
    throw new Error('Enter a non-empty gateway API key without whitespace.')
  }
  return key
}

async function readBoundedBody(
  response: Response,
  limit: number,
): Promise<string> {
  if (!response.body) throw new Error('The gateway returned an empty response.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit)
        throw new Error(
          'The gateway response exceeds the supported size limit.',
        )
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel()
  }
}

async function gatewayRequest(
  fetcher: ConnectorFetch,
  url: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response
  try {
    response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': 'Copilot-API-Connector',
        ...init.headers,
      },
    })
  } catch {
    throw new Error(
      'Gateway connection failed. Check the URL, tunnel access, host availability, and network.',
    )
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel()
    throw new Error(
      'Gateway authentication failed. Check the API key and whether the tunnel requires a separate sign-in.',
    )
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      `The gateway returned HTTP ${response.status}. Check gateway availability and model access.`,
    )
  }
  return response
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(
      'The gateway did not return valid JSON. The URL may point to a tunnel login page.',
    )
  }
}

function isCatalogModel(value: unknown): value is CatalogModel {
  return (
    isRecord(value)
    && typeof value.slug === 'string'
    && value.slug.length > 0
    && typeof value.display_name === 'string'
    && typeof value.context_window === 'number'
    && value.context_window > 0
    && isRecord(value.model_messages)
    && typeof value.model_messages.instructions_template === 'string'
    && Array.isArray(value.supported_reasoning_levels)
    && typeof value.default_reasoning_level === 'string'
  )
}

function getCatalogModels(value: unknown): CatalogModel[] {
  if (
    !isRecord(value)
    || !Array.isArray(value.models)
    || !value.models.every(isCatalogModel)
  ) {
    throw new Error(
      'The gateway returned an invalid Codex model catalog. Update the gateway before connecting.',
    )
  }
  return value.models
}

function supportsClientVersion(model: CatalogModel, version: string): boolean {
  if (model.minimal_client_version === undefined) return true
  if (typeof model.minimal_client_version !== 'string')
    throw new Error('The gateway returned an invalid minimum Codex version.')
  const minimum = model.minimal_client_version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/u,
  )
  if (!minimum)
    throw new Error('The gateway returned an invalid minimum Codex version.')
  const current = version.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const required = Number(minimum[index + 1])
    if (current[index] !== required) return current[index] > required
  }
  return true
}

export async function discoverGateway(
  input: ConnectorInput,
  version: string,
  fetcher: ConnectorFetch = fetch,
): Promise<GatewayDiscovery> {
  const baseUrl = normalizeGatewayUrl(input.url)
  const apiKey = validateApiKey(input.apiKey)
  const response = await gatewayRequest(fetcher, `${baseUrl}/v1/models`, apiKey)
  const modelsValue = parseJson(
    await readBoundedBody(response, MAX_CATALOG_BYTES),
  )
  if (!isRecord(modelsValue) || !Array.isArray(modelsValue.data)) {
    throw new Error('The gateway returned an invalid model discovery response.')
  }
  const discoveredIds = new Set<string>()
  for (const model of modelsValue.data) {
    if (!isRecord(model) || typeof model.id !== 'string') {
      throw new Error('Model discovery contains invalid model identifiers.')
    }
    const capabilities = model.capabilities
    if (
      isRecord(capabilities)
      && (capabilities.type === 'embeddings'
        || (isRecord(capabilities.supports)
          && capabilities.supports.tool_calls === false))
    )
      continue
    discoveredIds.add(model.id)
  }
  const headers = {
    'User-Agent': `codex-cli/${version}`,
    version,
  }
  const catalogUrl = `${baseUrl}/models?client_version=${encodeURIComponent(version)}`
  const fullResponse = await gatewayRequest(fetcher, catalogUrl, apiKey, {
    headers: { ...headers, 'x-full-model-catalog': 'true' },
  })
  const fullValue = parseJson(
    await readBoundedBody(fullResponse, MAX_CATALOG_BYTES),
  )
  const eligible = getCatalogModels(fullValue).filter(
    (model) =>
      discoveredIds.has(model.slug)
      && model.supported_in_api !== false
      && supportsClientVersion(model, version),
  )
  const seen = new Set<string>()
  const catalogModels = eligible.filter((model) => {
    if (seen.has(model.slug)) return false
    seen.add(model.slug)
    return true
  })
  if (catalogModels.length === 0) {
    throw new Error(
      'No discovered models have compatible Codex metadata and tool support.',
    )
  }
  const models: ConnectorModel[] = catalogModels.map((model) => ({
    id: model.slug,
    name: model.display_name,
    contextWindow: model.context_window,
    description: typeof model.description === 'string' ? model.description : '',
  }))
  const remoteResponse = await gatewayRequest(fetcher, catalogUrl, apiKey, {
    headers,
  })
  const remoteText = await readBoundedBody(remoteResponse, MAX_CATALOG_BYTES)
  const remoteModels = getCatalogModels(parseJson(remoteText))
  const remoteIds = new Set(remoteModels.map((model) => model.slug))
  // A remote catalog must not introduce unadvertised fallback models or omit
  // eligible models due to the gateway's size/exclusion rules.
  const remoteComplete =
    Buffer.byteLength(remoteText, 'utf8') <= REMOTE_CATALOG_BYTES
    && remoteIds.size === seen.size
    && remoteModels.length === remoteIds.size
    && [...seen].every((id) => remoteIds.has(id))
  const defaultModel =
    models.find((model) => /(?:^|\/)gpt-/u.test(model.id))?.id ?? models[0].id
  return {
    baseUrl,
    models,
    defaultModel,
    catalogMode: remoteComplete ? 'remote' : 'local',
    catalog: JSON.stringify({ models: catalogModels }),
    excludedModels: modelsValue.data.flatMap((model: unknown) =>
      isRecord(model) && typeof model.id === 'string' && !seen.has(model.id) ?
        [model.id]
      : [],
    ),
  }
}

export async function verifyStreamingTools(
  discovery: GatewayDiscovery,
  model: string,
  apiKey: string,
  fetcher: ConnectorFetch = fetch,
): Promise<void> {
  const response = await gatewayRequest(
    fetcher,
    `${discovery.baseUrl}/responses`,
    apiKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input:
          'Call connector_probe with ok set to true. This is a connection test.',
        stream: true,
        max_output_tokens: 4096,
        tools: [
          {
            type: 'function',
            name: 'connector_probe',
            description:
              'Verify tool-call transport. This function does not execute any code.',
            strict: true,
            parameters: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        ],
        tool_choice: { type: 'function', name: 'connector_probe' },
      }),
    },
  )
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel()
    throw new Error('The gateway did not return a Responses event stream.')
  }
  const stream = await readBoundedBody(response, REMOTE_CATALOG_BYTES)
  let completed = false
  let toolVerified = false
  for (const frame of stream.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') continue
    const event = parseJson(data)
    if (!isRecord(event)) continue
    if (
      event.type === 'error'
      || event.type === 'response.failed'
      || event.type === 'response.incomplete'
    ) {
      throw new Error(
        'The gateway streaming tool-call test failed. Check model access and gateway logs.',
      )
    }
    if (event.type === 'response.completed' && isRecord(event.response)) {
      completed = event.response.status === 'completed'
      const output = event.response.output
      toolVerified =
        Array.isArray(output)
        && output.some((item: unknown) => {
          if (
            !isRecord(item)
            || item.type !== 'function_call'
            || item.name !== 'connector_probe'
            || typeof item.arguments !== 'string'
          )
            return false
          const args = parseJson(item.arguments)
          return isRecord(args) && args.ok === true
        })
    }
  }
  if (!completed || !toolVerified) {
    throw new Error(
      'The gateway did not complete the expected streaming tool call.',
    )
  }
}
