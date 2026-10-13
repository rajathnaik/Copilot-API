import { expect, test } from 'bun:test'
import { createCodexCatalog } from '../src/harnesses/codex-catalog'
import { createGateway, SourceService } from '../src/runtime'

test('Codex uses a native models envelope and exact qualified routes, with conservative capabilities', () => {
  const catalog = createCodexCatalog([
    {
      id: 'source/one',
      name: 'One',
      sourceId: 'source',
      sourceLabel: 'Host',
      protocol: 'responses',
      supportsTools: true,
      contextWindow: 32000,
    },
    {
      id: 'source/two',
      name: 'Two',
      sourceId: 'source',
      sourceLabel: 'Host',
      protocol: 'responses',
    },
    {
      id: 'source/messages',
      name: 'Messages',
      sourceId: 'source',
      sourceLabel: 'Host',
      protocol: 'messages',
    },
  ])
  expect(catalog.models.map((model) => model.slug)).toEqual([
    'source/one',
    'source/two',
  ])
  expect(catalog.models[0]).toMatchObject({
    display_name: 'One / Host',
    shell_type: 'unified_exec',
    context_window: 32000,
    visibility: 'list',
    supported_in_api: true,
  })
  expect(
    catalog.models[0].model_messages.instructions_template.trim(),
  ).not.toBe('')
  expect(catalog.models[0].input_modalities).toEqual(['text'])
  expect(catalog.models[0].supports_reasoning_summary_parameter).toBe(false)
  expect(catalog.models[1]).toMatchObject({
    shell_type: 'disabled',
    context_window: 10000,
    supported_reasoning_levels: [],
  })
})

test('native catalog is authenticated, sharing-scoped and refreshed by deterministic ETag', async () => {
  const sources = new SourceService(
    [],
    { get: () => 'synthetic', set: () => {}, remove: () => {} },
    () => {},
    () =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: 'one',
              modelbridge: {
                protocol: 'responses',
                supportsTools: true,
                contextWindow: 32000,
              },
            },
          ],
        }),
      ),
  )
  const source = await sources.add({
    label: 'Host',
    kind: 'api',
    baseUrl: 'https://provider.example/v1',
    protocol: 'responses',
    apiKey: 'synthetic',
    shared: false,
  })
  const gateway = createGateway(sources, 'local', true)
  expect((await gateway.request('/v1/codex/models')).status).toBe(401)
  const headers = { Authorization: 'Bearer local' }
  expect((await gateway.request('/v1/codex/models', { headers })).status).toBe(
    422,
  )
  sources.setShared(source.id, true)
  const first = await gateway.request('/v1/codex/models', { headers })
  expect(await first.json()).toMatchObject({
    models: [{ slug: `${source.id}/one`, shell_type: 'unified_exec' }],
  })
  const etag = first.headers.get('etag')
  if (!etag) throw new Error('Native catalog is missing ETag.')
  expect(
    (
      await gateway.request('/v1/codex/models', {
        headers: { ...headers, 'If-None-Match': etag },
      })
    ).status,
  ).toBe(304)
  await sources.add({
    label: 'Another host',
    kind: 'api',
    baseUrl: 'https://another.example/v1',
    protocol: 'responses',
    apiKey: 'synthetic',
    shared: true,
  })
  const changed = await gateway.request('/v1/codex/models', {
    headers: { ...headers, 'If-None-Match': etag },
  })
  expect(changed.status).toBe(200)
  expect(changed.headers.get('etag')).not.toBe(etag)
  expect(await changed.json()).toMatchObject({ models: [{}, {}] })
  sources.setShared(source.id, false)
  const remaining = sources.list().find((item) => item.id !== source.id)
  if (!remaining) throw new Error('Additional test source is missing.')
  sources.setShared(remaining.id, false)
  expect(
    (
      await gateway.request('/v1/codex/models', {
        headers: { ...headers, 'If-None-Match': etag },
      })
    ).status,
  ).toBe(422)
})

test('Codex catalog enforces the actual native client response-size limit', async () => {
  const sources = new SourceService(
    [],
    { get: () => 'synthetic', set: () => {}, remove: () => {} },
    () => {},
    () =>
      Promise.resolve(
        Response.json({
          data: Array.from({ length: 2000 }, (_, index) => ({
            id: `model-${index}`,
            name: 'Model'.repeat(20),
          })),
        }),
      ),
  )
  await sources.add({
    label: 'Catalog limit fixture',
    kind: 'api',
    baseUrl: 'https://provider.example/v1',
    protocol: 'responses',
    apiKey: 'synthetic',
    shared: false,
  })
  const response = await createGateway(sources, 'local').request(
    '/v1/codex/models',
    { headers: { Authorization: 'Bearer local' } },
  )
  expect(response.status).toBe(413)
  expect(await response.text()).toContain('1 MiB')
})
