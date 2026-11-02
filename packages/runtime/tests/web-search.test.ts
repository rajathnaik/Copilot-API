import { expect, test } from 'bun:test'
import { CopilotProvider } from '../src/providers/copilot'
import { SourceService } from '../src/sources/source-service'
import { createGateway } from '../src/routing/gateway'
import {
  webSearchCandidates,
  webSearchModel,
  type Credentials,
  type Source,
} from '../src/contracts'
import {
  collectResponse,
  extractWebSearchResult,
  proxyWebSearch,
  WebSearchResultCache,
} from '../src/providers/copilot-compatibility/web-search-proxy'
import type { MessagesToolRegistry } from '../src/providers/copilot-compatibility/messages-translation'
import type { ResponseStreamEvent } from '../src/providers/copilot-compatibility/responses'

function credentials(): Credentials {
  const values = new Map<string, string>()
  return {
    get(id) {
      const value = values.get(id)
      if (!value) throw new Error('Credential missing')
      return value
    },
    set: (id, value) => {
      values.set(id, value)
    },
    remove: (id) => {
      values.delete(id)
    },
  }
}

const gpt = (id: string) => ({
  id,
  name: id.toUpperCase(),
  supported_endpoints: ['/responses'],
  capabilities: {
    supports: { tool_calls: true, reasoning_effort: ['low', 'medium', 'high'] },
  },
})
const fullCatalog = {
  data: [
    gpt('gpt-5.4-mini'),
    gpt('gpt-5.4'),
    gpt('gpt-5.2'),
    {
      id: 'claude',
      name: 'Claude',
      supported_endpoints: ['/v1/messages'],
      capabilities: { supports: { tool_calls: true } },
    },
    {
      id: 'chat-only',
      supported_endpoints: ['/chat/completions'],
      capabilities: { supports: { tool_calls: true } },
    },
  ],
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

function messagesStream(blocks: Block[], stop: string, input = 10, output = 5) {
  const chunks: Array<Record<string, unknown>> = [
    {
      type: 'message_start',
      message: {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: input, output_tokens: 0 },
      },
    },
  ]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      chunks.push(
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        },
      )
    } else {
      chunks.push(
        {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(block.input),
          },
        },
      )
    }
    chunks.push({ type: 'content_block_stop', index })
  })
  chunks.push(
    {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: output },
    },
    { type: 'message_stop' },
  )
  return new Response(
    chunks
      .map(
        (chunk) =>
          `event: ${String(chunk.type)}\ndata: ${JSON.stringify(chunk)}\n\n`,
      )
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function searchStream() {
  const events = [
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'ws_upstream',
        type: 'web_search_call',
        status: 'completed',
        action: {
          type: 'search',
          query: 'bun release',
          sources: [{ type: 'url', url: 'https://example.com/bun' }],
        },
      },
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'Bun 2 shipped.',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://example.com/bun',
                title: 'Bun blog',
              },
            ],
          },
        ],
      },
    },
    {
      type: 'response.completed',
      response: { id: 'resp_search', output: [], output_text: '' },
    },
  ]
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

interface Call {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

async function harness(
  options: {
    catalog?: unknown
    rounds?: Array<() => Response>
    search?: (signal?: AbortSignal | null) => Response | Promise<Response>
    requestTimeout?: number
  } = {},
) {
  const vault = credentials()
  const rounds = [...(options.rounds ?? [])]
  const upstream: Call[] = []
  const searches: Call[] = []
  const provider = new CopilotProvider(
    vault,
    async (url, init) => {
      if (url.endsWith('/token'))
        return Response.json({
          token: 'synthetic-copilot',
          refresh_in: 120,
          expires_at: 999999,
        })
      if (url.endsWith('/models'))
        return Response.json(options.catalog ?? fullCatalog)
      if (url === 'https://api.github.com/user')
        return new Response('not found', { status: 404 })
      const call = {
        url,
        headers: new Headers(init?.headers),
        body: JSON.parse(
          typeof init?.body === 'string' ? init.body : '{}',
        ) as Record<string, unknown>,
      }
      if (url.endsWith('/responses')) {
        searches.push(call)
        return options.search ? options.search(init?.signal) : searchStream()
      }
      upstream.push(call)
      const next = rounds.shift()
      if (!next) throw new Error('Unexpected upstream round.')
      return next()
    },
    Date.now,
    undefined,
    options.requestTimeout,
  )
  const sources = new SourceService([], vault, () => {}, fetch, provider)
  const source = await sources.addCopilot('synthetic-github', 'Copilot', true)
  const gateway = createGateway(sources, 'local')
  const send = (body: Record<string, unknown>) =>
    gateway.request('/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer local' },
      body: JSON.stringify({
        ...body,
        model: `${source.id}/${String(body.model)}`,
      }),
    })
  return { sources, source, send, upstream, searches }
}

interface StreamEvent {
  type: string
  sequence_number: number
  output_index?: number
  item?: Record<string, unknown>
  message?: string
  response?: { id: string; usage?: Record<string, unknown> }
}
type Message = { role: string; content: Array<Record<string, unknown>> }

function parseEvents(text: string) {
  return text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => !!line)
    .map((line) => JSON.parse(line.slice(6)) as StreamEvent)
}

const searchTool = { type: 'web_search' }
const execTool = {
  type: 'function',
  name: 'exec_command',
  parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
}

test('Messages models run proxied web searches with a GPT model and continue the turn server-side', async () => {
  const { send, upstream, searches } = await harness({
    rounds: [
      () =>
        messagesStream(
          [
            {
              type: 'tool_use',
              id: 'toolu_search',
              name: 'web_search',
              input: { query: 'bun release' },
            },
          ],
          'tool_use',
          10,
          5,
        ),
      () =>
        messagesStream(
          [{ type: 'text', text: 'Bun 2 is out.' }],
          'end_turn',
          20,
          7,
        ),
    ],
  })
  const response = await send({
    model: 'claude',
    input: 'What is new in Bun?',
    tools: [searchTool],
    stream: true,
  })
  expect(response.status).toBe(200)
  const events = parseEvents(await response.text())
  const types = events.map((event) => event.type)
  expect(types).toContain('response.web_search_call.in_progress')
  expect(types).toContain('response.web_search_call.searching')
  expect(types).toContain('response.web_search_call.completed')
  expect(types.filter((type) => type === 'response.created')).toHaveLength(1)
  expect(types.filter((type) => type === 'response.completed')).toHaveLength(1)
  expect(types.at(-1)).toBe('response.completed')
  const sequence = events.map((event) => event.sequence_number)
  expect(sequence).toEqual(sequence.map((_, index) => index))
  const added = events.filter(
    (event) => event.type === 'response.output_item.added',
  )
  expect(added.map((event) => event.output_index)).toEqual([0, 1])
  const done = events
    .filter((event) => event.type === 'response.output_item.done')
    .map((event) => event.item)
  expect(done[0]).toMatchObject({
    id: 'toolu_search',
    type: 'web_search_call',
    status: 'completed',
    action: {
      type: 'search',
      query: 'bun release',
      sources: [{ type: 'url', url: 'https://example.com/bun' }],
    },
  })
  expect(JSON.stringify(done[1])).toContain('Bun 2 is out.')
  expect(done.some((item) => item?.type === 'function_call')).toBe(false)
  const terminal = events.at(-1)?.response
  expect(terminal?.id).toBe(events[0]?.response?.id)
  expect(terminal?.usage).toMatchObject({ input_tokens: 20, output_tokens: 7 })

  expect(upstream).toHaveLength(2)
  expect(upstream[0]?.headers.get('x-initiator')).toBe('user')
  expect(upstream[1]?.headers.get('x-initiator')).toBe('agent')
  const schema: unknown = expect.objectContaining({ required: ['query'] })
  expect(upstream[0]?.body.tools).toEqual([
    expect.objectContaining({ name: 'web_search', input_schema: schema }),
  ])
  const continued = upstream[1]?.body.messages as Message[]
  expect(continued.at(-2)).toMatchObject({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_search', name: 'web_search' }],
  })
  expect(continued.at(-1)).toMatchObject({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_search' }],
  })
  const result = JSON.stringify(continued.at(-1))
  expect(result).toContain('Bun 2 shipped.')
  expect(result).toContain('1. Bun blog - https://example.com/bun')

  expect(searches).toHaveLength(1)
  expect(searches[0]?.headers.get('x-initiator')).toBe('agent')
  expect(searches[0]?.body).toMatchObject({
    model: 'gpt-5.4',
    input: 'bun release',
    tools: [{ type: 'web_search', search_context_size: 'low' }],
    include: ['web_search_call.action.sources'],
    stream: true,
    store: false,
    reasoning: { effort: 'low' },
  })
})

test('non-streaming turns with client tool calls return after searching and replay cached results', async () => {
  const { send, upstream } = await harness({
    rounds: [
      () =>
        messagesStream(
          [
            {
              type: 'tool_use',
              id: 'toolu_search',
              name: 'web_search',
              input: { query: 'bun release' },
            },
            {
              type: 'tool_use',
              id: 'toolu_exec',
              name: 'exec_command',
              input: { cmd: 'bun --version' },
            },
          ],
          'tool_use',
        ),
      () => messagesStream([{ type: 'text', text: 'Done.' }], 'end_turn'),
    ],
  })
  const first = await send({
    model: 'claude',
    input: 'Check Bun',
    tools: [searchTool, execTool],
  })
  expect(first.status).toBe(200)
  const result = (await first.json()) as {
    output: Array<Record<string, unknown>>
    output_text: string
  }
  expect(result.output.map((item) => item.type)).toEqual([
    'web_search_call',
    'function_call',
  ])
  expect(result.output[1]).toMatchObject({
    name: 'exec_command',
    call_id: 'toolu_exec',
  })
  expect(upstream).toHaveLength(1)

  const replay = await send({
    model: 'claude',
    input: [
      { type: 'message', role: 'user', content: 'Check Bun' },
      ...result.output,
      {
        type: 'web_search_call',
        id: 'toolu_expired',
        status: 'completed',
        action: { type: 'search', queries: ['old', 'query'] },
      },
      { type: 'function_call_output', call_id: 'toolu_exec', output: '2.0.0' },
    ],
    tools: [searchTool, execTool],
  })
  expect(replay.status).toBe(200)
  expect(((await replay.json()) as { output_text: string }).output_text).toBe(
    'Done.',
  )
  const messages = upstream[1]?.body.messages as Message[]
  expect(messages.at(-2)).toMatchObject({
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'toolu_search', input: { query: 'bun release' } },
      { type: 'tool_use', id: 'toolu_exec' },
      { type: 'tool_use', id: 'toolu_expired', input: { query: 'old; query' } },
    ],
  })
  const user = messages.at(-1) as Message
  expect(user.content.map((block) => block.tool_use_id)).toEqual([
    'toolu_search',
    'toolu_expired',
    'toolu_exec',
  ])
  expect(String(user.content[0]?.content)).toContain('Bun 2 shipped.')
  expect(String(user.content[1]?.content)).toContain('no longer available')
})

test('chat-completions models use the same web search proxy', async () => {
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id: 'chat-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'chat-only',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  const usage = `data: ${JSON.stringify({
    id: 'chat-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'chat-only',
    choices: [],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  })}\n\n`
  const stream = (body: string) => () =>
    new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
  const { send, upstream, searches } = await harness({
    rounds: [
      stream(
        chunk(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_search',
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: '{"query":"bun release"}',
                },
              },
            ],
          },
          null,
        )
          + chunk({}, 'tool_calls')
          + usage,
      ),
      stream(
        chunk({ role: 'assistant', content: 'Answer.' }, null)
          + chunk({}, 'stop')
          + usage,
      ),
    ],
  })
  const response = await send({
    model: 'chat-only',
    input: 'Search',
    tools: [{ type: 'web_search_preview' }],
  })
  expect(response.status).toBe(200)
  const result = (await response.json()) as {
    output: Array<Record<string, unknown>>
    output_text: string
  }
  expect(result.output[0]).toMatchObject({
    id: 'call_search',
    type: 'web_search_call',
  })
  expect(result.output_text).toBe('Answer.')
  expect(searches).toHaveLength(1)
  expect(upstream.every((call) => call.url.endsWith('/chat/completions'))).toBe(
    true,
  )
  expect(JSON.stringify(upstream[1]?.body.messages)).toContain('Bun 2 shipped.')
})

test('web search failures are reported to the model and continuation failures fail the response', async () => {
  const searchCall = () =>
    messagesStream(
      [
        {
          type: 'tool_use',
          id: 'toolu_search',
          name: 'web_search',
          input: { query: 'bun release' },
        },
      ],
      'tool_use',
    )
  const failedSearch = await harness({
    rounds: [
      searchCall,
      () => messagesStream([{ type: 'text', text: 'Sorry.' }], 'end_turn'),
    ],
    search: () => new Response('upstream broke', { status: 500 }),
  })
  const failed = await failedSearch.send({
    model: 'claude',
    input: 'Search',
    tools: [searchTool],
  })
  const failedResult = (await failed.json()) as {
    output: Array<Record<string, unknown>>
  }
  expect(failedResult.output[0]).toMatchObject({
    type: 'web_search_call',
    status: 'failed',
  })
  expect(JSON.stringify(failedSearch.upstream[1]?.body.messages)).toContain(
    'HTTP 500 for gpt-5.4',
  )

  const thrownSearch = await harness({
    rounds: [
      searchCall,
      () => messagesStream([{ type: 'text', text: 'Sorry.' }], 'end_turn'),
    ],
    search: () => Promise.reject(new Error('socket closed')),
  })
  await (
    await thrownSearch.send({
      model: 'claude',
      input: 'x',
      tools: [searchTool],
    })
  ).text()
  expect(JSON.stringify(thrownSearch.upstream[1]?.body.messages)).toContain(
    'Web search failed: socket closed.',
  )

  for (const stream of [true, false]) {
    const broken = await harness({
      rounds: [
        searchCall,
        () => new Response('busy synthetic-copilot', { status: 503 }),
      ],
    })
    const response = await broken.send({
      model: 'claude',
      input: 'Search',
      tools: [searchTool],
      stream,
    })
    if (stream) {
      expect(response.status).toBe(200)
      const events = parseEvents(await response.text())
      expect(events.map((event) => event.type).slice(-2)).toEqual([
        'error',
        'response.failed',
      ])
      expect(events.at(-2)?.message).toContain('HTTP 503')
    } else {
      expect(response.status).toBe(502)
      const body = await response.text()
      expect(body).toContain('HTTP 503')
      expect(body).not.toContain('synthetic-copilot')
    }
  }

  const rejected = await harness({
    rounds: [() => new Response('limited synthetic-copilot', { status: 429 })],
  })
  const limited = await rejected.send({
    model: 'claude',
    input: 'Search',
    tools: [searchTool],
  })
  expect(limited.status).toBe(429)
  expect(await limited.text()).toBe('limited [redacted]')
})

test('a slow search times out on its own deadline and the turn continues', async () => {
  const { send, upstream } = await harness({
    requestTimeout: 50,
    rounds: [
      () =>
        messagesStream(
          [
            {
              type: 'tool_use',
              id: 'toolu_search',
              name: 'web_search',
              input: { query: 'bun release' },
            },
          ],
          'tool_use',
        ),
      () => messagesStream([{ type: 'text', text: 'Answered.' }], 'end_turn'),
    ],
    search: (signal) =>
      new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      }),
  })
  const response = await send({
    model: 'claude',
    input: 'Search',
    tools: [searchTool],
    stream: true,
  })
  const events = parseEvents(await response.text())
  expect(events.at(-1)?.type).toBe('response.completed')
  expect(JSON.stringify(upstream[1]?.body.messages)).toContain(
    'Web search for gpt-5.4 timed out.',
  )
})

test('web search reports when no GPT Responses model is available', async () => {
  const { send, upstream, searches } = await harness({
    catalog: { data: [fullCatalog.data[3]] },
    rounds: [
      () =>
        messagesStream(
          [
            {
              type: 'tool_use',
              id: 'toolu_search',
              name: 'web_search',
              input: { query: 'bun release' },
            },
          ],
          'tool_use',
        ),
      () => messagesStream([{ type: 'text', text: 'No search.' }], 'end_turn'),
    ],
  })
  await (
    await send({ model: 'claude', input: 'x', tools: [searchTool] })
  ).text()
  expect(searches).toHaveLength(0)
  expect(JSON.stringify(upstream[1]?.body.messages)).toContain(
    'no GPT Responses model with tool support',
  )
})

test('web search model selection prefers the newest full GPT model and honours a saved override', async () => {
  const { sources, source } = await harness()
  expect(webSearchCandidates(source).map((model) => model.id)).toEqual([
    'gpt-5.4-mini',
    'gpt-5.4',
    'gpt-5.2',
  ])
  expect(webSearchModel(source)?.id).toBe('gpt-5.4')
  expect(
    webSearchModel({
      models: source.models.filter((model) => model.id === 'gpt-5.4-mini'),
    })?.id,
  ).toBe('gpt-5.4-mini')
  sources.setWebSearchModel(source.id, 'gpt-5.2')
  const saved = sources.list().find((item) => item.id === source.id) as Source
  expect(saved.webSearchModelId).toBe('gpt-5.2')
  expect(webSearchModel(saved)?.id).toBe('gpt-5.2')
  expect(() => sources.setWebSearchModel(source.id, 'claude')).toThrow(
    'Responses model',
  )
  expect(() => sources.setWebSearchModel('missing', null)).toThrow(
    'does not exist',
  )
  sources.setWebSearchModel(source.id, null)
  expect(
    sources.list().find((item) => item.id === source.id),
  ).not.toHaveProperty('webSearchModelId')
  expect(webSearchModel({ ...saved, webSearchModelId: 'gone' })?.id).toBe(
    'gpt-5.4',
  )
})

test('only Copilot sources accept a web search model', async () => {
  const sources = new SourceService(
    [],
    credentials(),
    () => {},
    () => Promise.resolve(Response.json({ data: [{ id: 'model-one' }] })),
  )
  const api = await sources.add({
    label: 'API source',
    kind: 'api',
    baseUrl: 'https://provider.example/v1',
    protocol: 'responses',
    apiKey: 'synthetic-upstream-key',
    shared: false,
  })
  expect(() => sources.setWebSearchModel(api.id, null)).toThrow(
    'Only Copilot sources',
  )
})

test('search results keep titled sources, truncate long answers and report empty searches', () => {
  expect(extractWebSearchResult([], '')).toMatchObject({ failed: true })
  expect(extractWebSearchResult([{}, null, 'x'], 'Fallback text')).toEqual({
    failed: false,
    text: 'Fallback text',
    sources: [],
  })
  const long = extractWebSearchResult([
    {
      type: 'message',
      content: [
        { type: 'output_text', text: 'a'.repeat(30_000) },
        { type: 'refusal' },
      ],
    },
  ])
  expect(long.text.endsWith('[Truncated by ModelBridge]')).toBe(true)
  const titled = extractWebSearchResult([
    {
      type: 'web_search_call',
      action: { sources: [{ url: 'https://a.example' }, { url: '' }] },
    },
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: '',
          annotations: [
            { type: 'url_citation', url: 'https://a.example', title: ' A ' },
            { type: 'url_citation', url: 'https://b.example' },
          ],
        },
      ],
    },
  ])
  expect(titled.sources).toEqual([
    { url: 'https://a.example', title: 'A' },
    { url: 'https://b.example', title: 'https://b.example' },
  ])
  expect(titled.text).toBe(
    'Sources:\n1. A - https://a.example\n2. https://b.example - https://b.example',
  )
})

test('search result cache expires entries and evicts the oldest beyond its limit', () => {
  let now = 0
  const cache = new WebSearchResultCache(() => now, 2, 100)
  cache.set('a', 'A')
  cache.set('b', 'B')
  cache.set('a', 'A2')
  cache.set('c', 'C')
  expect(cache.get('b')).toBeUndefined()
  expect(cache.get('a')).toBe('A2')
  now = 100
  expect(cache.get('c')).toBeUndefined()
  expect(cache.get('missing')).toBeUndefined()
})

function syntheticRound(
  events: Array<Record<string, unknown>>,
  searchIds: string[] = [],
) {
  const registry: MessagesToolRegistry = {
    byAlias: new Map(),
    byOriginal: new Map(),
    tools: [],
    webSearchCalls: new Set(searchIds),
  }
  return {
    registry,
    events: (async function* () {
      for (const event of events) yield event as unknown as ResponseStreamEvent
    })(),
  }
}

const created = {
  type: 'response.created',
  response: { id: 'resp_1', status: 'in_progress', output: [] },
}
const completed = (usage?: Record<string, unknown>) => ({
  type: 'response.completed',
  response: { id: 'resp_x', status: 'completed', output: [], usage },
})
const searchItem = (id: string, index: number, args: string) => [
  {
    type: 'response.output_item.added',
    output_index: index,
    item: { type: 'function_call', call_id: id, name: 'web_search' },
  },
  {
    type: 'response.function_call_arguments.delta',
    output_index: index,
    delta: args,
  },
  {
    type: 'response.output_item.done',
    output_index: index,
    item: {
      type: 'function_call',
      call_id: id,
      name: 'web_search',
      arguments: args,
    },
  },
]

test('the proxy enforces search and round limits and passes upstream failures through', async () => {
  const queries: string[] = []
  const remembered = new Map<string, string>()
  const stream = proxyWebSearch(
    syntheticRound(
      [
        created,
        ...searchItem('s1', 0, '{"query":"one"}'),
        ...searchItem('s2', 1, '{"query":"two"}'),
        ...searchItem('s3', 2, 'not json'),
        completed({
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 1 },
        }),
      ],
      ['s1', 's2', 's3'],
    ),
    {
      input: [],
      maxSearches: 1,
      maxRounds: 2,
      search: (query) => {
        queries.push(query)
        return Promise.resolve({ failed: false, text: 'ok', sources: [] })
      },
      remember: (id, text) => remembered.set(id, text),
      next: () =>
        Promise.resolve(
          syntheticRound(
            [
              created,
              ...searchItem('s4', 0, '{"query":"four"}'),
              completed({ input_tokens: 2, output_tokens: 3, total_tokens: 5 }),
            ],
            ['s4'],
          ),
        ),
    },
  )
  const result = await collectResponse(stream)
  expect(queries).toEqual(['one'])
  expect(remembered.get('s2')).toContain('limit of 1 searches')
  expect(remembered.get('s3')).toContain('did not include a query')
  expect(result.ok).toBe(true)
  expect(result.result?.id).toBe('resp_1')
  expect(result.result?.output).toHaveLength(4)
  expect(result.result?.usage).toEqual({
    input_tokens: 2,
    output_tokens: 3,
    total_tokens: 5,
  })

  const failed = await collectResponse(
    proxyWebSearch(
      syntheticRound([
        created,
        {
          type: 'response.failed',
          response: { id: 'resp_y', status: 'failed', output: [] },
        },
      ]),
      {
        input: [],
        search: () => Promise.reject(new Error('unused')),
        remember: () => {},
        next: () => Promise.reject(new Error('unused')),
      },
    ),
  )
  expect(failed).toMatchObject({ ok: false, result: { id: 'resp_1' } })

  const truncated = await collectResponse(
    proxyWebSearch(syntheticRound([created]), {
      input: [],
      search: () => Promise.reject(new Error('unused')),
      remember: () => {},
      next: () => Promise.reject(new Error('unused')),
    }),
  )
  expect(truncated).toEqual({ ok: false, result: null, message: undefined })

  const thrown = await collectResponse(
    proxyWebSearch(
      syntheticRound(
        [created, ...searchItem('s5', 0, '{"query":"x"}'), completed()],
        ['s5'],
      ),
      {
        input: [],
        search: () =>
          Promise.resolve({ failed: false, text: 'ok', sources: [] }),
        remember: () => {},
        next: () => Promise.reject(new TypeError('not an error')),
      },
    ),
  )
  expect(thrown).toMatchObject({
    ok: false,
    message: 'not an error',
  })
})
