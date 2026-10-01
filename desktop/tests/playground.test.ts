import { describe, expect, test } from 'bun:test'

import {
  SNIPPET_API_KEY_PLACEHOLDER,
  buildCurlSnippet,
  buildPlaygroundRequest,
  buildPythonSnippet,
  createStreamParser,
  getAttachmentLimits,
  getSupportedApis,
  parseErrorBody,
  parsePlaygroundResponse,
  pickDefaultApi,
  validateAttachments,
  type PlaygroundAttachment,
} from '../src/lib/playground'

const png: PlaygroundAttachment = {
  name: 'a.png',
  mediaType: 'image/png',
  data: 'iVBORw0KGgo=',
  size: 10,
}
const pdf: PlaygroundAttachment = {
  name: 'doc.pdf',
  mediaType: 'application/pdf',
  data: 'JVBERi0=',
  size: 20,
}

describe('getSupportedApis', () => {
  test('maps Copilot supported_endpoints to playground APIs', () => {
    expect(
      getSupportedApis({
        id: 'claude-sonnet-5',
        supported_endpoints: ['/v1/messages', '/chat/completions'],
      }),
    ).toEqual(['messages', 'chat'])
    expect(
      getSupportedApis({
        id: 'gpt-6-luna',
        supported_endpoints: ['/responses', 'ws:/responses'],
      }),
    ).toEqual(['responses'])
  })

  test('offers every API when endpoints are not declared', () => {
    expect(getSupportedApis({ id: 'deepseek-chat' })).toEqual([
      'messages',
      'chat',
      'responses',
    ])
    expect(getSupportedApis({ id: 'text-embedding-3-small' })).toEqual([])
  })

  test('pickDefaultApi prefers messages, then chat, then responses', () => {
    expect(pickDefaultApi(['chat', 'responses'])).toBe('chat')
    expect(pickDefaultApi(['responses'])).toBe('responses')
    expect(pickDefaultApi([])).toBeUndefined()
  })
})

describe('attachments', () => {
  const model = {
    id: 'claude-sonnet-5',
    capabilities: {
      supports: { vision: true },
      limits: {
        vision: {
          max_prompt_image_size: 100,
          max_prompt_images: 1,
          supported_media_types: ['image/png', 'application/pdf'],
        },
      },
    },
  }

  test('chat completions drops PDF support', () => {
    expect(getAttachmentLimits(model, 'chat').mediaTypes).toEqual(['image/png'])
    expect(getAttachmentLimits(model, 'messages').mediaTypes).toContain(
      'application/pdf',
    )
  })

  test('validates count, type and size', () => {
    const limits = getAttachmentLimits(model, 'messages')
    expect(validateAttachments([png], limits)).toBeUndefined()
    expect(validateAttachments([png, pdf], limits)).toContain('at most 1')
    expect(validateAttachments([{ ...png, size: 500 }], limits)).toContain(
      'larger than',
    )
    expect(
      validateAttachments([pdf], getAttachmentLimits(model, 'chat')),
    ).toContain('not supported')
  })

  test('models without vision reject attachments', () => {
    const limits = getAttachmentLimits(
      { id: 'x', capabilities: { supports: { vision: false } } },
      'messages',
    )
    expect(limits.enabled).toBe(false)
    expect(validateAttachments([png], limits)).toBeDefined()
  })
})

describe('buildPlaygroundRequest', () => {
  const messages = [
    { role: 'user' as const, text: 'hi' },
    { role: 'assistant' as const, text: 'hello' },
    { role: 'user' as const, text: 'look', attachments: [png, pdf] },
  ]

  test('chat completions', () => {
    const { path, body } = buildPlaygroundRequest('chat', {
      model: 'm',
      system: 'be brief',
      messages,
      maxTokens: 10,
      stream: true,
    })
    expect(path).toBe('/v1/chat/completions')
    expect(body).toMatchObject({ model: 'm', max_tokens: 10, stream: true })
    const sent = body.messages as Array<Record<string, unknown>>
    expect(sent[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(sent[3].content).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
      },
      { type: 'text', text: 'look' },
    ])
  })

  test('anthropic messages', () => {
    const { path, body } = buildPlaygroundRequest('messages', {
      model: 'm',
      system: 'sys',
      messages,
      stream: false,
    })
    expect(path).toBe('/v1/messages')
    expect(body.system).toBe('sys')
    expect(body.max_tokens).toBe(4096)
    const sent = body.messages as Array<Record<string, unknown>>
    expect(sent).toHaveLength(3)
    const content = sent[2].content as Array<Record<string, unknown>>
    expect(content.map((part) => part.type)).toEqual([
      'image',
      'document',
      'text',
    ])
  })

  test('openai responses', () => {
    const { path, body } = buildPlaygroundRequest('responses', {
      model: 'm',
      system: 'sys',
      messages,
      stream: true,
    })
    expect(path).toBe('/v1/responses')
    expect(body.instructions).toBe('sys')
    expect(body.max_output_tokens).toBe(4096)
    const input = body.input as Array<Record<string, unknown>>
    expect(input[1].content).toEqual([{ type: 'output_text', text: 'hello' }])
    const content = input[2].content as Array<Record<string, unknown>>
    expect(content.map((part) => part.type)).toEqual([
      'input_image',
      'input_file',
      'input_text',
    ])
  })
})

describe('parsePlaygroundResponse', () => {
  test('parses each API', () => {
    expect(
      parsePlaygroundResponse('chat', {
        choices: [{ message: { content: 'A' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    ).toEqual({ text: 'A', usage: { inputTokens: 3, outputTokens: 1 } })
    expect(
      parsePlaygroundResponse('messages', {
        content: [{ type: 'text', text: 'B' }],
        usage: { input_tokens: 2, output_tokens: 1 },
      }).text,
    ).toBe('B')
    expect(
      parsePlaygroundResponse('responses', {
        output: [
          { type: 'reasoning' },
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'C' }],
          },
        ],
      }).text,
    ).toBe('C')
  })

  test('unwraps gateway-wrapped upstream errors', () => {
    const body = JSON.stringify({
      error: {
        message: JSON.stringify({
          error: { message: 'model not supported', code: 'x' },
        }),
      },
    })
    expect(parseErrorBody(body, 400)).toBe('model not supported')
    expect(parseErrorBody('', 502)).toBe('Request failed with HTTP 502')
  })
})

describe('createStreamParser', () => {
  const feed = (api: Parameters<typeof createStreamParser>[0], raw: string) => {
    const parser = createStreamParser(api)
    let text = ''
    // Split into tiny chunks to exercise buffering across boundaries.
    for (let index = 0; index < raw.length; index += 7) {
      text += parser.push(raw.slice(index, index + 7)).textDelta
    }
    const final = parser.finish()
    return {
      text: text + final.textDelta,
      usage: final.usage,
      error: final.error,
    }
  }

  test('chat completions stream', () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
      'data: [DONE]',
      '',
    ].join('\n\n')
    expect(feed('chat', raw)).toEqual({
      text: 'Hello',
      usage: { inputTokens: 5, outputTokens: 2 },
      error: undefined,
    })
  })

  test('anthropic messages stream', () => {
    const raw = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"!"}}',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}',
      '',
    ].join('\r\n\r\n')
    expect(feed('messages', raw)).toEqual({
      text: 'Hi!',
      usage: { inputTokens: 9, outputTokens: 4 },
      error: undefined,
    })
  })

  test('responses stream and errors', () => {
    const raw = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Yo"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}',
      '',
    ].join('\n\n')
    expect(feed('responses', raw).text).toBe('Yo')
    expect(
      feed('messages', 'data: {"type":"error","error":{"message":"boom"}}\n\n')
        .error,
    ).toBe('boom')
  })
})

describe('snippets', () => {
  const request = buildPlaygroundRequest('messages', {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', text: "it's", attachments: [png] }],
    stream: false,
  })

  test('curl redacts base64 data and never embeds a real key', () => {
    const snippet = buildCurlSnippet('http://localhost:4141', request, {
      headerName: 'x-api-key',
    })
    expect(snippet).toContain('http://localhost:4141/v1/messages')
    expect(snippet).toContain(`x-api-key: ${SNIPPET_API_KEY_PLACEHOLDER}`)
    expect(snippet).toContain('<BASE64_DATA>')
    expect(snippet).not.toContain(png.data)
    expect(snippet).toContain("it'\\''s")
  })

  test('python uses the matching SDK and base URL', () => {
    expect(
      buildPythonSnippet('messages', 'http://localhost:4141', request),
    ).toContain('anthropic.Anthropic(base_url="http://localhost:4141"')
    const chat = buildPlaygroundRequest('chat', {
      model: 'gemini',
      messages: [{ role: 'user', text: 'hi' }],
      stream: true,
    })
    const snippet = buildPythonSnippet('chat', 'http://localhost:4141', chat)
    expect(snippet).toContain('OpenAI(base_url="http://localhost:4141/v1"')
    expect(snippet).toContain('client.chat.completions.create(')
    expect(snippet).not.toContain('stream=')
  })
})
