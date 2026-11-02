import { execFile, spawn } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import type { CommandResult } from '@modelbridge/runtime/dev-tunnels'

interface TunnelChild extends EventEmitter {
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exitCode: number | null
  kill(): boolean
}

interface TunnelLauncher {
  prepare?(): Promise<void>
  command(args: string[]): Promise<CommandResult>
  spawn(args: string[]): TunnelChild
}

let registryCache = ''

/** Reads the fresh machine and user PATH so newly installed CLIs are found without restarting. */
function registryPath(): Promise<string> {
  if (process.platform !== 'win32') return Promise.resolve('')
  return new Promise((resolve) => {
    execFile(
      path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 128_000,
      },
      (error, stdout) => resolve(error ? '' : String(stdout).trim()),
    )
  })
}

export async function refreshRegistryPath(): Promise<string> {
  registryCache = await registryPath()
  return registryCache
}

export function resolveDevTunnelExecutable(
  env: NodeJS.ProcessEnv = process.env,
  installedPath: string = registryCache,
): string {
  const name = process.platform === 'win32' ? 'devtunnel.exe' : 'devtunnel'
  const candidates = `${env.PATH ?? ''}${path.delimiter}${installedPath}`
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) =>
      entry
        .replace(/^"|"$/gu, '')
        .replace(
          /%([^%]+)%/gu,
          (original: string, key: string) => env[key] ?? original,
        ),
    )
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.join(entry, name))
  const roots: string[] = []
  if (process.platform === 'win32') {
    if (env.LOCALAPPDATA)
      roots.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet'))
    const programFiles = env.ProgramW6432 ?? env.ProgramFiles
    if (programFiles) roots.push(path.join(programFiles, 'WinGet'))
    for (const root of roots) candidates.push(path.join(root, 'Links', name))
  }
  const existing = () =>
    candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile())
  let found = existing()
  if (!found) {
    for (const root of roots) {
      const packages = path.join(root, 'Packages')
      if (!fs.existsSync(packages)) continue
      for (const entry of fs.readdirSync(packages, { withFileTypes: true }))
        if (entry.isDirectory() && /^Microsoft\.devtunnel_/iu.test(entry.name))
          candidates.push(path.join(packages, entry.name, name))
    }
    found = existing()
  }
  if (!found)
    throw new Error(
      "Install the Microsoft Dev Tunnels CLI using Microsoft's instructions, then retry. It is only required for hosting. No software is installed automatically.",
    )
  return found
}

const launcher: TunnelLauncher = {
  prepare: async () => {
    await refreshRegistryPath()
  },
  command: async (args) => {
    await refreshRegistryPath()
    const executable = resolveDevTunnelExecutable()
    return new Promise((resolve, reject) => {
      execFile(
        executable,
        args,
        { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') {
            reject(
              error instanceof Error ? error : (
                new Error('Could not launch Microsoft Dev Tunnels.', {
                  cause: error,
                })
              ),
            )
            return
          }
          resolve({
            code: error ? Number(error.code) : 0,
            output: `${stdout}${stderr}`,
          })
        },
      )
    })
  },
  spawn: (args) =>
    spawn(resolveDevTunnelExecutable(), args, { windowsHide: true }),
}

export type TunnelLoginProvider = 'github' | 'microsoft'
export interface TunnelUser {
  name: string
  provider: string
}

/** Parses `devtunnel user show`, e.g. "Logged in as octocat using GitHub." */
export function parseTunnelUser(output: string): TunnelUser | null {
  const match = /Logged in as (\S+) using (\w+)/iu.exec(output)
  return match ? { name: match[1], provider: match[2] } : null
}

export class TunnelProcess {
  private host: TunnelChild | null = null
  private loginProcess: TunnelChild | null = null
  login: { url: string; code: string } | null = null
  user: TunnelUser | null = null
  checkingUser = false
  accountError: string | null = null
  private accountCheck = 0
  error: string | null = null
  running = false
  private stopping = false
  onUnexpectedStop: (() => void) | null = null

  constructor(private readonly processLauncher: TunnelLauncher = launcher) {}

  get signingIn(): boolean {
    return this.loginProcess !== null
  }

  /** Refreshes CLI discovery off the main thread before a user-initiated tunnel action. */
  async prepare(): Promise<void> {
    await this.processLauncher.prepare?.()
  }

  command(args: string[]): Promise<CommandResult> {
    return this.processLauncher.command(args)
  }

  async refreshUser(): Promise<TunnelUser | null> {
    const check = ++this.accountCheck
    this.checkingUser = true
    this.accountError = null
    try {
      const result = await this.processLauncher.command(['user', 'show'])
      if (result.code !== 0)
        throw new Error(
          `Could not check Dev Tunnels sign-in: ${result.output.trim() || `CLI exited with code ${result.code}.`}`,
        )
      const user = parseTunnelUser(result.output)
      if (!user && !/^\s*Not logged in\.?\s*$/iu.test(result.output))
        throw new Error(
          'Dev Tunnels returned an unrecognized account response. Sign-in could not be confirmed.',
        )
      if (check === this.accountCheck) this.user = user
      return user
    } catch (error) {
      if (check === this.accountCheck) {
        this.user = null
        this.accountError =
          error instanceof Error ?
            error.message
          : 'Could not check Dev Tunnels sign-in.'
      }
      throw error
    } finally {
      if (check === this.accountCheck) this.checkingUser = false
    }
  }

  beginLogin(provider: TunnelLoginProvider = 'github'): void {
    if (this.loginProcess)
      throw new Error('A tunnel sign-in is already in progress.')
    if (this.host)
      throw new Error('Stop sharing before changing the Dev Tunnels account.')
    this.error = null
    const child = this.processLauncher.spawn(
      provider === 'github' ?
        ['user', 'login', '-g', '-d']
      : ['user', 'login', '-d'],
    )
    this.loginProcess = child
    this.accountCheck++
    this.checkingUser = false
    this.accountError = null
    this.user = null
    let output = ''
    const timer = setTimeout(() => {
      this.error = 'Tunnel sign-in timed out.'
      child.kill()
    }, 5 * 60_000)
    const receive = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-32_768)
      const prompt =
        /(https:\/\/\S+)\s+and enter the code:?\s*([A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{8,9})\b/iu.exec(
          output,
        )
      if (prompt) this.login = { url: prompt[1], code: prompt[2] }
    }
    child.stdout.on('data', receive)
    child.stderr.on('data', receive)
    child.on('error', (error: Error) => {
      this.error = error.message
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      this.loginProcess = null
      this.login = null
      if (code !== 0 || this.error) {
        this.error ??= 'Microsoft Dev Tunnels sign-in did not complete.'
        return
      }
      const check = this.accountCheck + 1
      void this.refreshUser()
        .then((user) => {
          if (!user && check === this.accountCheck)
            this.accountError =
              'Sign-in finished, but Dev Tunnels reports no signed-in account. Try signing in again, then check sign-in status.'
        })
        .catch((error: unknown) => {
          if (check === this.accountCheck)
            this.accountError =
              error instanceof Error ?
                error.message
              : 'Could not confirm Dev Tunnels sign-in.'
        })
    })
  }

  start(id: string): Promise<void> {
    if (this.host)
      return Promise.reject(new Error('A tunnel host is already active.'))
    this.error = null
    this.stopping = false
    return new Promise((resolve, reject) => {
      const child = this.processLauncher.spawn(['host', id])
      this.host = child
      let output = ''
      let ready = false
      const timer = setTimeout(() => {
        this.error = 'Tunnel hosting timed out.'
        child.kill()
      }, 60_000)
      const receive = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-32_768)
        if (!ready && /Ready to accept connections/iu.test(output)) {
          ready = true
          this.running = true
          clearTimeout(timer)
          resolve()
        }
        if (/Another host for the tunnel has connected/iu.test(output)) {
          this.error = 'Another process replaced this tunnel host.'
          child.kill()
        }
      }
      child.stdout.on('data', receive)
      child.stderr.on('data', receive)
      child.on('error', (error: Error) => {
        this.error = error.message
        if (!ready) reject(error)
      })
      child.on('close', () => {
        clearTimeout(timer)
        this.host = null
        this.running = false
        if (!ready)
          reject(
            new Error(
              this.error ?? 'Tunnel hosting exited before it was ready.',
            ),
          )
        else if (!this.stopping) {
          if (!this.error)
            this.error =
              'The tunnel host stopped. Enable remote access again to reconnect.'
          this.onUnexpectedStop?.()
        }
      })
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.host
    if (child && child.exitCode === null)
      await new Promise<void>((resolve) => {
        child.once('close', () => resolve())
        child.kill()
      })
    this.error = null
    this.running = false
  }

  async dispose(): Promise<void> {
    await this.stop()
    if (this.loginProcess) this.loginProcess.kill()
  }
}
