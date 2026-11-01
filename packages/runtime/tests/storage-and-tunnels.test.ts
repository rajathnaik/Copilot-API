import { afterEach, expect, test, spyOn } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWrite, EncryptedVault } from '../src/credentials/vault'
import {
  DevTunnels,
  validateTunnelUrl,
  type TunnelCommand,
} from '../src/remote-access/dev-tunnels'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})
function directory() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'modelbridge-core-'))
  directories.push(value)
  return value
}
const codec = {
  encrypt: (value: string) => Buffer.from(value).reverse().toString('base64'),
  decrypt: (value: string) => Buffer.from(value, 'base64').reverse().toString(),
}

test('protected storage survives restart without plaintext or silent credential recovery', async () => {
  const file = path.join(directory(), 'vault.json')
  const vault = await EncryptedVault.open(file, codec)
  await expect(vault.set('source', '  ')).rejects.toThrow('nonempty')
  expect(() => vault.get('missing')).toThrow('No saved')
  await vault.set('source', 'synthetic-protected-key')
  const empty = await EncryptedVault.open(file, { ...codec, decrypt: () => '' })
  expect(() => empty.get('source')).toThrow('OS profile')
  expect(fs.readFileSync(file, 'utf8')).not.toContain('synthetic-protected-key')
  expect((await EncryptedVault.open(file, codec)).get('source')).toBe(
    'synthetic-protected-key',
  )
  const changed = await EncryptedVault.open(file, {
    ...codec,
    decrypt: () => {
      throw new Error('profile changed')
    },
  })
  expect(() => changed.get('source')).toThrow('OS profile')
  await vault.remove('source')
  expect(() => vault.get('source')).toThrow()
  fs.writeFileSync(file, '{broken')
  await expect(EncryptedVault.open(file, codec)).rejects.toThrow()
})

test('vault decrypts once on open, serializes concurrent writes and upgrades only outdated records', async () => {
  const file = path.join(directory(), 'vault.json')
  let decrypts = 0
  const asyncCodec = {
    encrypt: async (value: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return `v2:${codec.encrypt(value)}`
    },
    decrypt: async (value: string) => {
      decrypts++
      await Promise.resolve()
      return codec.decrypt(value.replace(/^v[12]:/u, ''))
    },
    isCurrent: (value: string) => value.startsWith('v2:'),
  }
  fs.writeFileSync(
    file,
    JSON.stringify({
      old: `v1:${codec.encrypt('legacy-value')}`,
      fresh: `v2:${codec.encrypt('fresh-value')}`,
    }),
  )
  const narrow = await EncryptedVault.open(file, asyncCodec, ['fresh'])
  expect(decrypts).toBe(1)
  expect(narrow.get('fresh')).toBe('fresh-value')
  expect(() => narrow.get('old')).toThrow('cannot decrypt')
  decrypts = 0
  const vault = await EncryptedVault.open(file, asyncCodec)
  expect(decrypts).toBe(2)
  expect(vault.get('old')).toBe('legacy-value')
  expect(vault.get('old')).toBe('legacy-value')
  expect(decrypts).toBe(2)
  await Promise.all([
    vault.set('first', 'first-value'),
    vault.set('second', 'second-value'),
    vault.setMany({ third: 'third-value', fourth: 'fourth-value' }),
  ])
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
    string,
    string
  >
  expect(Object.keys(saved).sort()).toEqual([
    'first',
    'fourth',
    'fresh',
    'old',
    'second',
    'third',
  ])
  expect(await vault.upgrade('fresh')).toBe(false)
  expect(await vault.upgrade('missing')).toBe(false)
  expect(await vault.upgrade('old')).toBe(true)
  const upgraded = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
    string,
    string
  >
  expect(upgraded.old).toStartWith('v2:')
  expect((await EncryptedVault.open(file, asyncCodec)).get('old')).toBe(
    'legacy-value',
  )
  const failing = await EncryptedVault.open(file, {
    ...asyncCodec,
    encrypt: () => Promise.reject(new Error('provider unavailable')),
  })
  await expect(failing.set('first', 'replacement')).rejects.toThrow(
    'provider unavailable',
  )
  expect(failing.get('first')).toBe('first-value')
  expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(upgraded))
  await failing.remove('fresh')
  expect(() => failing.get('fresh')).toThrow('No saved')
})

test('atomic writes preserve an existing credential when replacement fails and clean their own temporary file', () => {
  const root = directory()
  const file = path.join(root, 'vault.json')
  atomicWrite(file, 'original')
  const rename = spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('synthetic rename failure')
  })
  try {
    expect(() => atomicWrite(file, 'replacement')).toThrow('rename failure')
  } finally {
    rename.mockRestore()
  }
  expect(fs.readFileSync(file, 'utf8')).toBe('original')
  expect(fs.readdirSync(root)).toEqual(['vault.json'])
})

test.skipIf(process.platform !== 'win32')(
  'atomic writes ride out transient Windows file locks but not persistent ones',
  () => {
    const root = directory()
    const file = path.join(root, 'vault.json')
    const real = fs.renameSync.bind(fs)
    const locked = () =>
      Object.assign(new Error('EPERM: operation not permitted'), {
        code: 'EPERM',
      })
    let failures = 2
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (failures-- > 0) throw locked()
      real(from, to)
    })
    try {
      atomicWrite(file, 'saved')
      expect(rename).toHaveBeenCalledTimes(3)
      failures = Number.POSITIVE_INFINITY
      expect(() => atomicWrite(file, 'replacement')).toThrow('EPERM')
    } finally {
      rename.mockRestore()
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('saved')
    expect(fs.readdirSync(root)).toEqual(['vault.json'])
  },
)

const id = `modelbridge-${'a'.repeat(32)}`
test('provisions an owned persistent tunnel and reads Microsoft-issued URLs without deleting other ports', async () => {
  const calls: string[][] = []
  let exists = false
  let port = false
  let anonymous = false
  const command: TunnelCommand = async (args) => {
    calls.push(args)
    if (args[0] === 'create') exists = true
    if (args[0] === 'access') anonymous = true
    if (args[0] === 'port') port = true
    if (args[0] === 'show') {
      if (!exists) return { code: 1, output: 'Tunnel not found' }
      return {
        code: 0,
        output: JSON.stringify({
          tunnel: {
            tunnelId: id,
            accessControl:
              anonymous ? [{ type: 'Anonymous', scopes: ['connect'] }] : [],
            ports:
              port ?
                [
                  {
                    portNumber: 4322,
                    portUri: 'https://owned-4322.euw.devtunnels.ms/',
                  },
                ]
              : [],
          },
        }),
      }
    }
    return { code: 0, output: 'done' }
  }
  const transport = new DevTunnels(id, command)
  expect(await transport.provision(4322)).toEqual({
    id,
    url: 'https://owned-4322.euw.devtunnels.ms',
  })
  expect(calls).toContainEqual(['create', id, '--allow-anonymous'])
  expect(calls).toContainEqual([
    'port',
    'create',
    id,
    '-p',
    '4322',
    '--protocol',
    'http',
  ])
  expect(
    calls.some(
      (args) => args.includes('delete') || args.includes('delete-all'),
    ),
  ).toBe(false)
  calls.length = 0
  await transport.provision(4322)
  expect(calls.every((args) => args[0] === 'show')).toBe(true)
})

test('tunnel failures do not invent URLs, claim readiness, modify unrelated resources or create resources after auth failures', async () => {
  expect(
    () => new DevTunnels('copilot-api', async () => ({ code: 0, output: '' })),
  ).toThrow('owned')
  const deniedCalls: string[][] = []
  const denied = new DevTunnels(id, async (args) => {
    deniedCalls.push(args)
    return { code: 1, output: 'Unauthorized' }
  })
  await expect(denied.provision(4322)).rejects.toThrow('no new tunnel')
  expect(deniedCalls).toHaveLength(1)
  await expect(denied.provision(0)).rejects.toThrow('valid')
  for (const output of [
    'not JSON',
    '{"tunnel":{"tunnelId":"someone-else"}}',
    JSON.stringify({
      tunnel: {
        tunnelId: id,
        accessControl: [{ type: 'Anonymous', scopes: ['connect'] }],
        ports: [{ portNumber: 4322 }],
      },
    }),
    JSON.stringify({
      tunnel: {
        tunnelId: id,
        accessControl: [{ type: 'Anonymous', scopes: ['connect'] }],
        ports: [{ portNumber: 4322, portUri: 'https://attacker.example' }],
      },
    }),
  ])
    await expect(
      new DevTunnels(id, async () => ({ code: 0, output })).provision(4322),
    ).rejects.toThrow()
  await expect(
    new DevTunnels(id, async (args) => ({
      code: 1,
      output: args[0] === 'show' ? 'Tunnel not found' : 'create denied',
    })).provision(4322),
  ).rejects.toThrow('create failed')
  expect(() => validateTunnelUrl('http://host.devtunnels.ms')).toThrow()
})
