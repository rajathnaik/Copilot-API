export interface UsageTokens {
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
}

export interface MeteredUsage {
  tokens: UsageTokens
  // False when the upstream response never reported token usage.
  reported: boolean
  // Copilot bills in AI units; one AI unit is 1e9 nano units.
  nanoAiu: number | null
}

export type UsageOutcome = 'completed' | 'failed' | 'cancelled'
export type UpstreamPurpose = 'request' | 'continuation' | 'web-search'

export interface UpstreamUsage extends UsageTokens {
  model: string
  purpose: UpstreamPurpose
  status: number
  outcome: UsageOutcome
  durationMs: number
  nanoAiu: number | null
}

export type UsageReporter = (usage: UpstreamUsage) => void

type Field = keyof UsageTokens
type Style = 'responses' | 'messages' | 'chat'

const maxJsonBytes = 16 * 1024 * 1024

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ?
      Math.round(value)
    : undefined
}

export function emptyUsage(): UsageTokens {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  }
}

/**
 * Collects token usage from Responses, Messages and Chat Completions bodies
 * or stream events. Later reports replace earlier ones field by field, which
 * matches how each protocol repeats cumulative counts.
 */
export class UsageMeter {
  private readonly fields: Partial<UsageTokens> = {}
  private nanoAiu: number | null = null

  observe(value: unknown): void {
    const event = record(value)
    if (!event) return
    this.copilot(event.copilot_usage)
    const response = record(event.response)
    if (response) {
      this.copilot(response.copilot_usage)
      this.usage(response.usage, 'responses')
    }
    const message = record(event.message)
    if (event.type === 'message_start' && message) {
      this.copilot(message.copilot_usage)
      this.usage(message.usage, 'messages')
    }
    if (event.type === 'message_delta' || event.type === 'message')
      this.usage(event.usage, 'messages')
    else if (event.object === 'response') this.usage(event.usage, 'responses')
    else this.usage(event.usage)
  }

  result(): MeteredUsage {
    return {
      tokens: { ...emptyUsage(), ...this.fields },
      reported: Object.keys(this.fields).length > 0,
      nanoAiu: this.nanoAiu,
    }
  }

  private copilot(value: unknown) {
    const units = count(record(value)?.total_nano_aiu)
    if (units !== undefined) this.nanoAiu = units
  }

  private usage(value: unknown, known?: Style) {
    const usage = record(value)
    if (!usage) return
    const style: Style =
      known
      ?? ('prompt_tokens' in usage || 'completion_tokens' in usage ? 'chat'
      : (
        'cache_read_input_tokens' in usage
        || 'cache_creation_input_tokens' in usage
      ) ?
        'messages'
      : 'responses')
    const set = (field: Field, amount: number | undefined) => {
      if (amount !== undefined) this.fields[field] = amount
    }
    if (style === 'chat') {
      set('inputTokens', count(usage.prompt_tokens))
      set(
        'cachedInputTokens',
        count(record(usage.prompt_tokens_details)?.cached_tokens),
      )
      set('outputTokens', count(usage.completion_tokens))
      set(
        'reasoningTokens',
        count(record(usage.completion_tokens_details)?.reasoning_tokens),
      )
      return
    }
    if (style === 'messages') {
      // Messages reports cache reads and writes outside input_tokens.
      const input = count(usage.input_tokens)
      const read = count(usage.cache_read_input_tokens)
      const write = count(usage.cache_creation_input_tokens)
      if (input !== undefined || read !== undefined || write !== undefined)
        set('inputTokens', (input ?? 0) + (read ?? 0) + (write ?? 0))
      set('cachedInputTokens', read)
      set('cacheWriteTokens', write)
      set('outputTokens', count(usage.output_tokens))
      return
    }
    const input = record(usage.input_tokens_details)
    set('inputTokens', count(usage.input_tokens))
    set('cachedInputTokens', count(input?.cached_tokens))
    set('cacheWriteTokens', count(input?.cache_write_tokens))
    set('outputTokens', count(usage.output_tokens))
    set(
      'reasoningTokens',
      count(record(usage.output_tokens_details)?.reasoning_tokens),
    )
  }
}

/**
 * Returns a response with an identical body that reports usage once the body
 * finishes, fails or is cancelled. The body is observed, never altered.
 */
export function meterResponse(
  response: Response,
  done: (usage: MeteredUsage, outcome: UsageOutcome) => void,
): Response {
  const meter = new UsageMeter()
  let finished = false
  const finish = (outcome: UsageOutcome) => {
    if (finished) return
    finished = true
    try {
      done(meter.result(), response.ok ? outcome : 'failed')
    } catch (error) {
      console.error(
        `[ModelBridge] Usage recording failed (${error instanceof Error ? error.name : 'Unknown failure'}).`,
      )
    }
  }
  if (!response.body) {
    finish('completed')
    return response
  }
  const type = response.headers.get('content-type') ?? ''
  const stream = type.includes('text/event-stream')
  const json = !stream && type.includes('json')
  const decoder = new TextDecoder()
  let buffer = ''
  let size = 0
  const parse = (text: string) => {
    try {
      meter.observe(JSON.parse(text))
    } catch {
      // Usage is best effort; malformed bodies reach the client unchanged.
    }
  }
  const observe = (chunk?: Uint8Array) => {
    if (!stream && !json) return
    const text = decoder.decode(chunk, { stream: chunk !== undefined })
    if (json) {
      size += text.length
      buffer = size > maxJsonBytes ? '' : buffer + text
      if (chunk === undefined && size <= maxJsonBytes) parse(buffer)
      return
    }
    buffer += text
    const lines = buffer.split(/\r?\n/u)
    buffer = chunk === undefined ? '' : (lines.pop() ?? '')
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data && data !== '[DONE]' && data.includes('usage')) parse(data)
    }
  }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          observe()
          finish('completed')
          controller.close()
          return
        }
        observe(next.value)
        controller.enqueue(next.value)
      } catch (error) {
        finish('failed')
        controller.error(error)
      }
    },
    async cancel(reason) {
      finish('cancelled')
      await reader.cancel(reason)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * Sends one upstream request and reports its usage when its body ends. A
 * request is reported as cancelled only when the client disconnected.
 */
export async function meteredFetch(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  report: UsageReporter | undefined,
  request: { model: string; purpose: UpstreamPurpose; client: AbortSignal },
  now: () => number = Date.now,
): Promise<Response> {
  if (!report) return fetcher(url, init)
  const started = now()
  const entry = (
    status: number,
    outcome: UsageOutcome,
    usage: MeteredUsage = {
      tokens: emptyUsage(),
      reported: false,
      nanoAiu: null,
    },
  ): UpstreamUsage => ({
    model: request.model,
    purpose: request.purpose,
    status,
    outcome,
    durationMs: Math.max(0, now() - started),
    ...usage.tokens,
    nanoAiu: usage.nanoAiu,
  })
  let response: Response
  try {
    response = await fetcher(url, init)
  } catch (error) {
    report(entry(0, request.client.aborted ? 'cancelled' : 'failed'))
    throw error
  }
  // A translator may stop reading after the final event; that is a completed
  // request when usage arrived, and a failure only when nothing did.
  return meterResponse(response, (usage, outcome) =>
    report(
      entry(
        response.status,
        outcome === 'cancelled' && !request.client.aborted ?
          usage.reported ?
            'completed'
          : 'failed'
        : outcome,
        usage,
      ),
    ),
  )
}
