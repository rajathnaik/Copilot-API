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

// Chat Completions requests are answered by the Responses API: the request is
// rewritten as a Responses request and the result is rewritten back, so every
// Responses model serves Chat Completions clients such as Hermes or Cline.

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  return (list(content) ?? [])
    .map((part) => {
      const value = record(part)
      return text(value?.text) ?? text(value?.refusal) ?? ''
    })
    .join('')
}

function userContent(content: unknown): Json[] {
  if (typeof content === 'string')
    return [{ type: 'input_text', text: content }]
  const parts = list(content)
  if (!parts) throw new AdapterError('A user message has no content.')
  return parts.map((value) => {
    const part = record(value)
    switch (part?.type) {
      case 'text':
        return { type: 'input_text', text: text(part.text) ?? '' }
      case 'image_url': {
        const image = record(part.image_url)
        const url = text(image?.url) ?? text(part.image_url)
        if (!url) throw new AdapterError('An image part has no URL.')
        return {
          type: 'input_image',
          image_url: url,
          detail: text(image?.detail) ?? 'auto',
        }
      }
      case 'file': {
        const file = record(part.file) ?? {}
        return {
          type: 'input_file',
          ...(text(file.file_data) && { file_data: file.file_data }),
          ...(text(file.file_id) && { file_id: file.file_id }),
          ...(text(file.filename) && { filename: file.filename }),
        }
      }
      default:
        throw new AdapterError(
          `Chat content type "${text(part?.type) ?? 'unknown'}" is not supported for this model.`,
        )
    }
  })
}

function textFormat(format: unknown): Json | undefined {
  const value = record(format)
  if (!value) return undefined
  if (value.type === 'json_schema') {
    const schema = record(value.json_schema) ?? {}
    return {
      type: 'json_schema',
      name: text(schema.name) ?? 'response',
      schema: record(schema.schema) ?? { type: 'object' },
      ...(typeof schema.strict === 'boolean' && { strict: schema.strict }),
      ...(text(schema.description) && { description: schema.description }),
    }
  }
  if (value.type === 'json_object' || value.type === 'text')
    return { type: value.type }
  return undefined
}

function toolChoice(choice: unknown): unknown {
  if (typeof choice === 'string') return choice
  const value = record(choice)
  const name = text(record(value?.function)?.name)
  return value?.type === 'function' && name ?
      { type: 'function', name }
    : undefined
}

export function chatToResponsesRequest(body: Json, model: Model): Json {
  if ((count(body.n) ?? 1) > 1)
    throw new AdapterError(
      'This model returns one choice per request; set n to 1.',
    )
  const messages = list(body.messages)
  if (!messages?.length)
    throw new AdapterError(
      'Chat Completions requests need at least one message.',
    )
  const instructions: string[] = []
  const input: Json[] = []
  for (const value of messages) {
    const message = record(value)
    const role = message?.role
    if (!message || typeof role !== 'string')
      throw new AdapterError('Every chat message needs a role.')
    if (role === 'system' || role === 'developer') {
      const content = contentText(message.content)
      if (!input.length) instructions.push(content)
      else
        input.push({
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: content }],
        })
    } else if (role === 'user')
      input.push({
        type: 'message',
        role: 'user',
        content: userContent(message.content),
      })
    else if (role === 'assistant') {
      const content = contentText(message.content)
      if (content)
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: content }],
        })
      for (const entry of list(message.tool_calls) ?? []) {
        const call = record(entry)
        const fn = record(call?.function)
        const name = text(fn?.name)
        if (!call || !name) continue
        input.push({
          type: 'function_call',
          call_id: text(call.id) ?? `call_${randomUUID()}`,
          name,
          arguments: text(fn?.arguments) ?? '{}',
        })
      }
    } else if (role === 'tool')
      input.push({
        type: 'function_call_output',
        call_id: text(message.tool_call_id) ?? '',
        output: contentText(message.content),
      })
    else throw new AdapterError(`Chat message role "${role}" is not supported.`)
  }
  const tools = (list(body.tools) ?? []).flatMap((value) => {
    const tool = record(value)
    const fn = record(tool?.function)
    const name = text(fn?.name)
    if (tool?.type !== 'function' || !fn || !name) return []
    return [
      {
        type: 'function',
        name,
        ...(text(fn.description) && { description: fn.description }),
        parameters: record(fn.parameters) ?? { type: 'object', properties: {} },
        strict: fn.strict === true,
      },
    ]
  })
  const reasoning = !!model.reasoningEfforts?.length
  const effort = text(body.reasoning_effort)
  const maximum = count(body.max_completion_tokens) ?? count(body.max_tokens)
  const format = textFormat(body.response_format)
  const verbosity = text(body.verbosity)
  const choice = toolChoice(body.tool_choice)
  return {
    model: body.model,
    input,
    ...(instructions.length && { instructions: instructions.join('\n\n') }),
    ...(tools.length && { tools }),
    ...(tools.length && choice !== undefined && { tool_choice: choice }),
    ...(typeof body.parallel_tool_calls === 'boolean' && {
      parallel_tool_calls: body.parallel_tool_calls,
    }),
    ...(maximum && { max_output_tokens: Math.max(16, Math.floor(maximum)) }),
    ...((reasoning || effort) && {
      reasoning: {
        ...(effort && { effort }),
        ...(reasoning && { summary: 'auto' }),
      },
    }),
    ...((format || verbosity) && {
      text: { ...(format && { format }), ...(verbosity && { verbosity }) },
    }),
    // Reasoning models reject sampling parameters, and Chat clients often send
    // them by default.
    ...(!reasoning
      && count(body.temperature) !== undefined && {
        temperature: body.temperature,
      }),
    ...(!reasoning && count(body.top_p) !== undefined && { top_p: body.top_p }),
    ...(text(body.prompt_cache_key) && {
      prompt_cache_key: body.prompt_cache_key,
    }),
    stream: body.stream === true,
    store: false,
  }
}

function finishReason(response: Json, tools: boolean): string {
  if (tools) return 'tool_calls'
  const reason = text(record(response.incomplete_details)?.reason)
  if (reason === 'max_output_tokens') return 'length'
  if (reason === 'content_filter') return 'content_filter'
  return 'stop'
}

function chatUsage(value: unknown): Json {
  const usage = responsesUsage(value)
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cached },
    completion_tokens_details: { reasoning_tokens: usage.reasoning },
  }
}

function completionId(response: Json): string {
  const id = text(response.id)
  return `chatcmpl-${id ?? randomUUID()}`
}

function created(response: Json): number {
  return count(response.created_at) ?? Math.floor(Date.now() / 1000)
}

export function responsesToChatResponse(response: Json, model: string): Json {
  const texts: string[] = []
  const refusals: string[] = []
  const reasoning: string[] = []
  const calls: Json[] = []
  for (const value of list(response.output) ?? []) {
    const item = record(value)
    if (item?.type === 'message')
      for (const entry of list(item.content) ?? []) {
        const part = record(entry)
        if (part?.type === 'output_text') texts.push(text(part.text) ?? '')
        else if (part?.type === 'refusal')
          refusals.push(text(part.refusal) ?? '')
      }
    else if (item?.type === 'reasoning') {
      const summary = reasoningSummary(item)
      if (summary) reasoning.push(summary)
    } else if (item?.type === 'function_call')
      calls.push({
        id: text(item.call_id) ?? `call_${randomUUID()}`,
        type: 'function',
        function: {
          name: text(item.name) ?? '',
          arguments: text(item.arguments) ?? '{}',
        },
      })
  }
  const content = texts.filter(Boolean).join('\n\n')
  return {
    id: completionId(response),
    object: 'chat.completion',
    created: created(response),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || (calls.length || refusals.length ? null : ''),
          ...(refusals.length && { refusal: refusals.join('\n\n') }),
          ...(reasoning.length && {
            reasoning_content: reasoning.join('\n\n'),
          }),
          ...(calls.length && { tool_calls: calls }),
        },
        finish_reason: finishReason(response, calls.length > 0),
        logprobs: null,
      },
    ],
    usage: chatUsage(response.usage),
  }
}

interface ToolState {
  index: number
  streamed: boolean
}

async function* chatFrames(
  body: ReadableStream<Uint8Array>,
  model: string,
  includeUsage: boolean,
): AsyncGenerator<string> {
  let id = `chatcmpl-${randomUUID()}`
  let createdAt = Math.floor(Date.now() / 1000)
  let started = false
  let wroteText = false
  let separate = false
  let wroteReasoning = false
  const tools = new Map<number, ToolState>()
  const frame = (value: Json) => `data: ${JSON.stringify(value)}\n\n`
  const chunk = (delta: Json, finish: string | null = null) =>
    frame({
      id,
      object: 'chat.completion.chunk',
      created: createdAt,
      model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    })
  const start = function* () {
    if (started) return
    started = true
    yield chunk({ role: 'assistant', content: '' })
  }
  const toolHeader = (item: Json, outputIndex: number) => {
    const state = { index: tools.size, streamed: false }
    tools.set(outputIndex, state)
    return chunk({
      tool_calls: [
        {
          index: state.index,
          id: text(item.call_id) ?? `call_${randomUUID()}`,
          type: 'function',
          function: { name: text(item.name) ?? '', arguments: '' },
        },
      ],
    })
  }
  for await (const event of responseEvents(body)) {
    const type = text(event.type)
    const response = record(event.response)
    if (type === 'response.created' || type === 'response.in_progress') {
      if (response && !started) {
        id = completionId(response)
        createdAt = created(response)
      }
      yield* start()
      continue
    }
    yield* start()
    const outputIndex = count(event.output_index) ?? -1
    const item = record(event.item)
    switch (type) {
      case 'response.output_item.added':
        if (item?.type === 'message' && wroteText) separate = true
        else if (item?.type === 'function_call')
          yield toolHeader(item, outputIndex)
        break
      case 'response.output_text.delta': {
        const delta = text(event.delta)
        if (!delta) break
        yield chunk({ content: separate ? `\n\n${delta}` : delta })
        separate = false
        wroteText = true
        break
      }
      case 'response.refusal.delta':
        if (text(event.delta)) yield chunk({ refusal: event.delta })
        break
      case 'response.reasoning_summary_part.added':
        if (wroteReasoning) yield chunk({ reasoning_content: '\n\n' })
        break
      case 'response.reasoning_summary_text.delta':
        if (text(event.delta)) {
          wroteReasoning = true
          yield chunk({ reasoning_content: event.delta })
        }
        break
      case 'response.function_call_arguments.delta': {
        const state = tools.get(outputIndex)
        if (!state || !text(event.delta)) break
        state.streamed = true
        yield chunk({
          tool_calls: [
            { index: state.index, function: { arguments: event.delta } },
          ],
        })
        break
      }
      case 'response.output_item.done': {
        if (item?.type !== 'function_call') break
        if (!tools.has(outputIndex)) yield toolHeader(item, outputIndex)
        const state = tools.get(outputIndex)
        if (state && !state.streamed && text(item.arguments)) {
          state.streamed = true
          yield chunk({
            tool_calls: [
              { index: state.index, function: { arguments: item.arguments } },
            ],
          })
        }
        break
      }
      case 'response.completed':
      case 'response.incomplete': {
        const final = response ?? {}
        yield chunk({}, finishReason(final, tools.size > 0))
        if (includeUsage)
          yield frame({
            id,
            object: 'chat.completion.chunk',
            created: createdAt,
            model,
            choices: [],
            usage: chatUsage(final.usage),
          })
        yield 'data: [DONE]\n\n'
        return
      }
      case 'response.failed':
      case 'error':
        yield frame({
          error: { message: failureMessage(event), type: 'api_error' },
        })
        return
    }
  }
  yield frame({
    error: {
      message: 'The source stream ended before the response completed.',
      type: 'api_error',
    },
  })
}

export function responsesStreamToChat(
  body: ReadableStream<Uint8Array>,
  model: string,
  includeUsage: boolean,
): AsyncGenerator<string> {
  return chatFrames(body, model, includeUsage)
}
