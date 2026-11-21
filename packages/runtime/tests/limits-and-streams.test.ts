import { expect, test } from 'bun:test'
import { createGateway, SourceService } from '../src/runtime'
import { readBoundedText } from '../src/sources/source-service'
import { withStreamTimeouts } from '../src/sources/stream-timeouts'

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

// Streams `chunks` with `gap` ms between them, then stalls if `stall` is set.
function trickle(chunks: Array<string>, gap: number, stall = false) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        await sleep(gap)
        controller.enqueue(new TextEncoder().encode(chunk))
      }
      if (!stall) controller.close()
    },
  })
}

test('stream timeouts let a long answer finish but stop a stalled one', async () => {
  const limits = { headers: 100, idle: 60 }
  // Eight 25 ms gaps outlast the 100 ms start limit and the 60 ms idle limit
  // combined, yet no single wait reaches the idle limit.
  const long = withStreamTimeouts(
    async () =>
      new Response(trickle(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 25)),
    limits,
  )
  expect(await (await long('https://source.test')).text()).toBe('abcdefgh')

  const stalled = withStreamTimeouts(
    async () => new Response(trickle(['a'], 0, true)),
    limits,
  )
  await expect((await stalled('https://source.test')).text()).rejects.toThrow(
    'Upstream stream timed out.',
  )

  const silent = withStreamTimeouts(
    (_url, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error)
        })
      }),
    limits,
  )
  await expect(silent('https://source.test')).rejects.toThrow(
    'Upstream response timed out.',
  )

  const client = new AbortController()
  const cancelled = await withStreamTimeouts(
    async () => new Response(trickle(['a'], 0, true)),
    { headers: 1000, idle: 1000 },
  )('https://source.test', { signal: client.signal })
  const reading = cancelled.text()
  client.abort(new Error('client left'))
  await expect(reading).rejects.toThrow('client left')
})

test('a stalled response fails even if upstream cancellation never settles', async () => {
  let cancelled = false
  const fetcher = withStreamTimeouts(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise(() => {}),
          cancel: () => {
            cancelled = true
            return new Promise(() => {})
          },
        }),
      ),
    { headers: 100, idle: 20 },
  )
  const response = await fetcher('https://source.test')
  const result = await Promise.race([
    response.text().then(
      () => 'completed',
      (error: Error) => error.message,
    ),
    sleep(200).then(() => 'hung'),
  ])
  expect(result).toBe('Upstream stream timed out.')
  expect(cancelled).toBe(true)
})

test('cancelling a response aborts its upstream request', async () => {
  let upstreamSignal: AbortSignal | undefined
  const fetcher = withStreamTimeouts(
    async (_url, init) => {
      upstreamSignal = init?.signal ?? undefined
      return new Response(new ReadableStream<Uint8Array>())
    },
    { headers: 100, idle: 100 },
  )
  const response = await fetcher('https://source.test')
  await response.body?.cancel('client stopped reading')
  expect(upstreamSignal?.aborted).toBe(true)
})

test('catalog reads enforce the exact byte boundary and decode split UTF-8 without loss', async () => {
  expect(await readBoundedText(new Response(null), 1)).toBe('')
  expect(await readBoundedText(new Response('abcd'), 4)).toBe('abcd')
  await expect(readBoundedText(new Response('abcde'), 4)).rejects.toThrow(
    '4-byte',
  )
  const bytes = new TextEncoder().encode('caf\u00e9')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 4))
      controller.enqueue(bytes.slice(4))
      controller.close()
    },
  })
  expect(await readBoundedText(new Response(body), 5)).toBe('caf\u00e9')
  await expect(readBoundedText(new Response('caf\u00e9'), 4)).rejects.toThrow(
    '4-byte',
  )
})

test('invalid and oversized catalogs are explicit failures, not empty successful discovery', async () => {
  const credentials = {
    get: () => 'synthetic-key',
    set: () => {},
    remove: () => {},
  }
  const input = {
    label: 'Limits',
    kind: 'api' as const,
    baseUrl: 'https://provider.example/v1',
    protocol: 'responses' as const,
    apiKey: 'synthetic-key',
    shared: false,
  }
  for (const body of [
    '{broken',
    '{"data":[]}',
    'x'.repeat(4 * 1024 * 1024 + 1),
  ]) {
    const sources = new SourceService(
      [],
      credentials,
      () => {},
      () => Promise.resolve(new Response(body)),
    )
    await expect(sources.add(input)).rejects.toThrow()
    expect(sources.list()).toHaveLength(0)
  }
})

test('gateway enforces the 8 MiB request limit and streams a result before the upstream finishes', async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  let forwarded = 0
  const sources = new SourceService(
    [],
    { get: () => 'synthetic-key', set: () => {}, remove: () => {} },
    () => {},
    (url) => {
      if (url.endsWith('/models'))
        return Promise.resolve(Response.json({ data: [{ id: 'one' }] }))
      forwarded++
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      )
    },
  )
  await sources.add({
    label: 'Streaming',
    kind: 'api',
    baseUrl: 'https://provider.example/v1',
    protocol: 'responses',
    apiKey: 'synthetic-key',
    shared: false,
  })
  const gateway = createGateway(sources, 'local')
  const headers = { Authorization: 'Bearer local' }
  const tooLarge = await gateway.request('/v1/responses', {
    method: 'POST',
    headers,
    body: 'x'.repeat(8 * 1024 * 1024 + 1),
  })
  expect(tooLarge.status).toBe(413)
  expect(forwarded).toBe(0)
  const response = await gateway.request('/v1/responses', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: sources.models()[0].id }),
  })
  if (!stream || !response.body)
    throw new Error('No inference stream was created.')
  const reader = response.body.getReader()
  stream.enqueue(new TextEncoder().encode('data: first\n\n'))
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(
    'data: first\n\n',
  )
  stream.enqueue(new TextEncoder().encode('data: second\n\n'))
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(
    'data: second\n\n',
  )
  stream.close()
  expect((await reader.read()).done).toBe(true)
})
