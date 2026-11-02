import { expect, test } from 'bun:test'
import { SourceService } from '../src/sources/source-service'
import type { Credentials, Source } from '../src/contracts'

function credentials(): Credentials & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
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

const hosts: Record<string, { key: string; models: string[] }> = {
  'https://first.devtunnels.ms/v1': { key: 'first-key', models: ['gpt'] },
  'https://second.devtunnels.ms/v1': {
    key: 'second-key',
    models: ['gpt', 'claude'],
  },
  'https://api.example.test/v1': { key: 'api-key', models: ['plain'] },
}

function setup() {
  const vault = credentials()
  const saved: Source[][] = []
  const requests: string[] = []
  let failSave = false
  const sources = new SourceService(
    [],
    vault,
    (next) => {
      if (failSave) throw new Error('disk full')
      saved.push(next)
    },
    async (url, init) => {
      requests.push(url)
      const host = hosts[url.replace(/\/models$/u, '')]
      const key = new Headers(init?.headers)
        .get('authorization')
        ?.replace(/^Bearer /u, '')
      if (!host) throw new Error('offline')
      if (key !== host.key) return new Response('denied', { status: 401 })
      return Response.json({
        data: host.models.map((id) => ({
          id,
          ...(url.includes('devtunnels') && {
            modelbridge: { protocol: 'responses' },
          }),
        })),
      })
    },
  )
  return {
    vault,
    saved,
    requests,
    sources,
    failSaves: () => {
      failSave = true
    },
  }
}

const remote = (baseUrl: string, apiKey: string, label = 'Remote host') => ({
  label,
  kind: 'remote' as const,
  baseUrl,
  protocol: 'responses' as const,
  apiKey,
  shared: false,
})

test('adding a host URL that is already connected reconnects it in place', async () => {
  const { sources, vault } = setup()
  const original = await sources.add(
    remote('https://first.devtunnels.ms', 'first-key', 'Home laptop'),
  )
  hosts['https://first.devtunnels.ms/v1'] = {
    key: 'rotated-key',
    models: ['gpt', 'gpt-mini'],
  }
  try {
    const again = await sources.add(
      remote('https://first.devtunnels.ms/v1/', 'rotated-key', 'Ignored'),
    )
    expect(again.id).toBe(original.id)
    expect(again.label).toBe('Home laptop')
    expect(again.models.map((model) => model.id)).toEqual(['gpt', 'gpt-mini'])
    expect(vault.get(original.id)).toBe('rotated-key')
    expect(sources.list()).toHaveLength(1)
  } finally {
    hosts['https://first.devtunnels.ms/v1'] = {
      key: 'first-key',
      models: ['gpt'],
    }
  }
  // Provider APIs may legitimately be added twice with different keys.
  const api = {
    label: 'API',
    kind: 'api' as const,
    baseUrl: 'https://api.example.test/v1',
    protocol: 'responses' as const,
    apiKey: 'api-key',
    shared: false,
  }
  await sources.add(api)
  await sources.add(api)
  expect(sources.list()).toHaveLength(3)
})

test('editing renames without contacting the host, and verifies a new URL or key before saving it', async () => {
  const { sources, vault, requests } = setup()
  const source = await sources.add(
    remote('https://first.devtunnels.ms', 'first-key'),
  )
  requests.length = 0
  const renamed = await sources.update({
    sourceId: source.id,
    label: 'Office desktop',
    baseUrl: source.baseUrl,
  })
  expect(renamed.label).toBe('Office desktop')
  expect(requests).toHaveLength(0)

  await expect(
    sources.update({
      sourceId: source.id,
      label: 'Office desktop',
      baseUrl: 'https://second.devtunnels.ms',
      apiKey: 'wrong-key',
    }),
  ).rejects.toThrow('HTTP 401')
  expect(sources.list()[0]?.baseUrl).toBe('https://first.devtunnels.ms/v1')
  expect(vault.get(source.id)).toBe('first-key')

  const moved = await sources.update({
    sourceId: source.id,
    label: 'Office desktop',
    baseUrl: 'https://second.devtunnels.ms',
    apiKey: 'second-key',
  })
  expect(moved.id).toBe(source.id)
  expect(moved.baseUrl).toBe('https://second.devtunnels.ms/v1')
  expect(moved.models.map((model) => model.id)).toEqual(['gpt', 'claude'])
  expect(vault.get(source.id)).toBe('second-key')
})

test('edits cannot create duplicate hosts, change Copilot access, or leave a new key when saving fails', async () => {
  const { sources, vault, failSaves } = setup()
  const first = await sources.add(
    remote('https://first.devtunnels.ms', 'first-key'),
  )
  await sources.add(remote('https://second.devtunnels.ms', 'second-key'))
  await expect(
    sources.update({
      sourceId: first.id,
      label: 'Moved',
      baseUrl: 'https://second.devtunnels.ms',
    }),
  ).rejects.toThrow('already uses this URL')
  await expect(
    sources.update({
      sourceId: '00000000-0000-4000-8000-000000000000',
      label: 'Missing',
    }),
  ).rejects.toThrow('does not exist')

  const copilot = new SourceService(
    [
      {
        id: '00000000-0000-4000-8000-000000000001',
        label: 'Copilot',
        kind: 'copilot',
        baseUrl: 'https://api.githubcopilot.com',
        shared: true,
        models: [{ id: 'gpt', name: 'gpt', protocol: 'responses' }],
      },
    ],
    credentials(),
    () => {},
  )
  const id = '00000000-0000-4000-8000-000000000001'
  expect((await copilot.update({ sourceId: id, label: 'Work' })).label).toBe(
    'Work',
  )
  await expect(
    copilot.update({ sourceId: id, label: 'Work', apiKey: 'token' }),
  ).rejects.toThrow('only be renamed')

  hosts['https://first.devtunnels.ms/v1'] = {
    key: 'rotated-key',
    models: ['gpt'],
  }
  failSaves()
  try {
    await expect(
      sources.update({
        sourceId: first.id,
        label: 'Rotated',
        apiKey: 'rotated-key',
      }),
    ).rejects.toThrow('disk full')
  } finally {
    hosts['https://first.devtunnels.ms/v1'] = {
      key: 'first-key',
      models: ['gpt'],
    }
  }
  expect(vault.get(first.id)).toBe('first-key')
  expect(sources.list().map((source) => source.label)).toEqual([
    'Remote host',
    'Remote host',
  ])
})

test('removing a source deletes it and its key, and keeps both if saving fails', async () => {
  const { sources, vault, saved, failSaves } = setup()
  const first = await sources.add(
    remote('https://first.devtunnels.ms', 'first-key'),
  )
  const second = await sources.add(
    remote('https://second.devtunnels.ms', 'second-key'),
  )
  await sources.remove(first.id)
  expect(sources.list().map((source) => source.id)).toEqual([second.id])
  expect(sources.models().every((model) => model.sourceId === second.id)).toBe(
    true,
  )
  expect(vault.values.has(first.id)).toBe(false)
  expect(saved.at(-1)).toHaveLength(1)
  await expect(sources.remove(first.id)).rejects.toThrow('does not exist')

  failSaves()
  await expect(sources.remove(second.id)).rejects.toThrow('disk full')
  expect(sources.list()).toHaveLength(1)
  expect(vault.get(second.id)).toBe('second-key')
})
