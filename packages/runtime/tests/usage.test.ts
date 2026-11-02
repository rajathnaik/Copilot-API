import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CopilotProvider } from '../src/providers/copilot'
import { SourceService } from '../src/sources/source-service'
import { createGateway } from '../src/routing/gateway'
import type { Credentials } from '../src/contracts'
import {
  meterResponse,
  meteredFetch,
  UsageMeter,
  type MeteredUsage,
  type UpstreamUsage,
  type UsageOutcome,
} from '../src/usage/usage-meter'
import {
  nanoAiuPerUsd,
  UsageLedger,
  type UsageEntry,
} from '../src/usage/usage-ledger'

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

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})
function temporary() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-usage-'))
  directories.push(directory)
  return directory
}

const sse = (events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
      + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )

function settle(response: Response) {
  let result: { usage: MeteredUsage; outcome: UsageOutcome } | undefined
  const metered = meterResponse(response, (usage, outcome) => {
    if (result) throw new Error('Reported twice')
    result = { usage, outcome }
  })
  return { metered, result: () => result }
}

test('the meter reads Responses, Messages and Chat usage and Copilot AI units', () => {
  const responses = new UsageMeter()
  responses.observe({
    type: 'response.completed',
    response: {
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 100, cache_write_tokens: 4 },
        output_tokens: 30,
        output_tokens_details: { reasoning_tokens: 12 },
      },
      copilot_usage: { total_nano_aiu: 2_500_000_000 },
    },
  })
  expect(responses.result()).toEqual({
    tokens: {
      inputTokens: 120,
      cachedInputTokens: 100,
      cacheWriteTokens: 4,
      outputTokens: 30,
      reasoningTokens: 12,
    },
    reported: true,
    nanoAiu: 2_500_000_000,
  })

  const messages = new UsageMeter()
  messages.observe({
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 5,
        output_tokens: 1,
      },
    },
  })
  messages.observe({ type: 'message_delta', usage: { output_tokens: 40 } })
  messages.observe({
    type: 'message_delta',
    copilot_usage: { total_nano_aiu: 7 },
  })
  messages.observe(null)
  messages.observe('ignored')
  expect(messages.result()).toEqual({
    tokens: {
      inputTokens: 65,
      cachedInputTokens: 50,
      cacheWriteTokens: 5,
      outputTokens: 40,
      reasoningTokens: 0,
    },
    reported: true,
    nanoAiu: 7,
  })

  const chat = new UsageMeter()
  chat.observe({
    object: 'chat.completion.chunk',
    usage: {
      prompt_tokens: 80,
      prompt_tokens_details: { cached_tokens: 64 },
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 8 },
    },
    copilot_usage: { total_nano_aiu: -1 },
  })
  expect(chat.result()).toEqual({
    tokens: {
      inputTokens: 80,
      cachedInputTokens: 64,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningTokens: 8,
    },
    reported: true,
    nanoAiu: null,
  })

  const inferred = new UsageMeter()
  inferred.observe({ object: 'response', usage: { input_tokens: 3 } })
  inferred.observe({ usage: { cache_read_input_tokens: 2 } })
  inferred.observe({ usage: { input_tokens: Number.NaN, output_tokens: 1.6 } })
  expect(inferred.result().tokens).toMatchObject({
    inputTokens: 2,
    cachedInputTokens: 2,
    outputTokens: 2,
  })
  expect(new UsageMeter().result().reported).toBe(false)
})

test('the response tap passes bodies through unchanged and reports once', async () => {
  const body = sse([
    { type: 'response.created', response: { id: 'r' } },
    {
      type: 'response.completed',
      response: { usage: { input_tokens: 9, output_tokens: 4 } },
    },
  ])
  const expected = await body.clone().text()
  const stream = settle(body)
  expect(stream.metered.headers.get('content-type')).toBe('text/event-stream')
  expect(await stream.metered.text()).toBe(expected)
  expect(stream.result()?.outcome).toBe('completed')
  expect(stream.result()?.usage.tokens.inputTokens).toBe(9)

  const json = settle(
    Response.json({
      usage: { prompt_tokens: 5, completion_tokens: 2 },
      copilot_usage: { total_nano_aiu: 11 },
    }),
  )
  await json.metered.json()
  expect(json.result()?.usage).toMatchObject({
    reported: true,
    nanoAiu: 11,
  })

  const broken = settle(
    new Response('{not json', {
      headers: { 'content-type': 'application/json' },
    }),
  )
  expect(await broken.metered.text()).toBe('{not json')
  expect(broken.result()?.usage.reported).toBe(false)

  const text = settle(new Response('plain usage text'))
  await text.metered.text()
  expect(text.result()).toMatchObject({ outcome: 'completed' })

  const failed = settle(Response.json({ error: 'no' }, { status: 429 }))
  expect(failed.metered.status).toBe(429)
  await failed.metered.text()
  expect(failed.result()?.outcome).toBe('failed')

  const empty = settle(new Response(null, { status: 204 }))
  expect(empty.result()?.outcome).toBe('completed')

  const cancelled = settle(sse([{ type: 'response.created' }]))
  await cancelled.metered.body?.cancel()
  expect(cancelled.result()?.outcome).toBe('cancelled')

  const erroring = settle(
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error('socket reset'))
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  )
  await expect(erroring.metered.text()).rejects.toThrow('socket reset')
  expect(erroring.result()?.outcome).toBe('failed')

  const original = console.error
  const logged: unknown[] = []
  console.error = (...values: unknown[]) => logged.push(...values)
  try {
    await meterResponse(Response.json({}), () => {
      throw new Error('ledger down')
    }).text()
  } finally {
    console.error = original
  }
  expect(String(logged[0])).toContain('Usage recording failed (Error)')
})

test('metered upstream requests attribute timing, failures and cancellation', async () => {
  let clock = 1000
  const now = () => clock
  const reports: UpstreamUsage[] = []
  const report = (usage: UpstreamUsage) => reports.push(usage)
  const client = new AbortController()
  const request = {
    model: 'gpt',
    purpose: 'request' as const,
    client: client.signal,
  }

  const unmetered = await meteredFetch(
    () => Promise.resolve(new Response('direct')),
    'https://upstream.example',
    {},
    undefined,
    request,
  )
  expect(await unmetered.text()).toBe('direct')

  const ok = await meteredFetch(
    () => {
      clock += 250
      return Promise.resolve(
        sse([
          {
            type: 'response.completed',
            response: { usage: { input_tokens: 3, output_tokens: 1 } },
          },
        ]),
      )
    },
    'https://upstream.example',
    {},
    report,
    request,
    now,
  )
  await ok.text()
  expect(reports.pop()).toMatchObject({
    model: 'gpt',
    purpose: 'request',
    status: 200,
    outcome: 'completed',
    durationMs: 250,
    inputTokens: 3,
    outputTokens: 1,
  })

  await expect(
    meteredFetch(
      () => Promise.reject(new Error('offline')),
      'https://upstream.example',
      {},
      report,
      request,
      now,
    ),
  ).rejects.toThrow('offline')
  expect(reports.pop()).toMatchObject({ status: 0, outcome: 'failed' })

  // Translators stop reading once they have the final event.
  const early = await meteredFetch(
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
                ),
              )
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    'https://upstream.example',
    {},
    report,
    request,
    now,
  )
  const reader = early.body?.getReader()
  await reader?.read()
  await reader?.cancel()
  expect(reports.pop()).toMatchObject({ outcome: 'completed', outputTokens: 5 })

  const silent = await meteredFetch(
    () => Promise.resolve(sse([])),
    'https://upstream.example',
    {},
    report,
    request,
    now,
  )
  await silent.body?.cancel()
  expect(reports.pop()).toMatchObject({ outcome: 'failed' })

  client.abort()
  const dropped = await meteredFetch(
    () => Promise.resolve(sse([])),
    'https://upstream.example',
    {},
    report,
    request,
    now,
  )
  await dropped.body?.cancel()
  expect(reports.pop()).toMatchObject({ outcome: 'cancelled' })
  await expect(
    meteredFetch(
      () => Promise.reject(new Error('aborted')),
      'https://upstream.example',
      {},
      report,
      request,
      now,
    ),
  ).rejects.toThrow('aborted')
  expect(reports.pop()).toMatchObject({ status: 0, outcome: 'cancelled' })
})

const entry = (overrides: Partial<UsageEntry> = {}): UsageEntry => ({
  sourceId: 'source-1',
  source: 'Copilot',
  kind: 'copilot',
  model: 'gpt',
  access: 'local',
  purpose: 'request',
  status: 200,
  outcome: 'completed',
  durationMs: 100,
  inputTokens: 100,
  cachedInputTokens: 40,
  cacheWriteTokens: 0,
  outputTokens: 20,
  reasoningTokens: 5,
  nanoAiu: nanoAiuPerUsd / 100,
  ...overrides,
})

test('the ledger summarizes ranges, models, access and days and persists across restarts', async () => {
  const directory = temporary()
  const noon = new Date(2026, 4, 15, 12, 0, 0).getTime()
  const day = 24 * 60 * 60 * 1000
  let clock = noon - 3 * day
  const ledger = await UsageLedger.open(directory, () => clock)
  ledger.record(entry({ model: 'claude', durationMs: 300 }))
  clock = noon - 60_000
  ledger.record(
    entry({
      access: 'remote',
      purpose: 'web-search',
      inputTokens: 1000,
      outputTokens: 0,
      nanoAiu: null,
    }),
  )
  clock = noon
  ledger.record(
    entry({
      outcome: 'failed',
      status: 500,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      nanoAiu: null,
    }),
  )
  ledger.record(
    entry({
      outcome: 'cancelled',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      nanoAiu: null,
    }),
  )
  ledger.record(entry({ model: '' }))
  expect(ledger.lastError).toContain('invalid')
  await ledger.flush()
  expect(ledger.lastError).toBeNull()

  const today = ledger.summary('today')
  expect(today.totals).toMatchObject({
    requests: 3,
    failed: 1,
    cancelled: 1,
    webSearches: 1,
    unreported: 0,
    inputTokens: 1000,
    totalTokens: 1000,
    costedRequests: 0,
    costUsd: null,
    averageDurationMs: 100,
  })
  expect(today.daily).toHaveLength(1)
  expect(today.recent.map((record) => record.outcome)).toEqual([
    'cancelled',
    'failed',
    'completed',
  ])

  const week = ledger.summary('7d')
  expect(week.daily).toHaveLength(7)
  expect(week.daily.map((bucket) => bucket.requests)).toEqual([
    0, 0, 0, 1, 0, 0, 3,
  ])
  expect(week.totals.requests).toBe(4)
  expect(week.totals.costUsd).toBeCloseTo(0.01)
  expect(week.totals.averageDurationMs).toBe(200)
  expect(week.models.map((model) => model.model)).toEqual(['gpt', 'claude'])
  expect(week.access.remote.requests).toBe(1)
  expect(week.access.local.requests).toBe(3)
  expect(ledger.summary('90d').daily).toHaveLength(90)

  fs.appendFileSync(
    path.join(directory, fs.readdirSync(directory)[0] ?? ''),
    '{"torn":\n',
  )
  const old = path.join(directory, 'usage-2020-01.jsonl')
  fs.writeFileSync(old, `${JSON.stringify({ ...entry(), at: 1 })}\n`)
  const outside = path.join(directory, 'usage-2026-01.jsonl')
  fs.writeFileSync(outside, `${JSON.stringify({ ...entry(), at: 1 })}\n`)
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'kept')
  const reopened = await UsageLedger.open(directory, () => clock)
  expect(reopened.summary('7d').totals.requests).toBe(4)
  expect(fs.existsSync(old)).toBe(false)
  expect(fs.existsSync(outside)).toBe(true)

  // Records older than the in-memory window are dropped as time passes.
  clock = noon + 100 * day
  reopened.record(entry())
  expect(reopened.summary('90d').totals.requests).toBe(1)

  await reopened.clear()
  expect(reopened.summary('90d').totals.requests).toBe(0)
  expect(fs.readdirSync(directory)).toEqual(['notes.txt'])
})

test('the ledger reports write failures without throwing', async () => {
  const directory = temporary()
  const ledger = await UsageLedger.open(directory)
  fs.rmSync(directory, { recursive: true })
  fs.writeFileSync(directory, 'not a directory')
  ledger.record(entry())
  await ledger.flush()
  expect(ledger.lastError).toMatch(/^Usage history could not be saved \(/u)
  expect(ledger.summary('today').totals.requests).toBe(1)
  fs.rmSync(directory)
})

test('gateway records attribute local and remote use of API sources', async () => {
  const upstream: string[] = []
  const sources = new SourceService(
    [],
    credentials(),
    () => {},
    (url) => {
      upstream.push(url)
      if (url.endsWith('/models'))
        return Promise.resolve(Response.json({ data: [{ id: 'model-one' }] }))
      if (upstream.length > 3)
        return Promise.resolve(
          Response.json({ error: 'busy' }, { status: 503 }),
        )
      return Promise.resolve(
        sse([
          {
            type: 'response.completed',
            response: { usage: { input_tokens: 12, output_tokens: 6 } },
          },
        ]),
      )
    },
  )
  const source = await sources.add({
    label: 'Provider',
    kind: 'api',
    baseUrl: 'https://provider.example/v1',
    protocol: 'responses',
    apiKey: 'synthetic-upstream-key',
    shared: true,
  })
  const records: UsageEntry[] = []
  const recorder = { record: (value: UsageEntry) => records.push(value) }
  const send = (key: string, sharedOnly: boolean) =>
    createGateway(sources, key, sharedOnly, recorder).request('/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: `${source.id}/model-one`, stream: true }),
    })
  await (await send('local-key', false)).text()
  await (await send('remote-key', true)).text()
  const failed = await send('local-key', false)
  expect(failed.status).toBe(503)
  await failed.text()
  expect(records).toMatchObject([
    {
      sourceId: source.id,
      source: 'Provider',
      kind: 'api',
      model: 'model-one',
      access: 'local',
      purpose: 'request',
      outcome: 'completed',
      inputTokens: 12,
      outputTokens: 6,
    },
    { access: 'remote', outcome: 'completed' },
    { access: 'local', status: 503, outcome: 'failed' },
  ])
})

const anthropic = (events: Array<Record<string, unknown>>) =>
  new Response(
    events
      .map(
        (event) =>
          `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
const messageStart = (input: number) => ({
  type: 'message_start',
  message: {
    id: `msg_${input}`,
    type: 'message',
    role: 'assistant',
    model: 'claude',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: input, output_tokens: 0 },
  },
})

test('Copilot records each upstream request, including web searches and continuation rounds', async () => {
  const vault = credentials()
  const rounds = [
    () =>
      anthropic([
        messageStart(10),
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'web_search',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"query":"bun"}',
          },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ]),
    () =>
      anthropic([
        messageStart(30),
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Bun 2.' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 7 },
        },
        { type: 'message_stop' },
      ]),
  ]
  const provider = new CopilotProvider(vault, (url) => {
    if (url.endsWith('/token'))
      return Promise.resolve(
        Response.json({
          token: 'synthetic-copilot',
          refresh_in: 120,
          expires_at: 999999,
        }),
      )
    if (url.endsWith('/models'))
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: 'gpt-5.4',
              name: 'GPT',
              supported_endpoints: ['/responses'],
              capabilities: { supports: { tool_calls: true } },
            },
            {
              id: 'claude',
              name: 'Claude',
              supported_endpoints: ['/v1/messages'],
              capabilities: { supports: { tool_calls: true } },
              billing: { is_premium: true, multiplier: 3 },
            },
          ],
        }),
      )
    if (url.endsWith('/responses'))
      return Promise.resolve(
        sse([
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Bun 2 shipped.' }],
            },
          },
          {
            type: 'response.completed',
            response: {
              id: 'resp_search',
              output: [],
              usage: { input_tokens: 50, output_tokens: 20 },
              copilot_usage: { total_nano_aiu: 1_000_000_000 },
            },
          },
        ]),
      )
    if (url === 'https://api.github.com/user')
      return Promise.resolve(new Response('not found', { status: 404 }))
    const next = rounds.shift()
    if (!next) throw new Error('Unexpected upstream round.')
    return Promise.resolve(next())
  })
  const sources = new SourceService([], vault, () => {}, fetch, provider)
  const source = await sources.addCopilot('synthetic-github', 'Copilot', true)
  const records: UsageEntry[] = []
  const response = await createGateway(sources, 'local', false, {
    record: (value) => records.push(value),
  }).request('/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer local' },
    body: JSON.stringify({
      model: `${source.id}/claude`,
      input: 'What is new in Bun?',
      tools: [{ type: 'web_search' }],
      stream: true,
    }),
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('Bun 2.')
  await Bun.sleep(10)
  const byPurpose = Object.fromEntries(
    records.map((record) => [record.purpose, record]),
  )
  expect(records).toHaveLength(3)
  expect(byPurpose.request).toMatchObject({
    model: 'claude',
    kind: 'copilot',
    outcome: 'completed',
    inputTokens: 10,
    outputTokens: 5,
    initiator: 'user',
    premium: 3,
  })
  expect(byPurpose['web-search']).toMatchObject({
    model: 'gpt-5.4',
    inputTokens: 50,
    outputTokens: 20,
    nanoAiu: 1_000_000_000,
    initiator: 'agent',
    premium: 0,
  })
  expect(byPurpose.continuation).toMatchObject({
    model: 'claude',
    inputTokens: 30,
    outputTokens: 7,
    initiator: 'agent',
    premium: 0,
  })
})

test('Copilot quota is parsed, cached for a minute and refreshed on demand', async () => {
  const vault = credentials()
  let clock = 1000
  let checks = 0
  let fail = false
  const provider = new CopilotProvider(
    vault,
    (url, init) => {
      expect(url).toBe('https://api.github.com/copilot_internal/user')
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'token synthetic-github',
      )
      checks++
      if (fail)
        return Promise.resolve(
          Response.json({ message: 'Bad credentials' }, { status: 401 }),
        )
      return Promise.resolve(
        Response.json({
          login: 'octocat',
          copilot_plan: 'individual_pro',
          quota_reset_date: '2026-06-01',
          quota_snapshots: {
            premium_interactions: {
              entitlement: 300,
              remaining: 120,
              percent_remaining: 40,
              unlimited: false,
              overage_count: 0,
              overage_permitted: true,
            },
            chat: { unlimited: true },
          },
        }),
      )
    },
    () => clock,
  )
  const id = 'copilot-source'
  await vault.set(id, 'synthetic-github')
  const quota = await provider.quota(id)
  expect(quota).toEqual({
    login: 'octocat',
    plan: 'individual_pro',
    resetDate: '2026-06-01',
    checkedAt: 1000,
    premium: {
      entitlement: 300,
      remaining: 120,
      percentRemaining: 40,
      unlimited: false,
      overageCount: 0,
      overagePermitted: true,
    },
    chat: {
      entitlement: null,
      remaining: null,
      percentRemaining: null,
      unlimited: true,
      overageCount: 0,
      overagePermitted: false,
    },
    completions: null,
  })
  clock += 30_000
  expect(await provider.quota(id)).toBe(quota)
  expect(checks).toBe(1)
  expect((await provider.quota(id, true)).checkedAt).toBe(31_000)
  clock += 61_000
  fail = true
  await expect(provider.quota(id)).rejects.toThrow()
  expect(checks).toBe(3)
})
