import { afterEach, describe, expect, test } from 'bun:test'
import { createGateway, SourceService } from '../src/runtime'
import type { Credentials, Protocol, SourceInput } from '../src/contracts'
import {
  normalizeBaseUrl,
  sourceHeaders,
  type SourceFetch,
} from '../src/sources/source-service'

class MemoryCredentials implements Credentials {
  readonly values = new Map<string, string>()
  get(id: string): string {
    const value = this.values.get(id)
    if (!value) throw new Error('Credential missing.')
    return value
  }
  set(id: string, value: string): void {
    this.values.set(id, value)
  }
  remove(id: string): void {
    this.values.delete(id)
  }
}

const input: SourceInput = {
  label: 'API source',
  kind: 'api',
  baseUrl: 'https://provider.example/v1',
  protocol: 'responses',
  apiKey: 'synthetic-upstream-key',
  shared: false,
}
const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true)
})

function service(
  fetcher: SourceFetch = async () =>
    Response.json({ data: [{ id: 'model-one' }] }),
) {
  const credentials = new MemoryCredentials()
  return new SourceService([], credentials, () => {}, fetcher)
}

describe('source contracts', () => {
  test('saved metadata cannot bypass URL policy or introduce ambiguous model routes', async () => {
    const sources = service()
    const source = await sources.add(input)
    const restored = (value: typeof source) =>
      new SourceService([value], new MemoryCredentials(), () => {})
    expect(() =>
      restored({ ...source, baseUrl: 'http://provider.example/v1' }),
    ).toThrow('HTTPS')
    expect(() =>
      restored({ ...source, baseUrl: 'https://provider.example/v1/' }),
    ).toThrow('normalized')
    expect(() =>
      restored({ ...source, models: [...source.models, ...source.models] }),
    ).toThrow('unique')
  })
  test('normalizes API prefixes and remote roots without exposing credentials through redirects', () => {
    expect(normalizeBaseUrl('https://host.example/api/v1/', 'api')).toBe(
      'https://host.example/api/v1',
    )
    expect(normalizeBaseUrl('https://host.example/', 'remote')).toBe(
      'https://host.example/v1',
    )
    expect(normalizeBaseUrl('http://127.0.0.1:4000/v1', 'remote')).toBe(
      'http://127.0.0.1:4000/v1',
    )
    for (const url of [
      'http://host.example',
      'https://a:b@host.example',
      'https://host.example?q=1',
      'https://host.example/#a',
    ])
      expect(() => normalizeBaseUrl(url, 'api')).toThrow()
    expect(() =>
      normalizeBaseUrl('https://host.example/api', 'remote'),
    ).toThrow('root URL')
  })

  test('assigns unique qualified routes and keeps provider keys out of source metadata', async () => {
    const sources = service(async (_url, init) => {
      expect(init?.redirect).toBe('error')
      return Response.json({ data: [{ id: 'same-model' }] })
    })
    await sources.add(input)
    await sources.add({ ...input, label: 'Other account' })
    const models = sources.models()
    expect(models).toHaveLength(2)
    expect(models[0].id).not.toBe(models[1].id)
    expect(sources.resolve(models[0].id)?.source.label).toBe(input.label)
    expect(sources.resolve('same-model')).toBeNull()
    expect(JSON.stringify(sources.list())).not.toContain(input.apiKey)
    const copy = sources.list()
    copy[0].shared = true
    expect(sources.models(true)).toHaveLength(0)
  })

  test('fails explicitly for unavailable, invalid, duplicate or incompatible catalogs', async () => {
    for (const fetcher of [
      async () => {
        throw new Error('offline')
      },
      async () => new Response('no', { status: 403 }),
      async () => Response.json({ data: [] }),
      async () => Response.json({ data: [{ id: 'a' }, { id: 'a' }] }),
    ])
      await expect(service(fetcher).add(input)).rejects.toThrow()
    await expect(
      service().add({
        ...input,
        kind: 'remote',
        baseUrl: 'https://remote.example',
      }),
    ).rejects.toThrow('capabilities')
  })

  test('rolls back a new credential when source metadata cannot be committed', async () => {
    const credentials = new MemoryCredentials()
    const sources = new SourceService(
      [],
      credentials,
      () => {
        throw new Error('disk failure')
      },
      async () => Response.json({ data: [{ id: 'one' }] }),
    )
    await expect(sources.add(input)).rejects.toThrow('disk failure')
    expect(credentials.values.size).toBe(0)
    expect(sources.list()).toHaveLength(0)
  })

  test('persists sharing choices and refuses unknown or duplicate source identities', async () => {
    const sources = service()
    const source = await sources.add(input)
    sources.setShared(source.id, true)
    expect(sources.models(true)).toHaveLength(1)
    sources.setShared(source.id, false)
    expect(sources.models(true)).toHaveLength(0)
    expect(() => sources.setShared('unknown', true)).toThrow('does not exist')
    expect(
      () =>
        new SourceService([source, source], new MemoryCredentials(), () => {}),
    ).toThrow('unique')
  })

  test('uses provider-native or remote-gateway authentication without passing incoming headers', () => {
    expect(
      sourceHeaders({ kind: 'api' }, 'messages', 'key').get('x-api-key'),
    ).toBe('key')
    expect(
      sourceHeaders({ kind: 'api' }, 'messages', 'key').get(
        'anthropic-version',
      ),
    ).toBe('2023-06-01')
    expect(
      sourceHeaders({ kind: 'remote' }, 'messages', 'key').get('authorization'),
    ).toBe('Bearer key')
  })
})

describe('authenticated explicit routing', () => {
  test('keeps local and shared catalogs and credentials separate', async () => {
    const sources = service()
    const source = await sources.add(input)
    const local = createGateway(sources, 'local-key')
    const shared = createGateway(sources, 'remote-key', true)
    expect(() => createGateway(sources, '')).toThrow()
    expect((await local.request('/v1/models')).status).toBe(401)
    expect(
      (
        await local.request('/v1/models', {
          headers: { Authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await shared.request('/v1/models', {
          headers: { Authorization: 'Bearer local-key' },
        })
      ).status,
    ).toBe(401)
    const request = () =>
      shared.request('/v1/models', {
        headers: { Authorization: 'Bearer remote-key' },
      })
    expect(await (await request()).json()).toMatchObject({ data: [] })
    sources.setShared(source.id, true)
    expect(await (await request()).json()).toMatchObject({
      data: [{ modelbridge: { protocol: 'responses' } }],
    })
    expect(
      await (
        await local.request('/health', {
          headers: { Authorization: 'Bearer local-key' },
        })
      ).json(),
    ).toMatchObject({ product: 'ModelBridge' })
  })

  test.each<Protocol>(['responses', 'messages', 'chat-completions'])(
    'forwards %s to its exact source with the raw model ID and a streaming body',
    async (protocol) => {
      const sources = service(async (url, init) => {
        if (url.endsWith('/models'))
          return Response.json({ data: [{ id: 'raw-model' }] })
        if (typeof init?.body !== 'string')
          throw new Error('Gateway did not send a JSON request body.')
        expect(JSON.parse(init.body)).toMatchObject({
          model: 'raw-model',
          stream: true,
        })
        expect(new Headers(init?.headers).get('x-client-secret')).toBeNull()
        expect(init?.redirect).toBe('error')
        return new Response('data: {"type":"ready"}\n\ndata: [DONE]\n\n', {
          headers: {
            'content-type': 'text/event-stream',
            'set-cookie': 'private=true',
          },
        })
      })
      await sources.add({ ...input, protocol })
      const model = sources.models()[0].id
      const endpoint =
        protocol === 'chat-completions' ? 'chat/completions' : protocol
      const response = await createGateway(sources, 'local').request(
        `/v1/${endpoint}`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer local',
            'x-client-secret': 'do-not-forward',
          },
          body: JSON.stringify({ model, stream: true }),
        },
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(await response.text()).toBe(
        'data: {"type":"ready"}\n\ndata: [DONE]\n\n',
      )
    },
  )

  test('rejects malformed, unknown, unshared and incompatible requests without fallback', async () => {
    const sources = service()
    await sources.add(input)
    const gateway = createGateway(sources, 'key')
    const send = (body: string, endpoint = 'responses') =>
      gateway.request(`/v1/${endpoint}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer key' },
        body,
      })
    expect((await send('{')).status).toBe(400)
    expect((await send('{}')).status).toBe(400)
    expect((await send('{"model":"unknown"}')).status).toBe(404)
    expect(
      (
        await send(
          JSON.stringify({ model: sources.models()[0].id }),
          'messages',
        )
      ).status,
    ).toBe(422)
    const shared = createGateway(sources, 'key', true)
    expect(
      (
        await shared.request('/v1/responses', {
          method: 'POST',
          headers: { Authorization: 'Bearer key' },
          body: JSON.stringify({ model: sources.models()[0].id }),
        })
      ).status,
    ).toBe(404)
  })

  test('surfaces network and credential errors and redacts upstream error bodies', async () => {
    let failure = 'network'
    const sources = service(async (url) => {
      if (url.endsWith('/models'))
        return Response.json({ data: [{ id: 'one' }] })
      if (failure === 'network') throw new Error('offline')
      return new Response(`rejected ${input.apiKey}`, {
        status: 429,
        headers: { 'retry-after': '2' },
      })
    })
    const source = await sources.add(input)
    const send = () =>
      createGateway(sources, 'key').request('/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer key' },
        body: JSON.stringify({ model: sources.models()[0].id }),
      })
    expect((await send()).status).toBe(502)
    failure = 'upstream'
    const error = await send()
    expect(error.status).toBe(429)
    expect(error.headers.get('retry-after')).toBe('2')
    expect(await error.text()).not.toContain(input.apiKey)
    sources.credentials.remove(source.id)
    expect((await send()).status).toBe(500)
  })
})

test('real local sockets route consumer hub -> producer hub -> selected provider without changing model identity', async () => {
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe(
        `Bearer ${input.apiKey}`,
      )
      if (new URL(request.url).pathname === '/v1/models')
        return Response.json({ data: [{ id: 'native-model' }] })
      expect(await request.json()).toMatchObject({ model: 'native-model' })
      return new Response('data: {"output":"synthetic-ok"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  servers.push(upstream)
  const producer = new SourceService([], new MemoryCredentials(), () => {})
  await producer.add({
    ...input,
    baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
    shared: true,
  })
  const producerGateway = createGateway(producer, 'producer-access', true)
  const host = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => producerGateway.fetch(request),
  })
  servers.push(host)
  const consumer = new SourceService([], new MemoryCredentials(), () => {})
  await consumer.add({
    ...input,
    kind: 'remote',
    baseUrl: `http://127.0.0.1:${host.port}`,
    apiKey: 'producer-access',
  })
  const gateway = createGateway(consumer, 'consumer-access')
  const response = await gateway.request('/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer consumer-access' },
    body: JSON.stringify({ model: consumer.models()[0].id }),
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('synthetic-ok')
})
