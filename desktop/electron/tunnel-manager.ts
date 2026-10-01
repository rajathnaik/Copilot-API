import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app, shell } from 'electron'

import type { TunnelLoginProvider, TunnelStatus } from '../src/types/ipc'
import { tMain } from './i18n'
import {
  getServerBaseUrl,
  isRunning as isServerRunning,
} from './server-manager'
import {
  TUNNEL_NAME,
  buildLoginArgs,
  getCliCandidatePaths,
  getCliExecutableName,
  getInstallCommand,
  isHostReady,
  isHostReplaced,
  isTunnelNotFound,
  parseDeviceLoginPrompt,
  parseHostUrl,
  parseTunnelShow,
  parseUserShow,
  type TunnelInfo,
} from './tunnel-cli'

const CLI_TIMEOUT_MS = 60_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
const HOST_READY_TIMEOUT_MS = 60_000
const LOG_LIMIT = 40

let cliPath: string | null = null
let hostProcess: ChildProcess | null = null
let loginProcess: ChildProcess | null = null
let stopRequested = false
let statusCallback: ((status: TunnelStatus) => void) | null = null
let quitHookRegistered = false

let status: TunnelStatus = {
  cliInstalled: false,
  installSupported: getInstallCommand(process.platform) !== null,
  installing: false,
  user: null,
  loggingIn: false,
  login: null,
  state: 'stopped',
  logs: [],
}

function setStatus(patch: Partial<TunnelStatus>): TunnelStatus {
  status = { ...status, ...patch }
  statusCallback?.(status)
  return status
}

function appendLog(chunk: string): void {
  const lines = chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return
  setStatus({ logs: [...status.logs, ...lines].slice(-LOG_LIMIT) })
}

function lastLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Request ID'))
  return lines.at(-1) ?? ''
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

// winget installs portable packages under Packages\<id>_<source>\ and does not
// always create a Links shim, so look there too.
function findWingetPackageExecutables(): string[] {
  if (process.platform !== 'win32') return []
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  const packagesDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages')
  try {
    return fs
      .readdirSync(packagesDir)
      .filter((name) => name.toLowerCase().startsWith('microsoft.devtunnel_'))
      .map((name) => path.join(packagesDir, name, 'devtunnel.exe'))
  } catch {
    return []
  }
}

function resolveCliPath(): string | null {
  const exe = getCliExecutableName(process.platform)
  const pathCandidates = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, exe))
  const candidates = [
    ...pathCandidates,
    ...getCliCandidatePaths(process.platform, process.env, os.homedir()),
    ...findWingetPackageExecutables(),
  ]
  return candidates.find((candidate) => isFile(candidate)) ?? null
}

function runCommand(
  command: string,
  args: string[],
  timeout = CLI_TIMEOUT_MS,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`
        if (!error) {
          resolve({ code: 0, output })
          return
        }
        const code = typeof error.code === 'number' ? error.code : 1
        resolve({ code, output: output || error.message })
      },
    )
  })
}

function runCli(args: string[]): Promise<{ code: number; output: string }> {
  if (!cliPath)
    return Promise.resolve({ code: 1, output: 'devtunnel not found' })
  return runCommand(cliPath, args)
}

function killProcess(child: ChildProcess | null): void {
  if (child && child.exitCode === null && !child.killed) child.kill()
}

function registerQuitHook(): void {
  if (quitHookRegistered) return
  quitHookRegistered = true
  // Child processes outlive Electron on Windows unless killed explicitly.
  app.on('will-quit', () => {
    stopRequested = true
    killProcess(hostProcess)
    killProcess(loginProcess)
  })
}

export function onTunnelStatusChange(
  callback: ((status: TunnelStatus) => void) | null,
): void {
  statusCallback = callback
  registerQuitHook()
}

export function getTunnelState(): TunnelStatus {
  return status
}

export async function refreshTunnelStatus(): Promise<TunnelStatus> {
  cliPath = resolveCliPath()
  if (!cliPath) {
    return setStatus({ cliInstalled: false, user: null })
  }

  const { output } = await runCli(['user', 'show'])
  return setStatus({ cliInstalled: true, user: parseUserShow(output) })
}

export async function installTunnelCli(): Promise<TunnelStatus> {
  const installCommand = getInstallCommand(process.platform)
  if (!installCommand || status.installing) return status

  setStatus({ installing: true, error: undefined })
  const { code, output } = await runCommand(
    installCommand.command,
    installCommand.args,
    INSTALL_TIMEOUT_MS,
  )
  appendLog(output)
  setStatus({ installing: false })

  const refreshed = await refreshTunnelStatus()
  if (!refreshed.cliInstalled) {
    return setStatus({
      error:
        code === 0 ?
          await tMain('remoteAccess.errorInstallNotFound')
        : lastLine(output) || (await tMain('remoteAccess.errorInstallFailed')),
    })
  }
  return refreshed
}

export function startTunnelLogin(provider: TunnelLoginProvider): TunnelStatus {
  if (!cliPath || loginProcess) return status

  setStatus({ loggingIn: true, login: null, error: undefined })
  const child = spawn(cliPath, buildLoginArgs(provider), { windowsHide: true })
  loginProcess = child
  let output = ''
  let opened = false

  const handleData = (data: Buffer) => {
    output += data.toString('utf8')
    const prompt = parseDeviceLoginPrompt(output)
    if (prompt && !opened) {
      opened = true
      setStatus({ login: prompt })
      void shell.openExternal(prompt.url)
    }
  }
  child.stdout.on('data', handleData)
  child.stderr.on('data', handleData)

  child.on('close', (code) => {
    if (loginProcess === child) loginProcess = null
    void refreshTunnelStatus().then((refreshed) => {
      setStatus({
        loggingIn: false,
        login: null,
        error: refreshed.user || code === null ? undefined : lastLine(output),
      })
    })
  })
  child.on('error', (error) => {
    if (loginProcess === child) loginProcess = null
    setStatus({ loggingIn: false, login: null, error: error.message })
  })

  return status
}

export function cancelTunnelLogin(): void {
  killProcess(loginProcess)
}

export async function logoutTunnel(): Promise<TunnelStatus> {
  await stopTunnel()
  await runCli(['user', 'logout'])
  return refreshTunnelStatus()
}

// Exposing an unauthenticated gateway to the internet would let anyone use
// the Copilot subscription, so require the running server to reject requests
// without an API key before opening the tunnel.
async function ensureServerRequiresKey(): Promise<void> {
  if (!isServerRunning()) {
    throw new Error(await tMain('remoteAccess.errorServerNotRunning'))
  }

  let responseStatus: number
  try {
    const response = await fetch(`${getServerBaseUrl()}/v1/models`)
    responseStatus = response.status
    await response.body?.cancel()
  } catch {
    throw new Error(await tMain('remoteAccess.errorServerNotRunning'))
  }

  if (responseStatus !== 401 && responseStatus !== 403) {
    throw new Error(await tMain('remoteAccess.errorKeyRequired'))
  }
}

async function showTunnel(id: string): Promise<{
  info: TunnelInfo | null
  notFound: boolean
  output: string
}> {
  const { output } = await runCli(['show', id, '-j'])
  return {
    info: parseTunnelShow(output),
    notFound: isTunnelNotFound(output),
    output,
  }
}

async function runCliOrThrow(args: string[]): Promise<void> {
  const { code, output } = await runCli(args)
  if (code !== 0)
    throw new Error(lastLine(output) || `devtunnel ${args[0]} failed`)
}

async function ensureTunnel(port: number): Promise<TunnelInfo> {
  let shown = await showTunnel(TUNNEL_NAME)
  if (!shown.info && shown.notFound) {
    await runCliOrThrow(['create', TUNNEL_NAME, '--allow-anonymous'])
    shown = await showTunnel(TUNNEL_NAME)
  }
  const info = shown.info
  if (!info) throw new Error(lastLine(shown.output) || 'devtunnel show failed')

  if (!info.anonymous) {
    await runCliOrThrow(['access', 'create', info.tunnelId, '--anonymous'])
  }

  for (const stalePort of info.ports.filter((p) => p.portNumber !== port)) {
    await runCliOrThrow([
      'port',
      'delete',
      info.tunnelId,
      '-p',
      String(stalePort.portNumber),
    ])
  }

  if (!info.ports.some((p) => p.portNumber === port)) {
    await runCliOrThrow([
      'port',
      'create',
      info.tunnelId,
      '-p',
      String(port),
      '--protocol',
      'http',
    ])
  }

  return (await showTunnel(info.tunnelId)).info ?? info
}

function hostTunnel(tunnelId: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!cliPath) {
      reject(new Error('devtunnel not found'))
      return
    }

    stopRequested = false
    const child = spawn(cliPath, ['host', tunnelId], { windowsHide: true })
    hostProcess = child
    let output = ''
    let settled = false
    let replacedError: string | undefined

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killProcess(child)
      reject(new Error(lastLine(output) || 'Timed out waiting for the tunnel'))
    }, HOST_READY_TIMEOUT_MS)

    const handleData = (data: Buffer) => {
      const text = data.toString('utf8')
      output += text
      appendLog(text)
      const url = parseHostUrl(output)
      if (url && url !== status.url) setStatus({ url })
      if (!settled && isHostReady(output)) {
        settled = true
        clearTimeout(timer)
        setStatus({ state: 'running', port, error: undefined })
        resolve()
      }
      if (settled && !replacedError && isHostReplaced(text)) {
        void tMain('remoteAccess.errorHostReplaced').then((message) => {
          replacedError = message
          killProcess(child)
        })
      }
    }
    child.stdout.on('data', handleData)
    child.stderr.on('data', handleData)

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', () => {
      if (hostProcess === child) hostProcess = null
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(new Error(lastLine(output) || 'devtunnel host exited'))
        return
      }
      if (stopRequested) {
        setStatus({ state: 'stopped', error: undefined })
      } else {
        setStatus({
          state: 'error',
          error: replacedError || lastLine(output) || 'devtunnel host exited',
        })
      }
    })
  })
}

export async function startTunnel(port: number): Promise<TunnelStatus> {
  if (status.state === 'starting' || status.state === 'running') return status

  setStatus({ state: 'starting', error: undefined, port })
  try {
    if (!cliPath) await refreshTunnelStatus()
    if (!cliPath) throw new Error(await tMain('remoteAccess.errorCliMissing'))
    if (!status.user)
      throw new Error(await tMain('remoteAccess.errorNotSignedIn'))

    await ensureServerRequiresKey()
    const info = await ensureTunnel(port)
    const portUri = info.ports.find((p) => p.portNumber === port)?.portUri
    if (portUri) setStatus({ url: portUri })

    await hostTunnel(info.tunnelId, port)
    return status
  } catch (error) {
    killProcess(hostProcess)
    return setStatus({
      state: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function stopTunnel(): Promise<TunnelStatus> {
  const child = hostProcess
  if (!child || child.exitCode !== null) {
    return Promise.resolve(setStatus({ state: 'stopped', error: undefined }))
  }

  stopRequested = true
  return new Promise((resolve) => {
    child.once('close', () => resolve(status))
    killProcess(child)
  })
}

// Keeps the tunnel pointed at the server after the server (re)starts, and
// closes it if the restarted server no longer requires an API key.
export async function handleServerStarted(
  port: number,
  autoStart: boolean,
): Promise<void> {
  if (status.state === 'running') {
    try {
      await ensureServerRequiresKey()
    } catch (error) {
      await stopTunnel()
      setStatus({
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (status.port !== port) {
      await stopTunnel()
      await startTunnel(port)
    }
    return
  }
  if (autoStart && status.state !== 'starting') {
    await startTunnel(port)
  }
}
