import type { MessagesToolRegistry } from './messages-translation'
import type {
  ResponseInputItem,
  ResponseOutputItem,
  ResponseOutputWebSearchCall,
  ResponsesResult,
  ResponseStreamEvent,
  ResponseUsage,
} from './responses'

export interface WebSearchSource {
  url: string
  title: string
}

export interface WebSearchOutcome {
  failed: boolean
  text: string
  sources: Array<WebSearchSource>
}

export interface WebSearchRound {
  events: AsyncIterable<ResponseStreamEvent>
  registry: MessagesToolRegistry
}

const maxResultCharacters = 24_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Adapted from the original Gateway web-search backend: collect the grounded
// answer, URL citations and action sources from a GPT Responses search.
export function extractWebSearchResult(
  output: Array<unknown>,
  outputText = '',
): WebSearchOutcome {
  const text: string[] = []
  const sources = new Map<string, WebSearchSource>()
  const addSource = (url: unknown, title: unknown) => {
    if (typeof url !== 'string' || !url) return
    const named = typeof title === 'string' && title.trim() ? title.trim() : ''
    const existing = sources.get(url)
    if (!existing) sources.set(url, { url, title: named || url })
    else if (named && existing.title === url) existing.title = named
  }
  for (const item of output) {
    if (!isRecord(item)) continue
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isRecord(part) || part.type !== 'output_text') continue
        if (typeof part.text === 'string' && part.text) text.push(part.text)
        for (const annotation of Array.isArray(part.annotations) ?
          part.annotations
        : []) {
          if (isRecord(annotation) && annotation.type === 'url_citation')
            addSource(annotation.url, annotation.title)
        }
      }
    }
    if (item.type === 'web_search_call' && isRecord(item.action)) {
      for (const source of Array.isArray(item.action.sources) ?
        item.action.sources
      : [])
        if (isRecord(source)) addSource(source.url, source.title)
    }
  }
  const answer = text.join('\n\n').trim() || outputText.trim()
  const list = [...sources.values()]
  if (!answer && !list.length)
    return {
      failed: true,
      text: 'The web search returned no results.',
      sources: list,
    }
  const cited = list
    .map((source, index) => `${index + 1}. ${source.title} - ${source.url}`)
    .join('\n')
  const combined = [answer, cited && `Sources:\n${cited}`]
    .filter(Boolean)
    .join('\n\n')
  return {
    failed: false,
    text:
      combined.length > maxResultCharacters ?
        `${combined.slice(0, maxResultCharacters)}\n[Truncated by ModelBridge]`
      : combined,
    sources: list,
  }
}

// Codex replays web_search_call items without their results, so the host keeps
// a bounded copy keyed by call ID to rebuild the conversation faithfully.
export class WebSearchResultCache {
  private readonly entries = new Map<
    string,
    { text: string; expires: number }
  >()

  constructor(
    private readonly now: () => number,
    private readonly limit = 500,
    private readonly ttl = 24 * 60 * 60 * 1000,
  ) {}

  set(id: string, text: string) {
    this.entries.delete(id)
    this.entries.set(id, { text, expires: this.now() + this.ttl })
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  get(id: string): string | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    if (entry.expires > this.now()) return entry.text
    this.entries.delete(id)
    return undefined
  }
}

function searchQuery(argumentsText: unknown): string {
  if (typeof argumentsText !== 'string') return ''
  try {
    const parsed: unknown = JSON.parse(argumentsText)
    return isRecord(parsed) && typeof parsed.query === 'string' ?
        parsed.query.trim()
      : ''
  } catch {
    return ''
  }
}

/**
 * Runs Messages-backed turns that use the proxied web_search tool. Search-only
 * tool turns are continued server-side; turns with client tool calls end after
 * their searches resolve so the harness can execute the remaining calls.
 */
export async function* proxyWebSearch(
  first: WebSearchRound,
  options: {
    input: Array<ResponseInputItem>
    next: (input: Array<ResponseInputItem>) => Promise<WebSearchRound>
    search: (query: string) => Promise<WebSearchOutcome>
    remember: (id: string, text: string) => void
    maxSearches?: number
    maxRounds?: number
  },
): AsyncGenerator<ResponseStreamEvent> {
  const maxSearches = options.maxSearches ?? 8
  const maxRounds = options.maxRounds ?? 10
  let sequence = 0
  let nextIndex = 0
  let responseId: string | undefined
  let usage: ResponseUsage | null = null
  let searches = 0
  let input = [...options.input]
  let round = first
  const emit = (event: object) =>
    ({ ...event, sequence_number: sequence++ }) as ResponseStreamEvent
  for (let roundIndex = 0; ; roundIndex++) {
    const indexes = new Map<number, number>()
    const pendingSearches = new Map<number, string>()
    const outputs: Array<ResponseOutputItem> = []
    let clientToolCall = false
    let searched = false
    let terminal: Extract<
      ResponseStreamEvent,
      { type: 'response.completed' | 'response.incomplete' }
    > | null = null
    for await (const event of round.events) {
      if (
        event.type === 'response.created'
        || event.type === 'response.in_progress'
      ) {
        if (roundIndex > 0) continue
        responseId ??= event.response.id
        yield emit(event)
        continue
      }
      if (
        event.type === 'response.completed'
        || event.type === 'response.incomplete'
      ) {
        terminal = event
        break
      }
      if (event.type === 'response.failed') {
        yield emit({
          ...event,
          response: { ...event.response, id: responseId ?? event.response.id },
        })
        return
      }
      if (!('output_index' in event)) {
        yield emit(event)
        continue
      }
      const local = event.output_index
      if (event.type === 'response.output_item.added') {
        const global = nextIndex++
        indexes.set(local, global)
        const item = event.item
        if (
          item.type === 'function_call'
          && round.registry.webSearchCalls.has(item.call_id)
        ) {
          pendingSearches.set(local, item.call_id)
          yield emit({
            type: 'response.output_item.added',
            output_index: global,
            item: {
              id: item.call_id,
              type: 'web_search_call',
              status: 'in_progress',
              action: { type: 'search' },
            },
          })
          yield emit({
            type: 'response.web_search_call.in_progress',
            item_id: item.call_id,
            output_index: global,
          })
          continue
        }
        if (item.type === 'function_call' || item.type === 'custom_tool_call')
          clientToolCall = true
      }
      const global = indexes.get(local) ?? local
      const searchId = pendingSearches.get(local)
      if (searchId) {
        if (event.type !== 'response.output_item.done') continue
        const query =
          event.item.type === 'function_call' ?
            searchQuery(event.item.arguments)
          : ''
        yield emit({
          type: 'response.web_search_call.searching',
          item_id: searchId,
          output_index: global,
        })
        searches++
        const outcome =
          !query ?
            {
              failed: true,
              text: 'The web search request did not include a query.',
              sources: [],
            }
          : searches > maxSearches ?
            {
              failed: true,
              text: `The web search limit of ${maxSearches} searches for this turn was reached. Answer with the information already gathered.`,
              sources: [],
            }
          : await options.search(query)
        options.remember(searchId, outcome.text)
        const item: ResponseOutputWebSearchCall = {
          id: searchId,
          type: 'web_search_call',
          status: outcome.failed ? 'failed' : 'completed',
          action: {
            type: 'search',
            query,
            ...(outcome.sources.length && {
              sources: outcome.sources.map((source) => ({
                type: 'url' as const,
                url: source.url,
              })),
            }),
          },
        }
        if (!outcome.failed)
          yield emit({
            type: 'response.web_search_call.completed',
            item_id: searchId,
            output_index: global,
          })
        yield emit({
          type: 'response.output_item.done',
          output_index: global,
          item,
        })
        outputs.push(item)
        searched = true
        continue
      }
      if (event.type === 'response.output_item.done') outputs.push(event.item)
      yield emit({ ...event, output_index: global })
    }
    if (!terminal) return
    // Codex treats usage as the current context size, so report the final
    // round (which resends the whole conversation) rather than a sum.
    usage = terminal.response.usage ?? usage
    if (
      !searched
      || clientToolCall
      || terminal.type === 'response.incomplete'
      || roundIndex + 1 >= maxRounds
    ) {
      yield emit({
        ...terminal,
        response: {
          ...terminal.response,
          id: responseId ?? terminal.response.id,
          usage,
        },
      })
      return
    }
    input = [...input, ...outputs.map((item) => item as ResponseInputItem)]
    try {
      round = await options.next(input)
    } catch (error) {
      const message =
        error instanceof Error ?
          error.message
        : 'Copilot failed to continue after web search.'
      yield emit({
        type: 'error',
        code: 'web_search_continuation_failed',
        message,
        param: null,
      })
      yield emit({
        type: 'response.failed',
        response: {
          ...terminal.response,
          id: responseId ?? terminal.response.id,
          status: 'failed',
          usage,
          error: { code: 'web_search_continuation_failed', message },
        },
      })
      return
    }
  }
}

// Folds a proxied event stream back into one Responses result for clients
// that requested a non-streaming response.
export async function collectResponse(
  stream: AsyncIterable<ResponseStreamEvent>,
): Promise<{ ok: boolean; result: ResponsesResult | null; message?: string }> {
  const output = new Map<number, ResponseOutputItem>()
  let message: string | undefined
  for await (const event of stream) {
    if (event.type === 'response.output_item.done')
      output.set(event.output_index, event.item)
    if (event.type === 'error') message = event.message
    if (
      event.type === 'response.completed'
      || event.type === 'response.incomplete'
      || event.type === 'response.failed'
    ) {
      const items = [...output.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, item]) => item)
      const text = items
        .flatMap((item) =>
          item.type === 'message' ?
            (item.content ?? []).flatMap((part) =>
              part.type === 'output_text' && typeof part.text === 'string' ?
                [part.text]
              : [],
            )
          : [],
        )
        .join('')
      return {
        ok: event.type !== 'response.failed',
        result: { ...event.response, output: items, output_text: text },
        message,
      }
    }
  }
  return { ok: false, result: null, message }
}
