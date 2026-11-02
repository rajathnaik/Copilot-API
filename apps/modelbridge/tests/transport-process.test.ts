import { expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as childProcess from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { DevTunnels } from '@modelbridge/runtime/dev-tunnels'
import {
  parseHostUrl,
  parseTunnelUser,
  refreshRegistryPath,
  resolveDevTunnelExecutable,
  TunnelProcess,
} from '../electron/devtunnel-process'

type ExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void

function fakeRegistry(reply: () => string) {
  return spyOn(childProcess, 'execFile').mockImplementation(((
    ...args: unknown[]
  ) => {
    const callback = args.at(-1) as ExecCallback
    callback(null, reply(), '')
    return new EventEmitter()
  }) as unknown as typeof childProcess.execFile)
}

test('host URLs come from the sharing port, not metadata, partial lines or inspection links', () => {
  const url = 'https://owned-4322.euw.devtunnels.ms'
  expect(
    parseHostUrl(`Hosting port: 4322\nConnect via browser: ${url}/\n`, 4322),
  ).toBe(url)
  expect(
    parseHostUrl(
      `Hosting port 4322 at https://owned.euw.devtunnels.ms:4322/, ${url}/ and inspect it at https://owned-4322-inspect.euw.devtunnels.ms/\n`,
      4322,
    ),
  ).toBe(url)
  expect(parseHostUrl(`Connect via browser: ${url}/\r\n`, 4322)).toBe(url)
  expect(
    parseHostUrl(
      'Connect via browser: https://owned.euw.devtunnels.ms:4322/\n',
      4322,
    ),
  ).toBe('https://owned.euw.devtunnels.ms:4322')
  expect(
    parseHostUrl(`Hosting port: 4322\nConnect via browser: ${url}/`, 4322),
  ).toBeNull()
  expect(
    parseHostUrl(
      'Hosting port 9000 at https://owned-9000.euw.devtunnels.ms/\n',
      4322,
    ),
  ).toBeNull()
  expect(
    parseHostUrl(
      'Connect via browser: https://owned-9000.euw.devtunnels.ms/\n',
      4322,
    ),
  ).toBeNull()
  expect(
    parseHostUrl(
      'Hosting port: 4322\nConnect via browser: https://owned-4322-inspect.euw.devtunnels.ms/\n',
      4322,
    ),
  ).toBeNull()
  expect(
    parseHostUrl(
      'Hosting port: 4322\nConnect via browser: https://owned-4322.euw.devtunnels.ms/, https://owned-4322-inspect.euw.devtunnels.ms/\n',
      4322,
    ),
  ).toBe(url)
  for (const invalid of [
    'http://owned-4322.euw.devtunnels.ms',
    'https://attacker.example',
    'https://owned-4322.euw.devtunnels.ms?token=unexpected',
  ]) {
    expect(() =>
      parseHostUrl(`Hosting port 4322 at ${invalid}\n`, 4322),
    ).toThrow()
  }
})

test('URL-less provisioning starts hosting, requires both URL and readiness, and cleans failed starts', async () => {
  const callbacks: Array<() => void> = []
  const timers: Array<ReturnType<typeof setTimeout>> = []
  const originalTimeout = setTimeout
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(
    new Proxy(originalTimeout, {
      apply(_target, _this, args: unknown[]) {
        const callback = args[0]
        if (typeof callback !== 'function')
          throw new Error('Expected timeout callback.')
        callbacks.push(() => {
          Reflect.apply(callback, undefined, [])
        })
        const timer = originalTimeout(() => {}, 60_000)
        timers.push(timer)
        return timer
      },
    }),
  )
  const calls: string[][] = []
  const children: Array<
    EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean }
  > = []
  const id = `modelbridge-${'a'.repeat(32)}`
  const transport = new TunnelProcess({
    command: async (args) => {
      calls.push(args)
      return {
        code: 0,
        output: JSON.stringify({
          tunnel: {
            tunnelId: id,
            accessControl: [{ type: 'Anonymous', scopes: ['connect'] }],
            ports: [
              { portNumber: 4322, protocol: 'http' },
              { portNumber: 9000 },
            ],
          },
        }),
      }
    },
    spawn: (args) => {
      calls.push(args)
      const events = new EventEmitter()
      const child = Object.assign(events, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        kill: () => {
          events.emit('close', 0)
          return true
        },
      })
      children.push(child)
      return child
    },
  })
  const child = () => {
    const value = children.at(-1)
    if (!value) throw new Error('Missing host process.')
    return value
  }
  const expire = () => {
    const callback = callbacks.at(-1)
    if (!callback) throw new Error('Missing timeout.')
    callback()
  }
  try {
    await expect(transport.start(id, 0)).rejects.toThrow('valid sharing port')
    const resource = await new DevTunnels(id, (args) =>
      transport.command(args),
    ).provision(4322)
    let started = transport.start(resource.id, 4322)
    expect(calls.at(-1)).toEqual(['host', id])
    child().stdout.emit(
      'data',
      Buffer.from(
        'Hosting port 9000 at https://owned-9000.euw.devtunnels.ms/\nReady to accept connections\n',
      ),
    )
    expect(transport.running).toBe(false)
    child().stdout.emit(
      'data',
      Buffer.from('Hosting port 4322 at https://owned-4322.eu'),
    )
    expect(transport.running).toBe(false)
    child().stderr.emit('data', Buffer.from('w.devtunnels.ms/\n'))
    expect(await started).toBe('https://owned-4322.euw.devtunnels.ms')
    expect(transport.running).toBe(true)
    await transport.stop()
    started = transport.start(id, 4322)
    child().stdout.emit(
      'data',
      Buffer.from(
        'Hosting port: 4322\nConnect via browser: https://owned-4322.euw.devtunnels.ms/\n',
      ),
    )
    expect(transport.running).toBe(false)
    child().stdout.emit('data', Buffer.from('Ready to accept connections\n'))
    await started
    await transport.stop()
    started = transport.start(id, 4322)
    child().stdout.emit('data', Buffer.from('Ready to accept connections\n'))
    expect(transport.running).toBe(false)
    expire()
    await expect(started).rejects.toThrow(
      'did not return a URL for sharing port 4322',
    )
    started = transport.start(id, 4322)
    child().stdout.emit(
      'data',
      Buffer.from(
        'Hosting port 4322 at https://attacker.example/\nReady to accept connections\n',
      ),
    )
    await expect(started).rejects.toThrow('invalid Dev Tunnels URL')
    expect(transport.running).toBe(false)
    started = transport.start(id, 4322)
    child().emit('close', 1)
    await expect(started).rejects.toThrow('exited before it was ready')
    started = transport.start(id, 4322)
    child().stdout.emit(
      'data',
      Buffer.from('Another host for the tunnel has connected\n'),
    )
    await expect(started).rejects.toThrow('replaced')
    expect(
      calls.some((args) => args.includes('delete') || args.includes('create')),
    ).toBe(false)
  } finally {
    await transport.dispose()
    timeout.mockRestore()
    for (const timer of timers) clearTimeout(timer)
  }
})

test('tunnel CLI lifecycle reports device login, readiness, replacement, failures and explicit stopping', async () => {
  const callbacks: Array<() => void> = []
  const timers: Array<ReturnType<typeof setTimeout>> = []
  const originalTimeout = setTimeout
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
    new Proxy(originalTimeout, {
      apply(_target, _this, args: unknown[]) {
        const callback = args[0]
        if (typeof callback !== 'function')
          throw new Error('Expected a timer callback.')
        callbacks.push(() => {
          Reflect.apply(callback, undefined, [])
        })
        const timer = originalTimeout(() => {}, 60_000)
        timers.push(timer)
        return timer
      },
    }),
  )
  const children: Array<
    EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      exitCode: number | null
    }
  > = []
  let commandError: Error | { code: number } | null = null
  const spawned: string[][] = []
  const transport = new TunnelProcess({
    command: () => {
      if (commandError instanceof Error) return Promise.reject(commandError)
      return Promise.resolve({
        code: commandError?.code ?? 0,
        output: 'output',
      })
    },
    spawn: (args) => {
      spawned.push(args)
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const events = new EventEmitter()
      const child = Object.assign(events, {
        stdout,
        stderr,
        exitCode: null,
        kill: () => {
          events.emit('close', 0)
          return true
        },
      })
      children.push(child)
      return child
    },
  })

  const child = () => {
    const value = children.at(-1)
    if (!value) throw new Error('No process was started.')
    return value
  }
  const expire = () => {
    const value = callbacks.at(-1)
    if (!value) throw new Error('No timeout was registered.')
    value()
  }
  try {
    expect(await transport.command(['show'])).toEqual({
      code: 0,
      output: 'output',
    })
    commandError = { code: 1 }
    expect((await transport.command(['show'])).code).toBe(1)
    commandError = new Error('cannot launch')
    await expect(transport.command(['show'])).rejects.toThrow('cannot launch')
    commandError = null
    transport.beginLogin()
    expect(spawned.at(-1)).toEqual(['user', 'login', '-g', '-d'])
    expect(() => transport.beginLogin()).toThrow('already')
    child().stdout.emit(
      'data',
      Buffer.from(
        'Browse to https://microsoft.com/devicelogin and enter the code: ABCD-',
      ),
    )
    expect(transport.login).toBeNull()
    child().stderr.emit('data', Buffer.from('1234\n'))
    expect(transport.login?.code).toBe('ABCD-1234')
    child().emit('close', 0)
    expect(transport.login).toBeNull()
    transport.beginLogin('microsoft')
    expect(spawned.at(-1)).toEqual(['user', 'login', '-d'])
    expire()
    expect(transport.error).toBe('Tunnel sign-in timed out.')
    transport.beginLogin()
    child().emit('error', new Error('login error'))
    child().emit('close', 1)
    expect(transport.error).toBe('login error')
    transport.beginLogin()
    child().emit('close', 1)
    expect(transport.error).toContain('did not complete')
    let stopped = 0
    transport.onUnexpectedStop = () => stopped++
    let started = transport.start('owned', 4322)
    await expect(transport.start('owned', 4322)).rejects.toThrow('already')
    child().stdout.emit(
      'data',
      Buffer.from(
        'Hosting port: 4322\nConnect via browser: https://owned-4322.euw.devtunnels.ms/\nReady to accept connections\n',
      ),
    )
    expect(await started).toBe('https://owned-4322.euw.devtunnels.ms')
    expect(transport.running).toBe(true)
    expect(() => transport.beginLogin()).toThrow('Stop sharing')
    await transport.stop()
    expect(stopped).toBe(0)
    started = transport.start('owned', 4322)
    child().stdout.emit(
      'data',
      Buffer.from(
        'Hosting port 4322 at https://owned-4322.euw.devtunnels.ms/\nReady to accept connections\n',
      ),
    )
    await started
    child().stderr.emit(
      'data',
      Buffer.from('Another host for the tunnel has connected\n'),
    )
    expect(transport.error).toContain('replaced')
    expect(stopped).toBe(1)
    started = transport.start('owned', 4322)
    child().emit('error', new Error('spawn error'))
    child().emit('close', 1)
    await expect(started).rejects.toThrow('spawn error')
    started = transport.start('owned', 4322)
    expire()
    await expect(started).rejects.toThrow('timed out')
    transport.beginLogin()
    await transport.dispose()
    expect(transport.running).toBe(false)
  } finally {
    await transport.dispose()
    timerSpy.mockRestore()
    for (const timer of timers) clearTimeout(timer)
  }
})

test('the signed-in Dev Tunnels account is detected and refreshed after sign-in', async () => {
  expect(parseTunnelUser('Logged in as octocat using GitHub.')).toEqual({
    name: 'octocat',
    provider: 'GitHub',
  })
  expect(parseTunnelUser('Not logged in.')).toBeNull()
  let reply: Error | { code: number; output: string } = {
    code: 0,
    output: 'Not logged in.',
  }
  const commands: string[][] = []
  const children: EventEmitter[] = []
  const transport = new TunnelProcess({
    command: (args) => {
      commands.push(args)
      return reply instanceof Error ?
          Promise.reject(reply)
        : Promise.resolve(reply)
    },
    spawn: () => {
      const events = new EventEmitter()
      children.push(events)
      return Object.assign(events, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        kill: () => true,
      })
    },
  })
  try {
    expect(await transport.refreshUser()).toBeNull()
    expect(commands.at(-1)).toEqual(['user', 'show'])
    reply = {
      code: 0,
      output: 'Logged in as user@example.com using Microsoft.',
    }
    expect(await transport.refreshUser()).toEqual({
      name: 'user@example.com',
      provider: 'Microsoft',
    })
    reply = new Error('Install the Microsoft Dev Tunnels CLI')
    await expect(transport.refreshUser()).rejects.toThrow('Install')
    expect(transport.user).toBeNull()
    expect(transport.accountError).toContain('Install')
    expect(transport.checkingUser).toBe(false)
    reply = { code: 1, output: 'network unavailable' }
    await expect(transport.refreshUser()).rejects.toThrow('network unavailable')
    expect(transport.accountError).toContain('network unavailable')
    reply = { code: 0, output: 'unknown response' }
    await expect(transport.refreshUser()).rejects.toThrow('unrecognized')
    expect(transport.accountError).toContain('could not be confirmed')
    reply = { code: 0, output: 'Logged in as octocat using GitHub.' }
    transport.beginLogin('github')
    expect(transport.signingIn).toBe(true)
    expect(transport.accountError).toBeNull()
    children.at(-1)?.emit('close', 0)
    await new Promise(setImmediate)
    expect(transport.user).toEqual({ name: 'octocat', provider: 'GitHub' })
    expect(transport.signingIn).toBe(false)
    expect(transport.checkingUser).toBe(false)
    reply = { code: 0, output: 'Not logged in.' }
    transport.beginLogin()
    children.at(-1)?.emit('close', 0)
    await new Promise(setImmediate)
    expect(transport.accountError).toContain('no signed-in account')
    reply = new Error('status command unavailable')
    transport.beginLogin()
    children.at(-1)?.emit('close', 0)
    await new Promise(setImmediate)
    expect(transport.accountError).toBe('status command unavailable')
    reply = { code: 0, output: 'Logged in as octocat using GitHub.' }
    expect(await transport.refreshUser()).toEqual({
      name: 'octocat',
      provider: 'GitHub',
    })
    expect(transport.accountError).toBeNull()
    transport.beginLogin()
    const before = commands.length
    children.at(-1)?.emit('close', 1)
    await new Promise(setImmediate)
    expect(transport.user).toBeNull()
    expect(commands).toHaveLength(before)
    expect(transport.error).toContain('did not complete')
  } finally {
    await transport.dispose()
  }
})

test('a late account check cannot overwrite a completed login or a newer manual check', async () => {
  const resolvers: Array<(value: { code: number; output: string }) => void> = []
  let child = new EventEmitter()
  const transport = new TunnelProcess({
    command: () => new Promise((resolve) => resolvers.push(resolve)),
    spawn: () => {
      child = new EventEmitter()
      return Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        kill: () => true,
      })
    },
  })
  const resolveCheck = (index: number, output: string) => {
    const resolve = resolvers[index]
    if (!resolve) throw new Error('Missing account check.')
    resolve({ code: 0, output })
  }
  try {
    const startup = transport.refreshUser()
    expect(transport.checkingUser).toBe(true)
    transport.beginLogin()
    expect(transport.checkingUser).toBe(false)
    child.emit('close', 0)
    expect(transport.checkingUser).toBe(true)
    resolveCheck(1, 'Logged in as octocat using GitHub.')
    await new Promise(setImmediate)
    resolveCheck(0, 'Not logged in.')
    await startup
    expect(transport.user?.name).toBe('octocat')
    const first = transport.refreshUser()
    const second = transport.refreshUser()
    resolveCheck(2, 'Not logged in.')
    await first
    expect(transport.checkingUser).toBe(true)
    expect(transport.user?.name).toBe('octocat')
    resolveCheck(3, 'Logged in as another-user using Microsoft.')
    await second
    expect(transport.user?.name).toBe('another-user')
    expect(transport.checkingUser).toBe(false)
  } finally {
    await transport.dispose()
  }
})

test('a missing tunnel CLI is an explicit error and never triggers installation or provisioning', async () => {
  const originalPath = process.env.PATH
  const originalLocal = process.env.LOCALAPPDATA
  const missing = path.join(os.tmpdir(), `modelbridge-no-cli-${randomUUID()}`)
  process.env.PATH = missing
  process.env.LOCALAPPDATA = missing
  const exists = spyOn(fs, 'existsSync').mockReturnValue(false)
  const registry = fakeRegistry(() => '')
  const blocking = spyOn(childProcess, 'execFileSync')
  try {
    const transport = new TunnelProcess()
    await transport.prepare()
    await expect(transport.command(['show'])).rejects.toThrow(
      'Install the Microsoft Dev Tunnels CLI',
    )
    expect(() => transport.beginLogin()).toThrow(
      'No software is installed automatically',
    )
    await expect(transport.start('owned', 4322)).rejects.toThrow(
      'Install the Microsoft Dev Tunnels CLI',
    )
    expect(registry).toHaveBeenCalledTimes(process.platform === 'win32' ? 2 : 0)
    expect(blocking).not.toHaveBeenCalled()
  } finally {
    blocking.mockRestore()
    registry.mockRestore()
    exists.mockRestore()
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalLocal === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = originalLocal
  }
})

test.skipIf(process.platform !== 'win32')(
  'a prepared registry PATH is reused by later CLI resolution without blocking',
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modelbridge-reg-'))
    fs.writeFileSync(path.join(directory, 'devtunnel.exe'), 'fixture')
    let reply = directory
    const registry = fakeRegistry(() => `${reply}\r\n`)
    try {
      expect(await refreshRegistryPath()).toBe(directory)
      expect(resolveDevTunnelExecutable({ PATH: '' })).toBe(
        path.join(directory, 'devtunnel.exe'),
      )
      reply = ''
      expect(await refreshRegistryPath()).toBe('')
    } finally {
      registry.mockRestore()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)

test('CLI resolution uses explicit absolute paths, fresh registry PATH and excludes directories', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modelbridge-cli-'))
  const name = process.platform === 'win32' ? 'devtunnel.exe' : 'devtunnel'
  const first = path.join(directory, 'first')
  const fresh = path.join(directory, 'fresh')
  fs.mkdirSync(first)
  fs.mkdirSync(path.join(first, name))
  fs.mkdirSync(fresh)
  fs.writeFileSync(path.join(fresh, name), 'fixture')
  try {
    const env = {
      PATH: `relative${path.delimiter}"${first}"`,
      CLI_HOME: fresh,
    }
    expect(resolveDevTunnelExecutable(env, '%CLI_HOME%')).toBe(
      path.join(fresh, name),
    )
    expect(() => resolveDevTunnelExecutable(env, '')).toThrow(
      'only required for hosting',
    )
    fs.rmdirSync(path.join(first, name))
    fs.writeFileSync(path.join(first, name), 'fixture')
    expect(resolveDevTunnelExecutable(env, fresh)).toBe(path.join(first, name))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== 'win32')(
  'CLI resolution discovers newly installed user and machine WinGet packages without stale PATH',
  () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modelbridge-winget-'),
    )
    const local = path.join(directory, 'user')
    const machine = path.join(directory, 'machine')
    const packageName = 'Microsoft.devtunnel_Microsoft.Winget.Source_fixture'
    const userPackage = path.join(
      local,
      'Microsoft',
      'WinGet',
      'Packages',
      packageName,
    )
    const machinePackage = path.join(machine, 'WinGet', 'Packages', packageName)
    const userLink = path.join(local, 'Microsoft', 'WinGet', 'Links')
    const machineLink = path.join(machine, 'WinGet', 'Links')
    const env = { PATH: '', LOCALAPPDATA: local, ProgramW6432: machine }
    try {
      expect(() => resolveDevTunnelExecutable(env, '')).toThrow('Install')
      for (const root of [userPackage, machinePackage, userLink, machineLink])
        fs.mkdirSync(root, { recursive: true })
      fs.mkdirSync(
        path.join(local, 'Microsoft', 'WinGet', 'Packages', 'unrelated'),
      )
      fs.writeFileSync(
        path.join(
          local,
          'Microsoft',
          'WinGet',
          'Packages',
          'Microsoft.devtunnel_not-a-folder',
        ),
        'fixture',
      )
      fs.writeFileSync(path.join(machinePackage, 'devtunnel.exe'), 'fixture')
      expect(resolveDevTunnelExecutable(env, '')).toBe(
        path.join(machinePackage, 'devtunnel.exe'),
      )
      fs.writeFileSync(path.join(userPackage, 'devtunnel.exe'), 'fixture')
      expect(resolveDevTunnelExecutable(env, '')).toBe(
        path.join(userPackage, 'devtunnel.exe'),
      )
      fs.writeFileSync(path.join(machineLink, 'devtunnel.exe'), 'fixture')
      expect(resolveDevTunnelExecutable(env, '')).toBe(
        path.join(machineLink, 'devtunnel.exe'),
      )
      fs.writeFileSync(path.join(userLink, 'devtunnel.exe'), 'fixture')
      expect(resolveDevTunnelExecutable(env, '')).toBe(
        path.join(userLink, 'devtunnel.exe'),
      )
      fs.unlinkSync(path.join(userLink, 'devtunnel.exe'))
      expect(
        resolveDevTunnelExecutable(
          { ...env, ProgramW6432: undefined, ProgramFiles: machine },
          '',
        ),
      ).toBe(path.join(machineLink, 'devtunnel.exe'))
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
