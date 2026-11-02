import { expect, test } from 'bun:test'
import { createGateway, SourceService } from '../src/runtime'
import { stabilizeResponseItemIds } from '../src/routing/stable-item-ids'

// Copilot-style stream: every event carries a freshly encrypted item id.
const events = [
  { type: 'response.created', response: { id: 'resp', output: [] } },
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: 'r-a', type: 'reasoning' },
  },
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: { id: 'r-b', type: 'reasoning' },
  },
  {
    type: 'response.output_item.added',
    output_index: 1,
    item: { id: 'm-a', type: 'message', content: [] },
  },
  {
    type: 'response.output_text.delta',
    output_index: 1,
    item_id: 'm-b',
    content_index: 0,
    delta: 'Hé',
  },
  {
    type: 'response.output_text.delta',
    output_index: 1,
    item_id: 'm-c',
    content_index: 0,
    delta: 'llo',
  },
  {
    type: 'response.output_item.done',
    output_index: 1,
    item: { id: 'm-d', type: 'message', phase: 'final_answer' },
  },
  {
    type: 'response.completed',
    response: {
      id: 'resp',
      output: [
        { id: 'r-e', type: 'reasoning' },
        { id: 'm-e', type: 'message' },
      ],
    },
  },
]

const sse = (eol: string) =>
  events
    .map(
      (event) =>
        `event: ${event.type}${eol}data: ${JSON.stringify(event)}${eol}${eol}`,
    )
    .join('') + `data: [DONE]${eol}${eol}`

function chunked(text: string, size: number) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size)
        controller.enqueue(bytes.slice(offset, offset + size))
      controller.close()
    },
  })
}

interface StreamEvent {
  type: string
  output_index?: number
  item_id?: string
  delta?: string
  item?: { id: string; phase?: string }
  response?: { output: Array<{ id: string }> }
}

function parse(text: string) {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)) as StreamEvent)
}

function expectStable(text: string) {
  const parsed = parse(text)
  expect(parsed).toHaveLength(events.length)
  const ids = parsed.flatMap((event) =>
    typeof event.output_index === 'number' ?
      [[event.output_index, event.item?.id ?? event.item_id]]
    : [],
  )
  expect(ids).toEqual([
    [0, 'r-a'],
    [0, 'r-a'],
    [1, 'm-a'],
    [1, 'm-a'],
    [1, 'm-a'],
    [1, 'm-a'],
  ])
  expect(parsed.at(-1)?.response?.output.map((item) => item.id)).toEqual([
    'r-a',
    'm-a',
  ])
  expect(
    parsed
      .map((event) => event.delta)
      .filter(Boolean)
      .join(''),
  ).toBe('Héllo')
  expect(parsed.at(-2)?.item?.phase).toBe('final_answer')
}

test('Responses stream items keep the id of their first event across arbitrary chunk boundaries', async () => {
  for (const eol of ['\n', '\r\n'])
    for (const size of [1, 7, 64, 100_000]) {
      const text = await new Response(
        stabilizeResponseItemIds(chunked(sse(eol), size)),
      ).text()
      expectStable(text)
      expect(text).toContain(`event: response.created${eol}`)
      expect(text.endsWith(`data: [DONE]${eol}${eol}`)).toBe(true)
    }
})

test('streams whose ids are already stable pass through byte for byte', async () => {
  const stable = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('')
  const consistent = stable
    .replace(/"r-[a-e]"/gu, '"r-a"')
    .replace(/"m-[a-e]"/gu, '"m-a"')
  expect(
    await new Response(
      stabilizeResponseItemIds(chunked(consistent, 13)),
    ).text(),
  ).toBe(consistent)
  const unterminated =
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"x"}}'
  expect(
    await new Response(
      stabilizeResponseItemIds(chunked(unterminated, 5)),
    ).text(),
  ).toBe(unterminated)
})

test('the gateway gives Codex stable Responses item ids from any source', async () => {
  const sources = new SourceService(
    [],
    { get: () => 'synthetic-key', set: () => {}, remove: () => {} },
    () => {},
    (url) =>
      Promise.resolve(
        url.endsWith('/models') ?
          Response.json({ data: [{ id: 'one' }] })
        : new Response(chunked(sse('\n'), 9), {
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          }),
      ),
  )
  await sources.add({
    label: 'Streaming',
    kind: 'api',
    baseUrl: 'https://provider.example/v1',
    protocol: 'responses',
    apiKey: 'synthetic-key',
    shared: false,
  })
  const response = await createGateway(sources, 'local').request(
    '/v1/responses',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer local' },
      body: JSON.stringify({ model: sources.models()[0].id, stream: true }),
    },
  )
  expect(response.status).toBe(200)
  expectStable(await response.text())
})
