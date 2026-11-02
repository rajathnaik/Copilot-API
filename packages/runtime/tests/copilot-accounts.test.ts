import { expect, test } from 'bun:test'
import { CopilotProvider } from '../src/providers/copilot'
import { SourceService } from '../src/sources/source-service'
import type { Credentials, Source } from '../src/contracts'

function credentials(initial: Record<string, string> = {}): Credentials & {
  values: Map<string, string>
} {
  const values = new Map(Object.entries(initial))
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

const catalog = {
  data: [
    { id: 'gpt', supported_endpoints: ['/responses'] },
    { id: 'claude', supported_endpoints: ['/v1/messages'] },
  ],
}

function provider(vault: Credentials, logins: Record<string, string | null>) {
  return new CopilotProvider(vault, async (url, init) => {
    const authorization = new Headers(init?.headers).get('authorization') ?? ''
    const token = authorization.replace(/^token /u, '')
    if (url === 'https://api.github.com/user') {
      const login = logins[token]
      return login ?
          Response.json({ login })
        : new Response('unavailable', { status: 503 })
    }
    if (url.endsWith('/copilot_internal/v2/token'))
      return Response.json({
        token: `copilot-${token}`,
        refresh_in: 600,
        expires_at: 9_999_999_999,
      })
    if (url.endsWith('/models')) return Response.json(catalog)
    return new Response('unexpected', { status: 404 })
  })
}

test('signing in again with the same GitHub account renews the existing Copilot source', async () => {
  const vault = credentials()
  const saved: Source[][] = []
  const sources = new SourceService(
    [],
    vault,
    (next) => saved.push(next),
    fetch,
    provider(vault, { first: 'Octocat', second: 'octocat', other: 'hubot' }),
  )
  const original = await sources.addCopilot('first', 'Copilot', true)
  expect(original.account).toBe('octocat')
  sources.setShared(original.id, true, ['gpt'])
  sources.setWebSearchModel(original.id, 'gpt')

  const renewed = await sources.addCopilot('second', 'Ignored label', false)
  expect(renewed.id).toBe(original.id)
  expect(renewed.label).toBe('Copilot')
  expect(renewed.shared).toBe(true)
  expect(renewed.sharedModelIds).toEqual(['gpt'])
  expect(renewed.webSearchModelId).toBe('gpt')
  expect(vault.get(original.id)).toBe('second')
  expect(sources.list()).toHaveLength(1)

  const other = await sources.addCopilot('other', 'Work', false)
  expect(other.id).not.toBe(original.id)
  expect(sources.list().map((source) => source.account)).toEqual([
    'octocat',
    'hubot',
  ])
  expect(saved.at(-1)).toHaveLength(2)
})

test('sign-in keeps adding sources when the GitHub account cannot be read, and restores the key if saving fails', async () => {
  const vault = credentials()
  let fail = false
  const sources = new SourceService(
    [],
    vault,
    () => {
      if (fail) throw new Error('disk full')
    },
    fetch,
    provider(vault, { first: 'octocat', second: 'octocat' }),
  )
  await sources.addCopilot('unknown-1', 'Copilot', true)
  await sources.addCopilot('unknown-2', 'Copilot', true)
  expect(sources.list()).toHaveLength(2)
  expect(sources.list().every((source) => !source.account)).toBe(true)

  const source = await sources.addCopilot('first', 'Copilot', true)
  fail = true
  await expect(sources.addCopilot('second', 'Copilot', true)).rejects.toThrow(
    'disk full',
  )
  expect(vault.get(source.id)).toBe('first')
})

test('startup merges saved duplicate Copilot sources for one account, keeping the shared source', async () => {
  const model = { id: 'gpt', name: 'gpt', protocol: 'responses' as const }
  const copilot = (id: string, shared: boolean, account?: string): Source => ({
    id,
    label: 'My Copilot subscription',
    kind: 'copilot',
    baseUrl: 'https://api.githubcopilot.com/v1',
    shared,
    ...(account && { account }),
    models: [model],
  })
  const ids = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000005',
  ]
  const vault = credentials({
    [ids[0]]: 'old',
    [ids[1]]: 'new',
    [ids[2]]: 'offline',
    [ids[4]]: 'api-key',
  })
  const saved: Source[][] = []
  const sources = new SourceService(
    [
      copilot(ids[0], false),
      copilot(ids[1], true),
      copilot(ids[2], false),
      copilot(ids[3], false, 'hubot'),
      {
        id: ids[4],
        label: 'API',
        kind: 'api',
        baseUrl: 'https://example.test/v1',
        shared: false,
        models: [model],
      },
    ],
    vault,
    (next) => saved.push(next),
    fetch,
    provider(vault, { old: 'octocat', new: 'octocat', offline: null }),
  )
  expect(await sources.mergeCopilotAccounts()).toBe(1)
  expect(
    sources.list().map((source) => [source.id, source.account ?? null]),
  ).toEqual([
    [ids[1], 'octocat'],
    [ids[2], null],
    [ids[3], 'hubot'],
    [ids[4], null],
  ])
  expect(vault.values.has(ids[0])).toBe(false)
  expect(vault.get(ids[1])).toBe('new')
  expect(saved).toHaveLength(1)

  expect(await sources.mergeCopilotAccounts()).toBe(0)
  expect(saved).toHaveLength(1)
})
