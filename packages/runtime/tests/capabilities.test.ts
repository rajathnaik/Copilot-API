import { expect, test } from 'bun:test'
import {
  codexCatalogMaxBytes,
  createCodexCatalog,
} from '../src/harnesses/codex-catalog'
import { codexInstructionsTemplate } from '../src/harnesses/codex-instructions'
import { CopilotProvider } from '../src/providers/copilot'
import { normalizeCopilotRequest } from '../src/providers/copilot-compatibility/request-normalization'
import { createGateway, SourceService } from '../src/runtime'
import type { AvailableModel, Credentials } from '../src/contracts'

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

const base: AvailableModel = {
  id: 'source/gpt',
  name: 'GPT',
  sourceId: 'source',
  sourceLabel: 'Host',
  protocol: 'responses',
  protocols: ['responses'],
}

test('Codex catalog advertises native instructions and discovered model capabilities', () => {
  const catalog = createCodexCatalog([
    {
      ...base,
      supportsTools: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      inputModalities: ['text', 'image'],
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
    },
    {
      ...base,
      id: 'source/serial',
      supportsTools: true,
      supportsParallelToolCalls: false,
      reasoningEfforts: ['none'],
    },
    { ...base, id: 'source/plain' },
  ])
  const [full, serial, plain] = catalog.models
  expect(full?.model_messages.instructions_template).toBe(
    codexInstructionsTemplate,
  )
  expect(codexInstructionsTemplate).not.toContain('based on GPT-5')
  expect(full).toMatchObject({
    input_modalities: ['text', 'image'],
    supports_reasoning_summaries: true,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: 'auto',
    default_reasoning_level: 'medium',
    shell_type: 'unified_exec',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    supports_search_tool: false,
    supports_parallel_tool_calls: true,
    context_window: 400_000,
    max_context_window: 400_000,
    max_output_tokens: 128_000,
    effective_context_window_percent: 95,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
  })
  expect(serial).toMatchObject({
    supports_parallel_tool_calls: false,
    supports_reasoning_summaries: false,
    default_reasoning_summary: 'none',
    default_reasoning_level: 'none',
  })
  expect(serial).not.toHaveProperty('max_output_tokens')
  expect(plain).toMatchObject({
    input_modalities: ['text'],
    apply_patch_tool_type: null,
    supports_parallel_tool_calls: false,
    shell_type: 'disabled',
  })
})

test('large Codex catalogs switch to compact instructions instead of dropping models', () => {
  const models = Array.from({ length: 80 }, (_, index) => ({
    ...base,
    id: `source/model-${index}`,
  }))
  const catalog = createCodexCatalog(models)
  expect(catalog.models).toHaveLength(80)
  expect(
    catalog.models.every(
      (model) => model.model_messages.instructions_template.length < 1_000,
    ),
  ).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(catalog))).toBeLessThanOrEqual(
    codexCatalogMaxBytes,
  )
})

test('Copilot discovery records vision, output and parallel tool limits that survive a remote hop', async () => {
  const vault = credentials()
  const provider = new CopilotProvider(vault, (url) => {
    if (url.endsWith('/token'))
      return Promise.resolve(
        Response.json({ token: 'synthetic', refresh_in: 120, expires_at: 1 }),
      )
    return Promise.resolve(
      Response.json({
        data: [
          {
            id: 'gpt-vision',
            name: 'GPT Vision',
            supported_endpoints: ['/responses'],
            capabilities: {
              supports: {
                tool_calls: true,
                parallel_tool_calls: false,
                vision: true,
              },
              limits: {
                max_context_window_tokens: 200_000,
                max_output_tokens: 64_000,
                vision: { max_prompt_image_size: 3_145_728 },
              },
            },
          },
          {
            id: 'claude-vision',
            supported_endpoints: ['/v1/messages'],
            capabilities: {
              limits: { vision: { max_prompt_image_size: 1_048_576 } },
            },
          },
          { id: 'text-only', supported_endpoints: ['/responses'] },
        ],
      }),
    )
  })
  const host = new SourceService([], vault, () => {}, fetch, provider)
  const source = await host.addCopilot('synthetic-github', 'Copilot', true)
  expect(source.models[0]).toMatchObject({
    supportsTools: true,
    supportsParallelToolCalls: false,
    inputModalities: ['text', 'image'],
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    maxImageBytes: 3_145_728,
  })
  expect(source.models[1]).toMatchObject({
    upstreamProtocol: 'messages',
    inputModalities: ['text', 'image'],
    maxImageBytes: 1_048_576,
  })
  expect(source.models[2]?.inputModalities).toEqual(['text'])

  const gateway = createGateway(host, 'remote-key', true)
  const client = new SourceService(
    [],
    credentials(),
    () => {},
    async (url, init) => gateway.request(new URL(url).pathname, init),
  )
  const remote = await client.add({
    label: 'Remote host',
    kind: 'remote',
    baseUrl: 'https://host.example',
    protocol: 'responses',
    apiKey: 'remote-key',
    shared: false,
  })
  expect(remote.models[0]).toMatchObject({
    upstreamProtocol: 'responses',
    supportsParallelToolCalls: false,
    inputModalities: ['text', 'image'],
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    maxImageBytes: 3_145_728,
  })
})

test('Copilot requests drop unsupported tools and fields and repair images before forwarding', () => {
  const small = `data:image/png;base64,${'A'.repeat(8)}`
  const large = `data:image/png;base64,${'A'.repeat(4_000)}`
  const payload: Record<string, unknown> = {
    tools: [
      { type: 'function', name: 'exec_command' },
      { type: 'image_generation' },
      { type: 'namespace', name: 'image_gen' },
      'unexpected',
    ],
    input: [
      {
        type: 'message',
        role: 'user',
        internal_chat_message_metadata_passthrough: { secret: true },
        content: [
          { type: 'input_image', image_url: small, detail: 'original' },
          { type: 'input_image', image_url: large, detail: 'high' },
          { type: 'input_image', image_url: 'https://example.com/a.png' },
        ],
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [{ type: 'input_image', image_url: small, detail: 'low' }],
      },
      'text',
    ],
  }
  const result = normalizeCopilotRequest(payload, 1_000)
  expect(result).toEqual({
    removedTools: ['image_generation', 'namespace:image_gen'],
    normalizedImageDetails: 1,
    omittedImages: 1,
    removedInputFields: 1,
  })
  expect(payload.tools).toEqual([
    { type: 'function', name: 'exec_command' },
    'unexpected',
  ])
  const [message, output] = payload.input as Array<{
    content: Array<Record<string, unknown>>
    output: Array<Record<string, unknown>>
  }>
  expect(message).not.toHaveProperty(
    'internal_chat_message_metadata_passthrough',
  )
  expect(message?.content[0]).toMatchObject({ detail: 'auto' })
  expect(message?.content[1]).toMatchObject({ type: 'input_text' })
  expect(message?.content[1].text).toContain('1000 bytes')
  expect(message?.content[2]).toEqual({
    type: 'input_image',
    image_url: 'https://example.com/a.png',
  })
  expect(output?.output[0]).toMatchObject({ detail: 'low' })
  expect(normalizeCopilotRequest({ input: 'plain' })).toEqual({
    removedTools: [],
    normalizedImageDetails: 0,
    omittedImages: 0,
    removedInputFields: 0,
  })
})

test('normalization is applied to native Responses requests sent to Copilot', async () => {
  const vault = credentials()
  let forwarded: Record<string, unknown> | undefined
  const provider = new CopilotProvider(vault, (url, init) => {
    if (url.endsWith('/token'))
      return Promise.resolve(
        Response.json({ token: 'synthetic', refresh_in: 120, expires_at: 1 }),
      )
    if (url.endsWith('/models'))
      return Promise.resolve(
        Response.json({
          data: [{ id: 'gpt', supported_endpoints: ['/responses'] }],
        }),
      )
    forwarded = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}',
    ) as Record<string, unknown>
    return Promise.resolve(Response.json({ id: 'resp', output: [] }))
  })
  const sources = new SourceService([], vault, () => {}, fetch, provider)
  const source = await sources.addCopilot('synthetic-github', 'Copilot', true)
  const response = await createGateway(sources, 'local').request(
    '/v1/responses',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer local' },
      body: JSON.stringify({
        model: `${source.id}/gpt`,
        input: 'Draw a cat',
        tools: [{ type: 'image_generation' }, { type: 'web_search' }],
      }),
    },
  )
  expect(response.status).toBe(200)
  expect(forwarded?.tools).toEqual([{ type: 'web_search' }])
})
