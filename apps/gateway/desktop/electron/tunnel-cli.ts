import path from 'node:path'

import type { TunnelLoginProvider } from '../src/types/ipc'

export const TUNNEL_NAME = 'copilot-api'

export interface TunnelUser {
  name: string
  provider: string
}

export interface TunnelInfo {
  tunnelId: string
  ports: Array<{ portNumber: number; portUri?: string }>
  anonymous: boolean
}

export interface DeviceLoginPrompt {
  code: string
  url: string
}

// `devtunnel user show` prints e.g. "Logged in as octocat using GitHub."
export function parseUserShow(output: string): TunnelUser | null {
  const match = /Logged in as (\S+) using (\w+)/i.exec(output)
  if (!match) return null
  return { name: match[1], provider: match[2] }
}

// `devtunnel user login -d` prints
// "Browse to https://github.com/login/device and enter the code: ABCD-1234"
export function parseDeviceLoginPrompt(
  output: string,
): DeviceLoginPrompt | null {
  const match = /(https:\/\/\S+?)\s+and enter the code:?\s*([\w-]+)/i.exec(
    output,
  )
  if (!match) return null
  return { url: match[1], code: match[2] }
}

// `devtunnel host` prints "Connect via browser: https://xxxx-4141.inc1.devtunnels.ms"
export function parseHostUrl(output: string): string | null {
  const match = /Connect via browser:\s*(https:\/\/\S+)/i.exec(output)
  return match ? match[1].replace(/[,/]+$/, '') : null
}

export function isHostReady(output: string): boolean {
  return /Ready to accept connections/i.test(output)
}

// The relay drops the existing host when another `devtunnel host` connects to
// the same tunnel, and the CLI does not reconnect afterwards.
export function isHostReplaced(text: string): boolean {
  return /Another host for the tunnel has connected/i.test(text)
}

export function isTunnelNotFound(output: string): boolean {
  return /Tunnel not found/i.test(output)
}

interface RawTunnelShow {
  tunnel?: {
    tunnelId?: unknown
    ports?: Array<{ portNumber?: unknown; portUri?: unknown }>
    accessControl?: Array<{ type?: unknown; scopes?: unknown }>
  }
}

// Parses `devtunnel show <id> -j`.
export function parseTunnelShow(output: string): TunnelInfo | null {
  const start = output.indexOf('{')
  if (start < 0) return null

  let parsed: RawTunnelShow
  try {
    parsed = JSON.parse(output.slice(start)) as RawTunnelShow
  } catch {
    return null
  }

  const tunnel = parsed.tunnel
  if (!tunnel || typeof tunnel.tunnelId !== 'string') return null

  const ports = (tunnel.ports ?? [])
    .filter((port) => typeof port.portNumber === 'number')
    .map((port) => ({
      portNumber: port.portNumber as number,
      portUri:
        typeof port.portUri === 'string' ?
          port.portUri.replace(/\/+$/, '')
        : undefined,
    }))

  const anonymous = (tunnel.accessControl ?? []).some(
    (entry) =>
      entry.type === 'Anonymous'
      && Array.isArray(entry.scopes)
      && entry.scopes.includes('connect'),
  )

  return { tunnelId: tunnel.tunnelId, ports, anonymous }
}

export function buildLoginArgs(provider: TunnelLoginProvider): string[] {
  return provider === 'github' ?
      ['user', 'login', '-g', '-d']
    : ['user', 'login', '-d']
}

// Locations where package managers install the devtunnel CLI, in addition to PATH.
export function getCliCandidatePaths(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  homeDir: string,
): string[] {
  if (platform === 'win32') {
    const localAppData =
      env.LOCALAPPDATA ?? path.win32.join(homeDir, 'AppData', 'Local')
    return [
      path.win32.join(
        localAppData,
        'Microsoft',
        'WinGet',
        'Links',
        'devtunnel.exe',
      ),
    ]
  }

  return [
    path.posix.join(homeDir, 'bin', 'devtunnel'),
    '/opt/homebrew/bin/devtunnel',
    '/usr/local/bin/devtunnel',
  ]
}

export function getCliExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'devtunnel.exe' : 'devtunnel'
}

export function getInstallCommand(
  platform: NodeJS.Platform,
): { command: string; args: string[] } | null {
  if (platform === 'win32') {
    return {
      command: 'winget',
      args: [
        'install',
        '--id',
        'Microsoft.devtunnel',
        '-e',
        '--accept-source-agreements',
        '--accept-package-agreements',
        '--disable-interactivity',
      ],
    }
  }
  if (platform === 'darwin') {
    return { command: 'brew', args: ['install', '--cask', 'devtunnel'] }
  }
  return null
}
