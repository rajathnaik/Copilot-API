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

test('protected storage survives restart without plaintext or silent credential recovery', () => {
  const file = path.join(directory(), 'vault.json')
  const vault = new EncryptedVault(file, codec)
  expect(() => vault.set('source', '  ')).toThrow('nonempty')
  expect(() => vault.get('missing')).toThrow('No saved')
  vault.set('source', 'synthetic-protected-key')
  expect(() =>
    new EncryptedVault(file, { ...codec, decrypt: () => '' }).get('source'),
  ).toThrow('OS profile')
  expect(fs.readFileSync(file, 'utf8')).not.toContain('synthetic-protected-key')
  expect(new EncryptedVault(file, codec).get('source')).toBe(
    'synthetic-protected-key',
  )
  expect(() =>
    new EncryptedVault(file, {
      ...codec,
      decrypt: () => {
        throw new Error('profile changed')
      },
    }).get('source'),
  ).toThrow('OS profile')
  vault.remove('source')
  expect(() => vault.get('source')).toThrow()
  fs.writeFileSync(file, '{broken')
  expect(() => new EncryptedVault(file, codec)).toThrow()
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
