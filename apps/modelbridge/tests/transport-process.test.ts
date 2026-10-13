import { expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as childProcess from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import {
  resolveDevTunnelExecutable,
  TunnelProcess,
} from '../electron/devtunnel-process'

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
  const transport = new TunnelProcess({
    command: () => {
      if (commandError instanceof Error) return Promise.reject(commandError)
      return Promise.resolve({
        code: commandError?.code ?? 0,
        output: 'output',
      })
    },
    spawn: () => {
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
    transport.beginLogin()
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
    let started = transport.start('owned')
    await expect(transport.start('owned')).rejects.toThrow('already')
    child().stdout.emit('data', Buffer.from('Ready to accept connections\n'))
    await started
    expect(transport.running).toBe(true)
    await transport.stop()
    expect(stopped).toBe(0)
    started = transport.start('owned')
    child().stdout.emit('data', Buffer.from('Ready to accept connections\n'))
    await started
    child().stderr.emit(
      'data',
      Buffer.from('Another host for the tunnel has connected\n'),
    )
    expect(transport.error).toContain('replaced')
    expect(stopped).toBe(1)
    started = transport.start('owned')
    child().emit('error', new Error('spawn error'))
    child().emit('close', 1)
    await expect(started).rejects.toThrow('spawn error')
    started = transport.start('owned')
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

test('a missing tunnel CLI is an explicit error and never triggers installation or provisioning', async () => {
  const originalPath = process.env.PATH
  const originalLocal = process.env.LOCALAPPDATA
  const missing = path.join(os.tmpdir(), `modelbridge-no-cli-${randomUUID()}`)
  process.env.PATH = missing
  process.env.LOCALAPPDATA = missing
  const exists = spyOn(fs, 'existsSync').mockReturnValue(false)
  const registry = spyOn(childProcess, 'execFileSync').mockReturnValue('')
  try {
    const transport = new TunnelProcess()
    await expect(transport.command(['show'])).rejects.toThrow(
      'Install the Microsoft Dev Tunnels CLI',
    )
    expect(() => transport.beginLogin()).toThrow(
      'No software is installed automatically',
    )
    await expect(transport.start('owned')).rejects.toThrow(
      'Install the Microsoft Dev Tunnels CLI',
    )
    expect(registry).toHaveBeenCalledTimes(process.platform === 'win32' ? 3 : 0)
  } finally {
    registry.mockRestore()
    exists.mockRestore()
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalLocal === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = originalLocal
  }
})

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
    const env = { PATH: `relative${path.delimiter}"${first}"`, CLI_HOME: fresh }
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
