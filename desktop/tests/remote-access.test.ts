import { describe, expect, test } from 'bun:test'

import {
  buildLoginArgs,
  getCliCandidatePaths,
  getInstallCommand,
  isHostReady,
  isHostReplaced,
  isTunnelNotFound,
  parseDeviceLoginPrompt,
  parseHostUrl,
  parseTunnelShow,
  parseUserShow,
} from '../electron/tunnel-cli'
import { SNIPPET_API_KEY_PLACEHOLDER } from '../src/lib/playground'
import { buildClientSetups, normalizePublicUrl } from '../src/lib/remote-access'

const HOST_OUTPUT = `Connection to host tunnel relay restored.
Hosting port: 4141
Connect via browser: https://abcd1234-4141.inc1.devtunnels.ms
Inspect network activity: https://abcd1234-4141-inspect.inc1.devtunnels.ms

Ready to accept connections for tunnel: copilot-api.inc1`

const SHOW_OUTPUT = JSON.stringify({
  tunnel: {
    tunnelId: 'copilot-api.inc1',
    ports: [
      {
        portNumber: 4141,
        protocol: 'http',
        portUri: 'https://abcd1234-4141.inc1.devtunnels.ms/',
      },
    ],
    accessControl: [{ type: 'Anonymous', subjects: [], scopes: ['connect'] }],
  },
})

describe('devtunnel output parsing', () => {
  test('parses the signed-in user', () => {
    expect(parseUserShow('Logged in as octocat using GitHub.\n')).toEqual({
      name: 'octocat',
      provider: 'GitHub',
    })
    expect(parseUserShow('Not logged in.')).toBeNull()
  })

  test('parses the device login prompt', () => {
    const output =
      'Welcome to dev tunnels!\nBrowse to https://github.com/login/device and enter the code: 64AE-18D6\n'
    expect(parseDeviceLoginPrompt(output)).toEqual({
      url: 'https://github.com/login/device',
      code: '64AE-18D6',
    })
    expect(parseDeviceLoginPrompt('Welcome to dev tunnels!')).toBeNull()
  })

  test('parses the host URL and readiness', () => {
    expect(parseHostUrl(HOST_OUTPUT)).toBe(
      'https://abcd1234-4141.inc1.devtunnels.ms',
    )
    expect(isHostReady(HOST_OUTPUT)).toBe(true)
    expect(isHostReady('Hosting port: 4141')).toBe(false)
    expect(
      isHostReplaced(
        'Connection to host tunnel relay closed. Another host for the tunnel has connected.',
      ),
    ).toBe(true)
    expect(isHostReplaced(HOST_OUTPUT)).toBe(false)
  })

  test('parses tunnel details from show -j', () => {
    expect(parseTunnelShow(SHOW_OUTPUT)).toEqual({
      tunnelId: 'copilot-api.inc1',
      ports: [
        {
          portNumber: 4141,
          portUri: 'https://abcd1234-4141.inc1.devtunnels.ms',
        },
      ],
      anonymous: true,
    })
  })

  test('detects tunnels without anonymous access', () => {
    const output = JSON.stringify({
      tunnel: { tunnelId: 'copilot-api.usw2', ports: [], accessControl: [] },
    })
    expect(parseTunnelShow(output)?.anonymous).toBe(false)
  })

  test('handles missing tunnels and invalid output', () => {
    expect(parseTunnelShow('Tunnel not found: copilot-api')).toBeNull()
    expect(parseTunnelShow('{ not json')).toBeNull()
    expect(isTunnelNotFound('Tunnel not found: copilot-api')).toBe(true)
  })

  test('builds login args per provider', () => {
    expect(buildLoginArgs('github')).toEqual(['user', 'login', '-g', '-d'])
    expect(buildLoginArgs('microsoft')).toEqual(['user', 'login', '-d'])
  })
})

describe('devtunnel install helpers', () => {
  test('uses winget on Windows and brew on macOS', () => {
    expect(getInstallCommand('win32')?.command).toBe('winget')
    expect(getInstallCommand('win32')?.args).toContain('Microsoft.devtunnel')
    expect(getInstallCommand('darwin')).toEqual({
      command: 'brew',
      args: ['install', '--cask', 'devtunnel'],
    })
    expect(getInstallCommand('linux')).toBeNull()
  })

  test('includes the winget links folder on Windows', () => {
    const paths = getCliCandidatePaths(
      'win32',
      { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      'C:\\Users\\me',
    )
    expect(paths).toContain(
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\devtunnel.exe',
    )
  })
})

describe('client setup snippets', () => {
  const setups = buildClientSetups('https://abc-4141.inc1.devtunnels.ms/')

  test('normalizes trailing slashes', () => {
    expect(normalizePublicUrl(' https://x.devtunnels.ms// ')).toBe(
      'https://x.devtunnels.ms',
    )
  })

  test('covers curl, Claude Code, Codex and OpenAI SDK', () => {
    expect(setups.map((setup) => setup.id)).toEqual([
      'curl',
      'claudeCode',
      'codex',
      'openaiSdk',
    ])
  })

  test('uses the right base URL per client', () => {
    const byId = Object.fromEntries(setups.map((s) => [s.id, s.code]))
    expect(byId.curl).toContain('https://abc-4141.inc1.devtunnels.ms/v1/models')
    expect(byId.claudeCode).toContain(
      'ANTHROPIC_BASE_URL=https://abc-4141.inc1.devtunnels.ms\n',
    )
    expect(byId.codex).toContain(
      'base_url = "https://abc-4141.inc1.devtunnels.ms"',
    )
    expect(byId.openaiSdk).toContain(
      'base_url="https://abc-4141.inc1.devtunnels.ms/v1"',
    )
  })

  test('never embeds a real key by default', () => {
    for (const setup of setups) {
      if (setup.id === 'codex') continue
      expect(setup.code).toContain(SNIPPET_API_KEY_PLACEHOLDER)
    }
    expect(setups.find((s) => s.id === 'codex')?.code).toContain(
      'env_key = "GITHUB_COPILOT_API_KEY"',
    )
  })
})
