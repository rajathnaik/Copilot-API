import type { DesktopProxySettings } from '../src/types/ipc'

const PROXY_ENV_KEYS = [
  'ALL_PROXY',
  'all_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
] as const

export type ElectronProxyConfig =
  | ElectronDirectProxyConfig
  | ElectronSystemProxyConfig
  | ElectronFixedProxyConfig

export interface ElectronDirectProxyConfig {
  mode: 'direct'
}

export interface ElectronSystemProxyConfig {
  mode: 'system'
}

export interface ElectronFixedProxyConfig {
  mode: 'fixed_servers'
  proxyBypassRules?: string
  proxyRules: string
}

function createProxyUrl(rawProxy: string): URL | null {
  const value = rawProxy.trim()
  if (!value) return null

  try {
    return new URL(value.includes('://') ? value : `http://${value}`)
  } catch {
    return null
  }
}

function normalizeProxyEnvValue(rawProxy: string): string | null {
  const url = createProxyUrl(rawProxy)
  return url?.toString() ?? null
}

function formatProxyHost(url: URL): string | null {
  if (!url.hostname) return null

  const hostname =
    url.hostname.includes(':') ?
      `[${url.hostname.replace(/^\[|\]$/g, '')}]`
    : url.hostname
  return `${hostname}${url.port ? `:${url.port}` : ''}`
}

function formatProxyServer(rawProxy: string): string | null {
  const url = createProxyUrl(rawProxy)
  if (!url) return null

  const host = formatProxyHost(url)
  if (!host) return null

  switch (url.protocol) {
    case 'http:':
      return host
    case 'https:':
      return `https://${host}`
    case 'socks:':
    case 'socks4:':
    case 'socks5:':
      return `${url.protocol}//${host}`
    default:
      return null
  }
}

function normalizeNoProxyRule(rule: string): string | null {
  const trimmed = rule.trim()
  if (!trimmed) return null
  if (trimmed === '*') return trimmed
  if (trimmed.startsWith('.')) return `*${trimmed}`
  return trimmed
}

function buildProxyBypassRules(noProxy: string): string | undefined {
  const rules: string[] = []

  for (const rawRule of noProxy.split(',')) {
    const rule = normalizeNoProxyRule(rawRule)
    if (rule && !rules.includes(rule)) {
      rules.push(rule)
    }
  }

  return rules.length > 0 ? rules.join(';') : undefined
}

export function hasNoProxyServerSwitch(argv: readonly string[]): boolean {
  return argv.includes('--no-proxy-server')
}

export function applyNoProxyServerOverride(
  proxySettings: DesktopProxySettings,
  noProxyServer: boolean,
): DesktopProxySettings {
  if (!noProxyServer) return proxySettings
  return {
    ...proxySettings,
    mode: 'direct',
  }
}

export function resolveElectronProxyConfigFromSettings(
  proxySettings: DesktopProxySettings,
): ElectronProxyConfig {
  if (proxySettings.mode === 'direct') return { mode: 'direct' }
  if (proxySettings.mode !== 'custom') return { mode: 'system' }

  const httpProxy = proxySettings.http_proxy.trim()
  const httpsProxy = proxySettings.https_proxy.trim()

  const httpProxyServer = httpProxy ? formatProxyServer(httpProxy) : null
  const httpsProxyServer = httpsProxy ? formatProxyServer(httpsProxy) : null
  if (!httpProxyServer && !httpsProxyServer) return { mode: 'system' }

  const proxyRules = [
    httpProxyServer ? `http=${httpProxyServer}` : null,
    httpsProxyServer ? `https=${httpsProxyServer}` : null,
  ].filter((rule): rule is string => rule !== null)

  return {
    mode: 'fixed_servers',
    proxyBypassRules: buildProxyBypassRules(proxySettings.no_proxy),
    proxyRules: proxyRules.join(';'),
  }
}

export function applyDesktopProxySettingsToEnv(
  env: NodeJS.ProcessEnv,
  proxySettings: DesktopProxySettings,
): boolean {
  for (const key of PROXY_ENV_KEYS) {
    delete env[key]
  }

  if (proxySettings.mode !== 'custom') return false

  const httpProxy = normalizeProxyEnvValue(proxySettings.http_proxy)
  const httpsProxy = normalizeProxyEnvValue(proxySettings.https_proxy)
  const noProxy = proxySettings.no_proxy.trim()
  if (!httpProxy && !httpsProxy) return false

  if (httpProxy) {
    env.HTTP_PROXY = httpProxy
    env.http_proxy = httpProxy
  }

  if (httpsProxy) {
    env.HTTPS_PROXY = httpsProxy
    env.https_proxy = httpsProxy
  }

  if (noProxy) {
    env.NO_PROXY = noProxy
    env.no_proxy = noProxy
  }

  return true
}
