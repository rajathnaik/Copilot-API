import { expect, test } from 'bun:test'
import { CopilotProvider } from '../src/providers/copilot'
import { SourceService } from '../src/sources/source-service'
import { createGateway } from '../src/routing/gateway'
import type { Credentials } from '../src/contracts'

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
const catalog = {
  data: [
    {
      id: 'gpt',
      name: 'GPT',
      supported_endpoints: ['/responses'],
      capabilities: {
        supports: {
          tool_calls: true,
          reasoning_effort: ['low', 'medium', 'high'],
        },
        limits: { max_context_window_tokens: 32000 },
      },
    },
    {
      id: 'claude',
      name: 'Claude',
      supported_endpoints: ['/v1/messages'],
      capabilities: { supports: { tool_calls: true } },
    },
    { id: 'chat-only', supported_endpoints: ['/chat/completions'] },
    {
      id: 'disabled',
      policy: { state: 'disabled' },
      supported_endpoints: ['/responses'],
    },
    { id: 'embedding', capabilities: { type: 'embeddings' } },
  ],
}
test('direct Copilot uses the inherited token exchange, endpoint discovery, headers and relative refresh schedule', async () => {
  const vault = credentials()
  let now = 1000
  let exchanges = 0
  const calls: Array<{
    url: string
    headers: Headers
    body?: Record<string, unknown>
  }> = []
  const provider = new CopilotProvider(
    vault,
    async (url, init) => {
      const headers = new Headers(init?.headers)
      const body =
        typeof init?.body === 'string' ?
          (JSON.parse(init.body) as Record<string, unknown>)
        : undefined
      calls.push({ url, headers, body })
      expect(init?.redirect).toBe('error')
      if (url.endsWith('/copilot_internal/v2/token')) {
        exchanges++
        expect(headers.get('authorization')).toBe('token synthetic-github')
        return Response.json({
          token: `synthetic-copilot-${exchanges}`,
          refresh_in: 120,
          expires_at: 999999,
          endpoints: { api: 'https://api.business.githubcopilot.com' },
        })
      }
      if (url.endsWith('/models')) return Response.json(catalog)
      expect(url).toBe('https://api.business.githubcopilot.com/responses')
      expect(headers.get('copilot-integration-id')).toBe('vscode-chat')
      expect(headers.get('editor-plugin-version')).toBe('copilot-chat/0.67.0')
      expect(headers.get('x-interaction-id')).toBe('conversation-1')
      expect(body).not.toHaveProperty('service_tier')
      return new Response('data: synthetic\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
    () => now,
  )
  const sourceService = new SourceService([], vault, () => {}, fetch, provider)
  const source = await sourceService.addCopilot(
    'synthetic-github',
    'Copilot',
    true,
  )
  expect(
    source.models.map((model) => [
      model.id,
      model.protocol,
      model.upstreamProtocol,
    ]),
  ).toEqual([
    ['gpt', 'responses', 'responses'],
    ['claude', 'responses', 'messages'],
    ['chat-only', 'responses', 'chat-completions'],
  ])
  const gateway = createGateway(sourceService, 'local')
  for (const time of [1000, 1000, 62000]) {
    now = time
    const response = await gateway.request('/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer local', session_id: 'conversation-1' },
      body: JSON.stringify({
        model: `${source.id}/gpt`,
        input: [
          { type: 'function_call_output', call_id: 'call-1', output: 'done' },
        ],
        stream: true,
        service_tier: 'auto',
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('synthetic')
  }
  expect(exchanges).toBe(3)
  expect(
    calls
      .filter((call) => call.url.endsWith('/responses'))
      .every((call) => call.headers.get('x-initiator') === 'agent'),
  ).toBe(true)
})
test('chat-only Copilot models are translated with inherited Messages/Chat converters without inventing completion on an interrupted stream', async () => {
  const vault = credentials()
  let interrupted = false
  let requestBody: Record<string, unknown> | undefined
  const provider = new CopilotProvider(vault, (url, init) => {
    if (url.endsWith('/token'))
      return Promise.resolve(
        Response.json({
          token: 'synthetic',
          refresh_in: 120,
          expires_at: 1000,
        }),
      )
    if (url.endsWith('/models')) return Promise.resolve(Response.json(catalog))
    expect(url).toBe('https://api.githubcopilot.com/chat/completions')
    if (typeof init?.body !== 'string')
      throw new Error('Expected a JSON request.')
    requestBody = JSON.parse(init.body) as Record<string, unknown>
    const chunks = [
      {
        id: 'chat-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'chat-only',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Hello from chat-only' },
            finish_reason: null,
          },
        ],
      },
      ...(interrupted ?
        []
      : [
          {
            id: 'chat-1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'chat-only',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
          {
            id: 'chat-1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'chat-only',
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
          },
        ]),
    ]
    return Promise.resolve(
      new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    )
  })
  const sources = new SourceService([], vault, () => {}, fetch, provider)
  const source = await sources.addCopilot('synthetic-github', 'Copilot', true)
  const gateway = createGateway(sources, 'local')
  for (const broken of [false, true]) {
    interrupted = broken
    const response = await gateway.request('/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer local' },
      body: JSON.stringify({
        model: `${source.id}/chat-only`,
        input: 'Say hello',
        reasoning: { effort: 'high' },
        stream: true,
      }),
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(requestBody).toMatchObject({
      model: 'chat-only',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Say hello' }] },
      ],
      stream_options: { include_usage: true },
      reasoning_effort: 'high',
    })
    expect(text).toContain('Hello from chat-only')
    expect(text).toContain(broken ? 'response.failed' : 'response.completed')
    if (broken) expect(text).not.toContain('response.completed')
  }
})
test('Copilot remote hops retain session affinity and last-turn initiator semantics without forwarding client auth or arbitrary headers', async () => {
  const vault = credentials()
  const forwarded: Array<{ headers: Headers; body: Record<string, unknown> }> =
    []
  const provider = new CopilotProvider(vault, (url, init) => {
    if (url.endsWith('/token'))
      return Promise.resolve(
        Response.json({
          token: 'synthetic',
          refresh_in: 120,
          expires_at: 1000,
        }),
      )
    if (url.endsWith('/models')) return Promise.resolve(Response.json(catalog))
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON body.')
    forwarded.push({
      headers: new Headers(init.headers),
      body: JSON.parse(init.body) as Record<string, unknown>,
    })
    return Promise.resolve(Response.json({ output: [] }))
  })
  const hostSources = new SourceService([], vault, () => {}, fetch, provider)
  await hostSources.addCopilot('synthetic-github', 'Copilot', true)
  const host = createGateway(hostSources, 'host', true)
  const consumerSources = new SourceService(
    [],
    credentials(),
    () => {},
    async (url, init) => host.request(new URL(url).pathname, init),
  )
  await consumerSources.add({
    label: 'Host',
    kind: 'remote',
    baseUrl: 'https://host.example',
    protocol: 'responses',
    apiKey: 'host',
    shared: false,
  })
  const consumer = createGateway(consumerSources, 'consumer')
  const model = consumerSources.models()[0]
  expect(model.reasoningEfforts).toEqual(['low', 'medium', 'high'])
  for (const role of ['user', 'assistant']) {
    const response = await consumer.request('/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer consumer',
        session_id: 'conversation-exact',
        'x-untrusted': 'must-not-forward',
      },
      body: JSON.stringify({
        model: model.id,
        reasoning: { effort: 'xhigh' },
        input: [
          {
            type: 'function_call_output',
            call_id: 'old',
            output: 'old output',
          },
          { role, content: 'new turn' },
        ],
      }),
    })
    expect(response.status).toBe(200)
    const last = forwarded.at(-1)
    expect(last?.headers.get('x-initiator')).toBe(
      role === 'user' ? 'user' : 'agent',
    )
    expect(last?.headers.get('x-interaction-id')).toBe('conversation-exact')
    expect(last?.headers.get('authorization')).toBe('Bearer synthetic')
    expect(last?.headers.has('x-untrusted')).toBe(false)
    expect(last?.body.reasoning).toEqual({ effort: 'high' })
  }
  expect(
    (
      await consumer.request('/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer consumer',
          session_id: 'a'.repeat(257),
        },
        body: JSON.stringify({ model: model.id }),
      })
    ).status,
  ).toBe(400)
})
test('device sign-in honours authorization_pending, slow_down and explicit cancellation', async () => {
  let now = 0
  const sleeps: number[] = []
  let polls = 0
  const provider = new CopilotProvider(
    credentials(),
    (url) =>
      Promise.resolve(
        Response.json(
          url.endsWith('/device/code') ?
            {
              device_code: 'device',
              user_code: 'ABCD-EFGH',
              verification_uri: 'https://github.com/login/device',
              expires_in: 100,
              interval: 2,
            }
          : ++polls === 1 ? { error: 'slow_down', interval: 8 }
          : polls === 2 ? { error: 'authorization_pending' }
          : { access_token: 'synthetic-github' },
        ),
      ),
    () => now,
    async (ms) => {
      sleeps.push(ms)
      now += ms
    },
  )
  const auth = await provider.beginLogin(new AbortController().signal)
  expect(auth.login.code).toBe('ABCD-EFGH')
  expect(await auth.complete()).toBe('synthetic-github')
  expect(sleeps).toEqual([3000, 9000, 9000])
  const controller = new AbortController()
  const cancelled = await provider.beginLogin(controller.signal)
  controller.abort(new Error('cancelled'))
  expect(cancelled.complete()).rejects.toThrow('cancelled')
})
test('device sign-in expiry, denial and cancellation before source persistence never create a source', async () => {
  for (const outcome of ['expired', 'denied', 'cancelled']) {
    let now = 0
    const controller = new AbortController()
    const vault = credentials()
    const provider = new CopilotProvider(
      vault,
      (url) => {
        if (url.endsWith('/device/code'))
          return Promise.resolve(
            Response.json({
              device_code: 'device',
              user_code: 'ABCD',
              verification_uri: 'https://github.com/login/device',
              expires_in: 2,
              interval: 1,
            }),
          )
        if (url.endsWith('/access_token'))
          return Promise.resolve(
            Response.json({
              error: 'access_denied',
              error_description: 'Access denied',
            }),
          )
        if (url.endsWith('/token'))
          return Promise.resolve(
            Response.json({
              token: 'synthetic',
              refresh_in: 120,
              expires_at: 1000,
            }),
          )
        controller.abort(new Error('Cancelled before saving'))
        return Promise.resolve(Response.json(catalog))
      },
      () => now,
      async (ms) => {
        now += outcome === 'denied' ? 0 : ms
      },
    )
    if (outcome === 'cancelled') {
      const sources = new SourceService(
        [],
        vault,
        () => {
          throw new Error('Persistence must not run')
        },
        fetch,
        provider,
      )
      await expect(
        sources.addCopilot(
          'synthetic-github',
          'Copilot',
          true,
          controller.signal,
        ),
      ).rejects.toThrow('Cancelled before saving')
      expect(sources.list()).toHaveLength(0)
    } else {
      const auth = await provider.beginLogin(controller.signal)
      await expect(auth.complete()).rejects.toThrow(
        outcome === 'expired' ? 'expired' : 'Access denied',
      )
    }
  }
})
test('simultaneous Copilot requests coalesce token refresh and failed catalog refresh preserves the saved source and key', async () => {
  const vault = credentials()
  let now = 0
  let fail = false
  let exchanges = 0
  const provider = new CopilotProvider(
    vault,
    async (url) => {
      if (url.endsWith('/token')) {
        exchanges++
        await Bun.sleep(5)
        return Response.json({
          token: 'synthetic',
          refresh_in: 120,
          expires_at: 1000,
        })
      }
      if (url.endsWith('/models'))
        return fail ?
            new Response('denied', { status: 403 })
          : Response.json(catalog)
      return Response.json({ output: [] })
    },
    () => now,
  )
  const sources = new SourceService([], vault, () => {}, fetch, provider)
  const source = await sources.addCopilot('synthetic-github', 'Copilot', true)
  const gateway = createGateway(sources, 'local')
  for (const time of [0, 61_000]) {
    now = time
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        gateway.request('/v1/responses', {
          method: 'POST',
          headers: { Authorization: 'Bearer local' },
          body: JSON.stringify({ model: `${source.id}/gpt`, input: 'hello' }),
        }),
      ),
    )
    expect(results.every((response) => response.status === 200)).toBe(true)
  }
  expect(exchanges).toBe(3)
  fail = true
  await expect(sources.refresh(source.id)).rejects.toThrow('HTTP 403')
  expect(sources.list()).toEqual([source])
  expect(vault.get(source.id)).toBe('synthetic-github')
})
test('non-streaming adapters, input validation and upstream authentication errors retain exact status and redact both tokens', async () => {
  for (const upstream of ['messages', 'chat-completions'] as const) {
    const vault = credentials()
    let mode = 'reply'
    const provider = new CopilotProvider(vault, (url) => {
      if (url.endsWith('/token'))
        return Promise.resolve(
          Response.json({
            token: 'synthetic-copilot',
            refresh_in: 120,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
        )
      if (url.endsWith('/models'))
        return Promise.resolve(Response.json(catalog))
      if (mode === 'denied')
        return Promise.resolve(
          new Response('synthetic-copilot synthetic-github', {
            status: 429,
            headers: { 'Retry-After': '2' },
          }),
        )
      if (mode === 'malformed')
        return Promise.resolve(Response.json({ invalid: true }))
      return Promise.resolve(
        Response.json(
          upstream === 'messages' ?
            {
              id: 'msg',
              type: 'message',
              role: 'assistant',
              model: 'claude',
              content: [{ type: 'text', text: 'NON_STREAM_OK' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 2 },
            }
          : {
              id: 'chat',
              object: 'chat.completion',
              created: 1,
              model: 'chat-only',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'NON_STREAM_OK' },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 2,
                total_tokens: 3,
              },
            },
        ),
      )
    })
    const sources = new SourceService([], vault, () => {}, fetch, provider)
    const source = await sources.addCopilot('synthetic-github', 'Copilot', true)
    const gateway = createGateway(sources, 'local')
    const request = (input: unknown = 'hello') =>
      gateway.request('/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer local' },
        body: JSON.stringify({
          model: `${source.id}/${upstream === 'messages' ? 'claude' : 'chat-only'}`,
          input,
          stream: false,
        }),
      })
    const response = await request()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      object: 'response',
      status: 'completed',
      output_text: 'NON_STREAM_OK',
    })
    expect((await request(10)).status).toBe(400)
    mode = 'malformed'
    expect((await request()).status).toBe(502)
    mode = 'denied'
    const denied = await request()
    expect(denied.status).toBe(429)
    expect(denied.headers.get('retry-after')).toBe('2')
    expect(await denied.text()).toBe('[redacted] [redacted]')
  }
})
test('untrusted token endpoints, policy failures and malformed catalogs do not create sources or leak credentials', async () => {
  for (const endpoint of [
    'https://evil.example',
    'http://api.githubcopilot.com',
    'https://api.githubcopilot.com/path',
  ]) {
    const provider = new CopilotProvider(credentials(), () =>
      Promise.resolve(
        Response.json({
          token: 'secret',
          refresh_in: 120,
          expires_at: 1000,
          endpoints: { api: endpoint },
        }),
      ),
    )
    expect(provider.discover('github-secret')).rejects.toThrow('endpoint')
  }
  const vault = credentials()
  const provider = new CopilotProvider(vault, () =>
    Promise.resolve(new Response('secret', { status: 403 })),
  )
  const sources = new SourceService([], vault, () => {}, fetch, provider)
  expect(sources.addCopilot('github-secret', 'Copilot', true)).rejects.toThrow(
    'HTTP 403',
  )
  expect(sources.list()).toEqual([])
})
test('Copilot Responses-to-Messages reuses the original translator and completes native tool-call streams', async () => {
  const vault = credentials()
  let translated: Record<string, unknown> | undefined
  const provider = new CopilotProvider(vault, (url, init) => {
    if (url.endsWith('/token'))
      return Promise.resolve(
        Response.json({
          token: 'synthetic',
          refresh_in: 120,
          expires_at: 1000,
        }),
      )
    if (url.endsWith('/models')) return Promise.resolve(Response.json(catalog))
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')
    if (typeof init?.body !== 'string')
      throw new Error('Expected a JSON request body.')
    translated = JSON.parse(init.body) as Record<string, unknown>
    const chunks = [
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_1',
          name: 'exec_command',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"cmd":"echo safe"}',
        },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: 'message_stop' },
    ]
    return Promise.resolve(
      new Response(
        chunks
          .map(
            (chunk) =>
              `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`,
          )
          .join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    )
  })
  const sources = new SourceService([], vault, () => {}, fetch, provider)
  const source = await sources.addCopilot('synthetic-github', 'Copilot', true)
  const response = await createGateway(sources, 'local').request(
    '/v1/responses',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer local' },
      body: JSON.stringify({
        model: `${source.id}/claude`,
        input: 'Run a harmless command',
        stream: true,
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
            },
          },
        ],
      }),
    },
  )
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(translated).toMatchObject({
    model: 'claude',
    stream: true,
    messages: [{ role: 'user' }],
  })
  expect(text).toContain('"type":"function_call"')
  expect(text).toContain('response.output_item.done')
  expect(text).toContain('response.completed')
})
