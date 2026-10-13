import { execFile, execFileSync, spawn } from 'node:child_process'
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
  command(args: string[]): Promise<CommandResult>
  spawn(args: string[]): TunnelChild
}

function registryPath(): string {
  if (process.platform !== 'win32') return ''
  return execFileSync(
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
  ).trim()
}

export function resolveDevTunnelExecutable(
  env: NodeJS.ProcessEnv = process.env,
  installedPath: string = registryPath(),
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
  command: (args) =>
    new Promise((resolve, reject) => {
      execFile(
        resolveDevTunnelExecutable(),
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
    }),
  spawn: (args) =>
    spawn(resolveDevTunnelExecutable(), args, { windowsHide: true }),
}

export class TunnelProcess {
  private host: TunnelChild | null = null
  private loginProcess: TunnelChild | null = null
  login: { url: string; code: string } | null = null
  error: string | null = null
  running = false
  private stopping = false
  onUnexpectedStop: (() => void) | null = null

  constructor(private readonly processLauncher: TunnelLauncher = launcher) {}

  command(args: string[]): Promise<CommandResult> {
    return this.processLauncher.command(args)
  }

  beginLogin(): void {
    if (this.loginProcess)
      throw new Error('A tunnel sign-in is already in progress.')
    this.error = null
    const child = this.processLauncher.spawn(['user', 'login', '-d'])
    this.loginProcess = child
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
      if (code !== 0 && !this.error)
        this.error = 'Microsoft Dev Tunnels sign-in did not complete.'
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
