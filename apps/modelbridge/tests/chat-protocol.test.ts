import { expect, test } from 'bun:test'
import {
  buildRequest,
  createStreamParser,
  curlSnippet,
  keyPlaceholder,
  parseErrorBody,
  parseReply,
  probeRequest,
  pythonSnippet,
} from '../src/chat-protocol'

const turns = [
  { role: 'user' as const, text: 'Hi' },
  { role: 'assistant' as const, text: 'Hello' },
  { role: 'user' as const, text: 'Again' },
]

test('requests are shaped for each protocol with system prompts and effort', () => {
  const chat = buildRequest('chat-completions', {
    model: 'gpt-x',
    system: ' Be brief ',
    turns,
    maxTokens: 100,
    effort: 'low',
    stream: true,
  })
  expect(chat.path).toBe('/v1/chat/completions')
  expect(chat.body).toEqual({
    model: 'gpt-x',
    messages: [
      { role: 'system', content: 'Be brief' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Again' },
    ],
    max_tokens: 100,
    reasoning_effort: 'low',
    stream: true,
    stream_options: { include_usage: true },
  })

  const messages = buildRequest('messages', {
    model: 'claude-x',
    system: 'Be brief',
    turns,
    maxTokens: 100,
    effort: 'medium',
    stream: false,
  })
  expect(messages.path).toBe('/v1/messages')
  expect(messages.body).toMatchObject({
    system: 'Be brief',
    max_tokens: 8192 + 1024,
    thinking: { type: 'enabled', budget_tokens: 8192 },
    stream: false,
  })
  expect(
    buildRequest('messages', { model: 'c', turns, maxTokens: 50, stream: true })
      .body,
  ).not.toHaveProperty('thinking')

  const responses = buildRequest('responses', {
    model: 'gpt-x',
    turns,
    maxTokens: 64,
    effort: 'high',
    stream: true,
  })
  expect(responses.path).toBe('/v1/responses')
  expect(responses.body).toMatchObject({
    max_output_tokens: 64,
    reasoning: { effort: 'high', summary: 'auto' },
    store: false,
  })
  expect(responses.body.input).toEqual([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Hi' }],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello' }],
    },
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Again' }],
    },
  ])
})

test('probes stay cheap and give reasoning models room to answer', () => {
  expect(
    probeRequest('chat-completions', { id: 'm', reasoningEfforts: undefined })
      .body,
  ).toMatchObject({ max_tokens: 32, stream: true })
  const reasoning = probeRequest('responses', {
    id: 'm',
    reasoningEfforts: ['minimal', 'high'],
  })
  expect(reasoning.body).toMatchObject({
    max_output_tokens: 1024,
    reasoning: { effort: 'minimal' },
  })
  expect(
    probeRequest('messages', { id: 'c', reasoningEfforts: ['low'] }).body,
  ).not.toHaveProperty('thinking')
})

test('complete replies are read for each protocol', () => {
  expect(
    parseReply('chat-completions', {
      choices: [{ message: { content: 'OK', reasoning_content: 'think' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    }),
  ).toEqual({
    text: 'OK',
    reasoning: 'think',
    usage: { inputTokens: 5, outputTokens: 1 },
  })
  expect(
    parseReply('messages', {
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'O' },
        { type: 'text', text: 'K' },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
  ).toEqual({
    text: 'OK',
    reasoning: 'hmm',
    usage: { inputTokens: 3, outputTokens: 2 },
  })
  expect(
    parseReply('responses', {
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'why' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'OK' }] },
      ],
      usage: { input_tokens: 4, output_tokens: 1 },
    }),
  ).toEqual({
    text: 'OK',
    reasoning: 'why',
    usage: { inputTokens: 4, outputTokens: 1 },
  })
  expect(
    parseReply('responses', { error: { message: ' Model not allowed ' } })
      .error,
  ).toBe('Model not allowed')
})

test('error bodies show the gateway message, raw text or the status', () => {
  expect(parseErrorBody('{"error":{"message":"Bad key"}}', 401)).toBe('Bad key')
  expect(parseErrorBody('{"error":"Not shared"}', 403)).toBe('Not shared')
  expect(parseErrorBody('upstream down', 502)).toBe('upstream down')
  expect(parseErrorBody('  ', 500)).toBe('Request failed with HTTP 500.')
})

test('stream parsers handle events split across chunks', () => {
  const chat = createStreamParser('chat-completions')
  const chatStream = [
    'data: {"choices":[{"delta":{"reasoning_content":"r"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"O"}}]}\n\ndata: {"choi',
    'ces":[{"delta":{"content":"K"}}]}\r\n\r\n',
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ]
  for (const chunk of chatStream) chat.push(chunk)
  expect(chat.finish()).toEqual({
    text: 'OK',
    reasoning: 'r',
    usage: { inputTokens: 7, outputTokens: 2 },
  })

  const messages = createStreamParser('messages')
  messages.push(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}\n\n'
      + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"t"}}\n\n'
      + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
  )
  messages.push(
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
  )
  expect(messages.finish()).toEqual({
    text: 'Hi',
    reasoning: 't',
    usage: { inputTokens: 9, outputTokens: 4 },
  })

  const responses = createStreamParser('responses')
  responses.push(
    'data: {"type":"response.reasoning_summary_text.delta","delta":"s"}\n\n'
      + 'data: {"type":"response.output_text.delta","delta":"Yes"}\n\n'
      + 'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}',
  )
  expect(responses.finish()).toEqual({
    text: 'Yes',
    reasoning: 's',
    usage: { inputTokens: 2, outputTokens: 1 },
  })

  const failed = createStreamParser('responses')
  failed.push(
    'data: {"type":"response.failed","response":{"error":{"message":"quota"}}}\n\n',
  )
  expect(failed.finish().error).toBe('quota')
  const errored = createStreamParser('messages')
  errored.push('data: {"type":"error","error":{"message":"overloaded"}}\n\n')
  expect(errored.finish().error).toBe('overloaded')
})

test('snippets use the key placeholder and the right SDK for each protocol', () => {
  const request = buildRequest('chat-completions', {
    model: "it's",
    turns: [{ role: 'user', text: 'Hi' }],
    maxTokens: 10,
    stream: true,
  })
  const curl = curlSnippet('http://127.0.0.1:4321', 'chat-completions', request)
  expect(curl).toContain('curl http://127.0.0.1:4321/v1/chat/completions')
  expect(curl).toContain(`authorization: Bearer ${keyPlaceholder}`)
  expect(curl).toContain("it'\\''s")
  const anthropic = buildRequest('messages', {
    model: 'claude',
    turns: [{ role: 'user', text: 'Hi' }],
    maxTokens: 10,
    stream: true,
  })
  expect(curlSnippet('http://h', 'messages', anthropic)).toContain(
    `x-api-key: ${keyPlaceholder}`,
  )

  const python = pythonSnippet('http://h', 'chat-completions', request)
  expect(python).toContain('OpenAI(base_url="http://h/v1"')
  expect(python).toContain('client.chat.completions.create(')
  expect(python).not.toContain('stream')
  expect(python).toContain('max_tokens=10,')
  const messages = pythonSnippet('http://h', 'messages', anthropic)
  expect(messages).toContain('anthropic.Anthropic(base_url="http://h"')
  const responses = pythonSnippet(
    'http://h',
    'responses',
    buildRequest('responses', {
      model: 'gpt',
      turns: [{ role: 'user', text: 'Hi' }],
      maxTokens: 10,
      stream: false,
    }),
  )
  expect(responses).toContain('client.responses.create(')
  expect(responses).toContain('store=False,')
  expect(responses).toContain('print(result.output_text)')
})
