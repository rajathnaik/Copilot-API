export const CONNECTOR_HARNESSES = [
  'codex',
  'claude-code',
  'opencode',
  'hermes',
  'openclaw',
] as const

export type ConnectorHarness = (typeof CONNECTOR_HARNESSES)[number]
export type ConnectorProtocol =
  'responses' | 'anthropic-messages' | 'chat-completions'
export type ConnectorCredentialMode = 'helper' | 'config'
export const HARNESS_NAMES: Record<ConnectorHarness, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  hermes: 'Hermes Agent',
  openclaw: 'OpenClaw',
}
export const HARNESS_PROTOCOLS: Record<ConnectorHarness, ConnectorProtocol> = {
  codex: 'responses',
  'claude-code': 'anthropic-messages',
  opencode: 'anthropic-messages',
  hermes: 'chat-completions',
  openclaw: 'chat-completions',
}

export function isConnectorHarness(value: unknown): value is ConnectorHarness {
  return CONNECTOR_HARNESSES.some((harness) => harness === value)
}

export interface ConnectorInput {
  harness?: ConnectorHarness
  url: string
  apiKey: string
  model?: string
  copyFrom?: ConnectorHarness
  allowPlaintext?: boolean
}

export interface ConnectorModel {
  id: string
  name: string
  contextWindow: number
  description: string
  maxOutputTokens?: number
  vision?: boolean
  reasoning?: boolean
}

export interface CodexInstallation {
  executable: string
  version: string
  configPath: string
  args?: string[]
}

export type HarnessInstallation = CodexInstallation

export interface ConnectorDiscovery {
  baseUrl: string
  models: ConnectorModel[]
  defaultModel: string
  catalogMode: 'remote' | 'local' | 'configured'
  excludedModels: string[]
}

export interface ConnectorConnection {
  harness: ConnectorHarness
  baseUrl: string
  model: string
  modelCount: number
  catalogMode: 'remote' | 'local' | 'configured'
  verifiedAt: string
  configPath: string
  protocol?: ConnectorProtocol
  credentialMode?: ConnectorCredentialMode
}

export interface ConnectorProfile {
  harness: ConnectorHarness
  connection: ConnectorConnection | null
  error?: string
}

export interface ConnectorStatus {
  appVersion: string
  installation: HarnessInstallation | null
  connection: ConnectorConnection | null
  secureStorage: boolean
  profiles?: ConnectorProfile[]
}

export type ConnectorResult<T> =
  { ok: true; value: T } | { ok: false; error: string }

export interface ConnectorAPI {
  status(harness?: ConnectorHarness): Promise<ConnectorResult<ConnectorStatus>>
  discover(input: ConnectorInput): Promise<ConnectorResult<ConnectorDiscovery>>
  connect(input: ConnectorInput): Promise<ConnectorResult<ConnectorConnection>>
  refresh(
    harness?: ConnectorHarness,
  ): Promise<ConnectorResult<ConnectorConnection>>
  undo(harness?: ConnectorHarness): Promise<ConnectorResult<null>>
  selectExecutable(
    harness?: ConnectorHarness,
  ): Promise<ConnectorResult<ConnectorStatus>>
  resetExecutable(
    harness?: ConnectorHarness,
  ): Promise<ConnectorResult<ConnectorStatus>>
  openInstallGuide(harness?: ConnectorHarness): Promise<ConnectorResult<null>>
}

declare global {
  interface Window {
    connectorAPI: ConnectorAPI
  }
}
