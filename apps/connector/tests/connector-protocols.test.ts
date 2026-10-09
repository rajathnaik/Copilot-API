import { describe, expect, test } from 'bun:test'
import {
  discoverStandardGateway,
  verifyStandardStreamingTools,
  type ConnectorFetch,
  type GatewayDiscovery,
} from '../electron/connector/gateway'

const input = {
  url: 'https://example.devtunnels.ms/v1/',
  apiKey: 'synthetic-protocol-test-key',
}
const discovery: GatewayDiscovery = {
  baseUrl: 'https://example.devtunnels.ms',
  models: [],
  defaultModel: 'test-model',
  catalogMode: 'configured',
  catalog: '{}',
  excludedModels: [],
}

function frame(value: unknown): string {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
}

function stream(values: unknown[], type = 'text/event-stream'): Response {
  return new Response(values.map(frame).join(''), {
    headers: { 'content-type': type },
  })
}

function messageEvents() {
  return [
    {
      type: 'message_start',
      message: {
        id: 'message-probe',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'probe-1',
        name: 'connector_probe',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"ok":' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: 'true}' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}

function chatEvents() {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                type: 'function',
                id: 'probe-1',
                function: { name: 'connector_probe', arguments: '{"ok":' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: 'true}' },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]
}

describe('protocol-specific gateway discovery', () => {
  const models = [
    {
      id: 'copilot/claude-sonnet-test',
      display_name: 'Claude Sonnet',
      description: 'Messages-compatible model',
      capabilities: {
        supports: { tool_calls: true, vision: true, reasoning: false },
        limits: {
          max_context_window_tokens: 200_000,
          max_output_tokens: 16_384,
        },
      },
    },
    { id: 'gpt-test', name: 'GPT', context_window: 128_000 },
    { id: 'gpt-test' },
    { id: 'embedding', capabilities: { type: 'embeddings' } },
    { id: 'no-tools', capabilities: { supports: { tool_calls: false } } },
  ]

  for (const protocol of ['anthropic-messages', 'chat-completions'] as const) {
    test(`${protocol} uses ordinary discovery, not the Codex catalog`, async () => {
      const calls: string[] = []
      const fetcher: ConnectorFetch = async (url, options) => {
        calls.push(url)
        expect(options?.redirect).toBe('error')
        expect(new Headers(options?.headers).get('authorization')).toBe(
          `Bearer ${input.apiKey}`,
        )
        expect(new Headers(options?.headers).get('user-agent')).toBe(
          'Copilot-API-Connector',
        )
        return Response.json({ data: models })
      }
      const result = await discoverStandardGateway(input, protocol, fetcher)
      expect(calls).toEqual([`${discovery.baseUrl}/v1/models`])
      expect(result.catalogMode).toBe('configured')
      expect(result.models).toHaveLength(2)
      expect(result.models[0]).toMatchObject({
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
        vision: true,
        reasoning: false,
      })
      expect(result.defaultModel).toBe(
        protocol === 'anthropic-messages' ?
          'copilot/claude-sonnet-test'
        : 'gpt-test',
      )
      expect(result.excludedModels).toEqual(['embedding', 'no-tools'])
    })
  }

  test('does not invent unknown model limits', async () => {
    const result = await discoverStandardGateway(
      input,
      'chat-completions',
      async () => Response.json({ data: [{ id: 'custom' }] }),
    )
    expect(result.models[0]).toEqual({
      id: 'custom',
      name: 'custom',
      contextWindow: 0,
      description: '',
    })
    expect(result.defaultModel).toBe('custom')
  })

  test('rejects invalid model identifiers and missing chat models', async () => {
    for (const data of [[{ id: '' }], [{ id: 4 }], []]) {
      await expect(
        discoverStandardGateway(input, 'chat-completions', async () =>
          Response.json({ data }),
        ),
      ).rejects.toThrow()
    }
  })
})

describe('Anthropic Messages transport', () => {
  test('uses the exact endpoint, headers and tool schema', async () => {
    await verifyStandardStreamingTools(
      discovery,
      'anthropic-messages',
      'claude-test',
      input.apiKey,
      async (url, options) => {
        expect(url).toBe(`${discovery.baseUrl}/v1/messages`)
        const headers = new Headers(options?.headers)
        expect(headers.get('x-api-key')).toBe(input.apiKey)
        expect(headers.has('authorization')).toBe(false)
        expect(headers.get('anthropic-version')).toBe('2023-06-01')
        if (typeof options?.body !== 'string')
          throw new Error('Expected a JSON request body.')
        const body: unknown = JSON.parse(options.body)
        expect(body).toMatchObject({
          model: 'claude-test',
          stream: true,
          max_tokens: 4096,
          tools: [
            {
              name: 'connector_probe',
              input_schema: { type: 'object', required: ['ok'] },
            },
          ],
          tool_choice: { type: 'tool', name: 'connector_probe' },
        })
        return stream(messageEvents())
      },
    )
  })

  test('handles CRLF and complete initial tool inputs', async () => {
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'message-probe',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'probe-1',
          name: 'connector_probe',
          input: { ok: true },
        },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]
    await verifyStandardStreamingTools(
      discovery,
      'anthropic-messages',
      'claude-test',
      input.apiKey,
      async () =>
        new Response(events.map(frame).join('').replace(/\n/g, '\r\n'), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
  })

  test('rejects truncated streams, wrong protocol and missing tool stops', async () => {
    const events = messageEvents()
    for (const values of [
      events.slice(0, -1),
      events.filter((event) => event.type !== 'content_block_stop'),
      events.filter((event) => event.type !== 'message_delta'),
      chatEvents(),
      [{ type: 'error', error: { message: input.apiKey } }],
    ]) {
      await expect(
        verifyStandardStreamingTools(
          discovery,
          'anthropic-messages',
          'test',
          input.apiKey,
          async () => stream(values),
        ),
      ).rejects.toThrow()
    }
  })

  test('rejects duplicate starts and out-of-order tool deltas', async () => {
    const events = messageEvents()
    for (const values of [
      [events[1], ...events],
      [events[2], ...events],
      [...events.slice(0, 5), events[2], ...events.slice(5)],
    ]) {
      await expect(
        verifyStandardStreamingTools(
          discovery,
          'anthropic-messages',
          'test',
          input.apiKey,
          async () => stream(values),
        ),
      ).rejects.toThrow()
    }
  })

  test('requires native model and usage metadata rather than just a tool-shaped stream', async () => {
    const events = messageEvents()
    for (const message of [
      { id: 'msg', type: 'message', role: 'assistant', content: [] },
      {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        usage: { input_tokens: -1, output_tokens: 0 },
      },
    ]) {
      await expect(
        verifyStandardStreamingTools(
          discovery,
          'anthropic-messages',
          'claude-test',
          input.apiKey,
          async () =>
            stream([{ type: 'message_start', message }, ...events.slice(1)]),
        ),
      ).rejects.toThrow('message start')
    }
    await expect(
      verifyStandardStreamingTools(
        discovery,
        'anthropic-messages',
        'claude-test',
        input.apiKey,
        async () =>
          stream([
            ...events.slice(0, -2),
            { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
            events.at(-1),
          ]),
      ),
    ).rejects.toThrow('usage')
  })
})

describe('OpenAI Chat Completions transport', () => {
  test('uses the exact endpoint, Bearer auth and nested function schema', async () => {
    await verifyStandardStreamingTools(
      discovery,
      'chat-completions',
      'gpt-test',
      input.apiKey,
      async (url, options) => {
        expect(url).toBe(`${discovery.baseUrl}/v1/chat/completions`)
        const headers = new Headers(options?.headers)
        expect(headers.get('authorization')).toBe(`Bearer ${input.apiKey}`)
        expect(headers.has('x-api-key')).toBe(false)
        if (typeof options?.body !== 'string')
          throw new Error('Expected a JSON request body.')
        const body: unknown = JSON.parse(options.body)
        expect(body).toMatchObject({
          model: 'gpt-test',
          stream: true,
          tools: [
            {
              type: 'function',
              function: { name: 'connector_probe', strict: true },
            },
          ],
          tool_choice: {
            type: 'function',
            function: { name: 'connector_probe' },
          },
        })
        return stream(chatEvents())
      },
    )
  })

  test('rejects truncated streams, wrong protocol and incorrect arguments', async () => {
    const events = chatEvents()
    for (const values of [
      events.slice(0, -1),
      [events[0], events[1], '[DONE]'],
      messageEvents(),
      [{ error: { message: input.apiKey } }, '[DONE]'],
      [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      name: 'connector_probe',
                      arguments: '{"ok":false}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        '[DONE]',
      ],
    ]) {
      await expect(
        verifyStandardStreamingTools(
          discovery,
          'chat-completions',
          'test',
          input.apiKey,
          async () => stream(values),
        ),
      ).rejects.toThrow()
    }
  })
})

test('standard probes reject non-streaming responses and malformed JSON', async () => {
  for (const protocol of ['anthropic-messages', 'chat-completions'] as const) {
    for (const response of [stream([], 'text/html'), stream(['not-json'])]) {
      await expect(
        verifyStandardStreamingTools(
          discovery,
          protocol,
          'test',
          input.apiKey,
          async () => response,
        ),
      ).rejects.toThrow()
    }
  }
})
