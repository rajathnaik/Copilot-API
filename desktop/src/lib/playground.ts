// Pure helpers for the desktop Playground tab: pick the client-facing API a
// model supports, build request bodies for each protocol, parse streamed and
// non-streamed responses, and render equivalent code snippets.

export type PlaygroundApi = 'chat' | 'messages' | 'responses'

export const PLAYGROUND_APIS: readonly PlaygroundApi[] = [
  'messages',
  'chat',
  'responses',
]

export const PLAYGROUND_API_PATHS: Record<PlaygroundApi, string> = {
  chat: '/v1/chat/completions',
  messages: '/v1/messages',
  responses: '/v1/responses',
}

export const PLAYGROUND_API_LABELS: Record<PlaygroundApi, string> = {
  chat: 'OpenAI Chat Completions',
  messages: 'Anthropic Messages',
  responses: 'OpenAI Responses',
}

export const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024
const DEFAULT_IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]
const PDF_MEDIA_TYPE = 'application/pdf'

export interface PlaygroundModel {
  id: string
  supported_endpoints?: unknown
  capabilities?: {
    supports?: { vision?: boolean }
    limits?: {
      vision?: {
        max_prompt_image_size?: number
        max_prompt_images?: number
        supported_media_types?: string[]
      }
    }
  }
  [key: string]: unknown
}

export interface PlaygroundAttachment {
  name: string
  mediaType: string
  // Base64 payload without the data: URL prefix.
  data: string
  size: number
}

export interface PlaygroundMessage {
  role: 'user' | 'assistant'
  text: string
  attachments?: PlaygroundAttachment[]
}

export interface PlaygroundRequestOptions {
  model: string
  system?: string
  messages: PlaygroundMessage[]
  maxTokens?: number
  stream: boolean
}

export interface PlaygroundRequest {
  path: string
  body: Record<string, unknown>
}

export interface PlaygroundUsage {
  inputTokens?: number
  outputTokens?: number
}

export interface PlaygroundResult {
  text: string
  usage?: PlaygroundUsage
  error?: string
}

export interface AttachmentLimits {
  enabled: boolean
  maxCount: number
  maxBytes: number
  mediaTypes: string[]
}

function endpointToApi(endpoint: string): PlaygroundApi | undefined {
  const normalized = endpoint.replace(/^ws:/, '')
  if (
    normalized === '/chat/completions'
    || normalized === '/v1/chat/completions'
  ) {
    return 'chat'
  }
  if (normalized === '/v1/messages' || normalized === '/messages') {
    return 'messages'
  }
  if (normalized === '/responses' || normalized === '/v1/responses') {
    return 'responses'
  }
  return undefined
}

// Copilot models advertise supported_endpoints; provider models usually do
// not, and the gateway can translate for them, so all APIs are offered.
export function getSupportedApis(model: PlaygroundModel): PlaygroundApi[] {
  if (!Array.isArray(model.supported_endpoints)) {
    return /embedding/i.test(model.id) ? [] : [...PLAYGROUND_APIS]
  }
  const apis = new Set<PlaygroundApi>()
  for (const endpoint of model.supported_endpoints) {
    if (typeof endpoint !== 'string') continue
    const api = endpointToApi(endpoint)
    if (api) apis.add(api)
  }
  return PLAYGROUND_APIS.filter((api) => apis.has(api))
}

export function isChatModel(model: PlaygroundModel): boolean {
  return getSupportedApis(model).length > 0
}

export function pickDefaultApi(
  apis: readonly PlaygroundApi[],
): PlaygroundApi | undefined {
  return PLAYGROUND_APIS.find((api) => apis.includes(api))
}

export function getAttachmentLimits(
  model: PlaygroundModel | undefined,
  api: PlaygroundApi,
): AttachmentLimits {
  const vision = model?.capabilities?.limits?.vision
  const supportsVision = model?.capabilities?.supports?.vision
  const declaredTypes = vision?.supported_media_types
  let mediaTypes =
    Array.isArray(declaredTypes) && declaredTypes.length > 0 ?
      [...declaredTypes]
    : [...DEFAULT_IMAGE_MEDIA_TYPES, PDF_MEDIA_TYPE]
  // Chat Completions has no file/document content part.
  if (api === 'chat') {
    mediaTypes = mediaTypes.filter((type) => type !== PDF_MEDIA_TYPE)
  }
  const enabled = supportsVision !== false && mediaTypes.length > 0
  return {
    enabled,
    maxCount: vision?.max_prompt_images ?? 5,
    maxBytes: vision?.max_prompt_image_size ?? DEFAULT_MAX_ATTACHMENT_BYTES,
    mediaTypes: enabled ? mediaTypes : [],
  }
}

export function validateAttachments(
  attachments: readonly PlaygroundAttachment[],
  limits: AttachmentLimits,
): string | undefined {
  if (attachments.length === 0) return undefined
  if (!limits.enabled) return 'This model does not accept attachments.'
  if (attachments.length > limits.maxCount) {
    return `This model accepts at most ${limits.maxCount} attachment(s) per request.`
  }
  for (const attachment of attachments) {
    if (!limits.mediaTypes.includes(attachment.mediaType)) {
      return `${attachment.name}: ${attachment.mediaType || 'unknown type'} is not supported by this model/API.`
    }
    if (attachment.size > limits.maxBytes) {
      return `${attachment.name} is larger than ${formatBytes(limits.maxBytes)}.`
    }
  }
  return undefined
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function isPdf(attachment: PlaygroundAttachment): boolean {
  return attachment.mediaType === PDF_MEDIA_TYPE
}

function dataUrl(attachment: PlaygroundAttachment): string {
  return `data:${attachment.mediaType};base64,${attachment.data}`
}

function buildChatBody(
  options: PlaygroundRequestOptions,
): Record<string, unknown> {
  const messages: unknown[] = []
  if (options.system?.trim()) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    const attachments = message.attachments ?? []
    if (message.role === 'assistant' || attachments.length === 0) {
      messages.push({ role: message.role, content: message.text })
      continue
    }
    messages.push({
      role: message.role,
      content: [
        ...attachments
          .filter((attachment) => !isPdf(attachment))
          .map((attachment) => ({
            type: 'image_url',
            image_url: { url: dataUrl(attachment) },
          })),
        ...(message.text ? [{ type: 'text', text: message.text }] : []),
      ],
    })
  }
  return {
    model: options.model,
    messages,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: options.stream,
  }
}

function buildMessagesBody(
  options: PlaygroundRequestOptions,
): Record<string, unknown> {
  const messages = options.messages.map((message) => {
    const attachments = message.attachments ?? []
    if (message.role === 'assistant' || attachments.length === 0) {
      return { role: message.role, content: message.text }
    }
    return {
      role: message.role,
      content: [
        ...attachments.map((attachment) =>
          isPdf(attachment) ?
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: attachment.mediaType,
                data: attachment.data,
              },
              title: attachment.name,
            }
          : {
              type: 'image',
              source: {
                type: 'base64',
                media_type: attachment.mediaType,
                data: attachment.data,
              },
            },
        ),
        ...(message.text ? [{ type: 'text', text: message.text }] : []),
      ],
    }
  })
  return {
    model: options.model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(options.system?.trim() ? { system: options.system } : {}),
    messages,
    stream: options.stream,
  }
}

function buildResponsesBody(
  options: PlaygroundRequestOptions,
): Record<string, unknown> {
  const input = options.messages.map((message) => {
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: [{ type: 'output_text', text: message.text }],
      }
    }
    return {
      role: 'user',
      content: [
        ...(message.attachments ?? []).map((attachment) =>
          isPdf(attachment) ?
            {
              type: 'input_file',
              filename: attachment.name,
              file_data: dataUrl(attachment),
            }
          : { type: 'input_image', image_url: dataUrl(attachment) },
        ),
        ...(message.text ? [{ type: 'input_text', text: message.text }] : []),
      ],
    }
  })
  return {
    model: options.model,
    ...(options.system?.trim() ? { instructions: options.system } : {}),
    input,
    max_output_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: options.stream,
  }
}

export function buildPlaygroundRequest(
  api: PlaygroundApi,
  options: PlaygroundRequestOptions,
): PlaygroundRequest {
  const body =
    api === 'chat' ? buildChatBody(options)
    : api === 'messages' ? buildMessagesBody(options)
    : buildResponsesBody(options)
  return { path: PLAYGROUND_API_PATHS[api], body }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeUsage(value: unknown): PlaygroundUsage | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  const inputTokens =
    asNumber(usage.input_tokens) ?? asNumber(usage.prompt_tokens)
  const outputTokens =
    asNumber(usage.output_tokens) ?? asNumber(usage.completion_tokens)
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return { inputTokens, outputTokens }
}

export function extractErrorMessage(payload: unknown): string | undefined {
  const record = asRecord(payload)
  if (!record) return typeof payload === 'string' ? payload : undefined
  const error = record.error
  if (typeof error === 'string') return error
  const errorRecord = asRecord(error)
  const message = errorRecord?.message
  if (typeof message !== 'string') return undefined
  // The gateway sometimes wraps the upstream JSON error inside message.
  try {
    return extractErrorMessage(JSON.parse(message)) ?? message.trim()
  } catch {
    return message.trim()
  }
}

export function parseErrorBody(text: string, status?: number): string {
  try {
    const message = extractErrorMessage(JSON.parse(text))
    if (message) return message
  } catch {
    // Not JSON; fall through to the raw text.
  }
  const trimmed = text.trim()
  if (trimmed) return trimmed.slice(0, 500)
  return status ? `Request failed with HTTP ${status}` : 'Request failed'
}

export function parsePlaygroundResponse(
  api: PlaygroundApi,
  payload: unknown,
): PlaygroundResult {
  const record = asRecord(payload)
  const error = extractErrorMessage(payload)
  if (!record || (record.error && error)) {
    return { text: '', error: error ?? 'Unexpected response' }
  }

  if (api === 'chat') {
    const choices = Array.isArray(record.choices) ? record.choices : []
    const message = asRecord(asRecord(choices[0])?.message)
    const content = message?.content
    return {
      text: typeof content === 'string' ? content : '',
      usage: normalizeUsage(record.usage),
    }
  }

  if (api === 'messages') {
    const content: unknown[] =
      Array.isArray(record.content) ? record.content : []
    const text = content
      .map((block) => asRecord(block))
      .filter((block) => block?.type === 'text')
      .map((block) => asString(block?.text))
      .join('')
    return { text, usage: normalizeUsage(record.usage) }
  }

  const output: unknown[] = Array.isArray(record.output) ? record.output : []
  const text = output
    .map((item) => asRecord(item))
    .filter((item) => item?.type === 'message')
    .flatMap((item): unknown[] =>
      Array.isArray(item?.content) ? item.content : [],
    )
    .map((part) => asRecord(part))
    .filter((part) => part?.type === 'output_text')
    .map((part) => asString(part?.text))
    .join('')
  return { text, usage: normalizeUsage(record.usage) }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export interface StreamUpdate {
  textDelta: string
  usage?: PlaygroundUsage
  error?: string
}

// Incremental SSE parser. Chunks may split events and lines arbitrarily.
export function createStreamParser(api: PlaygroundApi) {
  let buffer = ''
  let usage: PlaygroundUsage | undefined
  let streamError: string | undefined

  const mergeUsage = (next: PlaygroundUsage | undefined) => {
    if (!next) return
    usage = {
      inputTokens: next.inputTokens ?? usage?.inputTokens,
      outputTokens: next.outputTokens ?? usage?.outputTokens,
    }
  }

  const handleData = (data: string): { text: string; error?: string } => {
    if (!data || data === '[DONE]') return { text: '' }
    let event: Record<string, unknown> | undefined
    try {
      event = asRecord(JSON.parse(data))
    } catch {
      return { text: '' }
    }
    if (!event) return { text: '' }

    if (event.type === 'error' || (event.error && !event.type)) {
      return { text: '', error: extractErrorMessage(event) ?? 'Stream error' }
    }

    if (api === 'chat') {
      mergeUsage(normalizeUsage(event.usage))
      const choices = Array.isArray(event.choices) ? event.choices : []
      const delta = asRecord(asRecord(choices[0])?.delta)
      return { text: typeof delta?.content === 'string' ? delta.content : '' }
    }

    if (api === 'messages') {
      if (event.type === 'message_start') {
        mergeUsage(normalizeUsage(asRecord(event.message)?.usage))
      } else if (event.type === 'message_delta') {
        mergeUsage(normalizeUsage(event.usage))
      } else if (event.type === 'content_block_delta') {
        const delta = asRecord(event.delta)
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          return { text: delta.text }
        }
      }
      return { text: '' }
    }

    if (event.type === 'response.output_text.delta') {
      return { text: typeof event.delta === 'string' ? event.delta : '' }
    }
    if (
      event.type === 'response.completed'
      || event.type === 'response.incomplete'
    ) {
      mergeUsage(normalizeUsage(asRecord(event.response)?.usage))
    }
    if (event.type === 'response.failed') {
      const response = asRecord(event.response)
      return {
        text: '',
        error: extractErrorMessage(response) ?? 'Response failed',
      }
    }
    return { text: '' }
  }

  const drain = (flush: boolean): StreamUpdate => {
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = flush ? '' : (events.pop() ?? '')
    let textDelta = ''
    for (const rawEvent of events) {
      const data = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      const result = handleData(data)
      textDelta += result.text
      streamError ??= result.error
    }
    return { textDelta, usage, error: streamError }
  }

  return {
    push(chunk: string): StreamUpdate {
      buffer += chunk
      return drain(false)
    },
    finish(): StreamUpdate {
      return drain(true)
    },
  }
}

const SNIPPET_DATA_PLACEHOLDER = '<BASE64_DATA>'

// Replace base64 payloads so snippets stay readable.
export function redactAttachmentData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAttachmentData)
  const record = asRecord(value)
  if (!record) {
    if (
      typeof value === 'string'
      && value.startsWith('data:')
      && value.includes(';base64,')
    ) {
      return `${value.slice(0, value.indexOf(';base64,') + 8)}${SNIPPET_DATA_PLACEHOLDER}`
    }
    return value
  }
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    result[key] =
      key === 'data' && record.type === 'base64' && typeof entry === 'string' ?
        SNIPPET_DATA_PLACEHOLDER
      : redactAttachmentData(entry)
  }
  return result
}

// Snippets never embed the real gateway key; users paste their own.
export const SNIPPET_API_KEY_PLACEHOLDER = '<YOUR_GATEWAY_API_KEY>'

export interface SnippetAuth {
  headerName: string
}

function snippetAuthHeader(auth: SnippetAuth): string {
  return auth.headerName.toLowerCase() === 'authorization' ?
      `Authorization: Bearer ${SNIPPET_API_KEY_PLACEHOLDER}`
    : `${auth.headerName}: ${SNIPPET_API_KEY_PLACEHOLDER}`
}

export function buildCurlSnippet(
  baseUrl: string,
  request: PlaygroundRequest,
  auth?: SnippetAuth,
): string {
  const body = JSON.stringify(redactAttachmentData(request.body), null, 2)
  const lines = [
    `curl ${baseUrl}${request.path} \\`,
    `  -H "content-type: application/json" \\`,
  ]
  if (auth) lines.push(`  -H "${snippetAuthHeader(auth)}" \\`)
  lines.push(`  -d '${body.replace(/'/g, "'\\''")}'`)
  return lines.join('\n')
}

function pythonLiteral(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent)
  const inner = ' '.repeat(indent + 4)
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map((item) => `${inner}${pythonLiteral(item, indent + 4)}`).join(',\n')},\n${pad}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return '{}'
  return `{\n${entries
    .map(
      ([key, entry]) =>
        `${inner}${JSON.stringify(key)}: ${pythonLiteral(entry, indent + 4)}`,
    )
    .join(',\n')},\n${pad}}`
}

export function buildPythonSnippet(
  api: PlaygroundApi,
  baseUrl: string,
  request: PlaygroundRequest,
  auth?: SnippetAuth,
): string {
  const {
    stream: _stream,
    model,
    ...rest
  } = redactAttachmentData(request.body) as Record<string, unknown>
  const apiKey = auth ? SNIPPET_API_KEY_PLACEHOLDER : 'dummy'
  const args = Object.entries({ model, ...rest })
    .map(([key, value]) => `    ${key}=${pythonLiteral(value, 4)},`)
    .join('\n')

  if (api === 'messages') {
    return [
      '# pip install anthropic',
      'import anthropic',
      '',
      `client = anthropic.Anthropic(base_url="${baseUrl}", api_key="${apiKey}")`,
      '',
      'message = client.messages.create(',
      args,
      ')',
      'print(message.content[0].text)',
    ].join('\n')
  }

  const call =
    api === 'chat' ?
      'client.chat.completions.create'
    : 'client.responses.create'
  const output =
    api === 'chat' ?
      'print(result.choices[0].message.content)'
    : 'print(result.output_text)'
  return [
    '# pip install openai',
    'from openai import OpenAI',
    '',
    `client = OpenAI(base_url="${baseUrl}/v1", api_key="${apiKey}")`,
    '',
    `result = ${call}(`,
    args,
    ')',
    output,
  ].join('\n')
}
