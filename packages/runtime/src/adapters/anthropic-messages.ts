import { randomUUID } from 'node:crypto'
import type { Model } from '../contracts'
import {
  AdapterError,
  count,
  failureMessage,
  list,
  reasoningSummary,
  record,
  responseEvents,
  responsesUsage,
  text,
  type Json,
} from './json'

// Anthropic Messages requests (Claude Code and similar) are answered by the
// Responses API for models that have no native Messages endpoint.

// Reasoning items travel back to the client inside thinking-block signatures,
// so the next turn can return the encrypted reasoning to the model. Claude
// rejects these signatures, so they are removed before native Messages calls.
const signaturePrefix = 'modelbridge-reasoning-1#'

export function encodeReasoningSignature(
  encrypted: string,
  id: string,
): string {
  return `${signaturePrefix}${encrypted}@${id}`
}

export function isModelBridgeSignature(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(signaturePrefix)
}

function decodeReasoningSignature(
  value: unknown,
): { encrypted: string; id: string } | undefined {
  if (typeof value !== 'string' || !isModelBridgeSignature(value))
    return undefined
  const body = value.slice(signaturePrefix.length)
  const split = body.lastIndexOf('@')
  if (split <= 0) return undefined
  const id = body.slice(split + 1)
  return id ? { encrypted: body.slice(0, split), id } : undefined
}

const placeholderThinking = 'Thinking...'

function systemText(system: unknown): string {
  if (typeof system === 'string') return system
  return (list(system) ?? [])
    .map((block) => text(record(block)?.text) ?? '')
    .filter(Boolean)
    .join('\n\n')
}

function imagePart(block: Json): Json {
  const source = record(block.source)
  if (source?.type === 'base64')
    return {
      type: 'input_image',
      image_url: `data:${text(source.media_type) ?? 'image/png'};base64,${text(source.data) ?? ''}`,
      detail: 'auto',
    }
  if (source?.type === 'url' && text(source.url))
    return { type: 'input_image', image_url: source.url, detail: 'auto' }
  throw new AdapterError('An image block has an unsupported source.')
}

function documentPart(block: Json): Json {
  const source = record(block.source)
  const filename = text(block.title) ?? 'document.pdf'
  if (source?.type === 'base64')
    return {
      type: 'input_file',
      filename,
      file_data: `data:${text(source.media_type) ?? 'application/pdf'};base64,${text(source.data) ?? ''}`,
    }
  if (source?.type === 'text')
    return { type: 'input_text', text: text(source.data) ?? '' }
  if (source?.type === 'url' && text(source.url))
    return { type: 'input_file', file_url: source.url }
  throw new AdapterError('A document block has an unsupported source.')
}

function toolOutput(content: unknown, error: boolean): unknown {
  if (typeof content === 'string') return error ? `Error: ${content}` : content
  const parts = (list(content) ?? []).flatMap((value) => {
    const block = record(value)
    if (block?.type === 'text')
      return [{ type: 'input_text', text: text(block.text) ?? '' }]
    if (block?.type === 'image') return [imagePart(block)]
    return []
  })
  if (parts.every((part) => part.type === 'input_text')) {
    const joined = parts.map((part) => part.text).join('\n')
    return error ? `Error: ${joined}` : joined
  }
  return error ? [{ type: 'input_text', text: 'Error:' }, ...parts] : parts
}

function userItems(content: unknown): Json[] {
  if (typeof content === 'string')
    return [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: content }],
      },
    ]
  const items: Json[] = []
  let parts: Json[] = []
  const flush = () => {
    if (parts.length)
      items.push({ type: 'message', role: 'user', content: parts })
    parts = []
  }
  for (const value of list(content) ?? []) {
    const block = record(value)
    switch (block?.type) {
      case 'text':
        parts.push({ type: 'input_text', text: text(block.text) ?? '' })
        break
      case 'image':
        parts.push(imagePart(block))
        break
      case 'document':
        parts.push(documentPart(block))
        break
      case 'tool_result':
        flush()
        items.push({
          type: 'function_call_output',
          call_id: text(block.tool_use_id) ?? '',
          output: toolOutput(block.content, block.is_error === true),
        })
        break
    }
  }
  flush()
  return items
}

function assistantItems(content: unknown): Json[] {
  if (typeof content === 'string')
    return content ?
        [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: content }],
          },
        ]
      : []
  const items: Json[] = []
  let texts: string[] = []
  const flush = () => {
    const joined = texts.join('')
    if (joined)
      items.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: joined }],
      })
    texts = []
  }
  for (const value of list(content) ?? []) {
    const block = record(value)
    if (block?.type === 'text') texts.push(text(block.text) ?? '')
    else if (block?.type === 'tool_use') {
      flush()
      items.push({
        type: 'function_call',
        call_id: text(block.id) ?? `call_${randomUUID()}`,
        name: text(block.name) ?? '',
        arguments: JSON.stringify(block.input ?? {}),
      })
    } else if (block?.type === 'thinking') {
      const reasoning = decodeReasoningSignature(block.signature)
      if (!reasoning?.encrypted) continue
      flush()
      const summary = text(block.thinking)
      items.push({
        type: 'reasoning',
        id: reasoning.id,
        summary:
          summary && summary !== placeholderThinking ?
            [{ type: 'summary_text', text: summary }]
          : [],
        encrypted_content: reasoning.encrypted,
      })
    }
  }
  flush()
  return items
}

function tools(value: unknown): Json[] {
  return (list(value) ?? []).flatMap((entry) => {
    const tool = record(entry)
    const name = text(tool?.name)
    if (!tool || !name) return []
    if (text(tool.type)?.startsWith('web_search'))
      return [{ type: 'web_search' }]
    if (tool.type !== undefined && tool.type !== 'custom') return []
    return [
      {
        type: 'function',
        name,
        ...(text(tool.description) && { description: tool.description }),
        parameters: record(tool.input_schema) ?? {
          type: 'object',
          properties: {},
        },
        strict: false,
      },
    ]
  })
}

function toolChoice(value: unknown): unknown {
  const choice = record(value)
  switch (choice?.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return text(choice.name) ?
          { type: 'function', name: choice.name }
        : undefined
    default:
      return undefined
  }
}

function effort(body: Json): string | undefined {
  const requested = text(record(body.output_config)?.effort)
  if (requested) return requested
  const thinking = record(body.thinking)
  const budget = count(thinking?.budget_tokens)
  if (thinking?.type !== 'enabled' || budget === undefined) return undefined
  return (
    budget < 4096 ? 'low'
    : budget < 16_384 ? 'medium'
    : 'high'
  )
}

export function messagesToResponsesRequest(body: Json, model: Model): Json {
  const messages = list(body.messages)
  if (!messages?.length)
    throw new AdapterError('Messages requests need at least one message.')
  const input: Json[] = []
  for (const value of messages) {
    const message = record(value)
    if (message?.role === 'user') input.push(...userItems(message.content))
    else if (message?.role === 'assistant')
      input.push(...assistantItems(message.content))
    else throw new AdapterError('Every message needs a user or assistant role.')
  }
  const reasoning = !!model.reasoningEfforts?.length
  const requested = count(body.max_tokens)
  const maximum =
    requested && reasoning ? Math.max(requested, 12_800) : requested
  const requestedEffort = reasoning ? effort(body) : undefined
  const toolList = tools(body.tools)
  const choice = toolChoice(body.tool_choice)
  const instructions = systemText(body.system)
  return {
    model: body.model,
    input,
    ...(instructions && { instructions }),
    ...(toolList.length && { tools: toolList }),
    ...(toolList.length && choice !== undefined && { tool_choice: choice }),
    ...(record(body.tool_choice)?.disable_parallel_tool_use === true && {
      parallel_tool_calls: false,
    }),
    ...(maximum && { max_output_tokens: Math.max(16, Math.floor(maximum)) }),
    ...(reasoning && {
      reasoning: {
        ...(requestedEffort && { effort: requestedEffort }),
        summary: 'auto',
      },
      include: ['reasoning.encrypted_content'],
    }),
    stream: body.stream === true,
    store: false,
  }
}

// Copilot's Claude endpoint rejects ModelBridge reasoning signatures, which
// appear when a conversation moves from a hub-served model to Claude.
export function stripModelBridgeThinking(body: Json): Json {
  const messages = list(body.messages)
  if (!messages) return body
  return {
    ...body,
    messages: messages.map((value) => {
      const message = record(value)
      const content = list(message?.content)
      if (!message || message.role !== 'assistant' || !content) return value
      return {
        ...message,
        content: content.filter((entry) => {
          const block = record(entry)
          return !(
            block?.type === 'thinking'
            && isModelBridgeSignature(block.signature)
          )
        }),
      }
    }),
  }
}

function stopReason(response: Json, tools: boolean): string {
  if (tools) return 'tool_use'
  return (
      text(record(response.incomplete_details)?.reason) === 'max_output_tokens'
    ) ?
      'max_tokens'
    : 'end_turn'
}

function anthropicUsage(value: unknown): Json {
  const usage = responsesUsage(value)
  return {
    input_tokens: Math.max(0, usage.input - usage.cached),
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cached,
    cache_creation_input_tokens: 0,
  }
}

function messageId(response: Json): string {
  return `msg_${text(response.id) ?? randomUUID()}`
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return {}
  try {
    return JSON.parse(value) as unknown
  } catch {
    return {}
  }
}

function thinkingSignature(item: Json): string {
  return encodeReasoningSignature(
    text(item.encrypted_content) ?? '',
    text(item.id) ?? '',
  )
}

export function responsesToMessagesResponse(
  response: Json,
  model: string,
): Json {
  const content: Json[] = []
  let calls = false
  for (const value of list(response.output) ?? []) {
    const item = record(value)
    if (item?.type === 'reasoning') {
      if (!text(item.encrypted_content) && !reasoningSummary(item)) continue
      content.push({
        type: 'thinking',
        thinking: reasoningSummary(item) || placeholderThinking,
        signature: thinkingSignature(item),
      })
    } else if (item?.type === 'message')
      for (const entry of list(item.content) ?? []) {
        const part = record(entry)
        const value =
          part?.type === 'output_text' ? text(part.text)
          : part?.type === 'refusal' ? text(part.refusal)
          : undefined
        if (value) content.push({ type: 'text', text: value })
      }
    else if (item?.type === 'function_call') {
      calls = true
      content.push({
        type: 'tool_use',
        id: text(item.call_id) ?? `toolu_${randomUUID()}`,
        name: text(item.name) ?? '',
        input: parseArguments(item.arguments),
      })
    }
  }
  return {
    id: messageId(response),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason(response, calls),
    stop_sequence: null,
    usage: anthropicUsage(response.usage),
  }
}

type OpenBlock =
  | { kind: 'thinking'; index: number; output: number; wrote: boolean }
  | { kind: 'text'; index: number; output: number }
  | { kind: 'tool'; index: number; output: number; streamed: boolean }

async function* messagesFrames(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<string> {
  const frame = (value: Json) =>
    `event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`
  let started = false
  let next = 0
  let open: OpenBlock | undefined
  let calls = false
  const start = function* (response?: Json) {
    if (started) return
    started = true
    yield frame({
      type: 'message_start',
      message: {
        id: messageId(response ?? {}),
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }
  const close = function* () {
    if (!open) return
    yield frame({ type: 'content_block_stop', index: open.index })
    open = undefined
  }
  const begin = function* (block: OpenBlock, contentBlock: Json) {
    yield* close()
    open = block
    yield frame({
      type: 'content_block_start',
      index: block.index,
      content_block: contentBlock,
    })
  }
  const delta = (index: number, value: Json) =>
    frame({ type: 'content_block_delta', index, delta: value })
  for await (const event of responseEvents(body)) {
    const type = text(event.type)
    const response = record(event.response)
    yield* start(response)
    const output = count(event.output_index) ?? -1
    const item = record(event.item)
    switch (type) {
      case 'response.output_item.added':
        if (item?.type === 'reasoning')
          yield* begin(
            { kind: 'thinking', index: next++, output, wrote: false },
            { type: 'thinking', thinking: '', signature: '' },
          )
        else if (item?.type === 'function_call') {
          calls = true
          yield* begin(
            { kind: 'tool', index: next++, output, streamed: false },
            {
              type: 'tool_use',
              id: text(item.call_id) ?? `toolu_${randomUUID()}`,
              name: text(item.name) ?? '',
              input: {},
            },
          )
        }
        break
      case 'response.reasoning_summary_text.delta': {
        if (open?.kind !== 'thinking' || open.output !== output) break
        const value = text(event.delta)
        if (!value) break
        open.wrote = true
        yield delta(open.index, { type: 'thinking_delta', thinking: value })
        break
      }
      case 'response.reasoning_summary_part.added':
        if (open?.kind === 'thinking' && open.output === output && open.wrote)
          yield delta(open.index, { type: 'thinking_delta', thinking: '\n\n' })
        break
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const value = text(event.delta)
        if (!value) break
        if (open?.kind !== 'text' || open.output !== output)
          yield* begin(
            { kind: 'text', index: next++, output },
            { type: 'text', text: '' },
          )
        if (open) yield delta(open.index, { type: 'text_delta', text: value })
        break
      }
      case 'response.function_call_arguments.delta': {
        const value = text(event.delta)
        if (open?.kind !== 'tool' || open.output !== output || !value) break
        open.streamed = true
        yield delta(open.index, {
          type: 'input_json_delta',
          partial_json: value,
        })
        break
      }
      case 'response.output_item.done':
        if (item?.type === 'reasoning' && open?.kind === 'thinking') {
          if (!open.wrote)
            yield delta(open.index, {
              type: 'thinking_delta',
              thinking: reasoningSummary(item) || placeholderThinking,
            })
          yield delta(open.index, {
            type: 'signature_delta',
            signature: thinkingSignature(item),
          })
          yield* close()
        } else if (item?.type === 'function_call' && open?.kind === 'tool') {
          if (!open.streamed && text(item.arguments))
            yield delta(open.index, {
              type: 'input_json_delta',
              partial_json: item.arguments,
            })
          yield* close()
        } else if (item?.type === 'message' && open?.kind === 'text')
          yield* close()
        break
      case 'response.completed':
      case 'response.incomplete': {
        yield* close()
        const final = response ?? {}
        yield frame({
          type: 'message_delta',
          delta: { stop_reason: stopReason(final, calls), stop_sequence: null },
          usage: anthropicUsage(final.usage),
        })
        yield frame({ type: 'message_stop' })
        return
      }
      case 'response.failed':
      case 'error':
        yield frame({
          type: 'error',
          error: { type: 'api_error', message: failureMessage(event) },
        })
        return
    }
  }
  yield frame({
    type: 'error',
    error: {
      type: 'api_error',
      message: 'The source stream ended before the response completed.',
    },
  })
}

export function responsesStreamToMessages(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<string> {
  return messagesFrames(body, model)
}

export function anthropicErrorType(status: number): string {
  if (status === 400 || status === 413 || status === 422)
    return 'invalid_request_error'
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 429) return 'rate_limit_error'
  if (status === 529) return 'overloaded_error'
  return 'api_error'
}
