import type {
  AvailableModel,
  Protocol,
  ReasoningEffort,
} from '@modelbridge/runtime/contracts'
import { protocolPaths } from './apps'

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

export interface ChatOptions {
  model: string
  system?: string
  turns: Turn[]
  maxTokens: number
  effort?: ReasoningEffort
  stream: boolean
}

export interface ChatRequest {
  path: (typeof protocolPaths)[Protocol]
  body: Record<string, unknown>
}

export interface Usage {
  inputTokens?: number
  outputTokens?: number
}

export interface ParsedReply {
  text: string
  reasoning: string
  usage?: Usage
  error?: string
}

export const probePrompt = 'Reply with the single word OK.'

// Claude-style thinking budgets for each effort.
const thinkingBudgets: Partial<Record<ReasoningEffort, number>> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32000,
}

export function buildRequest(
  protocol: Protocol,
  options: ChatOptions,
): ChatRequest {
  const system = options.system?.trim()
  const turns = options.turns.map((turn) => ({
    role: turn.role,
    content: turn.text,
  }))
  const effort = options.effort === 'none' ? undefined : options.effort
  if (protocol === 'chat-completions')
    return {
      path: protocolPaths[protocol],
      body: {
        model: options.model,
        messages:
          system ? [{ role: 'system', content: system }, ...turns] : turns,
        max_tokens: options.maxTokens,
        ...(options.effort && { reasoning_effort: options.effort }),
        stream: options.stream,
        ...(options.stream && { stream_options: { include_usage: true } }),
      },
    }
  if (protocol === 'messages') {
    const budget = effort && thinkingBudgets[effort]
    return {
      path: protocolPaths[protocol],
      body: {
        model: options.model,
        ...(system && { system }),
        messages: turns,
        max_tokens:
          budget ?
            Math.max(options.maxTokens, budget + 1024)
          : options.maxTokens,
        ...(budget && { thinking: { type: 'enabled', budget_tokens: budget } }),
        stream: options.stream,
      },
    }
  }
  return {
    path: protocolPaths[protocol],
    body: {
      model: options.model,
      ...(system && { instructions: system }),
      input: options.turns.map((turn) => ({
        type: 'message',
        role: turn.role,
        content: [
          {
            type: turn.role === 'user' ? 'input_text' : 'output_text',
            text: turn.text,
          },
        ],
      })),
      max_output_tokens: options.maxTokens,
      ...(options.effort && {
        reasoning: { effort: options.effort, summary: 'auto' },
      }),
      store: false,
      stream: options.stream,
    },
  }
}

// The cheapest request that proves a model answers on a protocol. Reasoning
// models get their lowest effort and room to think before answering.
export function probeRequest(
  protocol: Protocol,
  model: Pick<AvailableModel, 'id' | 'reasoningEfforts'>,
): ChatRequest {
  const effort = model.reasoningEfforts?.[0]
  return buildRequest(protocol, {
    model: model.id,
    turns: [{ role: 'user', text: probePrompt }],
    maxTokens: effort ? 1024 : 32,
    ...(effort && protocol !== 'messages' && { effort }),
    stream: true,
  })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function usageOf(value: unknown): Usage | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const inputTokens = count(usage.input_tokens) ?? count(usage.prompt_tokens)
  const outputTokens =
    count(usage.output_tokens) ?? count(usage.completion_tokens)
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return { inputTokens, outputTokens }
}

export function errorMessage(payload: unknown): string | undefined {
  const value = record(payload)
  if (!value) return typeof payload === 'string' ? payload : undefined
  if (typeof value.error === 'string') return value.error
  const message = record(value.error)?.message
  return typeof message === 'string' ? message.trim() : undefined
}

export function parseErrorBody(body: string, status: number): string {
  try {
    const message = errorMessage(JSON.parse(body))
    if (message) return message
  } catch {
    // Not JSON; the raw text is shown instead.
  }
  return body.trim().slice(0, 500) || `Request failed with HTTP ${status}.`
}

// Reads a complete (non-streamed) reply.
export function parseReply(protocol: Protocol, payload: unknown): ParsedReply {
  const value = record(payload)
  const error = errorMessage(payload)
  if (!value || (value.error && error))
    return { text: '', reasoning: '', error: error ?? 'Unexpected response.' }
  const usage = usageOf(value.usage)
  if (protocol === 'chat-completions') {
    const choices = Array.isArray(value.choices) ? value.choices : []
    const message = record(record(choices[0])?.message)
    return {
      text: text(message?.content),
      reasoning: text(message?.reasoning_content),
      usage,
    }
  }
  if (protocol === 'messages') {
    const blocks = (Array.isArray(value.content) ? value.content : []).map(
      record,
    )
    return {
      text: blocks
        .filter((block) => block?.type === 'text')
        .map((block) => text(block?.text))
        .join(''),
      reasoning: blocks
        .filter((block) => block?.type === 'thinking')
        .map((block) => text(block?.thinking))
        .join(''),
      usage,
    }
  }
  const output = (Array.isArray(value.output) ? value.output : []).map(record)
  const parts = (type: string, part: string) =>
    output
      .filter((item) => item?.type === type)
      .flatMap((item): unknown[] => {
        const content = item?.[type === 'message' ? 'content' : 'summary']
        return Array.isArray(content) ? content : []
      })
      .map(record)
      .filter((item) => item?.type === part)
      .map((item) => text(item?.text))
      .join('')
  return {
    text: parts('message', 'output_text'),
    reasoning: parts('reasoning', 'summary_text'),
    usage,
  }
}

// Incremental SSE reader; chunks may split events and lines anywhere.
export function createStreamParser(protocol: Protocol) {
  let buffer = ''
  const reply: ParsedReply = { text: '', reasoning: '' }
  const merge = (next: Usage | undefined) => {
    if (!next) return
    reply.usage = {
      inputTokens: next.inputTokens ?? reply.usage?.inputTokens,
      outputTokens: next.outputTokens ?? reply.usage?.outputTokens,
    }
  }
  const handle = (data: string) => {
    if (!data || data === '[DONE]') return
    let event: Record<string, unknown> | undefined
    try {
      event = record(JSON.parse(data))
    } catch {
      return
    }
    if (!event) return
    if (event.type === 'error' || (event.error && !event.type)) {
      reply.error ??= errorMessage(event) ?? 'The stream reported an error.'
      return
    }
    if (protocol === 'chat-completions') {
      merge(usageOf(event.usage))
      const choices = Array.isArray(event.choices) ? event.choices : []
      const delta = record(record(choices[0])?.delta)
      reply.text += text(delta?.content)
      reply.reasoning += text(delta?.reasoning_content)
      return
    }
    if (protocol === 'messages') {
      if (event.type === 'message_start')
        merge(usageOf(record(event.message)?.usage))
      else if (event.type === 'message_delta') merge(usageOf(event.usage))
      else if (event.type === 'content_block_delta') {
        const delta = record(event.delta)
        if (delta?.type === 'text_delta') reply.text += text(delta.text)
        if (delta?.type === 'thinking_delta')
          reply.reasoning += text(delta.thinking)
      }
      return
    }
    if (event.type === 'response.output_text.delta')
      reply.text += text(event.delta)
    else if (event.type === 'response.reasoning_summary_text.delta')
      reply.reasoning += text(event.delta)
    else if (
      event.type === 'response.completed'
      || event.type === 'response.incomplete'
    )
      merge(usageOf(record(event.response)?.usage))
    else if (event.type === 'response.failed')
      reply.error ??=
        errorMessage(record(event.response)) ?? 'The response failed.'
  }
  const drain = (flush: boolean): ParsedReply => {
    const events = buffer.split(/\r?\n\r?\n/u)
    buffer = flush ? '' : (events.pop() ?? '')
    for (const event of events)
      handle(
        event
          .split(/\r?\n/u)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /u, ''))
          .join('\n'),
      )
    return { ...reply }
  }
  return {
    push(chunk: string) {
      buffer += chunk
      return drain(false)
    },
    finish() {
      return drain(true)
    },
  }
}

export const keyPlaceholder = '<YOUR_MODELBRIDGE_KEY>'

// Snippets never contain the real key; the user pastes their own.
export function curlSnippet(
  baseUrl: string,
  protocol: Protocol,
  request: ChatRequest,
): string {
  const body = JSON.stringify(request.body, null, 2)
  return [
    `curl ${baseUrl}${request.path} \\`,
    '  -H "content-type: application/json" \\',
    protocol === 'messages' ?
      `  -H "x-api-key: ${keyPlaceholder}" \\`
    : `  -H "authorization: Bearer ${keyPlaceholder}" \\`,
    `  -d '${body.replace(/'/gu, "'\\''")}'`,
  ].join('\n')
}

function python(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent)
  const inner = ' '.repeat(indent + 4)
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value))
    return value.length ?
        `[\n${value.map((item) => `${inner}${python(item, indent + 4)}`).join(',\n')},\n${pad}]`
      : '[]'
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.length ?
      `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${python(item, indent + 4)}`).join(',\n')},\n${pad}}`
    : '{}'
}

export function pythonSnippet(
  baseUrl: string,
  protocol: Protocol,
  request: ChatRequest,
): string {
  const { stream: _stream, stream_options: _options, ...body } = request.body
  const args = Object.entries(body)
    .map(([key, value]) => `    ${key}=${python(value, 4)},`)
    .join('\n')
  if (protocol === 'messages')
    return [
      '# pip install anthropic',
      'import anthropic',
      '',
      `client = anthropic.Anthropic(base_url="${baseUrl}", api_key="${keyPlaceholder}")`,
      '',
      'message = client.messages.create(',
      args,
      ')',
      'print(next(block.text for block in message.content if block.type == "text"))',
    ].join('\n')
  const chat = protocol === 'chat-completions'
  return [
    '# pip install openai',
    'from openai import OpenAI',
    '',
    `client = OpenAI(base_url="${baseUrl}/v1", api_key="${keyPlaceholder}")`,
    '',
    `result = client.${chat ? 'chat.completions' : 'responses'}.create(`,
    args,
    ')',
    chat ?
      'print(result.choices[0].message.content)'
    : 'print(result.output_text)',
  ].join('\n')
}
