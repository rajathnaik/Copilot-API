import { describe, expect, test } from 'bun:test'
import { CopilotProvider } from '../src/providers/copilot'
import { SourceService } from '../src/sources/source-service'
import { createGateway } from '../src/routing/gateway'
import { modelSchema, type Credentials } from '../src/contracts'
import {
  chatToResponsesRequest,
  responsesStreamToChat,
  responsesToChatResponse,
} from '../src/adapters/chat-completions'
import {
  encodeReasoningSignature,
  messagesToResponsesRequest,
  responsesStreamToMessages,
  responsesToMessagesResponse,
} from '../src/adapters/anthropic-messages'

type Json = Record<string, unknown>

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

const reasoningModel = modelSchema.parse({
  id: 'gpt',
  name: 'GPT',
  protocol: 'responses',
  reasoningEfforts: ['low', 'medium', 'high'],
})

const completed = {
  type: 'response.completed',
  response: {
    id: 'resp_1',
    status: 'completed',
    output: [],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
  },
}

const streamEvents: Json[] = [
  {
    type: 'response.created',
    response: { id: 'resp_1', created_at: 100, status: 'in_progress' },
  },
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'reasoning', id: 'rs_1', summary: [] },
  },
  {
    type: 'response.reasoning_summary_part.added',
    output_index: 0,
    summary_index: 0,
  },
  {
    type: 'response.reasoning_summary_text.delta',
    output_index: 0,
    delta: 'Plan',
  },
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'Plan' }],
      encrypted_content: 'enc-1',
    },
  },
  {
    type: 'response.output_item.added',
    output_index: 1,
    item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
  },
  { type: 'response.output_text.delta', output_index: 1, delta: 'Hello ' },
  { type: 'response.output_text.delta', output_index: 1, delta: 'world' },
  {
    type: 'response.output_item.done',
    output_index: 1,
    item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
  },
  {
    type: 'response.output_item.added',
    output_index: 2,
    item: {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '',
    },
  },
  {
    type: 'response.function_call_arguments.delta',
    output_index: 2,
    delta: '{"q":',
  },
  {
    type: 'response.function_call_arguments.delta',
    output_index: 2,
    delta: '"x"}',
  },
  {
    type: 'response.output_item.done',
    output_index: 2,
    item: {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"q":"x"}',
    },
  },
  {
    type: 'response.output_item.added',
    output_index: 3,
    item: {
      type: 'function_call',
      id: 'fc_2',
      call_id: 'call_2',
      name: 'other',
      arguments: '',
    },
  },
  {
    type: 'response.output_item.done',
    output_index: 3,
    item: {
      type: 'function_call',
      id: 'fc_2',
      call_id: 'call_2',
      name: 'other',
      arguments: '{"all":true}',
    },
  },
  completed,
]

function sse(events: Json[]): string {
  return events
    .map(
      (event) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join('')
}

function chunked(value: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value)
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
  })
}

async function collect(frames: AsyncGenerator<string>): Promise<string> {
  let output = ''
  for await (const frame of frames) output += frame
  return output
}

function dataLines(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
}

function chatSummary(output: string) {
  const lines = dataLines(output)
  let content = ''
  let reasoning = ''
  const calls: Array<{ id?: string; name?: string; arguments: string }> = []
  let finish: unknown
  let usage: unknown
  for (const line of lines) {
    if (line === '[DONE]') continue
    const chunk = JSON.parse(line) as {
      choices: Array<{ delta: Json; finish_reason: unknown }>
      usage?: unknown
    }
    if (chunk.usage) usage = chunk.usage
    for (const choice of chunk.choices) {
      if (typeof choice.delta.content === 'string')
        content += choice.delta.content
      if (typeof choice.delta.reasoning_content === 'string')
        reasoning += choice.delta.reasoning_content
      for (const call of (choice.delta.tool_calls ?? []) as Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>) {
        calls[call.index] ??= { arguments: '' }
        const entry = calls[call.index]
        if (call.id) entry.id = call.id
        if (call.function?.name) entry.name = call.function.name
        entry.arguments += call.function?.arguments ?? ''
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }
  }
  return { lines, content, reasoning, calls, finish, usage }
}

describe('Chat Completions adapter', () => {
  test('maps messages, tools and options onto a Responses request', () => {
    const request = chatToResponsesRequest(
      {
        model: 'source/gpt',
        stream: true,
        max_tokens: 4,
        reasoning_effort: 'high',
        temperature: 0.2,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'answer', schema: { type: 'object' } },
        },
        tool_choice: { type: 'function', function: { name: 'lookup' } },
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Find',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        messages: [
          { role: 'system', content: 'Be brief.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,AA' },
              },
            ],
          },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":1}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'found' },
          { role: 'developer', content: 'Late note' },
        ],
      },
      reasoningModel,
    )
    expect(request).toEqual({
      model: 'source/gpt',
      instructions: 'Be brief.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Look' },
            {
              type: 'input_image',
              image_url: 'data:image/png;base64,AA',
              detail: 'auto',
            },
          ],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"q":1}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'found' },
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Late note' }],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Find',
          parameters: { type: 'object', properties: {} },
          strict: false,
        },
      ],
      tool_choice: { type: 'function', name: 'lookup' },
      max_output_tokens: 16,
      reasoning: { effort: 'high', summary: 'auto' },
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          schema: { type: 'object' },
        },
      },
      stream: true,
      store: false,
    })
    expect(
      chatToResponsesRequest(
        {
          model: 'm',
          temperature: 0.5,
          messages: [{ role: 'user', content: 'x' }],
        },
        modelSchema.parse({ id: 'm', name: 'M', protocol: 'responses' }),
      ),
    ).toMatchObject({ temperature: 0.5 })
    expect(() =>
      chatToResponsesRequest(
        { model: 'm', n: 2, messages: [{ role: 'user', content: 'x' }] },
        reasoningModel,
      ),
    ).toThrow('one choice')
  })

  test('converts a completed response with text, reasoning, tools and usage', () => {
    const output = responsesToChatResponse(
      {
        id: 'resp_1',
        created_at: 100,
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Thought' }],
          },
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Partial' }],
          },
        ],
        usage: completed.response.usage,
      },
      'source/gpt',
    )
    expect(output).toEqual({
      id: 'chatcmpl-resp_1',
      object: 'chat.completion',
      created: 100,
      model: 'source/gpt',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Partial',
            reasoning_content: 'Thought',
          },
          finish_reason: 'length',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    })
  })

  test.each([1, 7, 64, 1 << 20])(
    'streams text, reasoning and parallel tool calls with %i-byte upstream chunks',
    async (size) => {
      const summary = chatSummary(
        await collect(
          responsesStreamToChat(
            chunked(sse(streamEvents), size),
            'source/gpt',
            true,
          ),
        ),
      )
      expect(summary.content).toBe('Hello world')
      expect(summary.reasoning).toBe('Plan')
      expect(summary.calls).toEqual([
        { id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
        { id: 'call_2', name: 'other', arguments: '{"all":true}' },
      ])
      expect(summary.finish).toBe('tool_calls')
      expect(summary.usage).toMatchObject({
        prompt_tokens: 10,
        total_tokens: 15,
      })
      expect(summary.lines.at(-1)).toBe('[DONE]')
      expect(JSON.parse(summary.lines[0])).toMatchObject({
        id: 'chatcmpl-resp_1',
        choices: [{ delta: { role: 'assistant' } }],
      })
    },
  )

  test('omits usage unless requested and reports failures without completing', async () => {
    const plain = chatSummary(
      await collect(
        responsesStreamToChat(chunked(sse(streamEvents), 64), 'm', false),
      ),
    )
    expect(plain.usage).toBeUndefined()
    const failed = dataLines(
      await collect(
        responsesStreamToChat(
          chunked(
            sse([
              streamEvents[0],
              {
                type: 'response.failed',
                response: { error: { message: 'quota exhausted' } },
              },
            ]),
            7,
          ),
          'm',
          true,
        ),
      ),
    )
    expect(JSON.parse(failed.at(-1) ?? '{}')).toEqual({
      error: { message: 'quota exhausted', type: 'api_error' },
    })
    expect(failed).not.toContain('[DONE]')
    const cut = dataLines(
      await collect(
        responsesStreamToChat(
          chunked(sse(streamEvents.slice(0, 7)), 7),
          'm',
          true,
        ),
      ),
    )
    expect(cut.at(-1)).toContain('ended before the response completed')
    expect(cut).not.toContain('[DONE]')
  })
})

describe('Anthropic Messages adapter', () => {
  test('maps Claude Code requests and round-trips reasoning through signatures', () => {
    const request = messagesToResponsesRequest(
      {
        model: 'source/gpt',
        max_tokens: 1000,
        stream: true,
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        thinking: { type: 'enabled', budget_tokens: 8000 },
        tool_choice: { type: 'any', disable_parallel_tool_use: true },
        tools: [
          {
            name: 'Read',
            description: 'Read a file',
            input_schema: { type: 'object', properties: {} },
          },
          { type: 'web_search_20250305', name: 'web_search' },
          { type: 'bash_20250124', name: 'bash' },
        ],
        messages: [
          { role: 'user', content: 'Read it' },
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'Plan',
                signature: encodeReasoningSignature('enc-1', 'rs_1'),
              },
              { type: 'thinking', thinking: 'Claude', signature: 'claude-sig' },
              { type: 'text', text: 'Reading.' },
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'Read',
                input: { path: 'a' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: 'file body',
              },
              { type: 'text', text: 'Continue' },
            ],
          },
        ],
      },
      reasoningModel,
    )
    expect(request).toEqual({
      model: 'source/gpt',
      instructions: 'You are Claude Code.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Read it' }],
        },
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Plan' }],
          encrypted_content: 'enc-1',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Reading.' }],
        },
        {
          type: 'function_call',
          call_id: 'toolu_1',
          name: 'Read',
          arguments: '{"path":"a"}',
        },
        {
          type: 'function_call_output',
          call_id: 'toolu_1',
          output: 'file body',
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Continue' }],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'Read',
          description: 'Read a file',
          parameters: { type: 'object', properties: {} },
          strict: false,
        },
        { type: 'web_search' },
      ],
      tool_choice: 'required',
      parallel_tool_calls: false,
      max_output_tokens: 12_800,
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      stream: true,
      store: false,
    })
  })

  test('converts a completed response into content blocks', () => {
    const message = responsesToMessagesResponse(
      {
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            id: 'rs_1',
            summary: [],
            encrypted_content: 'enc-1',
          },
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Done' }],
          },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'Read',
            arguments: '{"path":"a"}',
          },
        ],
        usage: completed.response.usage,
      },
      'source/gpt',
    )
    expect(message).toEqual({
      id: 'msg_resp_1',
      type: 'message',
      role: 'assistant',
      model: 'source/gpt',
      content: [
        {
          type: 'thinking',
          thinking: 'Thinking...',
          signature: encodeReasoningSignature('enc-1', 'rs_1'),
        },
        { type: 'text', text: 'Done' },
        { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 6,
        output_tokens: 5,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
      },
    })
  })

  test.each([1, 7, 64])(
    'streams Anthropic events with %i-byte upstream chunks',
    async (size) => {
      const output = await collect(
        responsesStreamToMessages(
          chunked(sse(streamEvents), size),
          'source/gpt',
        ),
      )
      const events = dataLines(output).map((line) => JSON.parse(line) as Json)
      expect(events.map((event) => event.type)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ])
      expect(events[3]).toEqual({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'signature_delta',
          signature: encodeReasoningSignature('enc-1', 'rs_1'),
        },
      })
      expect(events[13]).toMatchObject({
        index: 3,
        content_block: { type: 'tool_use', id: 'call_2', name: 'other' },
      })
      expect(events[14]).toMatchObject({
        delta: { type: 'input_json_delta', partial_json: '{"all":true}' },
      })
      expect(events[16]).toEqual({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: {
          input_tokens: 6,
          output_tokens: 5,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 0,
        },
      })
      expect(output).toContain('event: message_stop\n')
    },
  )
})

describe('gateway protocol routing', () => {
  async function copilotGateway() {
    const vault = credentials()
    const upstream: Array<{ url: string; headers: Headers; body: Json }> = []
    const provider = new CopilotProvider(vault, (url, init) => {
      if (url.endsWith('/token'))
        return Promise.resolve(
          Response.json({
            token: 'synthetic',
            refresh_in: 120,
            expires_at: 1000,
          }),
        )
      if (url.endsWith('/models'))
        return Promise.resolve(
          Response.json({
            data: [
              {
                id: 'gpt',
                supported_endpoints: ['/responses'],
                capabilities: {
                  supports: { reasoning_effort: ['low', 'medium', 'high'] },
                },
              },
              {
                id: 'claude',
                supported_endpoints: ['/v1/messages', '/chat/completions'],
              },
            ],
          }),
        )
      if (typeof init?.body !== 'string') throw new Error('Expected a body.')
      const body = JSON.parse(init.body) as Json
      upstream.push({ url, headers: new Headers(init.headers), body })
      if (url.endsWith('/responses'))
        return Promise.resolve(
          body.stream ?
            new Response(sse(streamEvents), {
              headers: { 'content-type': 'text/event-stream' },
            })
          : Response.json({
              id: 'resp_2',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: 'Hi' }],
                },
              ],
              usage: completed.response.usage,
            }),
        )
      if (url.endsWith('/chat/completions'))
        return Promise.resolve(
          new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n'
              + 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n'
              + 'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        )
      return Promise.resolve(
        Response.json({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'native' }],
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
      )
    })
    const sources = new SourceService([], vault, () => {}, fetch, provider)
    const source = await sources.addCopilot('synthetic-github', 'Copilot', true)
    return { sources, source, upstream }
  }

  test('serves every protocol for Copilot models, natively where Copilot can', async () => {
    const { sources, source, upstream } = await copilotGateway()
    expect(
      source.models.map((model) => [model.id, model.nativeProtocols]),
    ).toEqual([
      ['gpt', ['responses']],
      ['claude', ['messages', 'chat-completions']],
    ])
    const gateway = createGateway(sources, 'local')
    const listed = (await (
      await gateway.request('/v1/models', {
        headers: { Authorization: 'Bearer local' },
      })
    ).json()) as { data: Array<{ modelbridge: { protocols: string[] } }> }
    expect(listed.data.map((model) => model.modelbridge.protocols)).toEqual([
      ['responses', 'messages', 'chat-completions'],
      ['responses', 'messages', 'chat-completions'],
    ])

    const chat = await gateway.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer local' },
      body: JSON.stringify({
        model: `${source.id}/gpt`,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(chat.status).toBe(200)
    expect(chatSummary(await chat.text())).toMatchObject({
      content: 'Hello world',
      finish: 'tool_calls',
    })
    expect(upstream.at(-1)?.url).toMatch(/\/responses$/u)
    expect(upstream.at(-1)).toMatchObject({
      body: { model: 'gpt', store: false, reasoning: { summary: 'auto' } },
    })

    const native = await gateway.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer local' },
      body: JSON.stringify({
        model: `${source.id}/claude`,
        stream: true,
        tools: [
          {
            type: 'function',
            function: {
              name: 'pick',
              parameters: {
                anyOf: [
                  { type: 'object', properties: { a: { type: 'string' } } },
                ],
              },
            },
          },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    const nativeText = await native.text()
    expect(nativeText).toContain('"content":"ok"')
    expect(nativeText).not.toContain('usage')
    const nativeCall = upstream.at(-1)
    expect(nativeCall?.url).toMatch(/\/chat\/completions$/u)
    expect(nativeCall?.body.stream_options).toEqual({ include_usage: true })
    expect(nativeCall?.headers.get('x-initiator')).toBe('user')
    expect(
      (nativeCall?.body.tools as Array<{ function: { parameters: Json } }>)[0]
        .function.parameters,
    ).not.toHaveProperty('anyOf')

    const messages = await gateway.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'local' },
      body: JSON.stringify({
        model: `${source.id}/claude`,
        max_tokens: 100,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'x',
                signature: encodeReasoningSignature('enc', 'rs'),
              },
              { type: 'text', text: 'Earlier' },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }],
          },
        ],
      }),
    })
    expect(await messages.json()).toMatchObject({
      content: [{ type: 'text', text: 'native' }],
    })
    const messagesCall = upstream.at(-1)
    expect(messagesCall?.url).toMatch(/\/v1\/messages$/u)
    expect(messagesCall?.headers.get('x-initiator')).toBe('agent')
    expect(messagesCall?.body.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier' }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }],
      },
    ])

    const hubbed = await gateway.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'local' },
      body: JSON.stringify({
        model: `${source.id}/gpt`,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(await hubbed.json()).toMatchObject({
      id: 'msg_resp_2',
      model: `${source.id}/gpt`,
      content: [{ type: 'text', text: 'Hi' }],
      stop_reason: 'end_turn',
    })
  })

  test('remote clients forward advertised protocols to the host unchanged', async () => {
    const { sources: hostSources } = await copilotGateway()
    const host = createGateway(hostSources, 'host', true)
    const paths: string[] = []
    const consumerSources = new SourceService(
      [],
      credentials(),
      () => {},
      async (url, init) => {
        paths.push(new URL(url).pathname)
        return host.request(new URL(url).pathname, init)
      },
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
    const model = consumerSources
      .models()
      .find((item) => item.id.endsWith('/claude'))
    expect(model?.protocols).toEqual([
      'responses',
      'messages',
      'chat-completions',
    ])
    const response = await consumer.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer consumer' },
      body: JSON.stringify({
        model: model?.id,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(await response.text()).toContain('"content":"ok"')
    expect(paths.at(-1)).toBe('/v1/chat/completions')
  })

  test('uses Anthropic errors and auth for Messages clients and estimates tokens', async () => {
    const { sources, source } = await copilotGateway()
    const gateway = createGateway(sources, 'local')
    const denied = await gateway.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'wrong' },
      body: '{}',
    })
    expect(denied.status).toBe(401)
    expect(await denied.json()).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Gateway authentication required.',
      },
    })
    const invalid = await gateway.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'local' },
      body: JSON.stringify({ model: `${source.id}/gpt`, messages: [] }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error' },
    })
    const counted = await gateway.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'x-api-key': 'local' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'x'.repeat(400) }],
      }),
    })
    expect(
      ((await counted.json()) as { input_tokens: number }).input_tokens,
    ).toBeGreaterThan(100)
  })
})
