export interface ConnectorInput {
  url: string
  apiKey: string
  model?: string
}

export interface ConnectorModel {
  id: string
  name: string
  contextWindow: number
  description: string
}

export interface CodexInstallation {
  executable: string
  version: string
  configPath: string
}

export interface ConnectorDiscovery {
  baseUrl: string
  models: ConnectorModel[]
  defaultModel: string
  catalogMode: 'remote' | 'local'
  excludedModels: string[]
}

export interface ConnectorConnection {
  harness: 'codex'
  baseUrl: string
  model: string
  modelCount: number
  catalogMode: 'remote' | 'local'
  verifiedAt: string
  configPath: string
}

export interface ConnectorStatus {
  installation: CodexInstallation | null
  connection: ConnectorConnection | null
  secureStorage: boolean
}

export type ConnectorResult<T> =
  { ok: true; value: T } | { ok: false; error: string }

export interface ConnectorAPI {
  status(): Promise<ConnectorResult<ConnectorStatus>>
  discover(input: ConnectorInput): Promise<ConnectorResult<ConnectorDiscovery>>
  connect(input: ConnectorInput): Promise<ConnectorResult<ConnectorConnection>>
  refresh(): Promise<ConnectorResult<ConnectorConnection>>
  undo(): Promise<ConnectorResult<null>>
  selectCodex(): Promise<ConnectorResult<ConnectorStatus>>
}

declare global {
  interface Window {
    connectorAPI: ConnectorAPI
  }
}
