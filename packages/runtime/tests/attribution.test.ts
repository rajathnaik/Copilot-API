import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CopilotProvider } from '../src/providers/copilot'
import { SourceService } from '../src/sources/source-service'
import {
  cleanClientName,
  clientHeader,
  createGateway,
} from '../src/routing/gateway'
import type { Credentials } from '../src/contracts'
import {
  UsageLedger,
  type MonthlyClientUsage,
  type UsageEntry,
} from '../src/usage/usage-ledger'
import {
  limitState,
  noPremiumLimits,
  premiumLimitStatus,
  premiumLimitsSchema,
} from '../src/usage/premium-limits'

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

const completed = () =>
  new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: { usage: { input_tokens: 12, output_tokens: 6 } },
    })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )

test('client names travel to the host and attribute its remote usage', async () => {
  expect(cleanClientName('  Laptop\u0000\u200b  of\n\tRajath ')).toBe(
    'Laptop of Rajath',
  )
  expect(cleanClientName(undefined)).toBe('Unnamed client')
  expect(cleanClientName('x'.repeat(80))).toHaveLength(64)

  const hostSources = new SourceService(
    [],
    credentials(),
    () => {},
    (url) =>
      Promise.resolve(
        url.endsWith('/models') ?
          Response.json({ data: [{ id: 'model-one' }] })
        : completed(),
      ),
  )
  await hostSources.add({
    label: 'Provider',
    kind: 'api',
    baseUrl: 'https://provider.example/v1',
    protocol: 'responses',
    apiKey: 'synthetic-upstream-key',
    shared: true,
  })
  const hostRecords: UsageEntry[] = []
  const host = createGateway(hostSources, 'remote-key', true, {
    record: (value) => hostRecords.push(value),
  })
  const seen: Array<string | null> = []
  const clientSources = new SourceService(
    [],
    credentials(),
    () => {},
    async (url, init) => {
      seen.push(new Headers(init?.headers).get(clientHeader))
      return await host.request(new URL(url).pathname, init)
    },
  )
  const remote = await clientSources.add({
    label: 'Office host',
    kind: 'remote',
    baseUrl: 'https://host.example',
    protocol: 'responses',
    apiKey: 'remote-key',
    shared: false,
  })
  const clientRecords: UsageEntry[] = []
  let name: string | undefined = '  Rajath laptop '
  const client = createGateway(
    clientSources,
    'local-key',
    false,
    { record: (value) => clientRecords.push(value) },
    { clientName: () => name },
  )
  const send = () =>
    client.request('/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer local-key' },
      body: JSON.stringify({
        model: `${remote.id}/${remote.models[0]?.id}`,
        stream: true,
      }),
    })
  const first = await send()
  expect(first.status).toBe(200)
  await first.text()
  name = undefined
  await (await send()).text()
  await Bun.sleep(5)
  expect(seen.slice(1)).toEqual(['Rajath laptop', null])
  expect(hostRecords.map((record) => record.client)).toEqual([
    'Rajath laptop',
    'Unnamed client',
  ])
  expect(clientRecords.every((record) => record.client === undefined)).toBe(
    true,
  )
})

test('Copilot attributes prompts, agent follow-ups and premium requests', async () => {
  const vault = credentials()
  let status = 200
  const provider = new CopilotProvider(vault, (url) => {
    if (url.endsWith('/token'))
      return Promise.resolve(
        Response.json({
          token: 'synthetic',
          refresh_in: 120,
          expires_at: 999999,
        }),
      )
    if (url.endsWith('/models'))
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: 'premium',
              supported_endpoints: ['/responses'],
              billing: { is_premium: true, multiplier: 1.5 },
            },
            {
              id: 'included',
              supported_endpoints: ['/responses'],
              billing: { is_premium: false },
            },
            { id: 'unknown', supported_endpoints: ['/responses'] },
          ],
        }),
      )
    if (url === 'https://api.github.com/user')
      return Promise.resolve(new Response('nope', { status: 404 }))
    return Promise.resolve(
      status === 200 ? completed() : new Response('busy', { status }),
    )
  })
  const sources = new SourceService([], vault, () => {}, fetch, provider)
  const source = await sources.addCopilot('synthetic-github', 'Copilot', true)
  expect(source.models.map((model) => model.premiumMultiplier)).toEqual([
    1.5,
    0,
    undefined,
  ])
  expect(sources.models()[0]).not.toHaveProperty('premiumMultiplier')
  const records: UsageEntry[] = []
  const gateway = createGateway(sources, 'local', false, {
    record: (value) => records.push(value),
  })
  const send = async (model: string, input: unknown) => {
    const response = await gateway.request('/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer local' },
      body: JSON.stringify({
        model: `${source.id}/${model}`,
        input,
        stream: true,
      }),
    })
    await response.text()
  }
  const prompt = [{ type: 'message', role: 'user', content: 'Hi' }]
  const toolOutput = [
    ...prompt,
    { type: 'function_call_output', call_id: 'call_1', output: 'done' },
  ]
  await send('premium', prompt)
  await send('premium', toolOutput)
  await send('included', prompt)
  await send('unknown', prompt)
  status = 429
  await send('premium', prompt)
  await Bun.sleep(5)
  expect(
    records.map((record) => [record.model, record.initiator, record.premium]),
  ).toEqual([
    ['premium', 'user', 1.5],
    ['premium', 'agent', 0],
    ['included', 'user', 0],
    ['unknown', 'user', null],
    ['premium', 'user', 0],
  ])
})

test('the ledger groups remote clients, plots daily series and totals the current month', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-clients-'))
  directories.push(directory)
  const noon = new Date(2026, 4, 15, 12).getTime()
  const day = 24 * 60 * 60 * 1000
  let clock = noon - 20 * day
  const ledger = await UsageLedger.open(directory, () => clock)
  const entry = (overrides: Partial<UsageEntry>): UsageEntry => ({
    sourceId: 'source-1',
    source: 'Copilot',
    kind: 'copilot',
    model: 'gpt',
    access: 'remote',
    purpose: 'request',
    status: 200,
    outcome: 'completed',
    durationMs: 10,
    inputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10,
    reasoningTokens: 0,
    nanoAiu: null,
    ...overrides,
  })
  // Last month: counts in 30-day history but not in this month's limits.
  ledger.record(entry({ client: 'Laptop', initiator: 'user', premium: 5 }))
  clock = noon - day
  ledger.record(entry({ client: 'Laptop', initiator: 'user', premium: 1 }))
  clock = noon
  ledger.record(
    entry({ client: 'Laptop', model: 'claude', initiator: 'user', premium: 3 }),
  )
  ledger.record(
    entry({
      client: 'Laptop',
      model: 'claude',
      initiator: 'agent',
      premium: 0,
    }),
  )
  ledger.record(entry({ initiator: 'user', premium: 1, inputTokens: 1000 }))
  ledger.record(entry({ access: 'local', premium: 1 }))
  // Records written before attribution existed still load.
  ledger.record(entry({ client: 'Desk', purpose: 'web-search' }))

  const week = ledger.summary('7d')
  expect(week.totals).toMatchObject({
    requests: 6,
    prompts: 3,
    followUps: 1,
    premiumRequests: 6,
  })
  expect(
    week.clients.map((client) => [
      client.client,
      client.requests,
      client.premiumRequests,
    ]),
  ).toEqual([
    ['Laptop', 3, 4],
    ['Unnamed client', 1, 1],
    ['Desk', 1, 0],
  ])
  expect(week.clients[0]?.lastSeen).toBe(noon)
  expect(week.series.models.map((line) => line.name)).toEqual(['gpt', 'claude'])
  expect(week.series.models[0]?.tokens).toEqual([0, 0, 0, 0, 0, 110, 1230])
  expect(week.series.clients.map((line) => line.name)).toEqual([
    'Unnamed client',
    'Laptop',
    'Desk',
  ])
  expect(week.series.clients[1]?.premium).toEqual([0, 0, 0, 0, 0, 1, 3])
  expect(ledger.summary('30d').clients[0]?.premiumRequests).toBe(9)

  const month = ledger.month()
  expect(month.find((client) => client.client === 'Laptop')).toEqual({
    client: 'Laptop',
    requests: 3,
    premium: 4,
    lastSeen: noon,
    models: { gpt: 1, claude: 3 },
  })
  expect(month).toHaveLength(3)
})

test('premium limits warn per client and per model without blocking', () => {
  expect(premiumLimitsSchema.parse(noPremiumLimits)).toEqual(noPremiumLimits)
  expect(() =>
    premiumLimitsSchema.parse({ ...noPremiumLimits, defaultMonthly: -1 }),
  ).toThrow()
  expect(limitState(5, null)).toBe('none')
  expect(limitState(5, 10)).toBe('ok')
  expect(limitState(8, 10)).toBe('near')
  expect(limitState(11, 10)).toBe('over')
  expect(limitState(0, 0)).toBe('ok')

  const usage: MonthlyClientUsage[] = [
    {
      client: 'Laptop',
      requests: 9,
      premium: 9,
      lastSeen: 5,
      models: { claude: 6, gpt: 3 },
    },
    {
      client: 'Desk',
      requests: 2,
      premium: 2,
      lastSeen: 4,
      models: { gpt: 2 },
    },
    { client: 'Owner', requests: 50, premium: 50, lastSeen: 3, models: {} },
  ]
  const status = premiumLimitStatus(usage, {
    defaultMonthly: 10,
    models: { claude: 5 },
    clients: { Owner: null, Tablet: 20 },
  })
  expect(
    status.map((client) => [client.client, client.limit, client.state]),
  ).toEqual([
    ['Laptop', 10, 'over'],
    // Exempt from the monthly default, but per-model limits still apply.
    ['Owner', null, 'ok'],
    ['Desk', 10, 'ok'],
    ['Tablet', 20, 'ok'],
  ])
  expect(status[0]?.models).toEqual([
    { model: 'claude', premium: 6, limit: 5, state: 'over' },
    { model: 'gpt', premium: 3, limit: null, state: 'none' },
  ])
  expect(status[3]).toMatchObject({ requests: 0, lastSeen: null })
  expect(premiumLimitStatus(usage, noPremiumLimits)[0]?.state).toBe('none')
})
