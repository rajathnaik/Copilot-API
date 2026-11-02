import { events } from 'fetch-event-stream'

export type Json = Record<string, unknown>

// Thrown for a request a protocol adapter cannot express in the Responses API.
export class AdapterError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'AdapterError'
  }
}

export function record(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ?
      (value as Json)
    : undefined
}

export function list(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// Parses each JSON `data:` event of a Responses stream, skipping keep-alives
// and the `[DONE]` sentinel.
export async function* responseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Json> {
  for await (const message of events(new Response(body))) {
    if (!message.data || message.data === '[DONE]') continue
    let value: unknown
    try {
      value = JSON.parse(message.data)
    } catch {
      continue
    }
    const event = record(value)
    if (event) yield event
  }
}

export function sseResponseBody(
  frames: AsyncGenerator<string>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await frames.next()
      if (next.done) controller.close()
      else controller.enqueue(encoder.encode(next.value))
    },
    async cancel() {
      await frames.return(undefined)
    },
  })
}

// Extracts a readable message from an upstream error body of any format.
export function errorMessage(body: string, status: number): string {
  try {
    const value = record(JSON.parse(body))
    const error = record(value?.error)
    const message =
      text(error?.message) ?? text(value?.message) ?? text(value?.error)
    if (message) return message
  } catch {
    // Not JSON; fall through to the raw text.
  }
  const trimmed = body.trim().slice(0, 500)
  return trimmed || `The source returned HTTP ${status}.`
}

export interface ResponsesUsage {
  input: number
  output: number
  cached: number
  reasoning: number
}

export function responsesUsage(value: unknown): ResponsesUsage {
  const usage = record(value)
  return {
    input: count(usage?.input_tokens) ?? 0,
    output: count(usage?.output_tokens) ?? 0,
    cached: count(record(usage?.input_tokens_details)?.cached_tokens) ?? 0,
    reasoning:
      count(record(usage?.output_tokens_details)?.reasoning_tokens) ?? 0,
  }
}

export function reasoningSummary(item: Json): string {
  return (list(item.summary) ?? [])
    .map((part) => text(record(part)?.text) ?? '')
    .filter(Boolean)
    .join('\n\n')
}

export function failureMessage(event: Json): string {
  const error =
    record(event.error) ?? record(record(event.response)?.error) ?? {}
  return (
    text(error.message)
    ?? text(event.message)
    ?? 'The source failed to complete the response.'
  )
}
