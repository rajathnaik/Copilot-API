import type {
  ConnectorDiscovery,
  ConnectorInput,
  ConnectorModel,
  ConnectorProtocol,
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
  const headers = new Headers(init.headers)
  if (!headers.has('x-api-key'))
    headers.set('Authorization', `Bearer ${apiKey}`)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  if (!headers.has('User-Agent'))
    headers.set('User-Agent', 'Copilot-API-Connector')
  let response: Response
  try {
    response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers,
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

async function readDiscoveredModels(
  baseUrl: string,
  apiKey: string,
  fetcher: ConnectorFetch,
): Promise<Record<string, unknown>[]> {
  const response = await gatewayRequest(fetcher, `${baseUrl}/v1/models`, apiKey)
  const value = parseJson(await readBoundedBody(response, MAX_CATALOG_BYTES))
  if (!isRecord(value) || !Array.isArray(value.data))
    throw new Error('The gateway returned an invalid model discovery response.')
  const models: Record<string, unknown>[] = []
  for (const model of value.data) {
    if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim())
      throw new Error('Model discovery contains invalid model identifiers.')
    models.push(model)
  }
  return models
}

function supportsTools(model: Record<string, unknown>): boolean {
  const capabilities = model.capabilities
  return !(
    isRecord(capabilities)
    && (capabilities.type === 'embeddings'
      || (isRecord(capabilities.supports)
        && capabilities.supports.tool_calls === false))
  )
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
  const discovered = await readDiscoveredModels(baseUrl, apiKey, fetcher)
  const discoveredIds = new Set<string>()
  for (const model of discovered) {
    if (supportsTools(model) && typeof model.id === 'string')
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
    excludedModels: discovered.flatMap((model: unknown) =>
      isRecord(model) && typeof model.id === 'string' && !seen.has(model.id) ?
        [model.id]
      : [],
    ),
  }
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ?
      value
    : undefined
}

export async function discoverStandardGateway(
  input: ConnectorInput,
  protocol: Exclude<ConnectorProtocol, 'responses'>,
  fetcher: ConnectorFetch = fetch,
): Promise<GatewayDiscovery> {
  const baseUrl = normalizeGatewayUrl(input.url)
  const discovered = await readDiscoveredModels(
    baseUrl,
    validateApiKey(input.apiKey),
    fetcher,
  )
  const models: ConnectorModel[] = []
  const seen = new Set<string>()
  const excludedModels: string[] = []
  for (const model of discovered) {
    if (typeof model.id !== 'string') continue
    if (!supportsTools(model)) {
      excludedModels.push(model.id)
      continue
    }
    if (seen.has(model.id)) continue
    seen.add(model.id)
    const capabilities = isRecord(model.capabilities) ? model.capabilities : {}
    const limits = isRecord(capabilities.limits) ? capabilities.limits : {}
    const supports =
      isRecord(capabilities.supports) ? capabilities.supports : {}
    const output =
      positiveNumber(limits.max_output_tokens)
      ?? positiveNumber(model.max_output_tokens)
    models.push({
      id: model.id,
      name:
        typeof model.display_name === 'string' ? model.display_name
        : typeof model.name === 'string' ? model.name
        : model.id,
      description:
        typeof model.description === 'string' ? model.description : '',
      contextWindow:
        positiveNumber(limits.max_context_window_tokens)
        ?? positiveNumber(model.context_window)
        ?? 0,
      ...(output === undefined ? {} : { maxOutputTokens: output }),
      ...(typeof supports.vision === 'boolean' ?
        { vision: supports.vision }
      : {}),
      ...(typeof supports.reasoning === 'boolean' ?
        {
          reasoning: supports.reasoning,
        }
      : {}),
    })
  }
  if (!models.length)
    throw new Error(
      'No discovered chat models advertise compatible tool support.',
    )
  const preferred =
    protocol === 'anthropic-messages' ?
      (models.find((model) => /claude.*sonnet/iu.test(model.id))
      ?? models.find((model) => /claude/iu.test(model.id)))
    : models.find((model) => /(?:^|\/)gpt-/u.test(model.id))
  return {
    baseUrl,
    models,
    defaultModel: preferred?.id ?? models[0].id,
    catalogMode: 'configured',
    catalog: JSON.stringify({ models }),
    excludedModels,
  }
}

function streamFrames(stream: string): string[] {
  return stream
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .flatMap((frame) => {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      return data ? [data] : []
    })
}

const PROBE_PROMPT =
  'Call connector_probe with ok set to true. This is a connection test.'
const PROBE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
}

function validProbeArguments(text: string): boolean {
  const value = parseJson(text)
  return isRecord(value) && value.ok === true && Object.keys(value).length === 1
}

function validTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function verifyMessagesStream(frames: string[]): boolean {
  const tools = new Map<
    number,
    {
      name: string
      input: Record<string, unknown>
      arguments: string
      closed: boolean
    }
  >()
  let stopped = false
  let toolStop = false
  let started = false
  for (const data of frames) {
    if (data === '[DONE]') continue
    const event = parseJson(data)
    if (!isRecord(event)) continue
    if (event.type === 'error')
      throw new Error('The Anthropic Messages stream reported an error.')
    if (event.type === 'message_start') {
      if (
        started
        || !isRecord(event.message)
        || event.message.type !== 'message'
        || event.message.role !== 'assistant'
        || typeof event.message.id !== 'string'
        || !event.message.id
        || !Array.isArray(event.message.content)
        || typeof event.message.model !== 'string'
        || !event.message.model
        || !isRecord(event.message.usage)
        || !validTokenCount(event.message.usage.input_tokens)
        || !validTokenCount(event.message.usage.output_tokens)
      )
        throw new Error('The Messages stream has an invalid message start.')
      started = true
    }
    if (
      event.type === 'content_block_start'
      && typeof event.index === 'number'
      && isRecord(event.content_block)
      && event.content_block.type === 'tool_use'
      && typeof event.content_block.id === 'string'
      && event.content_block.id.length > 0
      && typeof event.content_block.name === 'string'
      && isRecord(event.content_block.input)
    ) {
      if (!started)
        throw new Error(
          'The Messages stream started a tool before its message.',
        )
      if (tools.has(event.index))
        throw new Error('The Messages stream repeated a tool block.')
      tools.set(event.index, {
        name: event.content_block.name,
        input: event.content_block.input,
        arguments: '',
        closed: false,
      })
    }
    if (
      event.type === 'content_block_delta'
      && typeof event.index === 'number'
      && isRecord(event.delta)
      && event.delta.type === 'input_json_delta'
      && typeof event.delta.partial_json === 'string'
    ) {
      const tool = tools.get(event.index)
      if (!tool || tool.closed)
        throw new Error('The Messages stream has an out-of-order tool delta.')
      tool.arguments += event.delta.partial_json
    }
    if (
      event.type === 'content_block_stop'
      && typeof event.index === 'number'
    ) {
      const tool = tools.get(event.index)
      if (tool) tool.closed = true
    }
    if (event.type === 'message_delta' && isRecord(event.delta)) {
      if (!isRecord(event.usage) || !validTokenCount(event.usage.output_tokens))
        throw new Error('The Messages stream has invalid output-token usage.')
      toolStop = event.delta.stop_reason === 'tool_use'
    }
    if (event.type === 'message_stop') stopped = true
  }
  return (
    started
    && stopped
    && toolStop
    && [...tools.values()].some(
      (tool) =>
        tool.closed
        && tool.name === 'connector_probe'
        && validProbeArguments(tool.arguments || JSON.stringify(tool.input)),
    )
  )
}

function verifyChatStream(frames: string[]): boolean {
  const tools = new Map<
    number,
    { id: string; type: string; name: string; arguments: string }
  >()
  let done = false
  let toolStop = false
  for (const data of frames) {
    if (data === '[DONE]') {
      done = true
      continue
    }
    const chunk = parseJson(data)
    if (!isRecord(chunk)) continue
    if (chunk.error !== undefined)
      throw new Error('The Chat Completions stream reported an error.')
    if (!Array.isArray(chunk.choices)) continue
    for (const choice of chunk.choices) {
      if (!isRecord(choice) || choice.index !== 0) continue
      if (choice.finish_reason === 'tool_calls') toolStop = true
      if (!isRecord(choice.delta) || !Array.isArray(choice.delta.tool_calls))
        continue
      for (const call of choice.delta.tool_calls) {
        if (
          !isRecord(call)
          || typeof call.index !== 'number'
          || !isRecord(call.function)
        )
          continue
        const tool = tools.get(call.index) ?? {
          id: '',
          type: '',
          name: '',
          arguments: '',
        }
        if (typeof call.id === 'string') tool.id += call.id
        if (typeof call.type === 'string') tool.type = call.type
        if (typeof call.function.name === 'string')
          tool.name += call.function.name
        if (typeof call.function.arguments === 'string')
          tool.arguments += call.function.arguments
        tools.set(call.index, tool)
      }
    }
  }
  return (
    done
    && toolStop
    && [...tools.values()].some(
      (tool) =>
        tool.id.length > 0
        && tool.type === 'function'
        && tool.name === 'connector_probe'
        && validProbeArguments(tool.arguments),
    )
  )
}

export async function verifyStandardStreamingTools(
  discovery: GatewayDiscovery,
  protocol: Exclude<ConnectorProtocol, 'responses'>,
  model: string,
  apiKey: string,
  fetcher: ConnectorFetch = fetch,
): Promise<void> {
  const messages = protocol === 'anthropic-messages'
  const response = await gatewayRequest(
    fetcher,
    `${discovery.baseUrl}/v1/${messages ? 'messages' : 'chat/completions'}`,
    apiKey,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(messages ?
          {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          }
        : {}),
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        ...(messages ?
          {
            max_tokens: 4096,
            tools: [
              {
                name: 'connector_probe',
                description: 'Connection test only. No code is executed.',
                input_schema: PROBE_SCHEMA,
              },
            ],
            tool_choice: { type: 'tool', name: 'connector_probe' },
          }
        : {
            max_completion_tokens: 4096,
            tools: [
              {
                type: 'function',
                function: {
                  name: 'connector_probe',
                  description: 'Connection test only. No code is executed.',
                  parameters: PROBE_SCHEMA,
                  strict: true,
                },
              },
            ],
            tool_choice: {
              type: 'function',
              function: { name: 'connector_probe' },
            },
          }),
      }),
    },
  )
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel()
    throw new Error(`The gateway did not return a ${protocol} event stream.`)
  }
  const frames = streamFrames(
    await readBoundedBody(response, REMOTE_CATALOG_BYTES),
  )
  if (!(messages ? verifyMessagesStream(frames) : verifyChatStream(frames)))
    throw new Error(
      `The gateway did not complete the expected ${protocol} streaming tool call. This model was not installed.`,
    )
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
